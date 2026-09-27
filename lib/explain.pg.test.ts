// Visual EXPLAIN against a real PostgreSQL server. Opt-in: set QUENCE_PG_TEST_URL.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { explainStatement, hottestNode, indexInfoFromRows, parsePgPlan, pgIndexInfoQuery, planRelations, suggestIndexes, type ExplainPlan } from './explain'

const url = process.env.QUENCE_PG_TEST_URL
const S = `qexplain_${Math.random().toString(36).slice(2, 8)}`

describe.skipIf(!url)('visual EXPLAIN on PostgreSQL', () => {
  let c: Client

  beforeAll(async () => {
    c = new Client({ connectionString: url })
    await c.connect()
    await c.query(`
      CREATE SCHEMA ${S};
      CREATE TABLE ${S}.customers (id int PRIMARY KEY, country text NOT NULL, "Email" text);
      INSERT INTO ${S}.customers SELECT g, (ARRAY['HR','DE','US','FR'])[1 + g % 4], 'c' || g || '@example.com' FROM generate_series(1, 5000) g;
      CREATE TABLE ${S}.orders (id int PRIMARY KEY, customer_id int NOT NULL, status text NOT NULL, total numeric NOT NULL, created_at timestamptz NOT NULL);
      INSERT INTO ${S}.orders SELECT g, 1 + g % 5000, (ARRAY['pending','shipped','delivered','cancelled'])[1 + g % 4], (g % 500) + 0.99,
        now() - (g || ' minutes')::interval FROM generate_series(1, 200000) g;
      CREATE INDEX ON ${S}.orders (customer_id);
      CREATE TABLE ${S}.tiny (id int PRIMARY KEY, name text);
      INSERT INTO ${S}.tiny SELECT g, 'n' || g FROM generate_series(1, 50) g;
      ANALYZE ${S}.customers; ANALYZE ${S}.orders; ANALYZE ${S}.tiny;
    `)
  }, 60_000)

  afterAll(async () => {
    await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`)
    await c.end()
  })

  const explain = async (sql: string, analyze = true): Promise<ExplainPlan> => {
    const res = await c.query(explainStatement('postgres', sql, analyze))
    const plan = parsePgPlan(res.rows[0]['QUERY PLAN'], sql)
    const q = pgIndexInfoQuery(planRelations(plan))
    const info = indexInfoFromRows((await c.query(q.sql, q.params)).rows)
    return { ...plan, ...suggestIndexes(plan, info) }
  }

  it('builds the tree with times and rows, and suggests an index for a filtered full scan', async () => {
    const plan = await explain(`SELECT * FROM ${S}.orders WHERE status = 'pending' AND created_at > now() - interval '3 days'`)
    expect(plan.analyzed).toBe(true)
    expect(plan.executionMs).toBeGreaterThan(0)
    const scan = findNode(plan, n => n.title.includes('Seq Scan'))!
    expect(scan.relation).toMatchObject({ schema: S, table: 'orders' })
    expect(scan.warnings.join(' ')).toMatch(/Read [\d,]+ rows to keep/)
    expect(plan.suggestions).toHaveLength(1)
    expect(plan.suggestions[0]).toMatchObject({ table: `${S}.orders`, columns: ['status', 'created_at'], priority: 'high' })
    expect(plan.suggestions[0].sql).toBe(`CREATE INDEX CONCURRENTLY orders_status_created_at_idx ON ${S}.orders (status, created_at);`)
    expect(hottestNode(plan)).not.toBeNull()

    // The suggestion works: after creating it, the planner uses it and nothing more is suggested
    await c.query(plan.suggestions[0].sql)
    await c.query(`ANALYZE ${S}.orders`)
    const after = await explain(`SELECT * FROM ${S}.orders WHERE status = 'pending' AND created_at > now() - interval '3 days'`)
    expect(findNode(after, n => n.subtitle.includes('orders_status_created_at_idx'))).toBeDefined()
    expect(after.suggestions).toHaveLength(0)
  })

  it('picks the right table in a join, quotes mixed-case columns and knows existing indexes', async () => {
    const plan = await explain(`SELECT o.id FROM ${S}.orders o JOIN ${S}.customers c ON c.id = o.customer_id WHERE c."Email" = 'c42@example.com' AND o.total > 400`)
    const tables = plan.suggestions.map(s => s.table)
    expect(tables).not.toContain(`${S}.tiny`)
    const cust = plan.suggestions.find(s => s.table === `${S}.customers`)
    // 5000 rows: big enough to suggest
    expect(cust?.sql).toBe(`CREATE INDEX CONCURRENTLY "customers_email_idx" ON ${S}.customers ("Email");`.replace('"customers_email_idx"', 'customers_email_idx'))
  })

  it('suggests an index in sort order for ORDER BY … LIMIT', async () => {
    const plan = await explain(`SELECT * FROM ${S}.orders ORDER BY total DESC LIMIT 10`)
    expect(plan.suggestions[0]?.columns).toEqual(['total DESC'])
    expect(plan.suggestions[0]?.sql).toContain('(total DESC)')
  })

  it('leaves small tables alone and says why', async () => {
    const plan = await explain(`SELECT * FROM ${S}.tiny WHERE name = 'n7'`)
    expect(plan.suggestions).toHaveLength(0)
    expect(plan.notes.join(' ')).toMatch(/small/)
  })

  it('explains without running (estimates only)', async () => {
    const plan = await explain(`SELECT count(*) FROM ${S}.customers WHERE country = 'HR'`, false)
    expect(plan.analyzed).toBe(false)
    expect(plan.root.totalMs).toBeNull()
    expect(plan.root.totalCost).toBeGreaterThan(0)
    expect(plan.suggestions[0]?.columns).toEqual(['country'])
  })
})

function findNode(plan: ExplainPlan, pred: (n: ExplainPlan['root']) => boolean) {
  const walk = (n: ExplainPlan['root']): ExplainPlan['root'] | undefined => pred(n) ? n : n.children.map(walk).find(Boolean)
  return walk(plan.root)
}
