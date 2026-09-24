// Exporting a table to a file: SQL dumps (CREATE + INSERT), CSV and JSON. Rows are read in batches
// from one consistent snapshot (PostgreSQL: a server-side cursor) and written as they arrive, so
// big tables don't have to fit in memory.
//
// SQL dumps name the table without its schema, like the CREATE statement (PostgreSQL dumps start
// with SET search_path instead), so a dump can be loaded into another schema or database.
//
// Every value is selected as text (col::text / CAST(col AS CHAR)), which keeps exact numerics,
// timestamps, arrays and bytea hex as the database prints them; the formatters turn that text
// into SQL literals, CSV fields or JSON values using each column's kind.

export type ExportDbType = 'postgres' | 'mysql'
export type ColumnKind = 'number' | 'boolean' | 'json' | 'binary' | 'text'

export interface ExportColumn {
  name: string
  type: string
  kind: ColumnKind
  generated: boolean      // computed by the table itself; never inserted
  identity: '' | 'a' | 'd' // PostgreSQL identity: ALWAYS needs OVERRIDING SYSTEM VALUE
  serial: boolean         // fed by a sequence / auto_increment; its counter is reset after a dump
}

export type TextRow = Record<string, string | null>

const quoteIdentFor = (dbType: ExportDbType) => dbType === 'mysql'
  ? (s: string) => '`' + s.replace(/`/g, '``') + '`'
  : (s: string) => '"' + s.replace(/"/g, '""') + '"'

// ── Metadata ──────────────────────────────────────────────────────────────────

export const EXPORT_COLUMNS_SQL: Record<ExportDbType, string> = {
  postgres: `
    SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, t.typcategory AS category, t.typname AS typname,
      a.attgenerated <> '' AS generated, a.attidentity::text AS identity,
      COALESCE(pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval(%', false) AS serial
    FROM pg_attribute a
    JOIN pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = (quote_ident($1) || '.' || quote_ident($2))::regclass AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum`,
  mysql: `
    SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, DATA_TYPE AS typname, '' AS category,
      EXTRA LIKE '%GENERATED%' AS generated, '' AS identity, EXTRA LIKE '%auto_increment%' AS serial
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
    ORDER BY ORDINAL_POSITION`,
}

export const EXPORT_PRIMARY_KEY_SQL: Record<ExportDbType, string> = {
  postgres: `
    SELECT a.attname AS name
    FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = (quote_ident($1) || '.' || quote_ident($2))::regclass AND i.indisprimary
    ORDER BY array_position(i.indkey, a.attnum)`,
  mysql: `
    SELECT COLUMN_NAME AS name FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
    ORDER BY ORDINAL_POSITION`,
}

const MYSQL_NUMBER = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'decimal', 'numeric', 'float', 'double', 'real', 'year'])
const MYSQL_BINARY = new Set(['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'bit', 'geometry', 'point', 'linestring', 'polygon'])

// pg returns booleans, MySQL returns 0/1
const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 't' || v === 'true'

export function parseExportColumns(dbType: ExportDbType, rows: Record<string, unknown>[]): ExportColumn[] {
  return rows.map(r => {
    const typname = String(r.typname ?? '').toLowerCase()
    let kind: ColumnKind = 'text'
    if (dbType === 'postgres') {
      if (typname === 'json' || typname === 'jsonb') kind = 'json'
      else if (typname === 'bytea') kind = 'binary'
      else if (r.category === 'N') kind = 'number'
      else if (r.category === 'B') kind = 'boolean'
    } else {
      if (typname === 'json') kind = 'json'
      else if (MYSQL_BINARY.has(typname)) kind = 'binary'
      else if (MYSQL_NUMBER.has(typname)) kind = 'number'
    }
    return {
      name: String(r.name),
      type: String(r.type ?? ''),
      kind,
      generated: truthy(r.generated),
      identity: (r.identity === 'a' || r.identity === 'd' ? r.identity : '') as ExportColumn['identity'],
      serial: truthy(r.serial),
    }
  })
}

// SELECT of the columns as text, in primary key order (a stable order for paging and diffs)
export function exportSelectSql(dbType: ExportDbType, schema: string, table: string, columns: ExportColumn[], primaryKey: string[]): string {
  const q = quoteIdentFor(dbType)
  const list = columns.map(c => dbType === 'postgres'
    ? `${q(c.name)}::text AS ${q(c.name)}`
    : c.kind === 'binary' ? `HEX(${q(c.name)}) AS ${q(c.name)}` : `CAST(${q(c.name)} AS CHAR) AS ${q(c.name)}`)
  const order = primaryKey.length ? ` ORDER BY ${primaryKey.map(q).join(', ')}` : ''
  return `SELECT ${list.join(', ')} FROM ${q(schema)}.${q(table)}${order}`
}

// ── SQL ───────────────────────────────────────────────────────────────────────

const PLAIN_NUMBER = /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i

export function sqlValue(dbType: ExportDbType, column: ExportColumn, text: string | null): string {
  if (text === null) return 'NULL'
  switch (column.kind) {
    case 'number':
      if (PLAIN_NUMBER.test(text)) return text
      break // NaN, Infinity: quoted
    case 'boolean':
      if (text === 'true' || text === 'false') return text.toUpperCase()
      break
    case 'binary':
      // pg prints bytea as \x… (valid bytea input); MySQL gives HEX()
      if (dbType === 'mysql') return `X'${text}'`
      break
  }
  const escaped = text.replace(/'/g, "''")
  // MySQL treats backslash as an escape character in string literals
  return `'${dbType === 'mysql' ? escaped.replace(/\\/g, '\\\\') : escaped}'`
}

export function insertStatements(
  dbType: ExportDbType, table: string, columns: ExportColumn[], rows: TextRow[], rowsPerStatement = 100,
): string[] {
  const q = quoteIdentFor(dbType)
  const cols = columns.filter(c => !c.generated)
  if (cols.length === 0 || rows.length === 0) return []
  const head = `INSERT INTO ${q(table)} (${cols.map(c => q(c.name)).join(', ')})`
    + (dbType === 'postgres' && cols.some(c => c.identity === 'a') ? ' OVERRIDING SYSTEM VALUE' : '')
  const per = Math.max(1, Math.trunc(rowsPerStatement))
  const statements: string[] = []
  for (let i = 0; i < rows.length; i += per) {
    const values = rows.slice(i, i + per).map(r => `(${cols.map(c => sqlValue(dbType, c, r[c.name] ?? null)).join(', ')})`)
    statements.push(per === 1 ? `${head} VALUES ${values[0]};` : `${head} VALUES\n  ${values.join(',\n  ')};`)
  }
  return statements
}

// After inserting explicit ids, move sequences past them (MySQL's auto_increment follows by itself)
export function resetSequenceStatements(dbType: ExportDbType, table: string, columns: ExportColumn[]): string[] {
  if (dbType !== 'postgres') return []
  const q = quoteIdentFor(dbType)
  const target = q(table)
  const lit = (s: string) => `'${s.replace(/'/g, "''")}'`
  return columns.filter(c => c.identity || c.serial).map(c =>
    `SELECT setval(pg_get_serial_sequence(${lit(target)}, ${lit(c.name)}), COALESCE(max(${q(c.name)}), 1), max(${q(c.name)}) IS NOT NULL) FROM ${target};`)
}

// ── CSV ───────────────────────────────────────────────────────────────────────

export interface CsvOptions {
  delimiter: string
  header: boolean
  nullAs: string      // what NULL becomes ('' or e.g. NULL)
  quoteAll: boolean
  bom: boolean        // UTF-8 byte order mark, so Excel detects the encoding
}

export const DEFAULT_CSV: CsvOptions = { delimiter: ',', header: true, nullAs: '', quoteAll: false, bom: false }

export function csvField(text: string, opts: CsvOptions): string {
  const needsQuotes = opts.quoteAll || text.includes(opts.delimiter) || /["\r\n]/.test(text) || /^\s|\s$/.test(text)
  return needsQuotes ? `"${text.replace(/"/g, '""')}"` : text
}

export function csvLines(columns: ExportColumn[], rows: TextRow[], opts: CsvOptions): string {
  return rows.map(r => columns.map(c => {
    const v = r[c.name] ?? null
    // A NULL shown as text must not be quoted, or it reads back as that text
    return v === null ? opts.nullAs : csvField(v, opts)
  }).join(opts.delimiter) + '\r\n').join('')
}

export function csvHeader(columns: ExportColumn[], opts: CsvOptions): string {
  return (opts.bom ? '﻿' : '') + (opts.header ? columns.map(c => csvField(c.name, opts)).join(opts.delimiter) + '\r\n' : '')
}

// ── JSON ──────────────────────────────────────────────────────────────────────

export type JsonLayout = 'array' | 'lines'

// Numbers stay numbers when a double holds them exactly (15 significant digits); longer ones
// (bigint ids, high-precision numerics) stay strings so no digit is lost
export function jsonValue(column: ExportColumn, text: string | null): unknown {
  if (text === null) return null
  switch (column.kind) {
    case 'number': {
      const digits = text.replace(/^-/, '').replace(/e.*$/i, '').replace('.', '').replace(/^0+/, '')
      const n = Number(text)
      return PLAIN_NUMBER.test(text) && Number.isFinite(n) && digits.length <= 15 ? n : text
    }
    case 'boolean':
      return text === 'true' || text === '1' ? true : text === 'false' || text === '0' ? false : text
    case 'json':
      try { return JSON.parse(text) } catch { return text }
    default:
      return text
  }
}

export function jsonObject(columns: ExportColumn[], row: TextRow): Record<string, unknown> {
  return Object.fromEntries(columns.map(c => [c.name, jsonValue(c, row[c.name] ?? null)]))
}

// ── Running an export ─────────────────────────────────────────────────────────

export type ExportFormat =
  | { kind: 'sql'; structure: boolean; data: boolean; dropTable: boolean; rowsPerStatement: number; transaction: boolean }
  | { kind: 'csv'; csv: CsvOptions }
  | { kind: 'json'; layout: JsonLayout; pretty: boolean }

export interface ExportJob {
  dbType: ExportDbType
  schema: string
  table: string
  format: ExportFormat
  columns?: string[]   // a subset to export (CSV/JSON); default all
  batchSize?: number
}

// Reads from one snapshot; cancel() interrupts the running statement
export interface ExportSnapshot {
  query(sql: string): Promise<Record<string, unknown>[]>
  close(): Promise<void>
}

export interface ExportIO {
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>   // metadata
  openSnapshot(): Promise<ExportSnapshot>
  createStatement(): Promise<string>    // the table's CREATE TABLE (for SQL structure)
  write(text: string): Promise<void>
}

export class ExportCancelled extends Error {
  constructor() { super('Export cancelled') }
}

const toTextRow = (row: Record<string, unknown>): TextRow =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v === null || v === undefined ? null : String(v)]))

export async function runExport(io: ExportIO, job: ExportJob, opts: {
  onProgress?: (rows: number) => void
  isCancelled?: () => boolean
  now?: Date
} = {}): Promise<{ rows: number }> {
  const { dbType, schema, table, format } = job
  const q = quoteIdentFor(dbType)
  const check = () => { if (opts.isCancelled?.()) throw new ExportCancelled() }

  let columns = parseExportColumns(dbType, await io.query(EXPORT_COLUMNS_SQL[dbType], [schema, table]))
  if (columns.length === 0) throw new Error(`Table ${schema}.${table} not found`)
  if (job.columns && format.kind !== 'sql') {
    const wanted = new Set(job.columns)
    columns = columns.filter(c => wanted.has(c.name))
    if (columns.length === 0) throw new Error('Choose at least one column')
  }
  const primaryKey = (await io.query(EXPORT_PRIMARY_KEY_SQL[dbType], [schema, table])).map(r => String(r.name))
  check()

  // ── Header ──
  const target = q(table)
  const withData = format.kind !== 'sql' || format.data
  if (format.kind === 'sql') {
    const stamp = (opts.now ?? new Date()).toISOString()
    let head = `-- QuenceDB dump of ${q(schema)}.${q(table)}\n-- ${format.structure ? (format.data ? 'Structure and data' : 'Structure only') : 'Data only'}, ${stamp}\n\n`
    // The same search path the CREATE statement was written for (its names omit this schema)
    if (dbType === 'postgres') head += `SET search_path TO ${q(schema)}, public;\n\n`
    if (format.structure) {
      if (format.dropTable) head += `DROP TABLE IF EXISTS ${target};\n`
      const create = (await io.createStatement()).trim()
      head += (create.endsWith(';') ? create : create + ';') + '\n\n'
    }
    if (format.data && format.transaction) head += dbType === 'mysql' ? 'START TRANSACTION;\n' : 'BEGIN;\n'
    await io.write(head)
  } else if (format.kind === 'csv') {
    await io.write(csvHeader(columns, format.csv))
  } else if (format.layout === 'array') {
    await io.write('[')
  }

  // ── Rows ──
  let total = 0
  if (withData) {
    const batch = Math.max(1, job.batchSize ?? 2000)
    const select = exportSelectSql(dbType, schema, table, columns, primaryKey)
    const snapshot = await io.openSnapshot()
    try {
      if (dbType === 'postgres') await snapshot.query(`DECLARE quence_export NO SCROLL CURSOR FOR ${select}`)
      for (;;) {
        check()
        const rows = (dbType === 'postgres'
          ? await snapshot.query(`FETCH ${batch} FROM quence_export`)
          : await snapshot.query(`${select} LIMIT ${batch} OFFSET ${total}`)).map(toTextRow)
        if (rows.length === 0) break
        let text = ''
        if (format.kind === 'sql') {
          text = insertStatements(dbType, table, columns, rows, format.rowsPerStatement).join('\n') + '\n'
        } else if (format.kind === 'csv') {
          text = csvLines(columns, rows, format.csv)
        } else {
          const items = rows.map(r => JSON.stringify(jsonObject(columns, r), null, format.layout === 'array' && format.pretty ? 2 : undefined))
          text = format.layout === 'lines'
            ? items.join('\n') + '\n'
            : (total === 0 ? '\n' : ',\n') + items.map(i => format.pretty ? i.replace(/^/gm, '  ') : i).join(',\n')
        }
        await io.write(text)
        total += rows.length
        opts.onProgress?.(total)
        if (rows.length < batch) break
      }
    } finally {
      await snapshot.close()
    }
  }
  check()

  // ── Footer ──
  if (format.kind === 'sql') {
    let foot = ''
    if (format.data) {
      const resets = resetSequenceStatements(dbType, table, columns)
      if (resets.length) foot += '\n' + resets.join('\n') + '\n'
      if (format.transaction) foot += '\nCOMMIT;\n'
    }
    if (foot) await io.write(foot)
  } else if (format.kind === 'json' && format.layout === 'array') {
    await io.write(total === 0 ? ']\n' : '\n]\n')
  }
  return { rows: total }
}

export function exportFileName(table: string, format: ExportFormat): string {
  const safe = table.replace(/[\\/:*?"<>|]/g, '_')
  return `${safe}.${format.kind === 'sql' ? 'sql' : format.kind === 'csv' ? (format.csv.delimiter === '\t' ? 'tsv' : 'csv') : format.layout === 'lines' ? 'jsonl' : 'json'}`
}
