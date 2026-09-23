import { describe, it, expect } from 'vitest'
import {
  ActionCancelled, formatBytes, runInTransaction, tableActionAvailable, tableActionStatements,
  type TableColumnInfo, type TxSession,
} from './table-actions'

// A session whose queries wait until released, to simulate a long statement or a lock wait
function fakeSession() {
  const log: string[] = []
  let release: ((err?: Error) => void) | null = null
  const session: TxSession = {
    query: sql => new Promise<void>((resolve, reject) => {
      log.push(sql)
      release = err => (err ? reject(err) : resolve())
    }),
    close: async commit => { log.push(commit ? 'COMMIT' : 'ROLLBACK') },
    cancel: async () => { log.push('CANCEL'); release?.(new Error('canceling statement due to user request')) },
  }
  const tick = () => new Promise(r => setTimeout(r, 0))
  return { session, log, finishQuery: async () => { await tick(); release?.() ; await tick() }, tick }
}

describe('runInTransaction', () => {
  it('commits after every statement succeeds', async () => {
    const f = fakeSession()
    const run = runInTransaction(async () => f.session, ['A', 'B'])
    await f.finishQuery()
    await f.finishQuery()
    await run.done
    expect(f.log).toEqual(['A', 'B', 'COMMIT'])
  })

  it('interrupts a running statement and rolls back when cancelled', async () => {
    const f = fakeSession()
    const run = runInTransaction(async () => f.session, ['DELETE FROM big', 'NEVER'])
    await f.tick()
    run.cancel()
    await expect(run.done).rejects.toBeInstanceOf(ActionCancelled)
    expect(f.log).toEqual(['DELETE FROM big', 'CANCEL', 'ROLLBACK'])
  })

  it('rolls back without running anything when cancelled before the session opened', async () => {
    const f = fakeSession()
    let openSession!: (s: TxSession) => void
    const run = runInTransaction(() => new Promise<TxSession>(r => { openSession = r }), ['A'])
    run.cancel()
    openSession(f.session)
    await expect(run.done).rejects.toBeInstanceOf(ActionCancelled)
    expect(f.log).toEqual(['ROLLBACK'])
  })

  it('rolls back and rethrows when a statement fails', async () => {
    const f = fakeSession()
    f.session.query = async sql => { f.log.push(sql); throw new Error('boom') }
    const run = runInTransaction(async () => f.session, ['A', 'B'])
    await expect(run.done).rejects.toThrow('boom')
    expect(f.log).toEqual(['A', 'ROLLBACK'])
  })

  it('ignores cancel once committing', async () => {
    const f = fakeSession()
    let committing = false
    const run = runInTransaction(async () => f.session, ['A'], () => { committing = true; run.cancel() })
    await f.finishQuery()
    await run.done
    expect(committing).toBe(true)
    expect(f.log).toEqual(['A', 'COMMIT'])
  })
})

const cols: TableColumnInfo[] = [
  { name: 'id', generated: false, identity: 'a' },
  { name: 'qty', generated: false, identity: '' },
  { name: 'doubled', generated: true, identity: '' },
]

describe('tableActionStatements (PostgreSQL)', () => {
  const pg = (kind: Parameters<typeof tableActionStatements>[3], opts = {}) => tableActionStatements('postgres', 'app', 'or"ders', kind, opts, cols)

  it('renames, empties, truncates and drops with quoted identifiers and options', () => {
    expect(pg('rename', { newName: 'orders_old' })).toEqual(['ALTER TABLE "app"."or""ders" RENAME TO "orders_old"'])
    expect(pg('empty')).toEqual(['DELETE FROM "app"."or""ders"'])
    expect(pg('truncate')).toEqual(['TRUNCATE TABLE "app"."or""ders"'])
    expect(pg('truncate', { restartIdentity: true, cascade: true })).toEqual(['TRUNCATE TABLE "app"."or""ders" RESTART IDENTITY CASCADE'])
    expect(pg('drop', { cascade: true })).toEqual(['DROP TABLE "app"."or""ders" CASCADE'])
  })

  it('duplicates structure, and data without generated columns while overriding identities', () => {
    expect(pg('duplicate', { newName: 'copy' })).toEqual(['CREATE TABLE "app"."copy" (LIKE "app"."or""ders" INCLUDING ALL)'])
    expect(pg('duplicate', { newName: 'copy', withData: true })).toEqual([
      'CREATE TABLE "app"."copy" (LIKE "app"."or""ders" INCLUDING ALL)',
      'INSERT INTO "app"."copy" ("id", "qty") OVERRIDING SYSTEM VALUE SELECT "id", "qty" FROM "app"."or""ders"',
      `SELECT setval(pg_get_serial_sequence('"app"."copy"', 'id'), max("id")) FROM "app"."copy" HAVING max("id") IS NOT NULL`,
    ])
  })

  it('requires a name for rename and duplicate', () => {
    expect(() => pg('rename', { newName: '  ' })).toThrow(/Enter a table name/)
  })

  it('runs maintenance commands', () => {
    expect(pg('vacuum', { full: true })).toEqual(['VACUUM (FULL, ANALYZE) "app"."or""ders"'])
    expect(pg('reindex')).toEqual(['REINDEX TABLE "app"."or""ders"'])
    expect(pg('analyze')).toEqual(['ANALYZE "app"."or""ders"'])
  })
})

describe('tableActionStatements (MySQL)', () => {
  const my = (kind: Parameters<typeof tableActionStatements>[3], opts = {}) => tableActionStatements('mysql', 'shop', 'orders', kind, opts, cols)

  it('uses MySQL syntax and ignores PostgreSQL-only options', () => {
    expect(my('rename', { newName: 'o2' })).toEqual(['RENAME TABLE `shop`.`orders` TO `shop`.`o2`'])
    expect(my('duplicate', { newName: 'o2' })).toEqual(['CREATE TABLE `shop`.`o2` LIKE `shop`.`orders`'])
    expect(my('truncate', { cascade: true, restartIdentity: true })).toEqual(['TRUNCATE TABLE `shop`.`orders`'])
    expect(my('drop', { cascade: true })).toEqual(['DROP TABLE `shop`.`orders`'])
    expect(my('optimize')).toEqual(['OPTIMIZE TABLE `shop`.`orders`'])
    expect(tableActionAvailable('mysql', 'vacuum')).toBe(false)
    expect(tableActionAvailable('postgres', 'optimize')).toBe(false)
  })
})

describe('formatBytes', () => {
  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(8192)).toBe('8.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})
