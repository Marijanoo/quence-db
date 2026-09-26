// Read-only MCP tools over the app's live database connections. Claude (or any MCP client) can
// list connections, databases and tables, describe tables and run read-only queries.
//
// Read-only is enforced by the database, not by inspecting the SQL:
//   PostgreSQL: a READ ONLY transaction, sent with the extended protocol (one statement only, so
//               "SELECT 1; COMMIT; DROP …" is rejected by the server), then rolled back
//   MySQL:      START TRANSACTION READ ONLY on a pool without multi-statements, then rolled back.
//               DDL commits implicitly even there, so only SELECT/SHOW/DESCRIBE/EXPLAIN/WITH start a query
//   MongoDB:    only find/aggregate/count through the driver, never the shell; pipelines may not
//               write ($out, $merge) or run server-side JavaScript ($where, $function, $accumulator)
// On top of that, a few server-administration functions are refused. For a hard guarantee,
// connect with a database user that only has read privileges.

import type { Pool as PgPool } from 'pg'
import type * as mysql from 'mysql2/promise'
import { BSON, type MongoClient } from 'mongodb'

const { EJSON } = BSON

export type McpDbType = 'pg' | 'mysql' | 'mongodb'

export interface McpConnectionInfo {
  id: string
  name: string
  dbType: McpDbType
  database: string       // the connection's default database
  connected: boolean
}

// The row-data tools that can be turned off globally or per connection (see mcp-settings.ts). Kept
// as a plain string here so this module doesn't need to import the settings module's type.
export type DataToolName = 'run_query' | 'mongo_find' | 'mongo_aggregate' | 'edit_cells' | 'insert_rows' | 'save_table_changes' | 'delete_rows' | 'execute'

export interface McpBackend {
  connections(): McpConnectionInfo[]               // only the ones shared with MCP clients
  pg(id: string, database?: string): PgPool | undefined
  mysql(id: string): mysql.Pool | undefined
  mongo(id: string): MongoClient | undefined
  dataToolAllowed(tool: DataToolName, connectionId: string): boolean
}

export const LIMITS = {
  defaultRows: 100,
  maxRows: 1000,
  maxCellChars: 2000,
  maxOutputChars: 200_000,
  statementTimeoutMs: 30_000,
}

export class McpToolError extends Error {}

// ── Connections ───────────────────────────────────────────────────────────────

export function findConnection(backend: McpBackend, ref: string, opts: { requireConnected?: boolean } = {}): McpConnectionInfo {
  const all = backend.connections()
  const match = all.find(c => c.id === ref) ?? all.filter(c => c.name.toLowerCase() === ref.toLowerCase())[0]
  if (!match) {
    throw new McpToolError(`No shared connection named "${ref}". Available: ${all.map(c => c.name).join(', ') || 'none (share connections in QuenceDB → MCP)'}`)
  }
  if (opts.requireConnected !== false && !match.connected) throw new McpToolError(`Connection "${match.name}" is not connected. Connect it first (the connect tool, or in QuenceDB).`)
  return match
}

// Throws if the tool is disabled for this connection, globally or by a per-connection override
export function requireDataTool(backend: McpBackend, tool: DataToolName, conn: McpConnectionInfo) {
  if (!backend.dataToolAllowed(tool, conn.id)) {
    throw new McpToolError(`${tool} is turned off for "${conn.name}" (QuenceDB → MCP → Data tools).`)
  }
}

const typeLabel = (t: McpDbType) => t === 'pg' ? 'postgresql' : t

export function listConnections(backend: McpBackend) {
  return backend.connections().map(c => ({ name: c.name, type: typeLabel(c.dbType), connected: c.connected, default_database: c.database || null }))
}

// ── Value formatting ──────────────────────────────────────────────────────────

function plainValue(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Date) return isNaN(v.getTime()) ? String(v) : v.toISOString()
  if (Buffer.isBuffer(v)) return `\\x${v.toString('hex')}`
  if (typeof v === 'string') return v.length > LIMITS.maxCellChars ? `${v.slice(0, LIMITS.maxCellChars)}… (${v.length} chars)` : v
  if (Array.isArray(v)) return v.map(plainValue)
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, plainValue(x)]))
  return v
}

// Result text for the client: JSON, capped in size, saying when anything was left out
export function formatRows(rows: Record<string, unknown>[], extra: Record<string, unknown> = {}, truncatedRows = false): string {
  let shown = rows.map(r => plainValue(r))
  let text = JSON.stringify({ ...extra, row_count: shown.length, truncated: truncatedRows || undefined, rows: shown }, null, 1)
  while (text.length > LIMITS.maxOutputChars && shown.length > 1) {
    shown = shown.slice(0, Math.floor(shown.length / 2))
    text = JSON.stringify({ ...extra, row_count: shown.length, truncated: true, note: 'Output too large; showing fewer rows. Select fewer columns or add a LIMIT.', rows: shown }, null, 1)
  }
  return text
}

const clampRows = (n: number | undefined) => Math.min(Math.max(1, Math.trunc(n ?? LIMITS.defaultRows)), LIMITS.maxRows)

// ── SQL read-only checks ──────────────────────────────────────────────────────

function stripLeadingComments(sql: string): string {
  let s = sql
  for (;;) {
    const t = s.replace(/^\s+/, '')
    if (t.startsWith('--') || t.startsWith('#')) { const nl = t.indexOf('\n'); s = nl < 0 ? '' : t.slice(nl + 1); continue }
    if (t.startsWith('/*') && !t.startsWith('/*!')) { const end = t.indexOf('*/'); s = end < 0 ? '' : t.slice(end + 2); continue }
    return t
  }
}

const READ_STATEMENTS: Record<'pg' | 'mysql', RegExp> = {
  pg: /^(SELECT|WITH|EXPLAIN|SHOW|VALUES|TABLE)\b/i,
  mysql: /^(SELECT|WITH|EXPLAIN|SHOW|DESCRIBE|DESC|TABLE|VALUES)\b/i,
}

// Functions that change server state or touch the server's files even inside a read-only transaction
const FORBIDDEN: Record<'pg' | 'mysql', RegExp> = {
  pg: /\b(pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_promote|pg_switch_wal|pg_create_restore_point|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|lo_import|lo_export|dblink\w*|pg_advisory\w*|pg_notify)\s*\(/i,
  mysql: /\b(LOAD_FILE|GET_LOCK|RELEASE_LOCK|RELEASE_ALL_LOCKS)\s*\(|\bINTO\s+(OUTFILE|DUMPFILE)\b/i,
}

export function checkReadOnlySql(dbType: 'pg' | 'mysql', sql: string): string {
  const body = stripLeadingComments(sql).replace(/;\s*$/, '')
  if (!body) throw new McpToolError('The query is empty')
  if (!READ_STATEMENTS[dbType].test(body)) {
    throw new McpToolError(`Only read queries can run here (${dbType === 'pg' ? 'SELECT, WITH, EXPLAIN, SHOW, VALUES, TABLE' : 'SELECT, WITH, EXPLAIN, SHOW, DESCRIBE, TABLE, VALUES'}). Writes are not enabled for MCP.`)
  }
  const forbidden = FORBIDDEN[dbType].exec(body)
  if (forbidden) throw new McpToolError(`${forbidden[0].replace(/\s*\($/, '')} is not allowed in read-only queries`)
  return body
}

async function pgReadOnly<T>(backend: McpBackend, conn: McpConnectionInfo, database: string | undefined, fn: (q: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; fields?: { name: string }[] }>) => Promise<T>): Promise<T> {
  const pool = backend.pg(conn.id, database)
  if (!pool) throw new McpToolError(`Connection "${conn.name}" is not connected`)
  const client = await pool.connect()
  try {
    await client.query('BEGIN READ ONLY')
    // Must stay before the user's query: PostgreSQL only lets a transaction switch to read-write
    // before its first statement, so this also blocks set_config('transaction_read_only', 'off')
    await client.query(`SET LOCAL statement_timeout = ${LIMITS.statementTimeoutMs}`)
    return await fn((sql, params) => client.query({ text: sql, values: params ?? [], queryMode: 'extended' } as never))
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

async function mysqlReadOnly<T>(backend: McpBackend, conn: McpConnectionInfo, database: string | undefined, fn: (q: (sql: string, params?: unknown[]) => Promise<any[]>) => Promise<T>): Promise<T> {
  const pool = backend.mysql(conn.id)
  if (!pool) throw new McpToolError(`Connection "${conn.name}" is not connected`)
  const c = await pool.getConnection()
  try {
    if (database) await c.query(`USE \`${database.replace(/`/g, '``')}\``)
    await c.query(`SET SESSION max_execution_time = ${LIMITS.statementTimeoutMs}`).catch(() => {}) // MariaDB lacks it
    await c.query('START TRANSACTION READ ONLY')
    return await fn(async (sql, params) => {
      const [rows] = await c.query(sql, params)
      return Array.isArray(rows) ? rows as any[] : []
    })
  } finally {
    await c.query('ROLLBACK').catch(() => {})
    c.release()
  }
}

// ── Tools ─────────────────────────────────────────────────────────────────────

export async function listDatabases(backend: McpBackend, ref: string) {
  const conn = findConnection(backend, ref)
  if (conn.dbType === 'pg') {
    return pgReadOnly(backend, conn, undefined, async q => (await q(
      `SELECT datname AS name, pg_size_pretty(pg_database_size(datname)) AS size FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname`)).rows)
  }
  if (conn.dbType === 'mysql') {
    return mysqlReadOnly(backend, conn, undefined, async q => (await q(
      `SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('mysql', 'performance_schema', 'sys', 'information_schema') ORDER BY 1`)))
  }
  const client = backend.mongo(conn.id)!
  const res = await client.db().admin().listDatabases()
  return res.databases.filter(d => !['admin', 'local', 'config'].includes(d.name)).map(d => ({ name: d.name, size_bytes: d.sizeOnDisk }))
}

const dbFor = (conn: McpConnectionInfo, database?: string) => {
  const db = database || conn.database
  if (!db) throw new McpToolError('Say which database (see list_databases)')
  return db
}

export async function listTables(backend: McpBackend, ref: string, database?: string, schema?: string) {
  const conn = findConnection(backend, ref)
  const db = dbFor(conn, database)
  if (conn.dbType === 'pg') {
    return pgReadOnly(backend, conn, db, async q => (await q(`
      SELECT n.nspname AS schema, c.relname AS name,
        CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' WHEN 'f' THEN 'foreign table' END AS kind,
        CASE WHEN c.relkind IN ('r', 'p', 'm') THEN GREATEST(c.reltuples, 0)::bigint END AS estimated_rows,
        obj_description(c.oid, 'pg_class') AS comment
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition
        AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'
        AND ($1::text IS NULL OR n.nspname = $1)
      ORDER BY 1, 2`, [schema ?? null])).rows)
  }
  if (conn.dbType === 'mysql') {
    return mysqlReadOnly(backend, conn, db, q => q(`
      SELECT TABLE_NAME AS name, IF(TABLE_TYPE = 'VIEW', 'view', 'table') AS kind, TABLE_ROWS AS estimated_rows, NULLIF(TABLE_COMMENT, '') AS comment
      FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [db]))
  }
  const mdb = backend.mongo(conn.id)!.db(db)
  const infos = await mdb.listCollections({}, { nameOnly: false }).toArray()
  const out = []
  for (const c of infos.sort((a, b) => a.name.localeCompare(b.name))) {
    if (c.name.startsWith('system.')) continue
    const kind = c.type === 'view' ? 'view' : 'collection'
    out.push({ name: c.name, kind, estimated_documents: kind === 'view' ? null : await mdb.collection(c.name).estimatedDocumentCount() })
  }
  return out
}

export async function describeTable(backend: McpBackend, ref: string, table: string, database?: string, schema?: string) {
  const conn = findConnection(backend, ref)
  const db = dbFor(conn, database)
  if (conn.dbType === 'pg') {
    const s = schema || 'public'
    return pgReadOnly(backend, conn, db, async q => {
      const oid = (await q(`SELECT to_regclass(quote_ident($1) || '.' || quote_ident($2))::oid AS oid`, [s, table])).rows[0]?.oid
      if (!oid) throw new McpToolError(`Table ${s}.${table} not found`)
      const columns = (await q(`
        SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
          pg_get_expr(d.adbin, d.adrelid) AS "default", col_description(a.attrelid, a.attnum) AS comment
        FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [oid])).rows
      const constraints = (await q(`
        SELECT conname AS name, CASE contype WHEN 'p' THEN 'primary key' WHEN 'f' THEN 'foreign key' WHEN 'u' THEN 'unique' WHEN 'c' THEN 'check' WHEN 'x' THEN 'exclusion' END AS kind,
          pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE conrelid = $1 ORDER BY contype, conname`, [oid])).rows
      const indexes = (await q(`SELECT indexrelid::regclass::text AS name, pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indrelid = $1 ORDER BY 1`, [oid])).rows
      const stats = (await q(`SELECT GREATEST(reltuples, 0)::bigint AS estimated_rows, obj_description($1, 'pg_class') AS comment FROM pg_class WHERE oid = $1`, [oid])).rows[0]
      return { schema: s, table, ...stats, columns, constraints, indexes }
    })
  }
  if (conn.dbType === 'mysql') {
    return mysqlReadOnly(backend, conn, db, async q => {
      const columns = await q(`
        SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE = 'YES' AS nullable, COLUMN_DEFAULT AS \`default\`,
          NULLIF(EXTRA, '') AS extra, NULLIF(COLUMN_COMMENT, '') AS comment
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [db, table])
      if (columns.length === 0) throw new McpToolError(`Table ${db}.${table} not found`)
      const foreignKeys = await q(`
        SELECT CONSTRAINT_NAME AS name, COLUMN_NAME AS \`column\`, REFERENCED_TABLE_NAME AS ref_table, REFERENCED_COLUMN_NAME AS ref_column
        FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`, [db, table])
      const indexes = await q(`
        SELECT INDEX_NAME AS name, NON_UNIQUE = 0 AS \`unique\`, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns
        FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? GROUP BY INDEX_NAME, NON_UNIQUE ORDER BY INDEX_NAME`, [db, table])
      const [stats] = await q(`SELECT TABLE_ROWS AS estimated_rows, NULLIF(TABLE_COMMENT, '') AS comment FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`, [db, table])
      return { database: db, table, ...stats, columns: columns.map(c => ({ ...c, nullable: !!Number(c.nullable) })), foreign_keys: foreignKeys, indexes }
    })
  }
  // MongoDB has no schema: describe the fields found in a sample of documents
  const coll = backend.mongo(conn.id)!.db(db).collection(table)
  const sample = await coll.aggregate([{ $sample: { size: 100 } }], { maxTimeMS: LIMITS.statementTimeoutMs }).toArray()
  const fields = new Map<string, { types: Set<string>; count: number }>()
  const walk = (doc: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(doc)) {
      const path = prefix ? `${prefix}.${k}` : k
      const t = v === null ? 'null' : Array.isArray(v) ? 'array' : v instanceof Date ? 'date' : (v as { _bsontype?: string })?._bsontype ?? typeof v
      const f = fields.get(path) ?? { types: new Set<string>(), count: 0 }
      f.types.add(t); f.count++
      fields.set(path, f)
      if (t === 'object' && prefix.split('.').length < 3) walk(v as Record<string, unknown>, path)
    }
  }
  sample.forEach(d => walk(d, ''))
  return {
    database: db, collection: table, sampled_documents: sample.length,
    estimated_documents: await coll.estimatedDocumentCount(),
    fields: [...fields].map(([name, f]) => ({ name, types: [...f.types], present_in: `${f.count}/${sample.length}` })),
    indexes: (await coll.indexes()).map(({ v: _v, ...ix }) => ix),
  }
}

export async function runQuery(backend: McpBackend, ref: string, sql: string, database?: string, maxRows?: number): Promise<string> {
  return (await runQueryResult(backend, ref, sql, database, maxRows)).text
}

// The rows as well as their text, for showing the result in a tab too
export async function runQueryResult(backend: McpBackend, ref: string, sql: string, database?: string, maxRows?: number): Promise<{
  text: string; rows: Record<string, unknown>[]; connection: McpConnectionInfo; database: string
}> {
  const conn = findConnection(backend, ref)
  if (conn.dbType === 'mongodb') throw new McpToolError(`"${conn.name}" is a MongoDB connection; use mongo_find or mongo_aggregate`)
  requireDataTool(backend, 'run_query', conn)
  const db = dbFor(conn, database)
  const limit = clampRows(maxRows)
  const body = checkReadOnlySql(conn.dbType, sql)
  const started = Date.now()
  const rows = conn.dbType === 'pg'
    ? await pgReadOnly(backend, conn, db, async q => (await q(body)).rows)
    : await mysqlReadOnly(backend, conn, db, q => q(body))
  const text = formatRows(rows.slice(0, limit), { ms: Date.now() - started, total_rows: rows.length }, rows.length > limit)
  return { text, rows: rows.slice(0, LIMITS.maxRows), connection: conn, database: db }
}

// Pipelines and filters may not write or run JavaScript on the server
const MONGO_FORBIDDEN = new Set(['$out', '$merge', '$where', '$function', '$accumulator'])

export function checkMongoReadOnly(value: unknown) {
  if (Array.isArray(value)) { value.forEach(checkMongoReadOnly); return }
  if (value && typeof value === 'object' && !(value as { _bsontype?: string })._bsontype && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value)) {
      if (MONGO_FORBIDDEN.has(k)) throw new McpToolError(`${k} is not allowed: MCP access is read-only`)
      checkMongoReadOnly(v)
    }
  }
}

// Extended JSON (relaxed): {"$oid": "…"}, {"$date": "…"} work in filters
function parseMongoJson(value: unknown, what: string): any {
  if (value === undefined || value === null || value === '') return undefined
  try {
    const parsed = typeof value === 'string' ? EJSON.parse(value, { relaxed: true }) : EJSON.deserialize(value as never, { relaxed: true })
    checkMongoReadOnly(parsed)
    return parsed
  } catch (err) {
    if (err instanceof McpToolError) throw err
    throw new McpToolError(`${what} is not valid (Extended) JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function mongoRows(docs: unknown[]): Record<string, unknown>[] {
  return docs.map(d => EJSON.serialize(d, { relaxed: true }) as Record<string, unknown>)
}

export async function mongoFind(backend: McpBackend, ref: string, collection: string, opts: {
  database?: string; filter?: unknown; projection?: unknown; sort?: unknown; limit?: number
}): Promise<string> {
  const conn = findConnection(backend, ref)
  if (conn.dbType !== 'mongodb') throw new McpToolError(`"${conn.name}" is not a MongoDB connection; use run_query`)
  requireDataTool(backend, 'mongo_find', conn)
  const limit = clampRows(opts.limit)
  const started = Date.now()
  const coll = backend.mongo(conn.id)!.db(dbFor(conn, opts.database)).collection(collection)
  const docs = await coll.find(parseMongoJson(opts.filter, 'filter') ?? {}, {
    projection: parseMongoJson(opts.projection, 'projection'),
    sort: parseMongoJson(opts.sort, 'sort'),
    limit: limit + 1,
    maxTimeMS: LIMITS.statementTimeoutMs,
  }).toArray()
  return formatRows(mongoRows(docs.slice(0, limit)), { ms: Date.now() - started }, docs.length > limit)
}

export async function mongoAggregate(backend: McpBackend, ref: string, collection: string, pipeline: unknown, opts: { database?: string; limit?: number }): Promise<string> {
  const conn = findConnection(backend, ref)
  if (conn.dbType !== 'mongodb') throw new McpToolError(`"${conn.name}" is not a MongoDB connection; use run_query`)
  requireDataTool(backend, 'mongo_aggregate', conn)
  const stages = parseMongoJson(pipeline, 'pipeline')
  if (!Array.isArray(stages)) throw new McpToolError('pipeline must be a JSON array of stages')
  const limit = clampRows(opts.limit)
  const started = Date.now()
  const coll = backend.mongo(conn.id)!.db(dbFor(conn, opts.database)).collection(collection)
  const docs = await coll.aggregate([...stages, { $limit: limit + 1 }], { maxTimeMS: LIMITS.statementTimeoutMs }).toArray()
  return formatRows(mongoRows(docs.slice(0, limit)), { ms: Date.now() - started }, docs.length > limit)
}
