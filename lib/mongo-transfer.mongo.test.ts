// MongoDB database export/import round trip: every BSON type, indexes, options and views survive.
// Opt-in: set QUENCE_MONGO_TEST_URL, e.g. mongodb://localhost:27017.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BSON, Decimal128, Double, Int32, Long, MongoClient, ObjectId, UUID } from 'mongodb'
import {
  closeExportCursor, createIndexesFromMetadata, importDocuments, listCollectionsForExport, openExportCursor,
  prepareCollection, readExportCursor,
} from '../electron/mongo-transfer'
import {
  collectionFileBase, parseCollections, planFolderImport, runMongoExport, runMongoImport, type FolderIO, type MongoTransferIO,
} from './mongo-transfer'

const url = process.env.QUENCE_MONGO_TEST_URL
const suffix = Math.random().toString(36).slice(2, 8)
const SOURCE = `qexp_src_${suffix}`
const TARGET = `qexp_dst_${suffix}`

function transferIO(client: MongoClient, db: string): MongoTransferIO {
  return {
    exportCollections: () => listCollectionsForExport(client, db),
    exportOpen: async c => openExportCursor(client, db, c),
    exportRead: (id, n) => readExportCursor(id, n),
    exportClose: id => closeExportCursor(id),
    importPrepare: async (m, drop) => { await prepareCollection(client, db, m, drop) },
    importDocuments: (c, docs) => importDocuments(client, db, c, docs),
    importIndexes: async m => (await createIndexesFromMetadata(client, db, m)).created,
  }
}

function memoryFolder(files: Map<string, string>, chunk = 100): FolderIO {
  return {
    create: async name => {
      files.set(name, '')
      return { write: async t => { files.set(name, files.get(name)! + t) }, close: async discard => { if (discard) files.delete(name) } }
    },
    open: async name => {
      const text = files.get(name)!
      let pos = 0
      return {
        size: text.length,
        read: async () => { const t = text.slice(pos, pos + chunk); pos += t.length; return { text: t, done: t.length === 0, position: pos } },
        close: async () => {},
      }
    },
  }
}

const canonical = (docs: unknown[]) => docs.map(d => BSON.EJSON.stringify(d, { relaxed: false }))

describe.skipIf(!url)('MongoDB database export and import', () => {
  let client: MongoClient

  beforeAll(async () => {
    client = new MongoClient(url!)
    await client.connect()
    const db = client.db(SOURCE)
    await db.createCollection('capped:logs', { capped: true, size: 100000 })
    await db.collection('capped:logs').insertOne({ _id: 1 as never, msg: 'hi' })
    await db.collection('people').insertMany([
      {
        _id: new ObjectId('64b000000000000000000001'), name: 'Ann', age: new Int32(31), score: new Double(5), big: Long.fromString('9007199254740993'),
        price: Decimal128.fromString('1.50'), at: new Date('2026-01-02T03:04:05.678Z'), tags: ['a', 'b'], uuid: new UUID('0f8fad5b-d9cb-469f-a165-70867728950e'),
        nested: { deep: { x: null } }, re: /ab+c/i,
      },
      { _id: 'string-id' as never, name: 'Bob' },
      { _id: 42 as never, name: 'Cy' },
    ])
    await db.collection('people').createIndex({ name: 1 }, { unique: true, name: 'name_unique' })
    await db.collection('people').createIndex({ at: -1, age: 1 }, { partialFilterExpression: { age: { $gt: 18 } } })
    await db.createCollection('adults', { viewOn: 'people', pipeline: [{ $match: { age: { $gte: 18 } } }] })
  })

  afterAll(async () => {
    await client.db(SOURCE).dropDatabase()
    await client.db(TARGET).dropDatabase()
    await client.close()
  })

  it('exports a database to a folder and imports it with identical documents, indexes and views', async () => {
    const files = new Map<string, string>()
    const source = transferIO(client, SOURCE)
    const collections = parseCollections(await source.exportCollections())
    expect(collections.map(c => [c.name, c.type])).toEqual([['adults', 'view'], ['capped:logs', 'collection'], ['people', 'collection']])

    const exported = await runMongoExport(source, memoryFolder(files), collections, { batchSize: 2 })
    expect(exported).toEqual({ collections: 3, documents: 4 })
    expect([...files.keys()].sort()).toEqual(['adults.metadata.json', 'capped%3Alogs.json', 'capped%3Alogs.metadata.json', 'people.json', 'people.metadata.json'])
    expect(files.get('people.json')!.trim().split('\n')).toHaveLength(3)

    const folder = memoryFolder(files, 37)
    const entries = await planFolderImport([...files].map(([name, text]) => ({ name, size: text.length })), async n => files.get(n)!)
    expect(entries.map(e => e.collection)).toEqual(['capped:logs', 'people', 'adults'])
    for (let round = 0; round < 2; round++) { // drop: importing twice replaces
      const res = await runMongoImport(transferIO(client, TARGET), folder, entries, { drop: true, batchSize: 2 })
      expect(res.errors).toEqual([])
      expect(res.documents).toBe(4)
    }

    const src = client.db(SOURCE), dst = client.db(TARGET)
    const all = async (db: typeof src, c: string) => canonical(await db.collection(c).find({}, { promoteValues: false }).sort({ name: 1 }).toArray())
    expect(await all(dst, 'people')).toEqual(await all(src, 'people'))
    const indexes = async (db: typeof src) => (await db.collection('people').indexes()).map(({ v: _v, ...ix }) => ix)
    expect(await indexes(dst)).toEqual(await indexes(src))
    expect(await dst.collection('adults').countDocuments()).toBe(1)
    const info = await dst.listCollections({ name: 'capped:logs' }).toArray()
    expect((info[0] as { options?: { capped?: boolean } }).options?.capped).toBe(true)
  })

  it('imports a plain JSON array or JSON Lines file into a named collection, reporting bad documents', async () => {
    const files = new Map([
      ['items.json', '[{"_id": 1, "a": {"$date": "2026-01-01T00:00:00Z"}}, {"_id": 1}, 5, {"_id": 2}]'],
    ])
    const res = await runMongoImport(transferIO(client, TARGET), memoryFolder(files, 7), [{ collection: 'from_file', dataFile: 'items.json', isView: false, size: 100 }], { drop: false })
    expect(res.documents).toBe(2)
    expect(res.failed).toBe(2) // the duplicate _id and the number
    expect(res.errors.join('\n')).toMatch(/duplicate key/)
    const doc = await client.db(TARGET).collection('from_file').findOne({ _id: 1 as never })
    expect(doc?.a).toBeInstanceOf(Date)
  })
})

describe('collectionFileBase', () => {
  it('escapes characters Windows forbids and keeps names unique', () => {
    const taken = new Set<string>()
    expect(collectionFileBase('a:b/c', taken)).toBe('a%3Ab%2Fc')
    expect(collectionFileBase('Users', taken)).toBe('Users')
    expect(collectionFileBase('users', taken)).toBe('users~2')
  })
})
