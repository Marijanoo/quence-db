// Foreign-key lookup: which columns of a table reference other tables, and paged/searchable
// queries over the referenced table for the "pick a row" popup (PostgreSQL and MySQL).

export type FkDbType = 'postgres' | 'mysql'

export interface FkRef {
  column: string     // referencing column in the current table
  refSchema: string  // referenced table (for MySQL the schema is the database)
  refTable: string
  refColumn: string
}

// Single-column foreign keys only; composite keys can't be picked from one cell
export const FOREIGN_KEYS_SQL: Record<FkDbType, string> = {
  postgres: `
    SELECT a.attname AS column_name, fn.nspname AS ref_schema, f.relname AS ref_table, fa.attname AS ref_column
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class f ON f.oid = con.confrelid
    JOIN pg_namespace fn ON fn.oid = f.relnamespace
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
    JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = con.confkey[1]
    WHERE con.contype = 'f' AND cardinality(con.conkey) = 1 AND n.nspname = $1 AND c.relname = $2
    ORDER BY a.attnum`,
  mysql: `
    SELECT k.COLUMN_NAME AS column_name, k.REFERENCED_TABLE_SCHEMA AS ref_schema, k.REFERENCED_TABLE_NAME AS ref_table, k.REFERENCED_COLUMN_NAME AS ref_column
    FROM information_schema.KEY_COLUMN_USAGE k
    WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
      AND (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE k2
           WHERE k2.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND k2.CONSTRAINT_NAME = k.CONSTRAINT_NAME
             AND k2.TABLE_SCHEMA = k.TABLE_SCHEMA AND k2.TABLE_NAME = k.TABLE_NAME) = 1
    ORDER BY k.ORDINAL_POSITION`,
}

export const TABLE_COLUMN_NAMES_SQL: Record<FkDbType, string> = {
  postgres: `
    SELECT a.attname AS name FROM pg_attribute a
    WHERE a.attrelid = (quote_ident($1) || '.' || quote_ident($2))::regclass AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum`,
  mysql: `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
}

export function parseForeignKeys(rows: Record<string, unknown>[]): FkRef[] {
  const seen = new Set<string>()
  return rows.flatMap(r => {
    const column = String(r.column_name)
    if (seen.has(column)) return [] // a column with several FKs: the first one wins
    seen.add(column)
    return [{ column, refSchema: String(r.ref_schema), refTable: String(r.ref_table), refColumn: String(r.ref_column) }]
  })
}

// Columns worth showing next to an id when nothing is configured yet
const DISPLAY_CANDIDATES = ['name', 'full_name', 'fullname', 'display_name', 'displayname', 'title', 'username', 'user_name', 'email', 'label', 'slug', 'code']

export function defaultDisplayColumns(columns: string[], refColumn: string): string[] {
  const byLower = new Map(columns.map(c => [c.toLowerCase(), c]))
  const picked: string[] = []
  for (const candidate of DISPLAY_CANDIDATES) {
    const actual = byLower.get(candidate)
    if (actual && actual !== refColumn && !picked.includes(actual)) picked.push(actual)
    if (picked.length === 2) break
  }
  return picked
}

export interface LookupQuery { sql: string; params: unknown[] }
export const LOOKUP_PAGE_SIZE = 50
export const KEY_ALIAS = '__key'

const quote = (dbType: FkDbType, s: string) => dbType === 'mysql' ? '`' + s.replace(/`/g, '``') + '`' : '"' + s.replace(/"/g, '""') + '"'
const asText = (dbType: FkDbType, expr: string) => dbType === 'mysql' ? `CAST(${expr} AS CHAR)` : `${expr}::text`
const escapeLike = (s: string) => s.replace(/[\\%_]/g, m => '\\' + m)

// One page of the referenced table in key order, after `cursor` (the last key already shown),
// optionally filtered by a search over the key and the display columns
export function lookupPageSql(dbType: FkDbType, fk: FkRef, displayColumns: string[], opts: { cursor?: string | null; search?: string; limit?: number } = {}): LookupQuery {
  const q = (s: string) => quote(dbType, s)
  const params: unknown[] = []
  const param = (v: unknown) => { params.push(v); return dbType === 'mysql' ? '?' : `$${params.length}` }
  const key = q(fk.refColumn)
  const shown = displayColumns.filter(c => c !== fk.refColumn)
  const select = [`${asText(dbType, key)} AS ${q(KEY_ALIAS)}`, ...shown.map(c => `${asText(dbType, q(c))} AS ${q(c)}`)]

  const where: string[] = []
  if (opts.cursor !== undefined && opts.cursor !== null) where.push(`${key} > ${param(opts.cursor)}`)
  const search = opts.search?.trim()
  if (search) {
    const like = dbType === 'mysql' ? 'LIKE' : 'ILIKE'
    const pattern = param(`%${escapeLike(search)}%`)
    where.push(`(${[key, ...shown.map(q)].map(c => `${asText(dbType, c)} ${like} ${pattern}`).join(' OR ')})`)
  }

  const sql = `SELECT ${select.join(', ')} FROM ${q(fk.refSchema)}.${q(fk.refTable)}`
    + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
    + ` ORDER BY ${key} LIMIT ${opts.limit ?? LOOKUP_PAGE_SIZE}`
  // MySQL can't reuse a placeholder, so repeat the search parameter for every column
  if (dbType === 'mysql' && search) {
    const pattern = params[params.length - 1]
    const repeats = 1 + shown.length
    params.splice(params.length - 1, 1, ...Array(repeats).fill(pattern))
  }
  return { sql, params }
}

export function lookupRowSql(dbType: FkDbType, fk: FkRef, displayColumns: string[], value: string): LookupQuery {
  const q = (s: string) => quote(dbType, s)
  const shown = displayColumns.filter(c => c !== fk.refColumn)
  const select = [`${asText(dbType, q(fk.refColumn))} AS ${q(KEY_ALIAS)}`, ...shown.map(c => `${asText(dbType, q(c))} AS ${q(c)}`)]
  return {
    sql: `SELECT ${select.join(', ')} FROM ${q(fk.refSchema)}.${q(fk.refTable)} WHERE ${q(fk.refColumn)} = ${dbType === 'mysql' ? '?' : '$1'} LIMIT 1`,
    params: [value],
  }
}

export const displayConfigKey = (connectionId: string, database: string, fk: Pick<FkRef, 'refSchema' | 'refTable'>) =>
  `quence-fk-display:${connectionId}:${database}:${fk.refSchema}.${fk.refTable}`
