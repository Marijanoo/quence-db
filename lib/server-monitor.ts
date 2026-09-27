// Server monitor: who is connected, what is running, what is blocked, and a few live server
// figures, for PostgreSQL, MySQL, MongoDB and Redis. Each engine is an adapter over a function that
// runs its native query; the UI polls load() and compares snapshots for per-second rates.

export type MonitorEngine = 'postgres' | 'mysql' | 'mongodb' | 'redis'
export type SessionState = 'active' | 'idle' | 'idle-tx' | 'waiting' | 'blocked'

export interface MonitorSession {
  id: string
  user: string
  database: string
  client: string
  app: string
  state: SessionState
  // The engine's own word for it (e.g. "idle in transaction", "Sleep", "getmore")
  stateLabel: string
  // Time in the current query or state
  durationMs: number | null
  connectedMs: number | null
  wait: string
  query: string
  blockedBy: string[]
  // Background workers and the server's own threads
  system: boolean
  // The monitor's own connection
  self: boolean
}

export interface MonitorSnapshot {
  at: number
  version: string
  uptimeS: number | null
  sessions: MonitorSession[]
  // Cumulative counters (for rates) and current values, by name
  counters: Record<string, number>
  gauges: Record<string, number>
}

export interface MonitorAdapter {
  engine: MonitorEngine
  load(): Promise<MonitorSnapshot>
  // Stops the running query, keeping the connection (undefined: the engine can't)
  cancel?: (id: string) => Promise<void>
  kill: (id: string) => Promise<void>
  killLabel: string
}

type Row = Record<string, unknown>
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v))

// PostgreSQL ------------------------------------------------------------------------------------

export const PG_SESSIONS_SQL = `SELECT pid, usename, datname, application_name, client_addr::text AS client_addr, client_port,
  backend_type, state, wait_event_type, wait_event, left(query, 20000) AS query,
  EXTRACT(EPOCH FROM (now() - COALESCE(CASE WHEN state = 'active' THEN query_start END, state_change))) * 1000 AS state_ms,
  EXTRACT(EPOCH FROM (now() - backend_start)) * 1000 AS conn_ms,
  pg_blocking_pids(pid) AS blocked_by, pid = pg_backend_pid() AS is_self
FROM pg_stat_activity`

export const PG_STATS_SQL = `SELECT version() AS version,
  EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time())) AS uptime_s,
  current_setting('max_connections')::int AS max_connections,
  (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend') AS connections,
  sum(xact_commit) AS commits, sum(xact_rollback) AS rollbacks,
  sum(blks_hit) AS blks_hit, sum(blks_read) AS blks_read,
  sum(tup_returned + tup_fetched) AS rows_read, sum(tup_inserted + tup_updated + tup_deleted) AS rows_written,
  sum(deadlocks) AS deadlocks
FROM pg_stat_database`

export function pgSession(r: Row): MonitorSession {
  const state = str(r.state)
  const blockedBy = Array.isArray(r.blocked_by) ? r.blocked_by.map(String) : []
  const system = r.backend_type !== undefined && r.backend_type !== null && r.backend_type !== 'client backend'
  const waitingOnLock = r.wait_event_type === 'Lock'
  return {
    id: str(r.pid),
    user: str(r.usename),
    database: str(r.datname),
    client: r.client_addr ? `${r.client_addr}${r.client_port && Number(r.client_port) > 0 ? `:${r.client_port}` : ''}` : (system ? '' : 'local socket'),
    app: str(r.application_name),
    state: blockedBy.length > 0 ? 'blocked'
      : state === 'active' ? (waitingOnLock ? 'waiting' : 'active')
      : state.startsWith('idle in transaction') ? 'idle-tx'
      : 'idle',
    stateLabel: system ? str(r.backend_type) : state || 'unknown',
    durationMs: num(r.state_ms),
    connectedMs: num(r.conn_ms),
    wait: r.wait_event ? `${r.wait_event_type}: ${r.wait_event}` : '',
    query: system ? '' : str(r.query),
    blockedBy,
    system,
    self: r.is_self === true,
  }
}

export function pgMonitor(run: (sql: string, params?: unknown[]) => Promise<Row[]>): MonitorAdapter {
  const signal = async (fn: 'pg_cancel_backend' | 'pg_terminate_backend', id: string) => {
    const rows = await run(`SELECT ${fn}($1::int) AS ok`, [Number(id)])
    if (rows[0]?.ok !== true) throw new Error(`Session ${id} is no longer there`)
  }
  return {
    engine: 'postgres',
    killLabel: 'Terminate Session',
    async load() {
      const [sessions, stats] = await Promise.all([run(PG_SESSIONS_SQL), run(PG_STATS_SQL)])
      const s = stats[0] ?? {}
      const all = sessions.map(pgSession)
      return {
        at: Date.now(),
        version: str(s.version).replace(/^PostgreSQL ([^\s,]+)[\s\S]*$/, 'PostgreSQL $1'),
        uptimeS: num(s.uptime_s),
        sessions: all,
        counters: pick(s, ['commits', 'rollbacks', 'blks_hit', 'blks_read', 'rows_read', 'rows_written', 'deadlocks']),
        gauges: {
          connections: num(s.connections) ?? all.filter(x => !x.system).length,
          max_connections: num(s.max_connections) ?? 0,
          active: all.filter(x => !x.system && x.state !== 'idle' && x.state !== 'idle-tx').length,
          blocked: all.filter(x => x.state === 'blocked').length,
        },
      }
    },
    cancel: id => signal('pg_cancel_backend', id),
    kill: id => signal('pg_terminate_backend', id),
  }
}

// MySQL / MariaDB -------------------------------------------------------------------------------

export const MYSQL_SESSIONS_SQL = `SELECT ID AS id, USER AS user, HOST AS host, DB AS db, COMMAND AS command, TIME AS time_s,
  STATE AS state, LEFT(INFO, 20000) AS info, ID = CONNECTION_ID() AS is_self
FROM information_schema.PROCESSLIST`
export const MYSQL_STATUS_NAMES = ['Uptime', 'Threads_connected', 'Threads_running', 'Questions', 'Com_commit', 'Com_rollback',
  'Slow_queries', 'Innodb_buffer_pool_read_requests', 'Innodb_buffer_pool_reads', 'Bytes_received', 'Bytes_sent', 'Aborted_connects']
export const MYSQL_STATUS_SQL = `SHOW GLOBAL STATUS WHERE Variable_name IN (${MYSQL_STATUS_NAMES.map(n => `'${n}'`).join(', ')})`
export const MYSQL_VARS_SQL = 'SELECT VERSION() AS version, @@max_connections AS max_connections'
// MySQL 8 with the sys schema; elsewhere lock waits are just not shown
export const MYSQL_LOCK_WAITS_SQL = 'SELECT waiting_pid, blocking_pid FROM sys.innodb_lock_waits'

const MYSQL_SYSTEM_USERS = new Set(['event_scheduler', 'system user'])

export function mysqlSession(r: Row, blockers: Map<string, string[]>): MonitorSession {
  const id = str(r.id)
  const command = str(r.command)
  const system = MYSQL_SYSTEM_USERS.has(str(r.user)) || ['Daemon', 'Binlog Dump', 'Binlog Dump GTID', 'Connect'].includes(command)
  const blockedBy = blockers.get(id) ?? []
  const waiting = /lock/i.test(str(r.state))
  return {
    id,
    user: str(r.user),
    database: str(r.db),
    client: str(r.host),
    app: '',
    state: blockedBy.length > 0 ? 'blocked' : command === 'Sleep' ? 'idle' : waiting ? 'waiting' : 'active',
    stateLabel: [command, str(r.state)].filter(Boolean).join(': '),
    durationMs: num(r.time_s) === null ? null : num(r.time_s)! * 1000,
    connectedMs: null,
    wait: waiting ? str(r.state) : '',
    query: str(r.info),
    blockedBy,
    system,
    self: Number(r.is_self) === 1,
  }
}

export function mysqlMonitor(run: (sql: string) => Promise<Row[]>): MonitorAdapter {
  const validId = (id: string) => { if (!/^\d+$/.test(id)) throw new Error(`Bad session id ${id}`); return id }
  return {
    engine: 'mysql',
    killLabel: 'Kill Connection',
    async load() {
      const [sessions, status, vars, waits] = await Promise.all([
        run(MYSQL_SESSIONS_SQL), run(MYSQL_STATUS_SQL), run(MYSQL_VARS_SQL), run(MYSQL_LOCK_WAITS_SQL).catch(() => [] as Row[]),
      ])
      const blockers = new Map<string, string[]>()
      for (const w of waits) {
        const k = str(w.waiting_pid)
        blockers.set(k, [...new Set([...(blockers.get(k) ?? []), str(w.blocking_pid)])])
      }
      const st: Record<string, number> = {}
      for (const r of status) {
        const name = str(r.Variable_name ?? r.VARIABLE_NAME)
        const v = num(r.Value ?? r.VARIABLE_VALUE)
        if (v !== null) st[name] = v
      }
      const all = sessions.map(r => mysqlSession(r, blockers))
      return {
        at: Date.now(),
        version: `MySQL ${str(vars[0]?.version)}`.replace(/^MySQL (.*MariaDB.*)$/, 'MariaDB $1').replace(/-MariaDB.*$/, ''),
        uptimeS: st.Uptime ?? null,
        sessions: all,
        counters: pick(st, ['Questions', 'Com_commit', 'Com_rollback', 'Slow_queries', 'Innodb_buffer_pool_read_requests', 'Innodb_buffer_pool_reads', 'Bytes_received', 'Bytes_sent']),
        gauges: {
          connections: st.Threads_connected ?? all.length,
          max_connections: num(vars[0]?.max_connections) ?? 0,
          active: st.Threads_running ?? all.filter(x => x.state !== 'idle').length,
          blocked: all.filter(x => x.state === 'blocked').length,
        },
      }
    },
    cancel: async id => { await run(`KILL QUERY ${validId(id)}`) },
    kill: async id => { await run(`KILL ${validId(id)}`) },
  }
}

// MongoDB ---------------------------------------------------------------------------------------

export const MONGO_CURRENT_OP = 'db.adminCommand({ currentOp: 1, $all: true })'
export const MONGO_SERVER_STATUS = 'db.adminCommand({ serverStatus: 1, repl: 0, metrics: 0, locks: 0, wiredTiger: 0, tcmalloc: 0 })'

export function mongoSession(op: Row): MonitorSession {
  const command = (op.command && typeof op.command === 'object' ? op.command : {}) as Row
  const users = Array.isArray(op.effectiveUsers) ? op.effectiveUsers as Row[] : []
  const meta = (op.clientMetadata ?? {}) as { application?: { name?: string }; driver?: { name?: string } }
  const active = op.active === true
  const type = str(op.type)
  const system = !op.client && !op.connectionId && type !== 'idleSession'
  const micros = num(op.microsecs_running)
  const ns = str(op.ns)
  const { lsid: _l, $clusterTime: _c, $db, ...shown } = command
  return {
    id: str(op.opid ?? op.desc),
    user: users.map(u => str(u.user)).join(', '),
    database: str($db) || ns.split('.')[0],
    client: str(op.client),
    app: str(meta.application?.name) || str(meta.driver?.name),
    state: op.waitingForLock === true ? 'waiting' : active ? 'active' : 'idle',
    stateLabel: active ? (str(op.op) || 'active') : (type || 'idle'),
    durationMs: micros !== null ? micros / 1000 : null,
    connectedMs: null,
    wait: op.waitingForLock === true ? 'waiting for a lock' : '',
    query: Object.keys(shown).length ? JSON.stringify(shown) : '',
    blockedBy: [],
    system: system || /^(WT|TTL|Checkpoint|monitoring|Replication)/i.test(str(op.desc)),
    self: 'currentOp' in command,
  }
}

export function mongoMonitor(run: (code: string) => Promise<Row[]>): MonitorAdapter {
  return {
    engine: 'mongodb',
    killLabel: 'Kill Operation',
    async load() {
      const [ops, status] = await Promise.all([run(MONGO_CURRENT_OP), run(MONGO_SERVER_STATUS)])
      const inprog = (Array.isArray(ops[0]?.inprog) ? ops[0].inprog : []) as Row[]
      const s = status[0] ?? {}
      const conns = (s.connections ?? {}) as Row
      const opc = (s.opcounters ?? {}) as Row
      const net = (s.network ?? {}) as Row
      const mem = (s.mem ?? {}) as Row
      const all = inprog.map(mongoSession)
      const ops_total = ['insert', 'query', 'update', 'delete', 'getmore', 'command'].reduce((a, k) => a + (num(opc[k]) ?? 0), 0)
      return {
        at: Date.now(),
        version: `MongoDB ${str(s.version)}`,
        uptimeS: num(s.uptime),
        sessions: all,
        counters: { ops: ops_total, ...pick(opc, ['insert', 'query', 'update', 'delete']), ...pick(net, ['bytesIn', 'bytesOut']) },
        gauges: {
          connections: num(conns.current) ?? 0,
          max_connections: (num(conns.current) ?? 0) + (num(conns.available) ?? 0),
          active: all.filter(x => !x.system && x.state !== 'idle').length,
          blocked: all.filter(x => x.state === 'waiting').length,
          resident_mb: num(mem.resident) ?? 0,
        },
      }
    },
    kill: async id => {
      const op = /^\d+$/.test(id) ? id : JSON.stringify(id)
      const rows = await run(`db.adminCommand({ killOp: 1, op: ${op} })`)
      if (rows[0]?.ok !== 1 && rows[0]?.ok !== true) throw new Error(str(rows[0]?.errmsg) || 'killOp failed')
    },
  }
}

// Redis -----------------------------------------------------------------------------------------

export function parseClientList(text: string): Row[] {
  return text.split(/\r?\n/).filter(l => l.trim()).map(line => {
    const row: Row = {}
    for (const part of line.trim().split(' ')) {
      const i = part.indexOf('=')
      if (i > 0) row[part.slice(0, i)] = part.slice(i + 1)
    }
    return row
  })
}

export function redisSession(c: Row, selfId: string): MonitorSession {
  const flags = str(c.flags)
  const cmd = str(c.cmd)
  const idle = num(c.idle) ?? 0
  const blocked = flags.includes('b')
  const replica = /[SM]/.test(flags)
  return {
    id: str(c.id),
    user: str(c.user),
    database: c.db !== undefined ? `db${c.db}` : '',
    client: str(c.addr),
    app: str(c.name) || str(c['lib-name']),
    state: blocked ? 'waiting' : flags.includes('x') ? 'idle-tx' : idle === 0 ? 'active' : 'idle',
    stateLabel: blocked ? 'blocked (BLPOP etc.)' : flags.includes('x') ? 'in MULTI' : idle === 0 ? 'active' : 'idle',
    durationMs: idle * 1000,
    connectedMs: (num(c.age) ?? 0) * 1000,
    wait: blocked ? 'blocking command' : '',
    query: cmd && cmd !== 'NULL' ? `last command: ${cmd.replace(/\|/g, ' ')}` : '',
    blockedBy: [],
    system: replica,
    self: str(c.id) === selfId,
  }
}

export function redisMonitor(api: {
  command: (line: string) => Promise<unknown>
  info: () => Promise<Record<string, Record<string, string>>>
}): MonitorAdapter {
  return {
    engine: 'redis',
    killLabel: 'Kill Client',
    async load() {
      const [list, self, info] = await Promise.all([api.command('CLIENT LIST'), api.command('CLIENT ID'), api.info()])
      const server = info.server ?? {}
      const stats = info.stats ?? {}
      const clients = info.clients ?? {}
      const memory = info.memory ?? {}
      const all = parseClientList(str(list)).map(c => redisSession(c, str(self)))
      return {
        at: Date.now(),
        version: `Redis ${str(server.redis_version)}`,
        uptimeS: num(server.uptime_in_seconds),
        sessions: all,
        counters: pick(stats, ['total_commands_processed', 'keyspace_hits', 'keyspace_misses', 'total_net_input_bytes', 'total_net_output_bytes', 'expired_keys', 'evicted_keys']),
        gauges: {
          connections: num(clients.connected_clients) ?? all.length,
          max_connections: num(clients.maxclients) ?? 0,
          active: all.filter(x => x.state === 'active').length,
          blocked: num(clients.blocked_clients) ?? 0,
          ops_per_sec: num(stats.instantaneous_ops_per_sec) ?? 0,
          used_memory: num(memory.used_memory) ?? 0,
          maxmemory: num(memory.maxmemory) ?? 0,
        },
      }
    },
    kill: async id => {
      if (!/^\d+$/.test(id)) throw new Error(`Bad client id ${id}`)
      const n = Number(await api.command(`CLIENT KILL ID ${id}`))
      if (n === 0) throw new Error(`Client ${id} is no longer connected`)
    },
  }
}

function pick(src: Row, keys: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const k of keys) { const v = num(src[k]); if (v !== null) out[k] = v }
  return out
}

// Figures ---------------------------------------------------------------------------------------

export interface Tile { label: string; value: string; hint?: string; tone?: 'warn' | 'bad' }

// Per second between two snapshots; null on the first one or after a server restart (counter went down)
export function rate(prev: MonitorSnapshot | null, cur: MonitorSnapshot, key: string): number | null {
  if (!prev) return null
  const a = prev.counters[key], b = cur.counters[key]
  const dt = (cur.at - prev.at) / 1000
  if (a === undefined || b === undefined || dt <= 0 || b < a) return null
  return (b - a) / dt
}

// Share of hits over the interval, or since the server started on the first snapshot
function ratio(prev: MonitorSnapshot | null, cur: MonitorSnapshot, hitKey: string, missKey: string, missIsTotal = false): number | null {
  const d = (k: string) => (cur.counters[k] ?? 0) - (prev && (prev.counters[k] ?? 0) <= (cur.counters[k] ?? 0) ? prev.counters[k] ?? 0 : 0)
  const hits = d(hitKey), misses = d(missKey)
  const total = missIsTotal ? misses : hits + misses
  if (total <= 0) return null
  return missIsTotal ? 1 - hits / total : hits / total
}

export const fmtRate = (v: number | null) => v === null ? '–' : v >= 100 || Number.isInteger(v) ? Math.round(v).toLocaleString() : v >= 10 ? v.toFixed(1) : v.toFixed(2)
export const fmtPct = (v: number | null) => v === null ? '–' : `${(v * 100).toFixed(v > 0.999 && v < 1 ? 2 : 1)}%`
export function fmtBytes(n: number | null): string {
  if (n === null) return '–'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`
}
export function fmtDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '–'
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${Math.floor(s % 60)}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

export function monitorTiles(engine: MonitorEngine, prev: MonitorSnapshot | null, cur: MonitorSnapshot): Tile[] {
  const g = cur.gauges
  const connTile: Tile = {
    label: 'Connections',
    value: g.max_connections ? `${g.connections} / ${g.max_connections}` : String(g.connections),
    tone: g.max_connections && g.connections / g.max_connections > 0.9 ? 'bad' : g.max_connections && g.connections / g.max_connections > 0.75 ? 'warn' : undefined,
  }
  const blockedTile: Tile = { label: engine === 'postgres' || engine === 'mysql' ? 'Blocked' : 'Waiting', value: String(g.blocked ?? 0), tone: g.blocked ? 'warn' : undefined }
  const uptime: Tile = { label: 'Uptime', value: fmtDuration(cur.uptimeS === null ? null : cur.uptimeS * 1000) }
  const perSec = (key: string) => fmtRate(rate(prev, cur, key))
  switch (engine) {
    case 'postgres': {
      const tps = prev ? (rate(prev, cur, 'commits') ?? 0) + (rate(prev, cur, 'rollbacks') ?? 0) : null
      const hit = ratio(prev, cur, 'blks_hit', 'blks_read')
      return [
        connTile,
        { label: 'Running', value: String(g.active) },
        blockedTile,
        { label: 'Transactions/s', value: fmtRate(tps), hint: `${perSec('rollbacks')} rollbacks/s` },
        { label: 'Rows read/s', value: perSec('rows_read'), hint: `${perSec('rows_written')} written/s` },
        { label: 'Cache hit', value: fmtPct(hit), tone: hit !== null && hit < 0.9 ? 'warn' : undefined },
        uptime,
      ]
    }
    case 'mysql': {
      const hit = ratio(prev, cur, 'Innodb_buffer_pool_reads', 'Innodb_buffer_pool_read_requests', true)
      return [
        connTile,
        { label: 'Running', value: String(g.active) },
        blockedTile,
        { label: 'Queries/s', value: perSec('Questions'), hint: `${perSec('Com_commit')} commits/s` },
        { label: 'Slow queries', value: (cur.counters.Slow_queries ?? 0).toLocaleString(), hint: 'since start' },
        { label: 'Buffer pool hit', value: fmtPct(hit), tone: hit !== null && hit < 0.9 ? 'warn' : undefined },
        { label: 'Network', value: `${fmtBytes(rate(prev, cur, 'Bytes_received'))}/s in`, hint: `${fmtBytes(rate(prev, cur, 'Bytes_sent'))}/s out` },
        uptime,
      ]
    }
    case 'mongodb':
      return [
        connTile,
        { label: 'Active ops', value: String(g.active) },
        blockedTile,
        { label: 'Ops/s', value: perSec('ops'), hint: `${perSec('query')} queries, ${perSec('insert')} inserts` },
        { label: 'Memory', value: fmtBytes((g.resident_mb ?? 0) * 1024 * 1024), hint: 'resident' },
        { label: 'Network', value: `${fmtBytes(rate(prev, cur, 'bytesIn'))}/s in`, hint: `${fmtBytes(rate(prev, cur, 'bytesOut'))}/s out` },
        uptime,
      ]
    case 'redis': {
      const hit = ratio(prev, cur, 'keyspace_hits', 'keyspace_misses')
      return [
        connTile,
        blockedTile,
        { label: 'Ops/s', value: fmtRate(g.ops_per_sec ?? null) },
        { label: 'Hit rate', value: fmtPct(hit), hint: 'key lookups' },
        { label: 'Memory', value: fmtBytes(g.used_memory ?? null), hint: g.maxmemory ? `of ${fmtBytes(g.maxmemory)}` : 'no limit' },
        { label: 'Evicted/s', value: perSec('evicted_keys'), tone: (rate(prev, cur, 'evicted_keys') ?? 0) > 0 ? 'warn' : undefined },
        uptime,
      ]
    }
  }
}
