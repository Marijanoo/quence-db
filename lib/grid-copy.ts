// "Copy As" formats for result grid rows: SQL statements and tab-separated values.

export type SqlDialect = 'postgres' | 'mysql'

export function quoteIdent(dbType: SqlDialect) {
  return dbType === 'mysql'
    ? (s: string) => '`' + s.replace(/`/g, '``') + '`'
    : (s: string) => '"' + s.replace(/"/g, '""') + '"'
}

export function sqlLiteral(value: unknown, dbType: SqlDialect): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  if (typeof value === 'boolean') return dbType === 'mysql' ? (value ? '1' : '0') : (value ? 'TRUE' : 'FALSE')
  const text = value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value)
  const escaped = text.replace(/'/g, "''")
  return dbType === 'mysql' ? `'${escaped.replace(/\\/g, '\\\\')}'` : `'${escaped}'`
}

export function buildInsertStatement(dbType: SqlDialect, schema: string, table: string, fields: string[], row: Record<string, unknown>): string {
  const q = quoteIdent(dbType)
  return `INSERT INTO ${q(schema)}.${q(table)} (${fields.map(q).join(', ')}) VALUES (${fields.map(f => sqlLiteral(row[f], dbType)).join(', ')});`
}

export function buildUpdateStatement(dbType: SqlDialect, schema: string, table: string, primaryKeys: string[], fields: string[], row: Record<string, unknown>): string {
  const q = quoteIdent(dbType)
  const sets = fields.filter(f => !primaryKeys.includes(f)).map(f => `${q(f)} = ${sqlLiteral(row[f], dbType)}`)
  const where = primaryKeys.map(pk => row[pk] === null || row[pk] === undefined ? `${q(pk)} IS NULL` : `${q(pk)} = ${sqlLiteral(row[pk], dbType)}`)
  return `UPDATE ${q(schema)}.${q(table)} SET ${sets.join(', ')} WHERE ${where.join(' AND ')};`
}

export function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

// Tabs and newlines inside values would break the columns, so they become spaces
export function rowsToTsv(fields: string[], rows: Record<string, unknown>[], withHeader: boolean): string {
  const clean = (s: string) => s.replace(/[\t\r\n]+/g, ' ')
  const lines = rows.map(row => fields.map(f => clean(cellText(row[f]))).join('\t'))
  return (withHeader ? [fields.map(clean).join('\t'), ...lines] : lines).join('\n')
}
