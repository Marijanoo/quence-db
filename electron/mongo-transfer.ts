import { randomUUID } from 'crypto'
import { BSON, MongoClient, MongoBulkWriteError, type FindCursor, type IndexDescription } from 'mongodb'

const { EJSON } = BSON

// Database export/import for MongoDB, in the formats mongoexport/mongodump use: one Extended JSON
// (canonical, so Int32/Int64/Double/Decimal128/dates survive) document per line, and per
// collection a metadata document with its options and indexes.
//
// Export reads each collection through one server cursor that stays open across IPC calls, so
// documents come in natural order whatever their _id types are.

export interface CollectionMetadata {
  name: string
  type: 'collection' | 'view' | 'timeseries'
  options: Record<string, unknown>     // createCollection options (capped, validator, viewOn, ...)
  indexes: Record<string, unknown>[]   // listIndexes() output
}

const exportCursors = new Map<string, { cursor: FindCursor; timer: ReturnType<typeof setTimeout> }>()
const CURSOR_IDLE_MS = 10 * 60 * 1000

function touch(cursorId: string) {
  const entry = exportCursors.get(cursorId)
  if (!entry) return undefined
  clearTimeout(entry.timer)
  entry.timer = setTimeout(() => { void closeExportCursor(cursorId) }, CURSOR_IDLE_MS)
  return entry
}

export async function listCollectionsForExport(client: MongoClient, database: string): Promise<{ metadata: string; estimate: number }[]> {
  const db = client.db(database)
  const infos = await db.listCollections({}, { nameOnly: false }).toArray()
  const out: { metadata: string; estimate: number }[] = []
  for (const info of infos.sort((a, b) => a.name.localeCompare(b.name))) {
    if (info.name.startsWith('system.')) continue
    const type = (info.type ?? 'collection') as CollectionMetadata['type']
    const isView = type === 'view'
    const indexes = isView ? [] : await db.collection(info.name).listIndexes().toArray()
    const estimate = isView ? 0 : await db.collection(info.name).estimatedDocumentCount()
    const metadata: CollectionMetadata = { name: info.name, type, options: (info as { options?: Record<string, unknown> }).options ?? {}, indexes }
    out.push({ metadata: EJSON.stringify(metadata, { relaxed: false }), estimate })
  }
  return out
}

export function openExportCursor(client: MongoClient, database: string, collection: string): string {
  const cursor = client.db(database).collection(collection).find({}, { noCursorTimeout: false, batchSize: 1000, promoteValues: false, promoteLongs: false })
  const cursorId = randomUUID()
  exportCursors.set(cursorId, { cursor, timer: setTimeout(() => {}, 0) })
  touch(cursorId)
  return cursorId
}

// Up to `limit` documents as canonical Extended JSON lines; done when the cursor is exhausted
export async function readExportCursor(cursorId: string, limit: number): Promise<{ lines: string[]; done: boolean }> {
  const entry = touch(cursorId)
  if (!entry) throw new Error('Export cursor not found (it may have timed out)')
  const lines: string[] = []
  while (lines.length < limit) {
    const doc = await entry.cursor.next()
    if (doc === null) {
      await closeExportCursor(cursorId)
      return { lines, done: true }
    }
    lines.push(EJSON.stringify(doc, { relaxed: false }))
  }
  return { lines, done: false }
}

export async function closeExportCursor(cursorId: string) {
  const entry = exportCursors.get(cursorId)
  if (!entry) return
  exportCursors.delete(cursorId)
  clearTimeout(entry.timer)
  await entry.cursor.close().catch(() => {})
}

// Creates the collection (or view) the metadata describes. `drop` replaces an existing one;
// otherwise an existing collection is kept and documents are added to it.
export async function prepareCollection(client: MongoClient, database: string, metadataText: string, drop: boolean): Promise<{ created: boolean }> {
  const metadata = EJSON.parse(metadataText, { relaxed: false }) as CollectionMetadata
  const db = client.db(database)
  const exists = (await db.listCollections({ name: metadata.name }, { nameOnly: true }).toArray()).length > 0
  if (exists && drop) await db.collection(metadata.name).drop()
  if (!exists || drop) {
    await db.createCollection(metadata.name, metadata.options as never)
    return { created: true }
  }
  return { created: false }
}

// Parses Extended JSON (canonical or relaxed, as mongoexport writes either) and inserts the
// documents. Unordered, so one bad document (e.g. a duplicate _id) doesn't stop the rest.
export async function importDocuments(client: MongoClient, database: string, collection: string, texts: string[]): Promise<{ inserted: number; errors: string[] }> {
  const docs: Record<string, unknown>[] = []
  const errors: string[] = []
  texts.forEach((text, i) => {
    try {
      const doc = EJSON.parse(text, { relaxed: false })
      // Canonical parsing turns a bare number into an Int32/Double object, so check for a plain document
      const isDocument = doc !== null && typeof doc === 'object' && !Array.isArray(doc) && !(doc as { _bsontype?: string })._bsontype
      if (!isDocument) errors.push(`Item ${i + 1}: not a document`)
      else docs.push(doc as Record<string, unknown>)
    } catch (err) {
      errors.push(`Item ${i + 1}: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
  if (docs.length === 0) return { inserted: 0, errors }
  try {
    const res = await client.db(database).collection(collection).insertMany(docs, { ordered: false })
    return { inserted: res.insertedCount, errors }
  } catch (err) {
    if (err instanceof MongoBulkWriteError) {
      const writeErrors = (Array.isArray(err.writeErrors) ? err.writeErrors : [err.writeErrors]).filter(Boolean)
      const messages = writeErrors.length ? writeErrors.map(e => e.errmsg ?? String(e)) : [err.message]
      return { inserted: err.result.insertedCount, errors: [...errors, ...messages] }
    }
    throw err
  }
}

// Recreates the indexes from the metadata (the default _id index always exists)
export async function createIndexesFromMetadata(client: MongoClient, database: string, metadataText: string): Promise<{ created: number }> {
  const metadata = EJSON.parse(metadataText, { relaxed: false }) as CollectionMetadata
  const specs = metadata.indexes
    .filter(ix => ix.name !== '_id_')
    .map(ix => {
      const { v: _v, ns: _ns, key, ...options } = ix as { v?: unknown; ns?: unknown; key: Record<string, unknown> }
      return { key, ...options } as IndexDescription
    })
  if (specs.length === 0) return { created: 0 }
  await client.db(database).collection(metadata.name).createIndexes(specs)
  return { created: specs.length }
}
