// Safe Run's SQL against PostgreSQL: wrapped writes return a capped preview and the exact total,
// run to completion, and roll back cleanly. Opt-in: set QUENCE_PG_TEST_URL.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { classifyStatement, previewWrap, PREVIEW_ROWS, PREVIEW_TOTAL_COLUMN } from './safe-run'

const url = process.env.QUENCE_PG_TEST_URL
const S = `qsafe_${Math.random().toString(36).slice(2, 8)}`

describe.skipIf(!url)('Safe Run against PostgreSQL', () => {
  let c: Client

  // Runs one statement the way Safe Run does, inside the caller's transaction
  const run = async (sql: string) => {
    const wrapped = previewWrap(sql, classifyStatement(sql))
    const res = await c.query(wrapped)
    const total = wrapped === sql ? res.rowCount : (res.rows.length ? Number(res.rows[0][PREVIEW_TOTAL_COLUMN]) : 0)
    return { wrapped: wrapped !== sql, total, preview: res.rows.map(({ [PREVIEW_TOTAL_COLUMN]: _t, ...r }) => r) }
  }
  const count = async (where = 'true') => (await c.query(`SELECT count(*)::int AS n FROM ${S}."Big Items" WHERE ${where}`)).rows[0].n

  beforeAll(async () => {
    c = new Client({ connectionString: url })
    await c.connect()
    await c.query(`CREATE SCHEMA ${S};
      CREATE TABLE ${S}."Big Items" (id int PRIMARY KEY, price int NOT NULL DEFAULT 0, tag text);
      CREATE TABLE ${S}.tags (tag text PRIMARY KEY, bonus int);
      INSERT INTO ${S}."Big Items" SELECT g, 0, CASE WHEN g % 2 = 0 THEN 'even' ELSE 'odd' END FROM generate_series(1, 5000) g;
      INSERT INTO ${S}.tags VALUES ('even', 2), ('odd', 1);`)
  })

  afterAll(async () => {
    await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`)
    await c.end()
  })

  it('previews a large UPDATE without returning every row, and rolls it back completely', async () => {
    await c.query('BEGIN')
    const res = await run(`UPDATE ${S}."Big Items" SET price = price + 1`)
    expect(res).toMatchObject({ wrapped: true, total: 5000 })
    expect(res.preview).toHaveLength(PREVIEW_ROWS)
    expect(res.preview[0]).toMatchObject({ price: 1 })
    expect(await count('price = 1')).toBe(5000) // the whole statement ran, not just the preview
    await c.query('ROLLBACK')
    expect(await count('price = 0')).toBe(5000)
  })

  it('handles UPDATE … FROM, DELETE … USING and INSERT … ON CONFLICT, and commits', async () => {
    await c.query('BEGIN')
    expect((await run(`UPDATE ${S}."Big Items" b SET price = t.bonus FROM ${S}.tags t WHERE b.tag = t.tag AND b.id <= 10`)).total).toBe(10)
    expect((await run(`DELETE FROM ${S}."Big Items" b USING ${S}.tags t WHERE b.tag = t.tag AND t.bonus = 1 AND b.id > 4990`)).total).toBe(5)
    const upsert = await run(`INSERT INTO ${S}."Big Items" (id, price) VALUES (1, 99), (6001, 7) ON CONFLICT (id) DO UPDATE SET price = excluded.price`)
    expect(upsert.total).toBe(2)
    await c.query('COMMIT')
    expect((await c.query(`SELECT price FROM ${S}."Big Items" WHERE id IN (1, 2, 6001) ORDER BY id`)).rows.map(r => r.price)).toEqual([99, 2, 7])
    expect(await count()).toBe(4996)
  })

  it('runs statements that already RETURN or start with WITH as written', async () => {
    await c.query('BEGIN')
    const returning = await run(`DELETE FROM ${S}."Big Items" WHERE id = 3 RETURNING id`)
    expect(returning).toMatchObject({ wrapped: false, total: 1, preview: [{ id: 3 }] })
    const cte = await run(`WITH d AS (DELETE FROM ${S}."Big Items" WHERE id = 5 RETURNING *) SELECT count(*) AS n FROM d`)
    expect(cte.wrapped).toBe(false)
    await c.query('ROLLBACK')
    expect(await count('id IN (3, 5)')).toBe(2)
  })

  it('rolls back DDL too (PostgreSQL DDL is transactional)', async () => {
    await c.query('BEGIN')
    await run(`DROP TABLE ${S}.tags`)
    await c.query('ROLLBACK')
    expect((await c.query(`SELECT to_regclass('${S}.tags') AS t`)).rows[0].t).not.toBeNull()
  })

  it('a plain EXPLAIN of a write shows the plan without changing anything', async () => {
    const before = await count()
    await c.query(`EXPLAIN DELETE FROM ${S}."Big Items"`)
    expect(await count()).toBe(before)
  })
})
