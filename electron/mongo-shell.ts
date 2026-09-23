import vm from 'vm'
import { types } from 'util'
import { parse } from 'acorn'
import {
  AbstractCursor, Binary, Collection, Db, Decimal128, Double, Int32, Long, MaxKey, MinKey,
  MongoClient, ObjectId, Timestamp, UUID,
} from 'mongodb'

// Runs mongosh-style scripts (`db.users.find({})`, `use shop`, `show collections`, ...) against a
// connected MongoClient. Top-level expression statements are awaited in order, so
// `db.a.insertOne({...}); db.a.find()` sees the insert, and the last one is the script's result.

export interface MongoShellResult {
  rows: Record<string, unknown>[]
  fields: string[]
  rowCount: number
  ms: number
  // Per row: BSON type of every field, keyed by dotted path like the grid's flattened columns
  types?: Record<string, BsonTypeName>[]
}

export interface MongoShellOptions {
  // Keep Int32/Double/Long distinct in find/findOne results (the driver otherwise turns them all
  // into JS numbers), so `types` is exact. Off for user scripts, which expect plain numbers.
  typed?: boolean
}

export type BsonTypeName =
  | 'double' | 'string' | 'object' | 'array' | 'binData' | 'uuid' | 'objectId' | 'bool' | 'date' | 'null'
  | 'regex' | 'javascript' | 'int' | 'timestamp' | 'long' | 'decimal' | 'minKey' | 'maxKey' | 'undefined'

const USE_LINE = /^\s*use\s+([^\s;]+)\s*;?\s*$/
const SHOW_LINE = /^\s*show\s+(\w+)\s*;?\s*$/i

// Rewrites the shell-only `use <db>` and `show <what>` lines into function calls. Line-for-line,
// so parse errors still point at the line the user wrote.
export function preprocessShellCommands(script: string): string {
  return script.split(/\r?\n/).map(line => {
    const use = USE_LINE.exec(line)
    if (use) return `__shell.use(${JSON.stringify(use[1])});`
    const show = SHOW_LINE.exec(line)
    if (show) return `__shell.show(${JSON.stringify(show[1].toLowerCase())});`
    return line
  }).join('\n')
}

// Wraps the script in an async function that awaits every top-level expression statement and
// returns the last one's value (boxed, so a thenable result isn't unwrapped a second time).
export function compileShellScript(script: string): string {
  const source = preprocessShellCommands(script)
  const program = parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true })
  let body = ''
  let pos = 0
  for (const stmt of program.body) {
    body += source.slice(pos, stmt.start)
    if (stmt.type === 'ExpressionStatement') {
      body += `__result = await (${source.slice(stmt.expression.start, stmt.expression.end)});`
    } else {
      body += source.slice(stmt.start, stmt.end)
    }
    pos = stmt.end
  }
  body += source.slice(pos)
  return `(async () => { let __result;\n${body}\nreturn { value: __result } })()`
}

// Driver cursors, chainable like the shell's: `.sort().skip().limit()` keep returning the wrapper,
// and awaiting it (which the script wrapper does) runs toArray().
function wrapCursor(cursor: AbstractCursor, count?: () => Promise<number>): any {
  const proxy: any = new Proxy(cursor, {
    get(target, prop) {
      if (prop === 'then') {
        return (resolve: any, reject: any) => target.toArray().then(resolve, reject)
      }
      if (prop === 'pretty') return () => proxy
      if (prop === 'count' || prop === 'size' || prop === 'itcount') {
        return () => (prop === 'count' && count) ? count() : target.toArray().then(docs => docs.length)
      }
      const value = Reflect.get(target, prop === 'projection' ? 'project' : prop, target)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        const res = value.apply(target, args)
        if (res === target) return proxy
        return res instanceof AbstractCursor ? wrapCursor(res) : res
      }
    },
  })
  return proxy
}

function bindWrapped(target: object, value: (...args: unknown[]) => unknown) {
  return (...args: unknown[]) => {
    const res = value.apply(target, args)
    return res instanceof AbstractCursor ? wrapCursor(res) : res
  }
}

function wrapCollection(db: Db, name: string, typed: boolean): any {
  const coll = db.collection(name)
  const readOptions = (projection: unknown, options: object) => ({
    ...options,
    ...(projection ? { projection } : {}),
    ...(typed ? { promoteValues: false } : {}),
  })
  const shell: Record<string, (...args: any[]) => unknown> = {
    // The shell's second argument is a projection, not driver options.
    find: (filter = {}, projection?, options = {}) =>
      wrapCursor(coll.find(filter, readOptions(projection, options)), () => coll.countDocuments(filter)),
    findOne: (filter = {}, projection?, options = {}) =>
      coll.findOne(filter, readOptions(projection, options)),
    insert: (docs) => Array.isArray(docs) ? coll.insertMany(docs) : coll.insertOne(docs),
    update: (filter, update, options: any = {}) => {
      const { multi, ...rest } = options
      return multi ? coll.updateMany(filter, update, rest) : coll.updateOne(filter, update, rest)
    },
    remove: (filter = {}, justOne?: boolean | { justOne?: boolean }) =>
      (typeof justOne === 'object' ? justOne.justOne : justOne) ? coll.deleteOne(filter) : coll.deleteMany(filter),
    count: (filter = {}, options = {}) => coll.countDocuments(filter, options),
    getIndexes: () => coll.indexes(),
    getName: () => name,
    getFullName: () => `${db.databaseName}.${name}`,
    renameCollection: (to: string, dropTarget = false) => coll.rename(to, { dropTarget }).then(() => ({ ok: 1 })),
  }
  return new Proxy(coll, {
    get(target, prop) {
      if (prop === 'then') return undefined
      if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(shell, prop)) return shell[prop]
      if (prop in target) {
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? bindWrapped(target, value) : value
      }
      // `db.system.profile` addresses the collection named "system.profile".
      if (typeof prop === 'string') return wrapCollection(db, `${name}.${prop}`, typed)
      return undefined
    },
  })
}

function wrapDb(client: MongoClient, db: Db, typed: boolean): any {
  const shell: Record<string, (...args: any[]) => unknown> = {
    getCollection: (name: string) => wrapCollection(db, name, typed),
    getCollectionNames: () => db.listCollections({}, { nameOnly: true }).toArray().then(cs => cs.map(c => c.name).sort()),
    getCollectionInfos: (filter = {}) => db.listCollections(filter).toArray(),
    getName: () => db.databaseName,
    getSiblingDB: (name: string) => wrapDb(client, client.db(name), typed),
    createCollection: (name: string, options = {}) => db.createCollection(name, options).then(() => ({ ok: 1 })),
    runCommand: (cmd) => db.command(typeof cmd === 'string' ? { [cmd]: 1 } : cmd),
    adminCommand: (cmd) => client.db('admin').command(typeof cmd === 'string' ? { [cmd]: 1 } : cmd),
    version: () => client.db('admin').command({ buildInfo: 1 }).then(info => info.version),
  }
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'then') return undefined
      if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(shell, prop)) return shell[prop]
      if (prop in target) {
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? bindWrapped(target, value) : value
      }
      if (typeof prop === 'string') return wrapCollection(target, prop, typed)
      return undefined
    },
  })
}

// The mongosh helper constructors. Plain functions so they work both with and without `new`.
function shellHelpers() {
  function ObjectIdHelper(value?: string) { return new ObjectId(value) }
  ObjectIdHelper.isValid = (value: string) => ObjectId.isValid(value)
  return {
    ObjectId: ObjectIdHelper,
    ObjectID: ObjectIdHelper,
    ISODate: function ISODate(value?: string) { return value === undefined ? new Date() : new Date(value) },
    NumberInt: function NumberInt(value: unknown = 0) { return new Int32(Number(value)) },
    NumberLong: function NumberLong(value: unknown = 0) { return Long.fromString(String(value)) },
    NumberDecimal: function NumberDecimal(value: unknown = 0) { return Decimal128.fromString(String(value)) },
    UUID: function UUIDHelper(value?: string) { return value === undefined ? new UUID() : new UUID(value) },
    BinData: function BinData(subtype: number, base64: string) { return new Binary(Buffer.from(base64, 'base64'), subtype) },
    Timestamp: function TimestampHelper(t = 0, i = 0) { return new Timestamp({ t, i }) },
    MinKey: function MinKeyHelper() { return new MinKey() },
    MaxKey: function MaxKeyHelper() { return new MaxKey() },
    Int32, Long, Double, Decimal128,
  }
}

// Converts driver/BSON values into JSON-friendly values for the result grid: ObjectIds become hex
// strings, dates ISO strings, 64-bit/decimal numbers numbers or strings, and so on.
export function toPlain(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function') return undefined
  if (typeof value !== 'object') return value
  if (types.isDate(value)) return isNaN((value as Date).getTime()) ? 'Invalid Date' : (value as Date).toISOString()
  if (types.isRegExp(value)) return String(value)
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  if (value instanceof Collection) return `Collection(${value.collectionName})`
  if (value instanceof Db) return `Db(${value.databaseName})`
  if (value instanceof AbstractCursor) return 'Cursor'

  const bson = (value as { _bsontype?: string })._bsontype
  if (bson) {
    const v = value as any
    switch (bson) {
      case 'ObjectId': return v.toHexString()
      case 'Int32': case 'Double': return v.valueOf()
      case 'Long': return v.lessThanOrEqual(Number.MAX_SAFE_INTEGER) && v.greaterThanOrEqual(Number.MIN_SAFE_INTEGER) ? v.toNumber() : v.toString()
      case 'Decimal128': return v.toString()
      case 'Binary': return v.sub_type === Binary.SUBTYPE_UUID ? v.toUUID().toHexString(true) : v.toString('base64')
      case 'Timestamp': return `Timestamp(${v.t}, ${v.i})`
      case 'BSONRegExp': return `/${v.pattern}/${v.options}`
      case 'MinKey': return 'MinKey'
      case 'MaxKey': return 'MaxKey'
      case 'Code': return v.code
      case 'DBRef': return { $ref: v.collection, $id: toPlain(v.oid, seen), ...(v.db ? { $db: v.db } : {}) }
      default: return String(v)
    }
  }

  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map(item => toPlain(item, seen) ?? null)
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const plain = toPlain(item, seen)
      if (plain !== undefined) out[key] = plain
    }
    return out
  } finally {
    seen.delete(value)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Shapes a script result into grid rows: documents stay rows, scalars (e.g. from distinct or
// countDocuments) become { value } / { result } rows.
export function toRows(result: unknown): Record<string, unknown>[] {
  if (result === undefined) return []
  const plain = toPlain(result)
  if (Array.isArray(plain)) return plain.map(item => isRecord(item) ? item : { value: item })
  if (isRecord(plain)) return [plain]
  return [{ result: plain }]
}

export function bsonTypeOf(value: unknown): BsonTypeName {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'boolean') return 'bool'
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'double'
  if (typeof value === 'bigint') return 'long'
  if (types.isDate(value)) return 'date'
  if (types.isRegExp(value)) return 'regex'
  if (Array.isArray(value)) return 'array'
  switch ((value as { _bsontype?: string })._bsontype) {
    case 'ObjectId': return 'objectId'
    case 'Int32': return 'int'
    case 'Double': return 'double'
    case 'Long': return 'long'
    case 'Decimal128': return 'decimal'
    case 'Binary': return (value as Binary).sub_type === Binary.SUBTYPE_UUID ? 'uuid' : 'binData'
    case 'Timestamp': return 'timestamp'
    case 'BSONRegExp': return 'regex'
    case 'MinKey': return 'minKey'
    case 'MaxKey': return 'maxKey'
    case 'Code': return 'javascript'
    default: return 'object'
  }
}

function isDocument(value: unknown): value is Record<string, unknown> {
  return bsonTypeOf(value) === 'object' && !(value as { _bsontype?: string })._bsontype
}

// Types of a document's fields, nested documents included as "parent.child" paths
export function documentTypes(doc: Record<string, unknown>, prefix = '', out: Record<string, BsonTypeName> = {}): Record<string, BsonTypeName> {
  for (const [key, value] of Object.entries(doc)) {
    const path = prefix ? `${prefix}.${key}` : key
    out[path] = bsonTypeOf(value)
    if (isDocument(value)) documentTypes(value, path, out)
  }
  return out
}

// Row types aligned with toRows(result)
export function resultTypes(result: unknown): Record<string, BsonTypeName>[] | undefined {
  if (Array.isArray(result)) return result.map(item => isDocument(item) ? documentTypes(item) : { value: bsonTypeOf(item) })
  if (isDocument(result)) return [documentTypes(result)]
  return undefined
}

function uniqueKeys(rows: Record<string, unknown>[]): string[] {
  const keys = new Set<string>()
  for (const row of rows) for (const key of Object.keys(row)) keys.add(key)
  return [...keys]
}

export async function runMongoShell(client: MongoClient, database: string | undefined, script: string, options: MongoShellOptions = {}): Promise<MongoShellResult> {
  const typed = !!options.typed
  const context = vm.createContext({
    ...shellHelpers(),
    print: () => {}, printjson: () => {},
    console: { log: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
  })
  const switchDb = (name: string) => { context.db = wrapDb(client, client.db(name), typed) }
  switchDb(database || client.db().databaseName)
  context.__shell = {
    use: (name: string) => { switchDb(name); return { message: `switched to db ${name}` } },
    show: async (what: string) => {
      switch (what) {
        case 'dbs': case 'databases': {
          const res = await client.db().admin().listDatabases()
          return res.databases.map(d => ({ name: d.name, sizeOnDisk: d.sizeOnDisk, empty: d.empty }))
        }
        case 'collections': case 'tables': {
          const list = await (context.db.listCollections({}, { nameOnly: true }) as AbstractCursor).toArray()
          return list.map((c: any) => ({ name: c.name, type: c.type })).sort((a, b) => a.name.localeCompare(b.name))
        }
        case 'users':
          return (await context.db.runCommand({ usersInfo: 1 })).users
        case 'roles':
          return (await context.db.runCommand({ rolesInfo: 1, showBuiltinRoles: true })).roles
        default:
          throw new Error(`Unknown show command: "show ${what}". Try "show dbs" or "show collections".`)
      }
    },
  }

  let compiled: string
  try {
    compiled = compileShellScript(script.trim())
  } catch (err) {
    throw new Error(`Invalid MongoDB shell syntax: ${err instanceof Error ? err.message : String(err)}`)
  }

  const start = Date.now()
  const { value } = await new vm.Script(compiled).runInContext(context, { timeout: 15000 })
  const ms = Date.now() - start
  const rows = toRows(value)
  return { rows, fields: uniqueKeys(rows), rowCount: rows.length, ms, types: resultTypes(value) }
}
