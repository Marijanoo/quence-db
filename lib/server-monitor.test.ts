import { describe, expect, it } from 'vitest'
import {
  fmtDuration, monitorTiles, mongoMonitor, mysqlMonitor, parseClientList, rate, redisMonitor,
  type MonitorSnapshot,
} from './server-monitor'

const snap = (at: number, counters: Record<string, number>, gauges: Record<string, number> = {}): MonitorSnapshot =>
  ({ at, version: '', uptimeS: 90061, sessions: [], counters, gauges: { connections: 5, max_connections: 100, active: 1, blocked: 0, ...gauges } })

describe('figures', () => {
  it('turns counters into per-second rates, and not across a restart', () => {
    const a = snap(0, { commits: 100 }), b = snap(2000, { commits: 140 })
    expect(rate(a, b, 'commits')).toBe(20)
    expect(rate(null, b, 'commits')).toBeNull()
    expect(rate(b, snap(4000, { commits: 3 }), 'commits')).toBeNull()
  })

  it('shows cache hit over the interval, connections near the limit as a warning', () => {
    const a = snap(0, { blks_hit: 1000, blks_read: 0, commits: 0, rollbacks: 0 })
    const b = snap(1000, { blks_hit: 1090, blks_read: 10, commits: 5, rollbacks: 1 }, { connections: 95 })
    const tiles = Object.fromEntries(monitorTiles('postgres', a, b).map(t => [t.label, t]))
    expect(tiles['Cache hit'].value).toBe('90.0%')
    expect(tiles['Transactions/s'].value).toBe('6')
    expect(tiles.Connections).toMatchObject({ value: '95 / 100', tone: 'bad' })
    expect(tiles.Uptime.value).toBe('1d 1h')
  })

  it('formats durations', () => {
    expect(fmtDuration(450)).toBe('450 ms')
    expect(fmtDuration(4200)).toBe('4.2 s')
    expect(fmtDuration(125_000)).toBe('2m 5s')
    expect(fmtDuration(null)).toBe('–')
  })
})

describe('MySQL', () => {
  it('reads the process list, lock waits and status, and kills by id', async () => {
    const sent: string[] = []
    const m = mysqlMonitor(async sql => {
      sent.push(sql)
      if (sql.includes('PROCESSLIST')) return [
        { id: 5, user: 'event_scheduler', host: 'localhost', db: null, command: 'Daemon', time_s: 900, state: 'Waiting on empty queue', info: null, is_self: 0 },
        { id: 11, user: 'app', host: '10.0.0.4:51234', db: 'shop', command: 'Query', time_s: 42, state: 'updating', info: 'UPDATE orders SET x = 1', is_self: 0 },
        { id: 12, user: 'app', host: '10.0.0.4:51240', db: 'shop', command: 'Query', time_s: 7, state: 'updating', info: 'UPDATE orders SET x = 2', is_self: 0 },
        { id: 13, user: 'root', host: 'localhost:6000', db: null, command: 'Query', time_s: 0, state: 'executing', info: 'SELECT ...', is_self: 1 },
        { id: 14, user: 'app', host: '10.0.0.5:4000', db: 'shop', command: 'Sleep', time_s: 300, state: '', info: null, is_self: 0 },
      ]
      if (sql.startsWith('SHOW GLOBAL STATUS')) return [{ Variable_name: 'Threads_connected', Value: '4' }, { Variable_name: 'Questions', Value: '1000' }, { Variable_name: 'Uptime', Value: '60' }]
      if (sql.startsWith('SELECT VERSION')) return [{ version: '8.4.2', max_connections: 151 }]
      if (sql.includes('innodb_lock_waits')) return [{ waiting_pid: 12, blocking_pid: 11 }]
      return []
    })
    const s = await m.load()
    const byId = Object.fromEntries(s.sessions.map(x => [x.id, x]))
    expect(byId['5'].system).toBe(true)
    expect(byId['12']).toMatchObject({ state: 'blocked', blockedBy: ['11'], durationMs: 7000 })
    expect(byId['13'].self).toBe(true)
    expect(byId['14'].state).toBe('idle')
    expect(s).toMatchObject({ version: 'MySQL 8.4.2', uptimeS: 60, gauges: { connections: 4, max_connections: 151, blocked: 1 } })
    await m.cancel!('11')
    await m.kill('12')
    expect(sent.slice(-2)).toEqual(['KILL QUERY 11', 'KILL 12'])
    await expect(m.kill('1; DROP TABLE x')).rejects.toThrow(/Bad session id/)
  })

  it('works without the sys schema', async () => {
    const m = mysqlMonitor(async sql => {
      if (sql.includes('innodb_lock_waits')) throw new Error("Table 'sys.innodb_lock_waits' doesn't exist")
      if (sql.startsWith('SELECT VERSION')) return [{ version: '10.11.6-MariaDB-0+deb12u1', max_connections: 100 }]
      return []
    })
    expect((await m.load()).version).toBe('MariaDB 10.11.6')
  })
})

describe('MongoDB', () => {
  it('reads currentOp and serverStatus, and kills operations', async () => {
    const sent: string[] = []
    const m = mongoMonitor(async code => {
      sent.push(code)
      if (code.includes('currentOp')) return [{
        inprog: [
          { type: 'op', opid: 101, active: true, op: 'query', ns: 'shop.orders', microsecs_running: 2_500_000, client: '10.0.0.4:5000',
            effectiveUsers: [{ user: 'app', db: 'admin' }], clientMetadata: { application: { name: 'api' } },
            command: { find: 'orders', filter: { status: 'open' }, lsid: {}, $db: 'shop' }, waitingForLock: false },
          { type: 'op', opid: 102, active: true, op: 'command', ns: 'admin.$cmd', microsecs_running: 50, client: '127.0.0.1:6000',
            command: { currentOp: 1, $all: true, $db: 'admin' } },
          { type: 'op', opid: 7, active: true, desc: 'WTCheckpointThread', op: 'none' },
          { type: 'idleSession', desc: 'inactive transaction', client: '10.0.0.9:1', command: {} },
        ],
      }]
      if (code.includes('serverStatus')) return [{ version: '7.0.12', uptime: 3600, connections: { current: 12, available: 838 }, opcounters: { query: 10, insert: 5, update: 0, delete: 0, getmore: 0, command: 20 }, mem: { resident: 256 } }]
      return [{ ok: 1 }]
    })
    const s = await m.load()
    const byId = Object.fromEntries(s.sessions.map(x => [x.id, x]))
    expect(byId['101']).toMatchObject({ user: 'app', database: 'shop', app: 'api', state: 'active', durationMs: 2500, query: '{"find":"orders","filter":{"status":"open"}}' })
    expect(byId['102'].self).toBe(true)
    expect(byId['7'].system).toBe(true)
    expect(s.gauges).toMatchObject({ connections: 12, max_connections: 850 })
    expect(s.counters.ops).toBe(35)
    await m.kill('101')
    expect(sent.at(-1)).toBe('db.adminCommand({ killOp: 1, op: 101 })')
  })
})

describe('Redis', () => {
  const LIST = [
    'id=3 addr=127.0.0.1:51000 laddr=127.0.0.1:6379 fd=8 name=QuenceDB age=120 idle=0 flags=N db=0 sub=0 psub=0 multi=-1 cmd=client|list user=default lib-name=ioredis',
    'id=7 addr=10.0.0.4:40000 laddr=127.0.0.1:6379 fd=9 name= age=3600 idle=45 flags=N db=2 sub=0 psub=0 multi=-1 cmd=get user=app',
    'id=8 addr=10.0.0.4:40002 laddr=127.0.0.1:6379 fd=10 name=worker age=30 idle=12 flags=b db=0 sub=0 psub=0 multi=-1 cmd=blpop user=app',
    '',
  ].join('\n')

  it('parses CLIENT LIST', () => {
    const rows = parseClientList(LIST)
    expect(rows).toHaveLength(3)
    expect(rows[1]).toMatchObject({ id: '7', name: '', cmd: 'get', db: '2' })
  })

  it('shows clients and INFO figures, and kills clients by id', async () => {
    const sent: string[] = []
    const m = redisMonitor({
      command: async line => { sent.push(line); return line === 'CLIENT LIST' ? LIST : line === 'CLIENT ID' ? 3 : 1 },
      info: async () => ({
        server: { redis_version: '7.2.4', uptime_in_seconds: '86400' },
        clients: { connected_clients: '3', blocked_clients: '1', maxclients: '10000' },
        stats: { instantaneous_ops_per_sec: '57', keyspace_hits: '90', keyspace_misses: '10' },
        memory: { used_memory: '1048576', maxmemory: '0' },
      }),
    })
    const s = await m.load()
    const byId = Object.fromEntries(s.sessions.map(x => [x.id, x]))
    expect(byId['3'].self).toBe(true)
    expect(byId['7']).toMatchObject({ database: 'db2', state: 'idle', durationMs: 45000, query: 'last command: get' })
    expect(byId['8']).toMatchObject({ state: 'waiting', app: 'worker' })
    const tiles = Object.fromEntries(monitorTiles('redis', null, s).map(t => [t.label, t.value]))
    expect(tiles).toMatchObject({ 'Ops/s': '57', 'Hit rate': '90.0%', Memory: '1.0 MB', Connections: '3 / 10000' })
    expect(m.cancel).toBeUndefined()
    await m.kill('7')
    expect(sent.at(-1)).toBe('CLIENT KILL ID 7')
  })
})
