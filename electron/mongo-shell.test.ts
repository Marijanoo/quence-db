import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Decimal128, Long, MongoClient, ObjectId, UUID } from 'mongodb'
import { compileShellScript, preprocessShellCommands, runMongoShell, toPlain, toRows } from './mongo-shell'
import { buildMongoCellScript, buildMongoSetScript, MONGO_TYPE_OPTIONS, type MongoTargetType } from '../lib/mongo-cell'

describe('preprocessShellCommands', () => {
  it('rewrites use and show lines and leaves everything else alone', () => {
    const out = preprocessShellCommands('use shop\nshow collections;\ndb.users.find({ use: 1 })')
    expect(out.split('\n')).toEqual([
      '__shell.use("shop");',
      '__shell.show("collections");',
      'db.users.find({ use: 1 })',
    ])
  })
})

describe('compileShellScript', () => {
  it('awaits every top-level expression and keeps declarations', () => {
    const out = compileShellScript('const n = 1\ndb.a.insertOne({ n }); db.a.find()')
    expect(out).toContain('const n = 1')
    expect(out).toContain('__result = await (db.a.insertOne({ n }));')
    expect(out).toContain('__result = await (db.a.find());')
  })

  it('rejects SQL as invalid syntax', () => {
    expect(() => compileShellScript('SELECT * FROM users')).toThrow()
  })
})

describe('grid edit scripts', () => {
  it('reach updateOne with each field in its BSON type', async () => {
    let captured: { filter: any; update: any } | undefined
    const collection = {
      updateOne: async (filter: unknown, update: unknown) => {
        captured = { filter, update }
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }
      },
    }
    const client = { db: () => ({ databaseName: 'test', collection: () => collection }) } as unknown as MongoClient
    const script = buildMongoSetScript('posts', '64b7f0c2a1b2c3d4e5f60718', 'objectId', [
      { col: 'title', text: 'Hi', type: 'string' },
      { col: 'stats.views', text: '10', type: 'int' },
      { col: 'price', text: '9.99', type: 'decimal' },
      { col: 'publishedAt', text: '2026-09-24T10:00:00Z', type: 'date' },
    ])
    const res = await runMongoShell(client, 'test', script)

    expect(res.rows[0]).toMatchObject({ matchedCount: 1 })
    expect(captured!.filter._id).toBeInstanceOf(ObjectId)
    expect(captured!.filter._id.toHexString()).toBe('64b7f0c2a1b2c3d4e5f60718')
    const set = captured!.update.$set
    expect(set.title).toBe('Hi')
    expect(set['stats.views']._bsontype).toBe('Int32')
    expect(Number(set['stats.views'])).toBe(10)
    expect(set.price).toBeInstanceOf(Decimal128)
    expect(set.price.toString()).toBe('9.99')
    expect(set.publishedAt).toBeInstanceOf(Date)
    expect(set.publishedAt.toISOString()).toBe('2026-09-24T10:00:00.000Z')
  })
})

describe('toPlain / toRows', () => {
  it('converts BSON values into grid-friendly values', () => {
    const id = new ObjectId()
    expect(toPlain({
      _id: id,
      at: new Date(0),
      big: Long.fromString('9007199254740993'),
      small: Long.fromNumber(5),
      price: Decimal128.fromString('1.50'),
      uuid: new UUID('0f8fad5b-d9cb-469f-a165-70867728950e'),
      nested: { ids: [id] },
    })).toEqual({
      _id: id.toHexString(),
      at: '1970-01-01T00:00:00.000Z',
      big: '9007199254740993',
      small: 5,
      price: '1.50',
      uuid: '0f8fad5b-d9cb-469f-a165-70867728950e',
      nested: { ids: [id.toHexString()] },
    })
  })

  it('wraps scalars and arrays of scalars into rows', () => {
    expect(toRows(3)).toEqual([{ result: 3 }])
    expect(toRows(['a', 'b'])).toEqual([{ value: 'a' }, { value: 'b' }])
    expect(toRows({ ok: 1 })).toEqual([{ ok: 1 }])
    expect(toRows(undefined)).toEqual([])
  })
})

// Needs a running MongoDB, e.g. QUENCE_MONGO_TEST_URL=mongodb://localhost:27017
const url = process.env.QUENCE_MONGO_TEST_URL
const dbName = `quence_shell_test_${Date.now()}`

describe.skipIf(!url)('runMongoShell against MongoDB', () => {
  let client: MongoClient
  const run = (script: string, database: string | undefined = dbName) => runMongoShell(client, database, script)

  beforeAll(async () => {
    client = new MongoClient(url!)
    await client.connect()
    await client.db(dbName).collection('users').insertMany([
      { name: 'Ann', age: 31, tags: ['a'], address: { city: 'Zagreb' } },
      { name: 'Bob', age: 17, tags: ['b'] },
      { name: 'Cid', age: 45, tags: ['a', 'b'] },
    ])
  })

  afterAll(async () => {
    await client.db(dbName).dropDatabase()
    await client.close()
  })

  it('runs find with filter, sort, skip and limit', async () => {
    const res = await run('db.users.find({ age: { $gt: 18 } }).sort({ age: -1 }).limit(1)')
    expect(res.rows.map(r => r.name)).toEqual(['Cid'])
    expect(typeof res.rows[0]._id).toBe('string')
  })

  it('treats the second find argument as a projection', async () => {
    const res = await run('db.users.find({}, { name: 1, _id: 0 }).sort({ name: 1 })')
    expect(res.rows).toEqual([{ name: 'Ann' }, { name: 'Bob' }, { name: 'Cid' }])
    expect(res.fields).toEqual(['name'])
  })

  it('supports getCollection, pretty, count and toArray', async () => {
    expect((await run('db.getCollection("users").find().pretty().toArray()')).rowCount).toBe(3)
    expect((await run('db.users.find({ tags: "a" }).count()')).rows).toEqual([{ result: 2 }])
    expect((await run('db.users.countDocuments()')).rows).toEqual([{ result: 3 }])
  })

  it('runs statements in order and returns the last result', async () => {
    const res = await run(`
      db.scratch.insertOne({ _id: ObjectId("64b000000000000000000001"), at: ISODate("2024-01-02T00:00:00Z"), n: NumberLong(7) })
      db.scratch.updateOne({ n: 7 }, { $set: { done: true } })
      db.scratch.findOne({ _id: new ObjectId("64b000000000000000000001") })
    `)
    expect(res.rows).toEqual([{ _id: '64b000000000000000000001', at: '2024-01-02T00:00:00.000Z', n: 7, done: true }])
  })

  it('supports variables, top-level await and aggregate', async () => {
    const res = await run(`
      const minAge = 18
      const docs = await db.users.aggregate([{ $match: { age: { $gte: minAge } } }, { $group: { _id: null, total: { $sum: "$age" } } }]).toArray()
      docs
    `)
    expect(res.rows).toEqual([{ _id: null, total: 76 }])
  })

  it('returns distinct values as rows', async () => {
    const res = await run('db.users.distinct("tags")')
    expect(res.rows).toEqual([{ value: 'a' }, { value: 'b' }])
  })

  it('supports use, show collections and legacy insert/remove', async () => {
    const res = await run(`use ${dbName}\ndb.legacy.insert([{ x: 1 }, { x: 2 }])\ndb.legacy.remove({ x: 1 })\nshow collections`, 'test')
    expect(res.rows.map(r => r.name)).toEqual(['legacy', 'scratch', 'users'])
    expect((await run('db.legacy.find({}, { _id: 0 })')).rows).toEqual([{ x: 2 }])
  })

  it('reports exact BSON types in typed mode', async () => {
    await run(`db.typed.insertOne({ _id: "t1", i: NumberInt(5), d: new Double(5), l: NumberLong("5"), s: "5", n: null, o: { x: true } })`)
    const plain = await run('db.typed.find({ _id: "t1" })')
    expect(plain.types?.[0].i).toBe('int')
    expect(plain.types?.[0].d).toBe('int') // untyped: the driver hands back a plain 5
    const typed = await runMongoShell(client, dbName, 'db.typed.find({ _id: "t1" })', { typed: true })
    expect(typed.types?.[0]).toEqual({ _id: 'string', i: 'int', d: 'double', l: 'long', s: 'string', n: 'null', o: 'object', 'o.x': 'bool' })
    expect(typed.rows[0]).toMatchObject({ i: 5, d: 5, l: 5, s: '5' })
  })

  it.each(MONGO_TYPE_OPTIONS.map(o => o.type))('changes a field type to %s', async (to: MongoTargetType) => {
    const values: Partial<Record<MongoTargetType, [unknown, string]>> = {
      string: [12, 'int'],
      objectId: ['64b000000000000000000009', 'string'],
      date: ['2024-01-02T00:00:00Z', 'string'],
      object: ['{"a":1}', 'string'],
    }
    const [value, fromType] = values[to] ?? ['12', 'string']
    const id = `conv-${to}`
    await run(`db.conv.insertOne({ _id: ${JSON.stringify(id)}, f: ${JSON.stringify(value)} })`)
    const script = buildMongoCellScript('conv', id, 'string', { kind: 'changeType', col: 'f', to }, value, fromType)
    expect((await run(script)).rows[0]).toMatchObject({ matchedCount: 1, modifiedCount: 1 })
    const bsonType = to === 'bool' ? 'bool' : to === 'long' ? 'long' : to
    expect((await run(`db.conv.countDocuments({ _id: ${JSON.stringify(id)}, f: { $type: ${JSON.stringify(bsonType)} } })`)).rows).toEqual([{ result: 1 }])
  })

  it('unsets fields and deletes documents by _id', async () => {
    await run('db.cells.insertOne({ _id: ObjectId("64b0000000000000000000aa"), a: 1, b: 2 })')
    await run(buildMongoCellScript('cells', '64b0000000000000000000aa', 'objectId', { kind: 'unset', col: 'a' }))
    expect((await run('db.cells.findOne({}, { _id: 0 })')).rows).toEqual([{ b: 2 }])
    const del = await run(buildMongoCellScript('cells', '64b0000000000000000000aa', 'objectId', { kind: 'deleteDocument' }))
    expect(del.rows[0]).toMatchObject({ deletedCount: 1 })
  })

  it('reports SQL as invalid shell syntax', async () => {
    await expect(run('SELECT * FROM users')).rejects.toThrow(/Invalid MongoDB shell syntax/)
  })

  it('reports server errors', async () => {
    await expect(run('db.users.find({ $bogus: 1 })')).rejects.toThrow(/bogus/)
  })
})
