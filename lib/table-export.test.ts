import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CSV, csvHeader, csvLines, exportFileName, exportSelectSql, insertStatements, jsonValue, parseExportColumns,
  resetSequenceStatements, runExport, sqlValue, type ExportColumn, type ExportIO, type ExportJob,
} from './table-export'

const col = (name: string, kind: ExportColumn['kind'], extra: Partial<ExportColumn> = {}): ExportColumn =>
  ({ name, type: kind, kind, generated: false, identity: '', serial: false, ...extra })

describe('parseExportColumns', () => {
  it('classifies PostgreSQL and MySQL column types', () => {
    expect(parseExportColumns('postgres', [
      { name: 'id', type: 'integer', category: 'N', typname: 'int4', generated: false, identity: 'a', serial: false },
      { name: 'doc', type: 'jsonb', category: 'U', typname: 'jsonb', generated: false, identity: '', serial: false },
      { name: 'ok', type: 'boolean', category: 'B', typname: 'bool', generated: false, identity: '', serial: false },
      { name: 'raw', type: 'bytea', category: 'U', typname: 'bytea', generated: true, identity: '', serial: false },
    ]).map(c => [c.name, c.kind, c.identity, c.generated])).toEqual([
      ['id', 'number', 'a', false], ['doc', 'json', '', false], ['ok', 'boolean', '', false], ['raw', 'binary', '', true],
    ])
    expect(parseExportColumns('mysql', [
      { name: 'id', type: 'int unsigned', typname: 'int', generated: 0, identity: '', serial: 1 },
      { name: 'pic', type: 'blob', typname: 'blob', generated: 0, identity: '', serial: 0 },
      { name: 'meta', type: 'json', typname: 'json', generated: 0, identity: '', serial: 0 },
    ]).map(c => [c.kind, c.serial])).toEqual([['number', true], ['binary', false], ['json', false]])
  })
})

describe('SQL output', () => {
  it('writes each value as a literal of its kind', () => {
    expect(sqlValue('postgres', col('n', 'number'), '12.50')).toBe('12.50')
    expect(sqlValue('postgres', col('n', 'number'), 'NaN')).toBe("'NaN'")
    expect(sqlValue('postgres', col('b', 'boolean'), 'true')).toBe('TRUE')
    expect(sqlValue('postgres', col('t', 'text'), "it's")).toBe("'it''s'")
    expect(sqlValue('postgres', col('t', 'text'), 'a\\b')).toBe("'a\\b'")
    expect(sqlValue('mysql', col('t', 'text'), "a\\b'c")).toBe("'a\\\\b''c'")
    expect(sqlValue('postgres', col('r', 'binary'), '\\x00ff')).toBe("'\\x00ff'")
    expect(sqlValue('mysql', col('r', 'binary'), '00FF')).toBe("X'00FF'")
    expect(sqlValue('postgres', col('t', 'text'), null)).toBe('NULL')
  })

  it('batches rows into INSERTs, skipping generated columns', () => {
    const cols = [col('id', 'number', { identity: 'a' }), col('name', 'text'), col('total', 'number', { generated: true })]
    const rows = [{ id: '1', name: 'a', total: '5' }, { id: '2', name: null, total: '6' }, { id: '3', name: 'c', total: '7' }]
    expect(insertStatements('postgres', 'items', cols, rows, 2)).toEqual([
      `INSERT INTO "items" ("id", "name") OVERRIDING SYSTEM VALUE VALUES\n  (1, 'a'),\n  (2, NULL);`,
      `INSERT INTO "items" ("id", "name") OVERRIDING SYSTEM VALUE VALUES\n  (3, 'c');`,
    ])
    expect(insertStatements('mysql', 'items', [col('id', 'number')], [{ id: '1' }], 1)).toEqual(['INSERT INTO `items` (`id`) VALUES (1);'])
  })

  it('resets PostgreSQL sequences past the inserted ids', () => {
    expect(resetSequenceStatements('postgres', 'items', [col('id', 'number', { serial: true }), col('name', 'text')])).toEqual([
      `SELECT setval(pg_get_serial_sequence('"items"', 'id'), COALESCE(max("id"), 1), max("id") IS NOT NULL) FROM "items";`,
    ])
    expect(resetSequenceStatements('mysql', 'items', [col('id', 'number', { serial: true })])).toEqual([])
  })

  it('selects every column as text in primary key order', () => {
    expect(exportSelectSql('postgres', 's', 't', [col('id', 'number'), col('raw', 'binary')], ['id']))
      .toBe('SELECT "id"::text AS "id", "raw"::text AS "raw" FROM "s"."t" ORDER BY "id"')
    expect(exportSelectSql('mysql', 'db', 't', [col('id', 'number'), col('raw', 'binary')], []))
      .toBe('SELECT CAST(`id` AS CHAR) AS `id`, HEX(`raw`) AS `raw` FROM `db`.`t`')
  })
})

describe('CSV and JSON output', () => {
  it('quotes only what needs it and keeps NULL apart from text', () => {
    const cols = [col('a', 'text'), col('b', 'text')]
    expect(csvHeader(cols, DEFAULT_CSV)).toBe('a,b\r\n')
    expect(csvLines(cols, [{ a: 'x,y', b: 'say "hi"' }, { a: 'line1\nline2', b: null }, { a: ' pad', b: '' }], DEFAULT_CSV))
      .toBe('"x,y","say ""hi"""\r\n"line1\nline2",\r\n" pad",\r\n')
    const opts = { ...DEFAULT_CSV, delimiter: ';', nullAs: 'NULL', quoteAll: true, bom: true, header: false }
    expect(csvHeader(cols, opts)).toBe('﻿')
    expect(csvLines(cols, [{ a: '1', b: null }], opts)).toBe('"1";NULL\r\n')
  })

  it('keeps numbers exact, parses JSON columns', () => {
    expect(jsonValue(col('n', 'number'), '42')).toBe(42)
    expect(jsonValue(col('n', 'number'), '0.25')).toBe(0.25)
    expect(jsonValue(col('n', 'number'), '9007199254740993')).toBe('9007199254740993')
    expect(jsonValue(col('n', 'number'), '123456789.123456789')).toBe('123456789.123456789')
    expect(jsonValue(col('b', 'boolean'), 'false')).toBe(false)
    expect(jsonValue(col('j', 'json'), '{"a":[1,2]}')).toEqual({ a: [1, 2] })
    expect(jsonValue(col('t', 'text'), null)).toBeNull()
  })

  it('names files after the table and format', () => {
    expect(exportFileName('a/b', { kind: 'sql', structure: true, data: true, dropTable: false, rowsPerStatement: 100, transaction: true })).toBe('a_b.sql')
    expect(exportFileName('t', { kind: 'csv', csv: { ...DEFAULT_CSV, delimiter: '\t' } })).toBe('t.tsv')
    expect(exportFileName('t', { kind: 'json', layout: 'lines', pretty: false })).toBe('t.jsonl')
  })
})

// A fake database: two columns, `total` rows served in FETCH batches
function fakeIO(total: number) {
  let written = ''
  const fetched: string[] = []
  let closed = false
  const rows = Array.from({ length: total }, (_, i) => ({ id: String(i + 1), name: i === 1 ? null : `n${i + 1}` }))
  let pos = 0
  const io: ExportIO = {
    query: async sql => sql.includes('indisprimary')
      ? [{ name: 'id' }]
      : [
        { name: 'id', type: 'integer', category: 'N', typname: 'int4', generated: false, identity: '', serial: true },
        { name: 'name', type: 'text', category: 'S', typname: 'text', generated: false, identity: '', serial: false },
      ],
    openSnapshot: async () => ({
      query: async sql => {
        fetched.push(sql)
        const m = /^FETCH (\d+)/.exec(sql)
        if (!m) return []
        const batch = rows.slice(pos, pos + Number(m[1]))
        pos += batch.length
        return batch
      },
      close: async () => { closed = true },
    }),
    createStatement: async () => 'CREATE TABLE "people" (\n  "id" serial PRIMARY KEY,\n  "name" text\n)',
    write: async text => { written += text },
  }
  return { io, get written() { return written }, fetched, get closed() { return closed } }
}

const job = (format: ExportJob['format'], extra: Partial<ExportJob> = {}): ExportJob =>
  ({ dbType: 'postgres', schema: 'app', table: 'people', format, batchSize: 2, ...extra })

describe('runExport', () => {
  it('dumps structure and data through a cursor, in batches', async () => {
    const fake = fakeIO(3)
    const progress: number[] = []
    const res = await runExport(fake.io, job({ kind: 'sql', structure: true, data: true, dropTable: true, rowsPerStatement: 100, transaction: true }),
      { onProgress: n => progress.push(n), now: new Date('2026-09-24T10:00:00Z') })
    expect(res.rows).toBe(3)
    expect(progress).toEqual([2, 3])
    expect(fake.closed).toBe(true)
    expect(fake.fetched[0]).toBe('DECLARE quence_export NO SCROLL CURSOR FOR SELECT "id"::text AS "id", "name"::text AS "name" FROM "app"."people" ORDER BY "id"')
    expect(fake.written).toBe([
      '-- QuenceDB dump of "app"."people"',
      '-- Structure and data, 2026-09-24T10:00:00.000Z',
      '',
      'SET search_path TO "app", public;',
      '',
      'DROP TABLE IF EXISTS "people";',
      'CREATE TABLE "people" (\n  "id" serial PRIMARY KEY,\n  "name" text\n);',
      '',
      'BEGIN;',
      `INSERT INTO "people" ("id", "name") VALUES\n  (1, 'n1'),\n  (2, NULL);`,
      `INSERT INTO "people" ("id", "name") VALUES\n  (3, 'n3');`,
      '',
      `SELECT setval(pg_get_serial_sequence('"people"', 'id'), COALESCE(max("id"), 1), max("id") IS NOT NULL) FROM "people";`,
      '',
      'COMMIT;',
      '',
    ].join('\n'))
  })

  it('writes structure only without touching the rows', async () => {
    const fake = fakeIO(3)
    await runExport(fake.io, job({ kind: 'sql', structure: true, data: false, dropTable: false, rowsPerStatement: 100, transaction: true }))
    expect(fake.fetched).toEqual([])
    expect(fake.written).not.toContain('INSERT')
    expect(fake.written).not.toContain('BEGIN')
  })

  it('writes a JSON array and a chosen subset of columns as CSV', async () => {
    const json = fakeIO(3)
    await runExport(json.io, job({ kind: 'json', layout: 'array', pretty: false }))
    expect(JSON.parse(json.written)).toEqual([{ id: 1, name: 'n1' }, { id: 2, name: null }, { id: 3, name: 'n3' }])

    const empty = fakeIO(0)
    await runExport(empty.io, job({ kind: 'json', layout: 'array', pretty: true }))
    expect(JSON.parse(empty.written)).toEqual([])

    const csv = fakeIO(2)
    await runExport(csv.io, job({ kind: 'csv', csv: DEFAULT_CSV }, { columns: ['name'] }))
    expect(csv.written).toBe('name\r\nn1\r\n\r\n')
  })

  it('stops when cancelled and still closes the snapshot', async () => {
    const fake = fakeIO(10)
    let calls = 0
    await expect(runExport(fake.io, job({ kind: 'csv', csv: DEFAULT_CSV }), {
      onProgress: () => { calls++ },
      isCancelled: () => calls >= 1,
    })).rejects.toThrow(/cancelled/)
    expect(fake.closed).toBe(true)
  })
})
