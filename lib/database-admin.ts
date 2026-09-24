// PostgreSQL database administration from the sidebar's database menu: create / edit / drop a
// database, create a schema, manage extensions and run maintenance. Builders return statements to
// run one by one: CREATE/DROP DATABASE, VACUUM and REINDEX DATABASE can't run inside a transaction.

const ident = (s: string) => '"' + s.replace(/"/g, '""') + '"'
const literal = (s: string) => "'" + s.replace(/'/g, "''") + "'"

export interface DatabaseSettings {
  name: string
  owner: string          // '' = the current user (new) / unchanged
  encoding: string       // new databases only; '' = server default
  template: string       // new databases only; '' = template1
  connectionLimit: number // -1 = no limit
  comment: string
}

export function buildCreateDatabase(db: DatabaseSettings): string[] {
  if (!db.name.trim()) throw new Error('Enter a database name')
  const options: string[] = []
  if (db.owner) options.push(`OWNER = ${ident(db.owner)}`)
  if (db.template) options.push(`TEMPLATE = ${ident(db.template)}`)
  if (db.encoding) options.push(`ENCODING = ${literal(db.encoding)}`)
  if (db.connectionLimit !== -1) options.push(`CONNECTION LIMIT = ${Math.trunc(db.connectionLimit)}`)
  const statements = [`CREATE DATABASE ${ident(db.name)}${options.length ? ' ' + options.join(' ') : ''}`]
  if (db.comment) statements.push(`COMMENT ON DATABASE ${ident(db.name)} IS ${literal(db.comment)}`)
  return statements
}

// Changes from `before` to `after`. The rename goes first; later statements use the new name.
export function buildAlterDatabase(before: DatabaseSettings, after: DatabaseSettings): string[] {
  if (!after.name.trim()) throw new Error('Enter a database name')
  const statements: string[] = []
  const name = ident(after.name)
  if (after.name !== before.name) statements.push(`ALTER DATABASE ${ident(before.name)} RENAME TO ${name}`)
  if (after.owner && after.owner !== before.owner) statements.push(`ALTER DATABASE ${name} OWNER TO ${ident(after.owner)}`)
  if (after.connectionLimit !== before.connectionLimit) statements.push(`ALTER DATABASE ${name} WITH CONNECTION LIMIT ${Math.trunc(after.connectionLimit)}`)
  if (after.comment !== before.comment) statements.push(`COMMENT ON DATABASE ${name} IS ${after.comment ? literal(after.comment) : 'NULL'}`)
  return statements
}

// FORCE (PostgreSQL 13+) disconnects other sessions using the database
export function buildDropDatabase(name: string, force: boolean): string {
  return `DROP DATABASE ${ident(name)}${force ? ' WITH (FORCE)' : ''}`
}

export function buildCreateSchema(name: string, owner: string): string {
  if (!name.trim()) throw new Error('Enter a schema name')
  return `CREATE SCHEMA ${ident(name)}${owner ? ` AUTHORIZATION ${ident(owner)}` : ''}`
}

// ── Extensions ────────────────────────────────────────────────────────────────

export interface ExtensionInfo {
  name: string
  defaultVersion: string
  installedVersion: string | null
  schema: string | null
  comment: string
}

export const EXTENSIONS_SQL = `SELECT a.name, a.default_version, a.installed_version, n.nspname AS schema, COALESCE(a.comment, '') AS comment
FROM pg_available_extensions a
LEFT JOIN pg_extension e ON e.extname = a.name
LEFT JOIN pg_namespace n ON n.oid = e.extnamespace
ORDER BY a.installed_version IS NULL, a.name`

export function parseExtensions(rows: Record<string, unknown>[]): ExtensionInfo[] {
  return rows.map(r => ({
    name: String(r.name),
    defaultVersion: String(r.default_version ?? ''),
    installedVersion: r.installed_version == null ? null : String(r.installed_version),
    schema: r.schema == null ? null : String(r.schema),
    comment: String(r.comment ?? ''),
  }))
}

// CASCADE also installs the extensions it depends on
export function buildInstallExtension(name: string, schema: string, cascade: boolean): string {
  return `CREATE EXTENSION IF NOT EXISTS ${ident(name)}${schema ? ` SCHEMA ${ident(schema)}` : ''}${cascade ? ' CASCADE' : ''}`
}

// CASCADE also drops objects that use it (e.g. columns of its types)
export function buildDropExtension(name: string, cascade: boolean): string {
  return `DROP EXTENSION ${ident(name)}${cascade ? ' CASCADE' : ''}`
}

export function buildUpdateExtension(name: string): string {
  return `ALTER EXTENSION ${ident(name)} UPDATE`
}

// ── Maintenance ───────────────────────────────────────────────────────────────

export type MaintenanceKind = 'analyze' | 'vacuum' | 'vacuumAnalyze' | 'vacuumFull' | 'reindex'

export const MAINTENANCE_LABELS: Record<MaintenanceKind, string> = {
  analyze: 'Analyze Database',
  vacuum: 'Vacuum Database',
  vacuumAnalyze: 'Vacuum Analyze Database',
  vacuumFull: 'Vacuum Full Database',
  reindex: 'Reindex Database',
}

// Runs on a connection to the database itself (VACUUM/ANALYZE without a table cover the current one)
export function maintenanceSql(kind: MaintenanceKind, database: string): string {
  switch (kind) {
    case 'analyze': return 'ANALYZE'
    case 'vacuum': return 'VACUUM'
    case 'vacuumAnalyze': return 'VACUUM (ANALYZE)'
    case 'vacuumFull': return 'VACUUM (FULL)'
    case 'reindex': return `REINDEX DATABASE ${ident(database)}`
  }
}

// ── Catalog lookups for the dialogs ───────────────────────────────────────────

export const DATABASE_INFO_SQL = `SELECT d.datname AS name, pg_get_userbyid(d.datdba) AS owner, pg_encoding_to_char(d.encoding) AS encoding,
  d.datconnlimit AS connection_limit, COALESCE(shobj_description(d.oid, 'pg_database'), '') AS comment
FROM pg_database d WHERE d.datname = $1`

export function parseDatabaseInfo(row: Record<string, unknown>): DatabaseSettings {
  return {
    name: String(row.name),
    owner: String(row.owner ?? ''),
    encoding: String(row.encoding ?? ''),
    template: '',
    connectionLimit: Number(row.connection_limit ?? -1),
    comment: String(row.comment ?? ''),
  }
}

export const ROLES_SQL = `SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY rolname`
export const TEMPLATES_SQL = `SELECT datname FROM pg_database WHERE datistemplate OR datallowconn ORDER BY datistemplate DESC, datname`

export const COMMON_ENCODINGS = ['UTF8', 'SQL_ASCII', 'LATIN1', 'LATIN2', 'LATIN9', 'WIN1250', 'WIN1251', 'WIN1252', 'EUC_JP', 'EUC_KR', 'EUC_CN']
