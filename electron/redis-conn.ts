import Redis, { type RedisOptions } from 'ioredis'

// Redis connections: browse keys with SCAN (never KEYS, which blocks the server), read values of
// every type with size caps, edit them, and run raw commands. Each logical database (db0, db1, …)
// gets its own client, so work in two databases never mixes up their SELECTs.

export interface RedisConnectOptions {
  host: string        // a hostname, or a redis:// / rediss:// URL
  port?: number
  user?: string
  password?: string
  database?: string   // default database index, as text
  ssl?: boolean
}

export type RedisType = 'string' | 'hash' | 'list' | 'set' | 'zset' | 'stream' | 'ReJSON-RL' | string

const conns = new Map<string, { options: RedisOptions; url?: string; clients: Map<number, Redis> }>()

function baseOptions(o: RedisConnectOptions): { options: RedisOptions; url?: string } {
  const common: RedisOptions = { lazyConnect: true, connectTimeout: 10_000, maxRetriesPerRequest: 1, enableOfflineQueue: true }
  if (/^rediss?:\/\//i.test(o.host)) return { options: common, url: o.host }
  return {
    options: {
      ...common,
      host: o.host || 'localhost',
      port: o.port || 6379,
      username: o.user || undefined,
      password: o.password || undefined,
      tls: o.ssl ? {} : undefined,
    },
  }
}

async function newClient(c: { options: RedisOptions; url?: string }, db: number): Promise<Redis> {
  const client = c.url ? new Redis(c.url, { ...c.options, db }) : new Redis({ ...c.options, db })
  client.on('error', () => { /* surfaced by the failing command */ })
  await client.connect()
  return client
}

export async function redisConnect(id: string, o: RedisConnectOptions): Promise<void> {
  await redisDisconnect(id)
  const base = baseOptions(o)
  const db = Number.parseInt(o.database ?? '', 10)
  const client = await newClient(base, Number.isInteger(db) && db >= 0 ? db : 0)
  try {
    await client.ping()
  } catch (err) {
    client.disconnect()
    throw err
  }
  conns.set(id, { ...base, clients: new Map([[client.options.db ?? 0, client]]) })
}

export async function redisDisconnect(id: string) {
  const c = conns.get(id)
  conns.delete(id)
  for (const client of c?.clients.values() ?? []) client.disconnect()
}

export function redisConnected(id: string) {
  return conns.has(id)
}

export async function redisCloseAll() {
  for (const id of [...conns.keys()]) await redisDisconnect(id)
}

async function clientFor(id: string, db: number): Promise<Redis> {
  const c = conns.get(id)
  if (!c) throw new Error('Not connected')
  let client = c.clients.get(db)
  if (!client) {
    client = await newClient(c, db)
    c.clients.set(db, client)
  }
  return client
}

// ── Databases ─────────────────────────────────────────────────────────────────

export function parseInfo(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  let section = 'server'
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('# ')) { section = line.slice(2).trim().toLowerCase(); out[section] = {}; continue }
    const i = line.indexOf(':')
    if (i > 0) (out[section] ??= {})[line.slice(0, i)] = line.slice(i + 1)
  }
  return out
}

// db0 … dbN-1 with their key counts (managed services may hide CONFIG; then 16, the default)
export async function redisDatabases(id: string): Promise<{ index: number; keys: number }[]> {
  const client = await clientFor(id, 0)
  let count = 16
  try {
    const cfg = await client.config('GET', 'databases') as string[]
    if (cfg?.[1]) count = Number(cfg[1]) || count
  } catch { /* CONFIG not allowed */ }
  const keyspace = parseInfo(await client.info('keyspace')).keyspace ?? {}
  return Array.from({ length: count }, (_, index) => ({
    index,
    keys: Number(/keys=(\d+)/.exec(keyspace[`db${index}`] ?? '')?.[1] ?? 0),
  }))
}

export async function redisInfo(id: string) {
  const client = await clientFor(id, 0)
  return parseInfo(await client.info())
}

// ── Keys ──────────────────────────────────────────────────────────────────────

export interface KeyEntry { key: string; type: RedisType; ttl: number } // ttl in ms; -1 none, -2 gone

export async function redisScan(id: string, db: number, opts: { pattern?: string; cursor?: string; count?: number; type?: string }): Promise<{ cursor: string; keys: KeyEntry[] }> {
  const client = await clientFor(id, db)
  const args: (string | number)[] = [opts.cursor ?? '0', 'MATCH', opts.pattern || '*', 'COUNT', opts.count ?? 500]
  if (opts.type) args.push('TYPE', opts.type)
  const [cursor, keys] = await client.call('SCAN', ...args) as [string, string[]]
  if (keys.length === 0) return { cursor, keys: [] }
  const pipe = client.pipeline()
  for (const k of keys) pipe.type(k).pttl(k)
  const res = await pipe.exec() ?? []
  return {
    cursor,
    keys: keys.map((key, i) => ({ key, type: String(res[i * 2]?.[1] ?? 'none'), ttl: Number(res[i * 2 + 1]?.[1] ?? -1) })),
  }
}

export const VALUE_LIMIT = 500          // items read from a collection
export const STRING_LIMIT = 256 * 1024  // bytes read from a string

export async function redisGet(id: string, db: number, key: string, opts: { limit?: number } = {}) {
  const client = await clientFor(id, db)
  const limit = Math.max(1, Math.min(opts.limit ?? VALUE_LIMIT, 10_000))
  const [type, ttl] = await Promise.all([client.type(key), client.pttl(key)])
  const base = { key, type, ttl }
  switch (type) {
    case 'none':
      throw new Error(`Key ${JSON.stringify(key)} does not exist`)
    case 'string': {
      const size = await client.strlen(key)
      const value = size > STRING_LIMIT ? await client.getrange(key, 0, STRING_LIMIT - 1) : await client.get(key)
      return { ...base, size, truncated: size > STRING_LIMIT, value: value ?? '' }
    }
    case 'hash': {
      const size = await client.hlen(key)
      const fields: { field: string; value: string }[] = []
      let cursor = '0'
      do {
        const [next, flat] = await client.hscan(key, cursor, 'COUNT', 500)
        for (let i = 0; i < flat.length && fields.length < limit; i += 2) fields.push({ field: flat[i], value: flat[i + 1] })
        cursor = next
      } while (cursor !== '0' && fields.length < limit)
      return { ...base, size, truncated: size > fields.length, fields }
    }
    case 'list': {
      const size = await client.llen(key)
      const items = (await client.lrange(key, 0, limit - 1)).map((value, index) => ({ index, value }))
      return { ...base, size, truncated: size > items.length, items }
    }
    case 'set': {
      const size = await client.scard(key)
      const members: string[] = []
      let cursor = '0'
      do {
        const [next, batch] = await client.sscan(key, cursor, 'COUNT', 500)
        members.push(...batch.slice(0, limit - members.length))
        cursor = next
      } while (cursor !== '0' && members.length < limit)
      return { ...base, size, truncated: size > members.length, members }
    }
    case 'zset': {
      const size = await client.zcard(key)
      const flat = await client.zrange(key, 0, limit - 1, 'WITHSCORES')
      const members: { member: string; score: string }[] = []
      for (let i = 0; i < flat.length; i += 2) members.push({ member: flat[i], score: flat[i + 1] })
      return { ...base, size, truncated: size > members.length, members }
    }
    case 'stream': {
      const size = await client.xlen(key)
      const raw = await client.xrevrange(key, '+', '-', 'COUNT', limit)
      const entries = raw.map(([entryId, flat]) => {
        const fields: Record<string, string> = {}
        for (let i = 0; i < flat.length; i += 2) fields[flat[i]] = flat[i + 1]
        return { id: entryId, fields }
      })
      return { ...base, size, truncated: size > entries.length, entries }
    }
    case 'ReJSON-RL': {
      const value = await client.call('JSON.GET', key) as string
      return { ...base, size: value.length, truncated: false, value }
    }
    default:
      return { ...base, size: 0, truncated: false, unsupported: true }
  }
}

// ── Editing ───────────────────────────────────────────────────────────────────

export type RedisEdit =
  | { op: 'setString'; key: string; value: string }
  | { op: 'hashSet'; key: string; field: string; value: string }
  | { op: 'hashDelete'; key: string; field: string }
  | { op: 'listSet'; key: string; index: number; value: string }
  | { op: 'listPush'; key: string; value: string; end: 'head' | 'tail' }
  | { op: 'listRemove'; key: string; index: number }
  | { op: 'setAdd'; key: string; member: string }
  | { op: 'setRemove'; key: string; member: string }
  | { op: 'zsetAdd'; key: string; member: string; score: number }
  | { op: 'zsetRemove'; key: string; member: string }
  | { op: 'streamAdd'; key: string; fields: Record<string, string> }
  | { op: 'streamDelete'; key: string; id: string }
  | { op: 'delete'; keys: string[] }
  | { op: 'rename'; key: string; newKey: string }
  | { op: 'expire'; key: string; seconds: number | null } // null: no expiry

export async function redisEdit(id: string, db: number, e: RedisEdit): Promise<{ changed: number }> {
  const client = await clientFor(id, db)
  switch (e.op) {
    case 'setString': await client.set(e.key, e.value, 'KEEPTTL'); return { changed: 1 }
    case 'hashSet': return { changed: (await client.hset(e.key, e.field, e.value)) || 1 }
    case 'hashDelete': return { changed: await client.hdel(e.key, e.field) }
    case 'listSet': await client.lset(e.key, e.index, e.value); return { changed: 1 }
    case 'listPush': return { changed: e.end === 'head' ? await client.lpush(e.key, e.value) && 1 : await client.rpush(e.key, e.value) && 1 }
    case 'listRemove': {
      // Lists remove by value; mark the item with a unique value first so only it goes
      const marker = `__quence_remove_${Date.now()}_${Math.random().toString(36).slice(2)}`
      const res = await client.multi().lset(e.key, e.index, marker).lrem(e.key, 1, marker).exec()
      const failed = res?.find(([err]) => err)
      if (failed) throw failed[0]
      return { changed: 1 }
    }
    case 'setAdd': return { changed: await client.sadd(e.key, e.member) }
    case 'setRemove': return { changed: await client.srem(e.key, e.member) }
    case 'zsetAdd': await client.zadd(e.key, e.score, e.member); return { changed: 1 }
    case 'zsetRemove': return { changed: await client.zrem(e.key, e.member) }
    case 'streamAdd': {
      const flat = Object.entries(e.fields).flat()
      if (!flat.length) throw new Error('A stream entry needs at least one field')
      await client.xadd(e.key, '*', ...flat)
      return { changed: 1 }
    }
    case 'streamDelete': return { changed: await client.xdel(e.key, e.id) }
    case 'delete': return { changed: e.keys.length ? await client.del(...e.keys) : 0 }
    case 'rename': {
      if (!e.newKey) throw new Error('The new name is empty')
      if (!await client.renamenx(e.key, e.newKey)) throw new Error(`A key named ${JSON.stringify(e.newKey)} already exists`)
      return { changed: 1 }
    }
    case 'expire':
      return { changed: e.seconds === null ? await client.persist(e.key) : await client.expire(e.key, Math.max(1, Math.round(e.seconds))) }
  }
}

// ── Console ───────────────────────────────────────────────────────────────────

// Splits a command line like redis-cli does: spaces separate arguments, "…" and '…' quote them
export function parseCommandLine(line: string): string[] {
  const args: string[] = []
  let i = 0
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++
    if (i >= line.length) break
    let arg = ''
    while (i < line.length && !/\s/.test(line[i])) {
      const ch = line[i]
      if (ch === '"' || ch === "'") {
        i++
        while (i < line.length && line[i] !== ch) {
          if (ch === '"' && line[i] === '\\' && i + 1 < line.length) {
            const n = line[i + 1]
            arg += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n
            i += 2
            continue
          }
          arg += line[i++]
        }
        if (line[i] !== ch) throw new Error('Unbalanced quotes')
        i++
      } else {
        arg += ch
        i++
      }
    }
    args.push(arg)
  }
  return args
}

export async function redisCommand(id: string, db: number, line: string): Promise<{ reply: unknown; ms: number }> {
  const [command, ...args] = parseCommandLine(line)
  if (!command) throw new Error('Type a command')
  // Each database has its own client; switching with SELECT would confuse it
  if (/^(select|monitor|subscribe|psubscribe|ssubscribe)$/i.test(command)) {
    throw new Error(`${command.toUpperCase()} isn't available here${command.toUpperCase() === 'SELECT' ? ': pick the database in the sidebar' : ''}`)
  }
  const client = await clientFor(id, db)
  const started = Date.now()
  const reply = await client.call(command, ...args)
  return { reply: plainReply(reply), ms: Date.now() - started }
}

function plainReply(v: unknown): unknown {
  if (Buffer.isBuffer(v)) return v.toString('utf8')
  if (Array.isArray(v)) return v.map(plainReply)
  return v
}
