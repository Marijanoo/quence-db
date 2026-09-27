// The table tab's filter: conditions built in the UI (or a WHERE clause typed by hand), turned into
// a parameterised WHERE for SQL databases or a find() filter for MongoDB. Filtering runs on the
// server, so it covers the whole table, not just the page on screen.

export type FilterOp =
  | 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'
  | 'contains' | 'not_contains' | 'starts' | 'ends'
  | 'null' | 'not_null' | 'empty' | 'not_empty'
  | 'between' | 'in' | 'not_in'

export interface FilterCondition {
  id: string
  enabled: boolean
  column: string
  op: FilterOp
  value: string
  value2?: string // 'between'
}

export interface TableFilter {
  mode: 'builder' | 'sql'
  match: 'all' | 'any'
  conditions: FilterCondition[]
  // mode 'sql': a WHERE clause (without the WHERE), or a MongoDB filter document as JSON
  raw: string
}

export const FILTER_OPS: { op: FilterOp; label: string; values: 0 | 1 | 2 | 'list' }[] = [
  { op: 'eq', label: '=', values: 1 },
  { op: 'ne', label: '≠', values: 1 },
  { op: 'lt', label: '<', values: 1 },
  { op: 'lte', label: '≤', values: 1 },
  { op: 'gt', label: '>', values: 1 },
  { op: 'gte', label: '≥', values: 1 },
  { op: 'contains', label: 'contains', values: 1 },
  { op: 'not_contains', label: 'does not contain', values: 1 },
  { op: 'starts', label: 'starts with', values: 1 },
  { op: 'ends', label: 'ends with', values: 1 },
  { op: 'between', label: 'between', values: 2 },
  { op: 'in', label: 'is one of', values: 'list' },
  { op: 'not_in', label: 'is not one of', values: 'list' },
  { op: 'null', label: 'is NULL', values: 0 },
  { op: 'not_null', label: 'is not NULL', values: 0 },
  { op: 'empty', label: 'is empty', values: 0 },
  { op: 'not_empty', label: 'is not empty', values: 0 },
]
export const opInfo = (op: FilterOp) => FILTER_OPS.find(o => o.op === op)!

export const emptyFilter = (): TableFilter => ({ mode: 'builder', match: 'all', conditions: [], raw: '' })

export function activeConditions(f: TableFilter | undefined): FilterCondition[] {
  return f && f.mode === 'builder' ? f.conditions.filter(c => c.enabled && c.column) : []
}

export function filterIsActive(f: TableFilter | undefined): boolean {
  if (!f) return false
  return f.mode === 'sql' ? f.raw.trim() !== '' : activeConditions(f).length > 0
}

// "a, b, c" → ["a", "b", "c"]; quotes keep commas: "x, y", 'z'
export function splitList(text: string): string[] {
  const out: string[] = []
  const re = /\s*(?:"((?:[^"]|"")*)"|'((?:[^']|'')*)'|([^,]*?))\s*(?:,|$)/g
  for (let m = re.exec(text); m && m.index < text.length; m = re.exec(text)) {
    const v = m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2] !== undefined ? m[2].replace(/''/g, "'") : m[3]
    if (v !== '' || m[1] !== undefined || m[2] !== undefined) out.push(v)
    if (m[0] === '') re.lastIndex++
  }
  return out
}

// SQL ---------------------------------------------------------------------------------------------

export type FilterDialect = 'postgres' | 'mysql' | 'sqlite'

const quote = (d: FilterDialect, name: string) => d === 'mysql' ? '`' + name.replace(/`/g, '``') + '`' : '"' + name.replace(/"/g, '""') + '"'
// LIKE with '!' as the escape character: the same in all three databases (backslash isn't)
const likeEscape = (s: string) => s.replace(/[!%_]/g, '!$&')

// `firstParam`: placeholders continue after parameters the query already has
export function buildSqlWhere(dialect: FilterDialect, filter: TableFilter | undefined, firstParam = 1): { sql: string; params: unknown[] } {
  if (!filter || !filterIsActive(filter)) return { sql: '', params: [] }
  if (filter.mode === 'sql') return { sql: `WHERE (${filter.raw.trim().replace(/;\s*$/, '')})`, params: [] }
  const params: unknown[] = []
  const p = (v: unknown) => { params.push(v); return dialect === 'mysql' ? '?' : `$${firstParam + params.length - 1}` }
  // Text comparisons work on any column type: numbers, dates, UUIDs, JSON
  const asText = (col: string) => dialect === 'postgres' ? `${col}::text` : dialect === 'mysql' ? `CAST(${col} AS CHAR)` : `CAST(${col} AS TEXT)`
  const like = (col: string, pattern: string, not = false) => dialect === 'postgres'
    ? `${asText(col)} ${not ? 'NOT ' : ''}ILIKE ${p(pattern)} ESCAPE '!'`
    // MySQL's usual collations and SQLite's LIKE ignore case already
    : `${asText(col)} ${not ? 'NOT ' : ''}LIKE ${p(pattern)} ESCAPE '!'`
  const parts = activeConditions(filter).map(c => {
    const col = quote(dialect, c.column)
    switch (c.op) {
      case 'eq': return `${col} = ${p(c.value)}`
      case 'ne': return `(${col} <> ${p(c.value)} OR ${col} IS NULL)`
      case 'lt': return `${col} < ${p(c.value)}`
      case 'lte': return `${col} <= ${p(c.value)}`
      case 'gt': return `${col} > ${p(c.value)}`
      case 'gte': return `${col} >= ${p(c.value)}`
      case 'contains': return like(col, `%${likeEscape(c.value)}%`)
      case 'not_contains': return `(${like(col, `%${likeEscape(c.value)}%`, true)} OR ${col} IS NULL)`
      case 'starts': return like(col, `${likeEscape(c.value)}%`)
      case 'ends': return like(col, `%${likeEscape(c.value)}`)
      case 'between': return `${col} BETWEEN ${p(c.value)} AND ${p(c.value2 ?? '')}`
      case 'in':
      case 'not_in': {
        const items = splitList(c.value)
        if (items.length === 0) return c.op === 'in' ? '1 = 0' : '1 = 1'
        const list = `(${items.map(v => p(v)).join(', ')})`
        return c.op === 'in' ? `${col} IN ${list}` : `(${col} NOT IN ${list} OR ${col} IS NULL)`
      }
      case 'null': return `${col} IS NULL`
      case 'not_null': return `${col} IS NOT NULL`
      case 'empty': return `(${col} IS NULL OR ${asText(col)} = '')`
      case 'not_empty': return `(${col} IS NOT NULL AND ${asText(col)} <> '')`
    }
  })
  return { sql: `WHERE ${parts.join(filter.match === 'all' ? ' AND ' : ' OR ')}`, params }
}

// MongoDB -----------------------------------------------------------------------------------------

// Typed text as the value it most likely means: numbers, booleans, null, ObjectIds for _id, dates
// in ISO form; anything else stays a string. Wrapping in quotes forces a string.
export function mongoValue(text: string, column: string): string {
  const t = text.trim()
  if (/^"(?:[^"\\]|\\.)*"$/.test(t)) return t
  if (/^'.*'$/.test(t)) return JSON.stringify(t.slice(1, -1))
  if (/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(t) && Number.isFinite(Number(t))) return String(Number(t))
  if (t === 'true' || t === 'false' || t === 'null') return t
  if ((column === '_id' || column.endsWith('Id') || column.endsWith('_id')) && /^[0-9a-f]{24}$/i.test(t)) return `ObjectId(${JSON.stringify(t)})`
  if (/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(t)) return `ISODate(${JSON.stringify(t)})`
  return JSON.stringify(text)
}

const regexEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

// The filter as MongoDB shell code (an object literal), e.g. { "status": "open", "qty": { $gt: 5 } }
export function buildMongoFilter(filter: TableFilter | undefined): string {
  if (!filter || !filterIsActive(filter)) return '{}'
  if (filter.mode === 'sql') return filter.raw.trim()
  const parts = activeConditions(filter).map(c => {
    const k = JSON.stringify(c.column)
    const v = () => mongoValue(c.value, c.column)
    const rx = (pattern: string) => `{ $regex: ${JSON.stringify(pattern)}, $options: "i" }`
    switch (c.op) {
      case 'eq': return `{ ${k}: ${v()} }`
      case 'ne': return `{ ${k}: { $ne: ${v()} } }`
      case 'lt': return `{ ${k}: { $lt: ${v()} } }`
      case 'lte': return `{ ${k}: { $lte: ${v()} } }`
      case 'gt': return `{ ${k}: { $gt: ${v()} } }`
      case 'gte': return `{ ${k}: { $gte: ${v()} } }`
      case 'contains': return `{ ${k}: ${rx(regexEscape(c.value))} }`
      case 'not_contains': return `{ ${k}: { $not: ${rx(regexEscape(c.value))} } }`
      case 'starts': return `{ ${k}: ${rx(`^${regexEscape(c.value)}`)} }`
      case 'ends': return `{ ${k}: ${rx(`${regexEscape(c.value)}$`)} }`
      case 'between': return `{ ${k}: { $gte: ${v()}, $lte: ${mongoValue(c.value2 ?? '', c.column)} } }`
      case 'in': return `{ ${k}: { $in: [${splitList(c.value).map(x => mongoValue(x, c.column)).join(', ')}] } }`
      case 'not_in': return `{ ${k}: { $nin: [${splitList(c.value).map(x => mongoValue(x, c.column)).join(', ')}] } }`
      case 'null': return `{ ${k}: null }`
      case 'not_null': return `{ ${k}: { $ne: null } }`
      case 'empty': return `{ $or: [{ ${k}: null }, { ${k}: "" }] }`
      case 'not_empty': return `{ ${k}: { $nin: [null, ""] } }`
    }
  })
  if (parts.length === 1) return parts[0]
  return `{ ${filter.match === 'all' ? '$and' : '$or'}: [${parts.join(', ')}] }`
}

// A short text for the filter bar, e.g. "status = pending and total > 100"
export function describeFilter(filter: TableFilter | undefined): string {
  if (!filter || !filterIsActive(filter)) return ''
  if (filter.mode === 'sql') return filter.raw.trim()
  return activeConditions(filter).map(c => {
    const o = opInfo(c.op)
    if (o.values === 0) return `${c.column} ${o.label}`
    if (o.values === 2) return `${c.column} between ${c.value} and ${c.value2 ?? ''}`
    if (o.values === 'list') return `${c.column} ${o.label} (${c.value})`
    return `${c.column} ${o.label} ${c.value}`
  }).join(filter.match === 'all' ? ' and ' : ' or ')
}
