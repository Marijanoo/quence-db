// Table-grid saves against a real PostgreSQL server. Opt-in: set QUENCE_PG_TEST_URL (see lib/structure-sync.pg.test.ts).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { buildRowSavePlans } from './database-view'

const url = process.env.QUENCE_PG_TEST_URL
const S = `qgrid_${Math.random().toString(36).slice(2, 8)}`

describe.skipIf(!url)('new-row inserts against PostgreSQL', () => {
  let c: Client

  beforeAll(async () => {
    c = new Client({ connectionString: url })
    await c.connect()
    await c.query(`
      CREATE SCHEMA ${S};
      CREATE TABLE ${S}.people (
        id serial PRIMARY KEY,
        name text NOT NULL,
        email text NOT NULL,
        status text NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL DEFAULT now(),
        note text
      );
    `)
  })

  afterAll(async () => {
    await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`)
    await c.end()
  })

  it('fills every untyped column with its default', async () => {
    const [plan] = buildRowSavePlans('postgres', S, 'people', ['id'], [], [
      { rowIndex: 0, col: 'name', value: 'Ann' },
      { rowIndex: 0, col: 'email', value: 'ann@example.com' },
    ])
    const res = await c.query(plan.update.sql, plan.update.params)
    expect(res.rows).toHaveLength(1)
    const row = res.rows[0]
    expect(row).toMatchObject({ id: 1, name: 'Ann', email: 'ann@example.com', status: 'active', note: null })
    expect(row.created_at).toBeInstanceOf(Date)
  })

  it('reports the database error and inserts nothing when a required column is missing', async () => {
    const [plan] = buildRowSavePlans('postgres', S, 'people', ['id'], [], [{ rowIndex: 0, col: 'name', value: 'Bob' }])
    await expect(c.query(plan.update.sql, plan.update.params)).rejects.toThrow(/null value in column "email"/)
    expect(Number((await c.query(`SELECT count(*) AS n FROM ${S}.people`)).rows[0].n)).toBe(1)
  })
})
