// Cell edits on MongoDB collections (the grid's right-click menu): value conversions for
// "Change Type to", and the shell scripts that apply them to one document by its _id.
// Grid values are the plain values the backend sends (ObjectIds as hex strings, dates as ISO
// strings, ...); `types` says what they were in BSON.

export type MongoTargetType = 'string' | 'int' | 'long' | 'double' | 'decimal' | 'bool' | 'date' | 'objectId' | 'array' | 'object' | 'null'

export const MONGO_TYPE_OPTIONS: { type: MongoTargetType; label: string }[] = [
  { type: 'string', label: 'String' },
  { type: 'int', label: 'Int32' },
  { type: 'long', label: 'Int64' },
  { type: 'double', label: 'Double' },
  { type: 'decimal', label: 'Decimal128' },
  { type: 'bool', label: 'Boolean' },
  { type: 'date', label: 'Date' },
  { type: 'objectId', label: 'ObjectId' },
  { type: 'array', label: 'Array' },
  { type: 'object', label: 'Object' },
  { type: 'null', label: 'Null' },
]

export const BSON_TYPE_LABELS: Record<string, string> = {
  ...Object.fromEntries(MONGO_TYPE_OPTIONS.map(o => [o.type, o.label])),
  uuid: 'UUID', binData: 'Binary', regex: 'Regex', javascript: 'Code', timestamp: 'Timestamp',
  minKey: 'MinKey', maxKey: 'MaxKey', undefined: 'Undefined',
}

export type MongoCellEdit =
  | { kind: 'changeType'; col: string; to: MongoTargetType }
  | { kind: 'emptyString'; col: string }
  | { kind: 'unset'; col: string }
  | { kind: 'deleteDocument' }

const lit = (v: unknown) => JSON.stringify(v)
const INT32_MIN = -2147483648
const INT32_MAX = 2147483647
const HEX_OBJECT_ID = /^[0-9a-f]{24}$/i
const INTEGER_TEXT = /^[-+]?\d+$/
const DECIMAL_TEXT = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/

function describe(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 40 ? `${text.slice(0, 40)}…` : text
}

function fail(value: unknown, label: string): never {
  throw new Error(`Can't convert ${describe(value)} to ${label}`)
}

// Numeric value of a cell, for conversions to number types. Dates convert to epoch milliseconds.
function toNumber(value: unknown, fromType: string | undefined, label: string): number {
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string') {
    if (fromType === 'date') {
      const ms = Date.parse(value)
      if (!isNaN(ms)) return ms
    }
    const text = value.trim()
    if (DECIMAL_TEXT.test(text)) return Number(text)
  }
  return fail(value, label)
}

// Shell expression for a grid value, keeping the BSON type it had
export function typedLiteral(value: unknown, type: string | undefined): string {
  if (value === null || value === undefined) return 'null'
  switch (type) {
    case 'objectId': return `ObjectId(${lit(value)})`
    case 'date': return `ISODate(${lit(value)})`
    case 'long': return `NumberLong(${lit(String(value))})`
    case 'int': return `NumberInt(${lit(value)})`
    case 'double': return `new Double(${lit(value)})`
    case 'decimal': return `NumberDecimal(${lit(String(value))})`
    case 'uuid': return `UUID(${lit(value)})`
    default: return lit(value)
  }
}

// Shell expression for the value converted to `to`, e.g. "42" (string) → NumberInt(42)
export function convertMongoValue(value: unknown, fromType: string | undefined, to: MongoTargetType): string {
  const label = MONGO_TYPE_OPTIONS.find(o => o.type === to)!.label
  const isNull = value === null || value === undefined
  switch (to) {
    case 'null':
      return 'null'
    case 'string':
      if (isNull) return '""'
      return lit(typeof value === 'object' ? JSON.stringify(value) : String(value))
    case 'int': {
      if (isNull) fail(value, label)
      const n = Math.trunc(toNumber(value, fromType, label))
      if (!Number.isFinite(n) || n < INT32_MIN || n > INT32_MAX) fail(value, label)
      return `NumberInt(${n})`
    }
    case 'long': {
      if (isNull) fail(value, label)
      // Integer text keeps every digit; numbers beyond 2^53 would already be rounded
      if (typeof value === 'string' && INTEGER_TEXT.test(value.trim())) return `NumberLong(${lit(value.trim().replace(/^\+/, ''))})`
      const n = Math.trunc(toNumber(value, fromType, label))
      if (!Number.isFinite(n)) fail(value, label)
      return `NumberLong(${lit(String(n))})`
    }
    case 'double': {
      if (isNull) fail(value, label)
      const n = toNumber(value, fromType, label)
      if (!Number.isFinite(n)) fail(value, label)
      return `new Double(${n})`
    }
    case 'decimal': {
      if (isNull) fail(value, label)
      if (typeof value === 'string' && DECIMAL_TEXT.test(value.trim()) && fromType !== 'date') return `NumberDecimal(${lit(value.trim())})`
      const n = toNumber(value, fromType, label)
      if (!Number.isFinite(n)) fail(value, label)
      return `NumberDecimal(${lit(String(n))})`
    }
    case 'bool': {
      if (isNull) return 'false'
      if (typeof value === 'boolean') return String(value)
      if (typeof value === 'number') return String(value !== 0)
      if (typeof value === 'string') {
        const text = value.trim().toLowerCase()
        if (['true', '1', 'yes', 'y', 'on'].includes(text)) return 'true'
        if (['false', '0', 'no', 'n', 'off', ''].includes(text)) return 'false'
        if (DECIMAL_TEXT.test(text)) return String(Number(text) !== 0)
      }
      return fail(value, label)
    }
    case 'date': {
      if (typeof value === 'number' && Number.isFinite(value)) return `ISODate(${lit(new Date(value).toISOString())})`
      if (typeof value === 'string') {
        const text = value.trim()
        const ms = INTEGER_TEXT.test(text) ? Number(text) : Date.parse(text)
        if (!isNaN(ms) && Number.isFinite(ms)) return `ISODate(${lit(new Date(ms).toISOString())})`
      }
      return fail(value, label)
    }
    case 'objectId':
      if (typeof value === 'string' && HEX_OBJECT_ID.test(value.trim())) return `ObjectId(${lit(value.trim().toLowerCase())})`
      return fail(value, label)
    case 'array':
      if (Array.isArray(value)) return lit(value)
      return isNull ? '[]' : `[${typedLiteral(value, fromType)}]`
    case 'object': {
      if (isNull) return '{}'
      if (typeof value === 'object' && !Array.isArray(value)) return lit(value)
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return lit(parsed)
        } catch { /* not JSON */ }
      }
      return fail(value, label)
    }
  }
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Shell expression for text typed into a cell, keeping the field's current BSON type
// (typing "42" into an Int32 field stores NumberInt(42), not the string "42")
export function typedValueFromText(text: string | null, type: string | undefined): string {
  if (text === null) return 'null'
  switch (type) {
    case undefined:
    case 'string':
    case 'null': // an empty field: store what was typed as text; "Change Type to" converts it
      return lit(text)
    case 'int': case 'long': case 'double': case 'decimal': case 'bool': case 'date': case 'objectId':
      return convertMongoValue(text, 'string', type)
    case 'array':
    case 'object': {
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { return fail(text, type === 'array' ? 'Array (enter JSON)' : 'Object (enter JSON)') }
      if (type === 'array' ? !Array.isArray(parsed) : (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
        return fail(text, type === 'array' ? 'Array (enter JSON)' : 'Object (enter JSON)')
      }
      return lit(parsed)
    }
    case 'uuid':
      if (UUID_TEXT.test(text.trim())) return `UUID(${lit(text.trim().toLowerCase())})`
      return fail(text, 'UUID')
    default:
      throw new Error(`Editing ${BSON_TYPE_LABELS[type] ?? type} values isn't supported`)
  }
}

// One update for all edited fields of a document; dotted names set nested fields
export function buildMongoSetScript(collection: string, id: unknown, idType: string | undefined, fields: { col: string; text: string | null; type: string | undefined }[]): string {
  const filter = mongoIdFilter(id, idType)
  if (!filter) throw new Error('This document\'s _id type is not supported for editing')
  const sets = fields.map(f => {
    if (f.col === '_id' || f.col.startsWith('_id.')) throw new Error("_id can't be changed")
    return `${lit(f.col)}: ${typedValueFromText(f.text, f.type)}`
  })
  return `db.getCollection(${lit(collection)}).updateOne(${filter}, { $set: { ${sets.join(', ')} } })`
}

// Filter expression matching the document by _id, or null when its _id type can't be rebuilt
export function mongoIdFilter(id: unknown, idType: string | undefined): string | null {
  if (id === null || id === undefined) return null
  if (idType && ['binData', 'regex', 'javascript', 'timestamp', 'minKey', 'maxKey', 'undefined', 'array'].includes(idType)) return null
  return `{ _id: ${typedLiteral(id, idType)} }`
}

export function buildMongoCellScript(collection: string, id: unknown, idType: string | undefined, edit: MongoCellEdit, value?: unknown, valueType?: string): string {
  const filter = mongoIdFilter(id, idType)
  if (!filter) throw new Error('This document\'s _id type is not supported for editing')
  const coll = `db.getCollection(${lit(collection)})`
  switch (edit.kind) {
    case 'changeType':
      return `${coll}.updateOne(${filter}, { $set: { ${lit(edit.col)}: ${convertMongoValue(value, valueType, edit.to)} } })`
    case 'emptyString':
      return `${coll}.updateOne(${filter}, { $set: { ${lit(edit.col)}: "" } })`
    case 'unset':
      return `${coll}.updateOne(${filter}, { $unset: { ${lit(edit.col)}: "" } })`
    case 'deleteDocument':
      return `${coll}.deleteOne(${filter})`
  }
}
