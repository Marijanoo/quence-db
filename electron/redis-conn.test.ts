// Redis browsing and editing against a real server. Opt-in: QUENCE_REDIS_TEST_URL, e.g.
// redis://localhost:6379 (the tests use databases 13 and 14 and empty them).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  parseCommandLine, parseInfo, redisCloseAll, redisCommand, redisConnect, redisDatabases, redisEdit, redisGet, redisScan,
} from './redis-conn'

describe('parseCommandLine', () => {
  it('splits like redis-cli', () => {
    expect(parseCommandLine('SET "my key" \'a b\' x"y z"')).toEqual(['SET', 'my key', 'a b', 'xy z'])
    expect(parseCommandLine('  GET  k  ')).toEqual(['GET', 'k'])
    expect(parseCommandLine('SET k "line\\nbreak \\"q\\""')).toEqual(['SET', 'k', 'line\nbreak "q"'])
    expect(() => parseCommandLine('GET "open')).toThrow(/Unbalanced/)
  })

  it('parses INFO sections', () => {
    expect(parseInfo('# Server\r\nredis_version:7.2.4\r\n\r\n# Keyspace\r\ndb0:keys=3,expires=0\r\n')).toEqual({
      server: { redis_version: '7.2.4' }, keyspace: { db0: 'keys=3,expires=0' },
    })
  })
})

const url = process.env.QUENCE_REDIS_TEST_URL
const DB = 13

describe.skipIf(!url)('Redis against a server', () => {
  beforeAll(async () => {
    await redisConnect('r', { host: url! })
    await redisCommand('r', DB, 'FLUSHDB')
    await redisCommand('r', 14, 'FLUSHDB')
    await redisCommand('r', DB, 'SET "user:1:name" Ann')
    await redisCommand('r', DB, 'HSET user:1 name Ann age 31')
    await redisCommand('r', DB, 'RPUSH queue a b c d')
    await redisCommand('r', DB, 'SADD tags red green')
    await redisCommand('r', DB, 'ZADD scores 10 ann 20 bob')
    await redisCommand('r', DB, 'XADD events * kind click x 1')
    await redisCommand('r', DB, 'SET session:9 token EX 600')
    await redisCommand('r', 14, 'SET other 1')
  })

  afterAll(async () => {
    await redisCommand('r', DB, 'FLUSHDB')
    await redisCommand('r', 14, 'FLUSHDB')
    await redisCloseAll()
  })

  it('lists databases with key counts', async () => {
    const dbs = await redisDatabases('r')
    expect(dbs.length).toBeGreaterThanOrEqual(15)
    expect(dbs[DB]).toEqual({ index: DB, keys: 7 })
    expect(dbs[14]).toEqual({ index: 14, keys: 1 })
  })

  it('scans keys with their types and TTLs, by pattern and type', async () => {
    const all: { key: string; type: string; ttl: number }[] = []
    let cursor = '0'
    do { const r = await redisScan('r', DB, { cursor, count: 2 }); all.push(...r.keys); cursor = r.cursor } while (cursor !== '0')
    expect(all.map(k => k.key).sort()).toEqual(['events', 'queue', 'scores', 'session:9', 'tags', 'user:1', 'user:1:name'])
    expect(all.find(k => k.key === 'session:9')!.ttl).toBeGreaterThan(500_000)
    expect(all.find(k => k.key === 'queue')).toMatchObject({ type: 'list', ttl: -1 })
    const users = (await redisScan('r', DB, { pattern: 'user:*' })).keys.map(k => k.key).sort()
    expect(users).toEqual(['user:1', 'user:1:name'])
    expect((await redisScan('r', DB, { type: 'hash' })).keys.map(k => k.key)).toEqual(['user:1'])
  })

  it('reads every type, capping collections', async () => {
    expect(await redisGet('r', DB, 'user:1:name')).toMatchObject({ type: 'string', value: 'Ann', size: 3, truncated: false })
    expect((await redisGet('r', DB, 'user:1')).fields).toEqual(expect.arrayContaining([{ field: 'name', value: 'Ann' }, { field: 'age', value: '31' }]))
    expect(await redisGet('r', DB, 'queue', { limit: 2 })).toMatchObject({ size: 4, truncated: true, items: [{ index: 0, value: 'a' }, { index: 1, value: 'b' }] })
    expect(((await redisGet('r', DB, 'tags')).members as string[]).sort()).toEqual(['green', 'red'])
    expect((await redisGet('r', DB, 'scores')).members).toEqual([{ member: 'ann', score: '10' }, { member: 'bob', score: '20' }])
    expect((await redisGet('r', DB, 'events')).entries).toEqual([{ id: expect.any(String), fields: { kind: 'click', x: '1' } }])
    await expect(redisGet('r', DB, 'nope')).rejects.toThrow(/does not exist/)
  })

  it('edits values, keeping a string TTL, and renames, expires and deletes keys', async () => {
    await redisEdit('r', DB, { op: 'setString', key: 'session:9', value: 'new' })
    expect(await redisGet('r', DB, 'session:9')).toMatchObject({ value: 'new', ttl: expect.any(Number) })
    expect((await redisGet('r', DB, 'session:9')).ttl).toBeGreaterThan(0)

    await redisEdit('r', DB, { op: 'hashSet', key: 'user:1', field: 'age', value: '32' })
    await redisEdit('r', DB, { op: 'hashDelete', key: 'user:1', field: 'name' })
    expect((await redisGet('r', DB, 'user:1')).fields).toEqual([{ field: 'age', value: '32' }])

    await redisEdit('r', DB, { op: 'listSet', key: 'queue', index: 0, value: 'A' })
    await redisEdit('r', DB, { op: 'listRemove', key: 'queue', index: 2 })
    await redisEdit('r', DB, { op: 'listPush', key: 'queue', value: 'z', end: 'head' })
    expect((await redisGet('r', DB, 'queue')).items!.map((i: { value: string }) => i.value)).toEqual(['z', 'A', 'b', 'd'])

    await redisEdit('r', DB, { op: 'zsetAdd', key: 'scores', member: 'cy', score: 15 })
    await redisEdit('r', DB, { op: 'setRemove', key: 'tags', member: 'red' })
    expect((await redisGet('r', DB, 'scores')).members!.map((m: { member: string }) => m.member)).toEqual(['ann', 'cy', 'bob'])

    await redisEdit('r', DB, { op: 'rename', key: 'tags', newKey: 'colors' })
    await expect(redisEdit('r', DB, { op: 'rename', key: 'colors', newKey: 'queue' })).rejects.toThrow(/already exists/)
    await redisEdit('r', DB, { op: 'expire', key: 'colors', seconds: 100 })
    expect((await redisGet('r', DB, 'colors')).ttl).toBeGreaterThan(90_000)
    await redisEdit('r', DB, { op: 'expire', key: 'colors', seconds: null })
    expect((await redisGet('r', DB, 'colors')).ttl).toBe(-1)
    expect(await redisEdit('r', DB, { op: 'delete', keys: ['colors', 'events'] })).toEqual({ changed: 2 })
  })

  it('runs console commands in the chosen database, and refuses SELECT', async () => {
    expect((await redisCommand('r', 14, 'GET other')).reply).toBe('1')
    expect((await redisCommand('r', DB, 'GET other')).reply).toBeNull()
    expect((await redisCommand('r', DB, 'HGETALL user:1')).reply).toEqual(['age', '32'])
    await expect(redisCommand('r', DB, 'select 2')).rejects.toThrow(/pick the database/)
  })
})
