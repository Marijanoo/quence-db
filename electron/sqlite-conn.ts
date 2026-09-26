import Database from 'better-sqlite3'
import * as fs from 'fs'
import { randomUUID } from 'crypto'

// SQLite databases the user opens (a connection is a file), with the same operations the app
// uses for PostgreSQL and MySQL: queries, introspection and transaction sessions. Not to be
// confused with sqlite-db.ts, the app's own settings store.
//
// better-sqlite3 is synchronous: a query runs to completion on the main process. Attached
// databases appear as extra "databases"; "main" is the file itself.

export interface SqliteQueryResult {
  rows: Record<string, unknown>[]
  fields: string[]
  rowCount: number
  ms: number
}

const open = new Map<string, { db: Database.Database; file: string }>()
const sessions = new Map<string, { db: Database.Database; timer: ReturnType<typeof setTimeout> }>()
const SESSION_IDLE_MS = 15 * 60 * 1000

function configure(db: Database.Database) {
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
}

export function sqliteConnect(id: string, file: string, create = false): void {
  sqliteDisconnect(id)
  if (!file) throw new Error('Choose a database file')
  if (!create && !fs.existsSync(file)) throw new Error(`File not found: ${file}`)
  const db = new Database(file, { fileMustExist: !create })
  configure(db)
  // Fails early on files that aren't SQLite databases
  db.prepare('SELECT count(*) FROM sqlite_master').get()
  open.set(id, { db, file })
}

export function sqliteDisconnect(id: string) {
  const c = open.get(id)
  open.delete(id)
  try { c?.db.close() } catch { /* already closed */ }
}

export function sqliteConnected(id: string) {
  return open.has(id)
}

export function sqliteCloseAll() {
  for (const id of [...open.keys()]) sqliteDisconnect(id)
  for (const [sid, s] of sessions) { clearTimeout(s.timer); try { s.db.close() } catch {} sessions.delete(sid) }
}

function dbOf(id: string) {
  const c = open.get(id)
  if (!c) throw new Error('Not connected')
  return c
}

// 64-bit integers: exact numbers when they fit, text when they don't; blobs as bytes
function plainRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'bigint' ? (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v.toString()) : v
  }
  return out
}

// Parameters: numbers that are really integers bind as integers; big integers given as text stay text
function bindable(params: unknown[] | undefined): unknown[] {
  return (params ?? []).map(p => typeof p === 'boolean' ? (p ? 1 : 0) : p === undefined ? null : p)
}

// The app builds PostgreSQL-style $1, $2 placeholders; SQLite reads $1 as a named parameter and
// better-sqlite3 won't bind those from a list, so they become @p1, @p2 bound by name. Strings,
// quoted names and comments are left alone.
export function numberedToNamed(sql: string): { sql: string; changed: boolean } {
  let out = ''
  let changed = false
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch
      let j = i + 1
      while (j < sql.length && !(sql[j] === close && sql[j + 1] !== close)) j += sql[j] === close ? 2 : 1
      out += sql.slice(i, j + 1); i = j + 1
      continue
    }
    if (ch === '-' && sql[i + 1] === '-') { const end = sql.indexOf('\n', i); const stop = end < 0 ? sql.length : end; out += sql.slice(i, stop); i = stop; continue }
    if (ch === '/' && sql[i + 1] === '*') { const end = sql.indexOf('*/', i + 2); const stop = end < 0 ? sql.length : end + 2; out += sql.slice(i, stop); i = stop; continue }
    const m = ch === '$' ? /^\$(\d+)/.exec(sql.slice(i, i + 12)) : null
    if (m && !/[\w$]/.test(sql[i - 1] ?? '')) { out += `@p${m[1]}`; i += m[0].length; changed = true; continue }
    out += ch
    i++
  }
  return { sql: out, changed }
}

export function runStatement(db: Database.Database, sql: string, params?: unknown[]): SqliteQueryResult {
  const started = Date.now()
  const values = bindable(params)
  const named = values.length ? numberedToNamed(sql) : { sql, changed: false }
  const stmt = db.prepare(named.sql)
  const args: unknown[] = named.changed ? [Object.fromEntries(values.map((v, k) => [`p${k + 1}`, v]))] : values
  if (stmt.reader) {
    stmt.safeIntegers(true)
    const rows = (stmt.all(...args) as Record<string, unknown>[]).map(plainRow)
    return { rows, fields: stmt.columns().map(c => c.name), rowCount: rows.length, ms: Date.now() - started }
  }
  const info = stmt.run(...args)
  return { rows: [], fields: [], rowCount: info.changes, ms: Date.now() - started }
}

export function sqliteQuery(id: string, sql: string, database?: string, params?: unknown[]): SqliteQueryResult {
  void database // attached databases are addressed by name in the SQL itself ("other".table)
  return runStatement(dbOf(id).db, sql, params)
}

export function sqliteDatabases(id: string): string[] {
  const rows = dbOf(id).db.prepare('PRAGMA database_list').all() as { name: string }[]
  return rows.map(r => r.name).filter(n => n !== 'temp')
}

const q = (name: string) => '"' + name.replace(/"/g, '""') + '"'

export function sqliteIntrospect(id: string, database: string) {
  const db = dbOf(id).db
  const objects = db.prepare(`SELECT name, type FROM ${q(database)}.sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`).all() as { name: string; type: string }[]
  const tables = objects.map(o => ({ table_schema: database, table_name: o.name, table_type: o.type === 'view' ? 'VIEW' : 'BASE TABLE' }))
  const columns: { table_schema: string; table_name: string; column_name: string; data_type: string }[] = []
  for (const o of objects) {
    const cols = db.prepare(`PRAGMA ${q(database)}.table_xinfo(${q(o.name)})`).all() as { name: string; type: string; hidden: number }[]
    for (const c of cols) if (c.hidden !== 1) columns.push({ table_schema: database, table_name: o.name, column_name: c.name, data_type: c.type || 'ANY' })
  }
  return { tables, columns, functions: [], enums: [], types: [] }
}

// ── Sessions: a second handle on the file, for transactions (Safe Run, imports, exports) ──

function touch(sessionId: string) {
  const s = sessions.get(sessionId)
  if (!s) throw new Error('Transaction session not found (it may have timed out and been rolled back)')
  clearTimeout(s.timer)
  s.timer = setTimeout(() => { void sqliteSessionClose(sessionId, false) }, SESSION_IDLE_MS)
  return s
}

export function sqliteSessionOpen(id: string, opts: { autocommit?: boolean; readOnly?: boolean } = {}): string {
  const { file } = dbOf(id)
  const db = new Database(file, { fileMustExist: true, readonly: !!opts.readOnly })
  configure(db)
  if (!opts.autocommit) db.exec('BEGIN')
  const sessionId = randomUUID()
  sessions.set(sessionId, { db, timer: setTimeout(() => {}, 0) })
  touch(sessionId)
  return sessionId
}

export function sqliteSessionQuery(sessionId: string, sql: string, params?: unknown[]): SqliteQueryResult {
  return runStatement(touch(sessionId).db, sql, params)
}

export function sqliteSessionClose(sessionId: string, commit: boolean) {
  const s = sessions.get(sessionId)
  if (!s) throw new Error('Transaction session not found (it may have timed out and been rolled back)')
  sessions.delete(sessionId)
  clearTimeout(s.timer)
  try {
    if (s.db.inTransaction) s.db.exec(commit ? 'COMMIT' : 'ROLLBACK')
  } finally {
    s.db.close()
  }
}
