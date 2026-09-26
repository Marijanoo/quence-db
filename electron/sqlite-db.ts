import Database from 'better-sqlite3'
import * as path from 'path'
import { app, safeStorage } from 'electron'

// ── Credential encryption ────────────────────────────────────────────────────
// Encrypted values are prefixed so legacy plaintext rows (written before this
// was added) remain readable as-is and get re-encrypted on next save.
const ENC_PREFIX = 'enc:v1:'

export function encryptIfPossible(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === '') return plain ?? null
  if (!safeStorage.isEncryptionAvailable()) return plain
  return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64')
}

export function decryptIfPossible(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined || stored === '') return stored ?? null
  if (!stored.startsWith(ENC_PREFIX)) return stored
  if (!safeStorage.isEncryptionAvailable()) return stored
  const buf = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64')
  return safeStorage.decryptString(buf)
}

let _db: Database.Database | null = null

function db(): Database.Database {
  if (_db) return _db
  const dbPath = path.join(app.getPath('userData'), 'quence-db.db')
  _db = new Database(dbPath)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  migrate(_db)
  return _db
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      db_type TEXT NOT NULL DEFAULT 'pg',
      host TEXT NOT NULL DEFAULT '',
      port INTEGER NOT NULL DEFAULT 5432,
      database TEXT NOT NULL DEFAULT '',
      username TEXT NOT NULL DEFAULT '',
      password TEXT NOT NULL DEFAULT '',
      ssl INTEGER NOT NULL DEFAULT 0,
      vpn_config_path TEXT,
      vpn_username TEXT,
      vpn_password TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS saved_queries (
      id TEXT PRIMARY KEY,
      connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
      database_name TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      sql TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  // Columns added later; existing databases get them without losing anything
  addColumn(db, 'connections', 'options', "TEXT NOT NULL DEFAULT '{}'")   // JSON: environment, color, safe run, SSH
  addColumn(db, 'connections', 'ssh_password', 'TEXT')
  addColumn(db, 'connections', 'ssh_passphrase', 'TEXT')
}

function addColumn(db: Database.Database, table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!columns.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

// ── Connections ───────────────────────────────────────────────────────────────

export function dbGetConnections(): any[] {
  return (db().prepare('SELECT * FROM connections ORDER BY name ASC').all() as any[]).map(toConnection)
}

export function dbGetConnection(id: string): any {
  const row = db().prepare('SELECT * FROM connections WHERE id = ?').get(id) as any
  return row ? toConnection(row) : undefined
}

export function dbCreateConnection(c: any): void {
  db().prepare(`
    INSERT INTO connections (id, name, db_type, host, port, database, username, password, ssl,
      vpn_config_path, vpn_username, vpn_password, options, ssh_password, ssh_passphrase, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    c.id, c.name, c.dbType ?? 'pg', c.host ?? '', c.port ?? 5432,
    c.database ?? '', c.username ?? '', encryptIfPossible(c.password) ?? '',
    c.ssl ? 1 : 0,
    c.vpnConfigPath ?? null, c.vpnUsername ?? null, encryptIfPossible(c.vpnPassword),
    JSON.stringify(c.options ?? {}), encryptIfPossible(c.sshPassword), encryptIfPossible(c.sshPassphrase),
    c.createdAt ?? Date.now(), c.updatedAt ?? Date.now()
  )
}

export function dbUpdateConnection(id: string, data: any): void {
  const sets: string[] = []
  const vals: any[] = []
  const fields: Record<string, string> = {
    name: 'name', dbType: 'db_type', host: 'host', port: 'port',
    database: 'database', username: 'username', password: 'password', ssl: 'ssl',
    vpnConfigPath: 'vpn_config_path', vpnUsername: 'vpn_username', vpnPassword: 'vpn_password',
    options: 'options', sshPassword: 'ssh_password', sshPassphrase: 'ssh_passphrase',
  }
  for (const [k, col] of Object.entries(fields)) {
    if (data[k] !== undefined) {
      sets.push(`${col} = ?`)
      let val = data[k]
      if (k === 'ssl') val = val ? 1 : 0
      else if (k === 'password' || k === 'vpnPassword' || k === 'sshPassword' || k === 'sshPassphrase') val = encryptIfPossible(val)
      else if (k === 'options') val = JSON.stringify(val ?? {})
      vals.push(val)
    }
  }
  if (!sets.length) return
  sets.push('updated_at = ?')
  vals.push(Date.now(), id)
  db().prepare(`UPDATE connections SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
}

export function dbDeleteConnection(id: string): void {
  db().prepare('DELETE FROM connections WHERE id = ?').run(id)
}

// ── Saved queries ─────────────────────────────────────────────────────────────

export function dbGetSavedQueries(connectionId?: string): any[] {
  const rows = (connectionId
    ? db().prepare('SELECT * FROM saved_queries WHERE connection_id = ? ORDER BY name ASC').all(connectionId)
    : db().prepare('SELECT * FROM saved_queries ORDER BY name ASC').all()) as any[]
  return rows.map(toSavedQuery)
}

export function dbCreateSavedQuery(q: any): void {
  db().prepare(`
    INSERT INTO saved_queries (id, connection_id, database_name, name, sql, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    q.id, q.connectionId ?? null, q.databaseName ?? '',
    q.name, q.sql ?? '', q.createdAt ?? Date.now(), q.updatedAt ?? Date.now()
  )
}

export function dbUpdateSavedQuery(id: string, data: any): void {
  const sets: string[] = []
  const vals: any[] = []
  if (data.name !== undefined)         { sets.push('name = ?');          vals.push(data.name) }
  if (data.sql !== undefined)          { sets.push('sql = ?');           vals.push(data.sql) }
  if (data.databaseName !== undefined) { sets.push('database_name = ?'); vals.push(data.databaseName) }
  if (!sets.length) return
  sets.push('updated_at = ?')
  vals.push(Date.now(), id)
  db().prepare(`UPDATE saved_queries SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
}

export function dbDeleteSavedQuery(id: string): void {
  db().prepare('DELETE FROM saved_queries WHERE id = ?').run(id)
}

// ── Mappers ───────────────────────────────────────────────────────────────────

function parseJson(text: unknown): Record<string, unknown> {
  try { const v = JSON.parse(String(text ?? '{}')); return v && typeof v === 'object' ? v : {} } catch { return {} }
}

function toConnection(r: any) {
  return {
    id: r.id, name: r.name, dbType: r.db_type,
    host: r.host, port: r.port, database: r.database,
    username: r.username, password: decryptIfPossible(r.password) ?? '', ssl: !!r.ssl,
    vpnConfigPath: r.vpn_config_path ?? undefined,
    vpnUsername: r.vpn_username ?? undefined,
    vpnPassword: decryptIfPossible(r.vpn_password) ?? undefined,
    options: parseJson(r.options),
    sshPassword: decryptIfPossible(r.ssh_password) ?? undefined,
    sshPassphrase: decryptIfPossible(r.ssh_passphrase) ?? undefined,
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  }
}

function toSavedQuery(r: any) {
  return {
    id: r.id, connectionId: r.connection_id, databaseName: r.database_name,
    name: r.name, sql: r.sql,
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  }
}
