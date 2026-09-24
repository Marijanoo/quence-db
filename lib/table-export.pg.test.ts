// Table export against PostgreSQL: a dump restores to identical rows. Opt-in: set QUENCE_PG_TEST_URL
// (see structure-sync.pg.test.ts).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { DEFAULT_CSV, runExport, type ExportFormat, type ExportIO } from './table-export'
import { fetchSchemaSnapshot, snapshotSearchPath, tableDisplayDdl } from './structure-sync'

const url = process.env.QUENCE_PG_TEST_URL
const S = `qexport_${Math.random().toString(36).slice(2, 8)}`

describe.skipIf(!url)('table export against PostgreSQL', () => {
  let c: Client

  beforeAll(async () => {
    c = new Client({ connectionString: url })
    await c.connect()
    await c.query(`
      CREATE SCHEMA ${S};
      SET search_path TO ${S};
      CREATE TYPE mood AS ENUM ('sad', 'happy');
      CREATE TABLE items (
        id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        seq serial,
        name text,
        price numeric(30, 10),
        big bigint,
        ok boolean,
        doc jsonb,
        raw bytea,
        tags text[],
        at timestamptz,
        feeling mood,
        total numeric GENERATED ALWAYS AS (price * 2) STORED
      );
      INSERT INTO items (name, price, big, ok, doc, raw, tags, at, feeling) VALUES
        ('plain', 1.5, 1, true, '{"a": [1, "x"]}', '\\x00ff10', '{a,b}', '2026-02-28 23:45:09.123456+13', 'happy'),
        (E'quote '' backslash \\\\ newline\\n tab\\t', 12345678901234567890.0123456789, 9223372036854775807, false, 'null', '', '{}', '1970-01-01 00:00:00+00', 'sad'),
        (NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
      RESET search_path;
    `)
  })

  afterAll(async () => {
    await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`)
    await c.end()
  })

  // Like the app: metadata on the connection, rows from a read-only snapshot on a second connection
  function io(out: { text: string }): ExportIO {
    return {
      query: async (sql, params) => (await c.query(sql, params)).rows,
      openSnapshot: async () => {
        const snap = new Client({ connectionString: url })
        await snap.connect()
        await snap.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        return {
          query: async sql => (await snap.query(sql)).rows,
          close: async () => { await snap.query('ROLLBACK').catch(() => {}); await snap.end() },
        }
      },
      createStatement: async () => {
        const snapshot = await fetchSchemaSnapshot(async (sql, params) => {
          await c.query(`SELECT set_config('search_path', $1, false)`, [snapshotSearchPath(S)])
          try { return (await c.query(sql, params)).rows } finally { await c.query('RESET search_path') }
        }, S)
        return tableDisplayDdl(snapshot.tables.find(t => t.name === 'items')!)
      },
      write: async text => { out.text += text },
    }
  }

  const rowsAsText = async () =>
    (await c.query(`SELECT to_jsonb(i)::text AS row FROM ${S}.items i ORDER BY id`)).rows.map(r => r.row as string)

  it('restores a structure-and-data dump to identical rows, and new rows get fresh ids', async () => {
    const before = await rowsAsText()
    const out = { text: '' }
    const format: ExportFormat = { kind: 'sql', structure: true, data: true, dropTable: true, rowsPerStatement: 2, transaction: true }
    const res = await runExport(io(out), { dbType: 'postgres', schema: S, table: 'items', format, batchSize: 2 })
    expect(res.rows).toBe(3)

    await c.query(out.text) // drops the table and recreates it from the dump
    await c.query('RESET search_path')
    expect(await rowsAsText()).toEqual(before)

    // The identity and serial counters continue after the restored ids
    const next = (await c.query(`INSERT INTO ${S}.items (name) VALUES ('after') RETURNING id, seq`)).rows[0]
    expect(next).toEqual({ id: 4, seq: 4 })
    await c.query(`DELETE FROM ${S}.items WHERE name = 'after'`)
  })

  it('exports CSV and JSON with exact values', async () => {
    const csv = { text: '' }
    await runExport(io(csv), { dbType: 'postgres', schema: S, table: 'items', format: { kind: 'csv', csv: DEFAULT_CSV }, columns: ['id', 'name', 'price'] })
    expect(csv.text.split('\r\n')[0]).toBe('id,name,price')
    expect(csv.text).toContain('2,"quote \' backslash \\ newline\n tab\t",12345678901234567890.0123456789\r\n')
    expect(csv.text.endsWith('3,,\r\n')).toBe(true)

    const json = { text: '' }
    await runExport(io(json), { dbType: 'postgres', schema: S, table: 'items', format: { kind: 'json', layout: 'array', pretty: true } })
    const rows = JSON.parse(json.text)
    expect(rows[0]).toMatchObject({ id: 1, price: 1.5, big: 1, ok: true, doc: { a: [1, 'x'] }, raw: '\\x00ff10', tags: '{a,b}', feeling: 'happy', total: 3 })
    // Too many digits for a double: kept as text
    expect(rows[1]).toMatchObject({ price: '12345678901234567890.0123456789', big: '9223372036854775807', ok: false, doc: null })
    expect(rows[2].name).toBeNull()
  })
})
