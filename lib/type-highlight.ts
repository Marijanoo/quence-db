// "Highlight by data type" for result grids: which kind of value a cell holds, and which kinds
// the user has chosen to tint. Colors live in the Appearance settings as --hl-<kind> variables.

export const HIGHLIGHT_KINDS = ['string', 'number', 'datetime', 'boolean', 'json', 'uuid', 'binary'] as const
export type HighlightKind = typeof HIGHLIGHT_KINDS[number]

export const HIGHLIGHT_LABELS: Record<HighlightKind, string> = {
  string: 'Text',
  number: 'Numbers',
  datetime: 'Dates & times',
  boolean: 'Booleans',
  json: 'JSON & arrays',
  uuid: 'UUIDs',
  binary: 'Binary',
}

// Column types from PostgreSQL (udt_name / format_type) and MySQL (DATA_TYPE / COLUMN_TYPE)
export function kindFromColumnType(type: string | undefined): HighlightKind | null {
  if (!type) return null
  const t = type.toLowerCase().trim()
  if (t.startsWith('_') || t.endsWith('[]')) return 'json' // PostgreSQL arrays
  const base = t.replace(/\(.*$/, '').replace(/\s+unsigned$/, '').trim()
  if (/^(int2|int4|int8|smallint|integer|int|bigint|tinyint|mediumint|float4|float8|real|double precision|double|float|numeric|decimal|money|serial|bigserial|smallserial|oid)$/.test(base)) return 'number'
  if (/^(bool|boolean|bit)$/.test(base)) return 'boolean'
  if (/^(date|time|timetz|timestamp|timestamptz|interval|datetime|year)$/.test(base) || base.startsWith('timestamp') || base.startsWith('time ')) return 'datetime'
  if (/^(json|jsonb|xml)$/.test(base)) return 'json'
  if (base === 'uuid') return 'uuid'
  if (/^(bytea|blob|tinyblob|mediumblob|longblob|binary|varbinary)$/.test(base)) return 'binary'
  if (/^(text|varchar|character varying|char|character|bpchar|name|citext|tinytext|mediumtext|longtext|enum|set)$/.test(base)) return 'string'
  return null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Fallback when the column type is unknown (query results, MongoDB, enums, custom types)
export function kindFromValue(value: unknown): HighlightKind | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' || typeof value === 'bigint') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (value instanceof Date) return 'datetime'
  if (typeof value === 'string') return UUID_RE.test(value) ? 'uuid' : 'string'
  if (value instanceof Uint8Array || (typeof value === 'object' && (value as { type?: unknown }).type === 'Buffer')) return 'binary'
  if (typeof value === 'object') {
    const bson = (value as { _bsontype?: string })._bsontype
    if (bson === 'ObjectId' || bson === 'ObjectID') return 'uuid'
    if (bson === 'Decimal128' || bson === 'Long' || bson === 'Int32' || bson === 'Double') return 'number'
    return 'json'
  }
  return null
}

// NULL cells are never tinted
export function cellHighlightKind(columnType: string | undefined, value: unknown): HighlightKind | null {
  if (value === null || value === undefined) return null
  return kindFromColumnType(columnType) ?? kindFromValue(value)
}

// ── Enabled kinds: shared by every grid, remembered between sessions ──────────

const STORAGE_KEY = 'quence-type-highlights'
const listeners = new Set<() => void>()
let enabled: ReadonlySet<HighlightKind> = load()

function load(): ReadonlySet<HighlightKind> {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is HighlightKind => (HIGHLIGHT_KINDS as readonly string[]).includes(k)) : [])
  } catch { return new Set() }
}

export const highlightStore = {
  get: () => enabled,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  set(next: Iterable<HighlightKind>) {
    enabled = new Set(next)
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...enabled])) } catch { /* preference only */ }
    for (const l of listeners) l()
  },
  toggle(kind: HighlightKind, on: boolean) {
    const next = new Set(enabled)
    if (on) next.add(kind); else next.delete(kind)
    highlightStore.set(next)
  },
}

const EMPTY: ReadonlySet<HighlightKind> = new Set()
export const serverSnapshot = () => EMPTY
