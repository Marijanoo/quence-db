import Database from 'better-sqlite3'
import * as path from 'path'
import { app } from 'electron'

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
      vpn_config_path, vpn_username, vpn_password, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    c.id, c.name, c.dbType ?? 'pg', c.host ?? '', c.port ?? 5432,
    c.database ?? '', c.username ?? '', c.password ?? '',
    c.ssl ? 1 : 0,
    c.vpnConfigPath ?? null, c.vpnUsername ?? null, c.vpnPassword ?? null,
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
  }
  for (const [k, col] of Object.entries(fields)) {
    if (data[k] !== undefined) {
      sets.push(`${col} = ?`)
      vals.push(k === 'ssl' ? (data[k] ? 1 : 0) : data[k])
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

function toConnection(r: any) {
  return {
    id: r.id, name: r.name, dbType: r.db_type,
    host: r.host, port: r.port, database: r.database,
    username: r.username, password: r.password, ssl: !!r.ssl,
    vpnConfigPath: r.vpn_config_path ?? undefined,
    vpnUsername: r.vpn_username ?? undefined,
    vpnPassword: r.vpn_password ?? undefined,
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
