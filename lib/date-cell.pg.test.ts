// Picked dates round-trip through PostgreSQL. Opt-in: set QUENCE_PG_TEST_URL (see structure-sync.pg.test.ts).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { dateColumnKind, formatCellDate, parseCellDate } from './date-cell'

const url = process.env.QUENCE_PG_TEST_URL
const S = `qdate_${Math.random().toString(36).slice(2, 8)}`

describe.skipIf(!url)('date cells against PostgreSQL', () => {
  let c: Client

  beforeAll(async () => {
    c = new Client({ connectionString: url })
    await c.connect()
    // A server time zone different from the client's, like a remote database
    await c.query(`SET TIME ZONE 'Pacific/Auckland'; CREATE SCHEMA ${S}; CREATE TABLE ${S}.t (d date, ts timestamp, tz timestamptz)`)
  })

  afterAll(async () => {
    await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`)
    await c.end()
  })

  it('gives date, timestamp and timestamptz columns a calendar from the types the grid reads', async () => {
    await c.query(`CREATE TABLE ${S}.typed (a date, b timestamp(3), c timestamp with time zone, d timestamptz(0), e time, f text)`)
    // The same query the table tab runs for its column types
    const { rows } = await c.query(`SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, [S, 'typed'])
    expect(rows.map(r => dateColumnKind(r.udt_name))).toEqual(['date', 'timestamp', 'timestamptz', 'timestamptz', null, null])
  })

  it('stores the picked day and moment exactly, and reads back as the same picked value', async () => {
    const picked = new Date(2026, 1, 28, 23, 45, 9) // late evening: a wrong zone would shift the day
    await c.query(`INSERT INTO ${S}.t VALUES ($1, $2, $3)`, [
      formatCellDate(picked, 'date'), formatCellDate(picked, 'timestamp'), formatCellDate(picked, 'timestamptz'),
    ])
    const row = (await c.query(`SELECT d, ts, tz, d::text AS d_text, ts::text AS ts_text FROM ${S}.t`)).rows[0]
    expect(row.d_text).toBe('2026-02-28')
    expect(row.ts_text).toBe('2026-02-28 23:45:09')
    expect((row.tz as Date).getTime()).toBe(picked.getTime())
    // What the grid gets back from the driver maps to the same picker value
    for (const [value, kind] of [[row.d, 'date'], [row.ts, 'timestamp'], [row.tz, 'timestamptz']] as const) {
      expect(formatCellDate(parseCellDate(value)!, kind)).toBe(formatCellDate(picked, kind))
    }
  })
})
