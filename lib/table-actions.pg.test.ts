// Table actions against a real PostgreSQL server. Opt-in: set QUENCE_PG_TEST_URL (see structure-sync.pg.test.ts).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import {
  ActionCancelled, TABLE_COLUMNS_SQL, TABLE_STATS_SQL, runInTransaction, tableActionStatements,
  type TableColumnInfo, type TxSession,
} from './table-actions'

const url = process.env.QUENCE_PG_TEST_URL
const S = `qtable_${Math.random().toString(36).slice(2, 8)}`

describe.skipIf(!url)('table actions against PostgreSQL', () => {
  let c: Client
  // Same shape as the app: one script wrapped in a transaction
  const run = (statements: string[]) => c.query(['BEGIN', ...statements, 'COMMIT'].join(';\n') + ';')
  const count = async (sql: string) => Number((await c.query(sql)).rows[0].n)

  beforeAll(async () => {
    c = new Client({ connectionString: url })
    await c.connect()
    await c.query(`
      CREATE SCHEMA ${S};
      CREATE TABLE ${S}.orders (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        ticket serial,
        qty integer NOT NULL CHECK (qty > 0),
        doubled integer GENERATED ALWAYS AS (qty * 2) STORED
      );
      CREATE INDEX orders_qty_idx ON ${S}.orders (qty);
      INSERT INTO ${S}.orders (qty) SELECT g FROM generate_series(1, 50) g;
      CREATE VIEW ${S}.big_orders AS SELECT * FROM ${S}.orders WHERE qty > 10;
    `)
  })

  afterAll(async () => {
    await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`)
    await c.end()
  })

  it('reads columns and stats', async () => {
    const cols = (await c.query(TABLE_COLUMNS_SQL.postgres, [S, 'orders'])).rows
    expect(cols.map(r => [r.name, r.generated, r.identity])).toEqual([['id', false, 'a'], ['ticket', false, ''], ['qty', false, ''], ['doubled', true, '']])
    const stats = (await c.query(TABLE_STATS_SQL.postgres, [S, 'orders'])).rows[0]
    expect(Number(stats.total_bytes)).toBeGreaterThan(0)
  })

  it('duplicates a table with its data, indexes and a working identity', async () => {
    const cols = (await c.query(TABLE_COLUMNS_SQL.postgres, [S, 'orders'])).rows as TableColumnInfo[]
    await run(tableActionStatements('postgres', S, 'orders', 'duplicate', { newName: 'orders_copy', withData: true }, cols))
    expect(await count(`SELECT count(*) AS n FROM ${S}.orders_copy`)).toBe(50)
    expect(await count(`SELECT count(*) AS n FROM pg_indexes WHERE schemaname = '${S}' AND tablename = 'orders_copy'`)).toBe(2)
    const inserted = await c.query(`INSERT INTO ${S}.orders_copy (qty) VALUES (7) RETURNING id, doubled`)
    expect(Number(inserted.rows[0].id)).toBe(51)
    expect(inserted.rows[0].doubled).toBe(14)
  })

  it('duplicates structure only', async () => {
    await run(tableActionStatements('postgres', S, 'orders', 'duplicate', { newName: 'orders_empty' }))
    expect(await count(`SELECT count(*) AS n FROM ${S}.orders_empty`)).toBe(0)
  })

  it('truncates with RESTART IDENTITY and empties with DELETE', async () => {
    await run(tableActionStatements('postgres', S, 'orders_copy', 'truncate', { restartIdentity: true }))
    const next = await c.query(`INSERT INTO ${S}.orders_copy (qty) VALUES (1) RETURNING id`)
    expect(Number(next.rows[0].id)).toBe(1)
    await run(tableActionStatements('postgres', S, 'orders_copy', 'empty'))
    expect(await count(`SELECT count(*) AS n FROM ${S}.orders_copy`)).toBe(0)
  })

  it('renames, and drops with CASCADE when a view depends on the table', async () => {
    await run(tableActionStatements('postgres', S, 'orders_empty', 'rename', { newName: 'orders_renamed' }))
    expect(await count(`SELECT count(*) AS n FROM pg_tables WHERE schemaname = '${S}' AND tablename = 'orders_renamed'`)).toBe(1)

    await expect(run(tableActionStatements('postgres', S, 'orders', 'drop'))).rejects.toThrow(/depend/)
    await c.query('ROLLBACK')
    await run(tableActionStatements('postgres', S, 'orders', 'drop', { cascade: true }))
    expect(await count(`SELECT count(*) AS n FROM pg_views WHERE schemaname = '${S}'`)).toBe(0)
  })

  it('cancels a DROP stuck behind a lock and an EMPTY that already ran, changing nothing', async () => {
    await c.query(`CREATE TABLE ${S}.victim (id int PRIMARY KEY); INSERT INTO ${S}.victim SELECT generate_series(1, 1000)`)
    // Mirrors the pg:session-* IPC handlers: a dedicated client in a transaction, cancelled from another connection
    const openSession = async (): Promise<TxSession> => {
      const s = new Client({ connectionString: url })
      await s.connect()
      await s.query('BEGIN')
      return {
        query: async sql => { await s.query(sql) },
        close: async commit => { try { await s.query(commit ? 'COMMIT' : 'ROLLBACK') } finally { await s.end() } },
        cancel: async () => { await c.query('SELECT pg_cancel_backend($1)', [(s as unknown as { processID: number }).processID]) },
      }
    }
    const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

    // Another session reads the table, so DROP waits for its lock
    const locker = new Client({ connectionString: url })
    await locker.connect()
    await locker.query(`BEGIN; LOCK TABLE ${S}.victim IN ACCESS SHARE MODE`)
    const drop = runInTransaction(openSession, tableActionStatements('postgres', S, 'victim', 'drop'))
    await wait(300)
    drop.cancel()
    await expect(drop.done).rejects.toBeInstanceOf(ActionCancelled)
    await locker.query('ROLLBACK')
    await locker.end()
    expect(await count(`SELECT count(*) AS n FROM ${S}.victim`)).toBe(1000)

    // The DELETE finishes, then a slow statement is cancelled: the delete must be rolled back too
    const empty = runInTransaction(openSession, [...tableActionStatements('postgres', S, 'victim', 'empty'), 'SELECT pg_sleep(10)'])
    await wait(300)
    empty.cancel()
    await expect(empty.done).rejects.toBeInstanceOf(ActionCancelled)
    expect(await count(`SELECT count(*) AS n FROM ${S}.victim`)).toBe(1000)
  })

  it('runs maintenance commands (VACUUM outside a transaction)', async () => {
    await run(tableActionStatements('postgres', S, 'orders_renamed', 'analyze'))
    await run(tableActionStatements('postgres', S, 'orders_renamed', 'reindex'))
    await c.query(tableActionStatements('postgres', S, 'orders_renamed', 'vacuum', { full: true })[0])
  })
})
