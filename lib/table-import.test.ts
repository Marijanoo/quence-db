// CSV/JSON table import. The database tests are opt-in: QUENCE_PG_TEST_URL / QUENCE_MYSQL_TEST_URL.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import * as mysql from 'mysql2/promise'
import { autoMap, buildInsert, CsvParser, readPreview, runTableImport, toParam, type TableImportSession } from './table-import'
import { EXPORT_COLUMNS_SQL, parseExportColumns, type ExportColumn } from './table-export'

function reader(text: string, chunk = 5) {
  let pos = 0
  return async () => { const t = text.slice(pos, pos + chunk); pos += t.length; return { text: t, done: t.length === 0, position: pos } }
}

function parseCsv(text: string, delimiter = ',', size = text.length || 1) {
  const p = new CsvParser(delimiter)
  const out: string[][] = []
  for (let i = 0; i < text.length; i += size) out.push(...p.push(text.slice(i, i + size)))
  return [...out, ...p.end()]
}

const CSV = '﻿id,name,note\r\n1,"Ann, the ""first""","multi\nline"\r\n2,Bob,\n\n3,"",x'

describe('CsvParser', () => {
  it('parses quotes, doubled quotes, embedded line breaks, CRLF and a BOM', () => {
    expect(parseCsv(CSV)).toEqual([
      ['id', 'name', 'note'],
      ['1', 'Ann, the "first"', 'multi\nline'],
      ['2', 'Bob', ''],
      ['3', '', 'x'],
    ])
  })

  it('gives the same rows for every chunk size', () => {
    const whole = parseCsv(CSV)
    for (let size = 1; size <= 20; size++) expect(parseCsv(CSV, ',', size)).toEqual(whole)
  })

  it('supports other delimiters and reports an unterminated quote', () => {
    expect(parseCsv('a\tb\n1\t2', '\t')).toEqual([['a', 'b'], ['1', '2']])
    expect(() => parseCsv('a,"b')).toThrow(/quoted field/)
  })
})

describe('preview, mapping and values', () => {
  const cols = (names: string[]): ExportColumn[] => names.map(name => ({ name, type: 'text', kind: 'text', generated: name === 'total', identity: '', serial: false }))

  it('previews CSV and JSON files', async () => {
    expect(await readPreview(reader(CSV), { kind: 'csv', delimiter: ',', header: true }, 2)).toEqual({
      fields: ['id', 'name', 'note'],
      rows: [{ id: '1', name: 'Ann, the "first"', note: 'multi\nline' }, { id: '2', name: 'Bob', note: '' }],
    })
    expect((await readPreview(reader('a,b\n1,2'), { kind: 'csv', delimiter: ',', header: false })).fields).toEqual(['Column 1', 'Column 2'])
    expect(await readPreview(reader('[{"a": 1}, {"b": {"c": true}, "a": null}]'), { kind: 'json' })).toEqual({
      fields: ['a', 'b'], rows: [{ a: 1, b: undefined }, { a: null, b: { c: true } }],
    })
  })

  it('maps fields to columns by name, ignoring case and separators, never onto generated columns', () => {
    expect(autoMap(['ID', 'Full Name', 'total', 'extra'], cols(['id', 'full_name', 'total']))).toEqual([
      { source: 'ID', target: 'id' }, { source: 'Full Name', target: 'full_name' },
    ])
  })

  it('converts values to text parameters', () => {
    const opts = { emptyIsNull: true, nullText: '\\N' }
    expect(toParam('', 'postgres', opts)).toBeNull()
    expect(toParam('\\N', 'postgres', opts)).toBeNull()
    expect(toParam('', 'postgres', { ...opts, emptyIsNull: false })).toBe('')
    expect(toParam(true, 'postgres', opts)).toBe('true')
    expect(toParam(true, 'mysql', opts)).toBe('1')
    expect(toParam(1.5, 'mysql', opts)).toBe('1.5')
    expect(toParam({ a: [1] }, 'postgres', opts)).toBe('{"a":[1]}')
  })

  it('builds multi-row inserts', () => {
    expect(buildInsert('postgres', 's', 't', ['a', 'b'], [['1', null], ['2', 'x']])).toEqual({
      sql: 'INSERT INTO "s"."t" ("a", "b") OVERRIDING SYSTEM VALUE VALUES ($1, $2), ($3, $4)', params: ['1', null, '2', 'x'],
    })
    expect(buildInsert('mysql', 's', 't', ['a'], [['1'], ['2']]).sql).toBe('INSERT INTO `s`.`t` (`a`) VALUES (?), (?)')
  })
})

const pgUrl = process.env.QUENCE_PG_TEST_URL
const S = `qimport_${Math.random().toString(36).slice(2, 8)}`

describe.skipIf(!pgUrl)('table import against PostgreSQL', () => {
  let c: Client
  let columns: ExportColumn[]
  const session: TableImportSession = { execute: async (sql, params) => ({ rowCount: (await c.query(sql, params as unknown[])).rowCount }) }

  beforeAll(async () => {
    c = new Client({ connectionString: pgUrl })
    await c.connect()
    await c.query(`CREATE SCHEMA ${S}; CREATE TABLE ${S}.people (
      id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL, born date, score numeric(6,2), active boolean, tags text[], doc jsonb,
      name_len int GENERATED ALWAYS AS (length(name)) STORED)`)
    columns = parseExportColumns('postgres', (await c.query(EXPORT_COLUMNS_SQL.postgres, [S, 'people'])).rows)
  })

  afterAll(async () => {
    await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`)
    await c.end()
  })

  const job = (format: { kind: 'csv'; delimiter: string; header: boolean } | { kind: 'json' }, mapping: { source: string; target: string }[], deleteFirst = false) => ({
    dbType: 'postgres' as const, schema: S, table: 'people', format, mapping, columns, deleteFirst, batchRows: 2,
    values: { emptyIsNull: true, nullText: '' },
  })

  it('imports CSV rows with their types, NULLs and explicit identity ids, then continues the sequence', async () => {
    const csv = 'Id,Name,Born,Score,Active,Tags\n10,Ann,2001-02-03,1.5,true,"{a,b}"\n11,"Bob, Jr",,,f,{}\n12,Cy,1999-12-31,-2,,\n'
    await c.query('BEGIN')
    const res = await runTableImport(reader(csv, 7), session, job({ kind: 'csv', delimiter: ',', header: true }, autoMap(['Id', 'Name', 'Born', 'Score', 'Active', 'Tags'], columns)))
    await c.query('COMMIT')
    expect(res.rows).toBe(3)
    const rows = (await c.query(`SELECT id, name, born::text, score::text, active, tags, name_len FROM ${S}.people ORDER BY id`)).rows
    expect(rows).toEqual([
      { id: 10, name: 'Ann', born: '2001-02-03', score: '1.50', active: true, tags: ['a', 'b'], name_len: 3 },
      { id: 11, name: 'Bob, Jr', born: null, score: null, active: false, tags: [], name_len: 7 },
      { id: 12, name: 'Cy', born: '1999-12-31', score: '-2.00', active: null, tags: null, name_len: 2 },
    ])
    expect((await c.query(`INSERT INTO ${S}.people (name) VALUES ('Next') RETURNING id`)).rows[0].id).toBe(13)
  })

  it('imports JSON, replacing the rows when asked, and names the failing record while rolling back', async () => {
    const json = '[{"name": "J1", "doc": {"x": [1, 2]}, "active": true}, {"name": "J2", "doc": null}]'
    await c.query('BEGIN')
    await runTableImport(reader(json), session, job({ kind: 'json' }, [{ source: 'name', target: 'name' }, { source: 'doc', target: 'doc' }, { source: 'active', target: 'active' }], true))
    await c.query('COMMIT')
    expect((await c.query(`SELECT name, doc, active FROM ${S}.people ORDER BY name`)).rows).toEqual([
      { name: 'J1', doc: { x: [1, 2] }, active: true }, { name: 'J2', doc: null, active: null },
    ])

    const bad = '{"name": "ok1"}\n{"name": "ok2"}\n{"name": null}\n'
    await c.query('BEGIN')
    await expect(runTableImport(reader(bad), session, job({ kind: 'json' }, [{ source: 'name', target: 'name' }])))
      .rejects.toThrow(/Record 3: .*not-null/)
    await c.query('ROLLBACK')
    expect((await c.query(`SELECT count(*)::int AS n FROM ${S}.people`)).rows[0].n).toBe(2)
  })
})

const myUrl = process.env.QUENCE_MYSQL_TEST_URL
const M = `qimport_${Math.random().toString(36).slice(2, 8)}`

describe.skipIf(!myUrl)('table import against MySQL', () => {
  let c: mysql.Connection
  const session: TableImportSession = {
    execute: async (sql, params) => {
      const [res] = await c.query(sql, params)
      return { rowCount: Array.isArray(res) ? res.length : (res as mysql.ResultSetHeader).affectedRows }
    },
  }

  beforeAll(async () => {
    c = await mysql.createConnection({ uri: myUrl!, dateStrings: true })
    await c.query(`CREATE DATABASE ${M}`)
    await c.query(`CREATE TABLE ${M}.items (id int AUTO_INCREMENT PRIMARY KEY, name varchar(50) NOT NULL, price decimal(8,2), ok tinyint(1), doc json)`)
  })

  afterAll(async () => {
    await c.query(`DROP DATABASE IF EXISTS ${M}`)
    await c.end()
  })

  it('imports CSV and JSON rows', async () => {
    const columns = parseExportColumns('mysql', (await c.query(EXPORT_COLUMNS_SQL.mysql, [M, 'items']))[0] as Record<string, unknown>[])
    const base = { dbType: 'mysql' as const, schema: M, table: 'items', columns, deleteFirst: false, values: { emptyIsNull: true, nullText: '' } }
    await c.query('START TRANSACTION')
    await runTableImport(reader('name;price\nA;1.25\n"B;x";\n', 4), session, { ...base, format: { kind: 'csv', delimiter: ';', header: true }, mapping: [{ source: 'name', target: 'name' }, { source: 'price', target: 'price' }] })
    await runTableImport(reader('{"name":"C","ok":true,"doc":{"k":1}}'), session, { ...base, format: { kind: 'json' }, mapping: [{ source: 'name', target: 'name' }, { source: 'ok', target: 'ok' }, { source: 'doc', target: 'doc' }] })
    await c.query('COMMIT')
    const [rows] = await c.query(`SELECT name, price, ok, doc FROM ${M}.items ORDER BY id`)
    expect(rows).toEqual([
      { name: 'A', price: '1.25', ok: null, doc: null },
      { name: 'B;x', price: null, ok: null, doc: null },
      { name: 'C', price: null, ok: 1, doc: { k: 1 } },
    ])
  })
})
