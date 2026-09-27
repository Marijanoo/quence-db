'use client'

// The Server Monitor tab: live figures, and the sessions on the server with what they're running.
// Polls while the tab is open; sessions can be cancelled or killed after a confirmation.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, ChevronDown, ChevronRight, Copy, FileCode, Loader2, Pause, Play, RefreshCw, Search, Square, X, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { confirmAction } from '@/components/confirm-dialog'
import { SqlHighlight } from '@/components/sql-highlight'
import { ContextMenuAt, type MenuEntry } from '@/components/context-menu'
import {
  fmtDuration, monitorTiles, mongoMonitor, mysqlMonitor, pgMonitor, redisMonitor,
  type MonitorAdapter, type MonitorEngine, type MonitorSession, type MonitorSnapshot, type SessionState,
} from '@/lib/server-monitor'

function adapterFor(engine: MonitorEngine, connId: string): MonitorAdapter {
  const api = window.electronAPI!
  const rows = (res: { ok: boolean; rows?: Record<string, unknown>[]; error?: string }) => {
    if (!res.ok) throw new Error(res.error ?? 'Query failed')
    return res.rows ?? []
  }
  switch (engine) {
    case 'postgres': return pgMonitor(async (sql, params) => rows(await api.pg.query(connId, sql, undefined, params)))
    case 'mysql': return mysqlMonitor(async sql => rows(await api.mysql.query(connId, sql)))
    case 'mongodb': return mongoMonitor(async code => rows(await api.mongodb.query(connId, code, 'admin')))
    case 'redis': return redisMonitor({
      command: async line => {
        const res = await api.redis.command(connId, 0, line)
        if (!res.ok) throw new Error(res.error ?? 'Command failed')
        return res.reply
      },
      info: async () => {
        const res = await api.redis.info(connId)
        if (!res.ok) throw new Error(res.error ?? 'INFO failed')
        return res.info ?? {}
      },
    })
  }
}

const INTERVALS = [0, 2, 5, 10, 30] as const

const STATE_STYLE: Record<SessionState, { dot: string; text: string }> = {
  active: { dot: 'bg-green-500', text: 'text-green-400' },
  idle: { dot: 'bg-muted-foreground/40', text: 'text-muted-foreground' },
  'idle-tx': { dot: 'bg-amber-500', text: 'text-amber-400' },
  waiting: { dot: 'bg-orange-500', text: 'text-orange-400' },
  blocked: { dot: 'bg-red-500', text: 'text-red-400' },
}

type SortKey = 'id' | 'user' | 'database' | 'state' | 'duration'

export function ServerMonitor({ engine, connectionId, label, onOpenQuery }: {
  engine: MonitorEngine
  connectionId: string
  label: string
  // Opens the text in a new query tab
  onOpenQuery?: (text: string) => void
}) {
  const adapter = useMemo(() => adapterFor(engine, connectionId), [engine, connectionId])
  const [snap, setSnap] = useState<MonitorSnapshot | null>(null)
  const [prev, setPrev] = useState<MonitorSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [interval, setIntervalS] = useState<number>(5)
  const [showIdle, setShowIdle] = useState(engine === 'mongodb' ? false : true)
  const [showSystem, setShowSystem] = useState(false)
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'duration', dir: 'desc' })
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<{ x: number; y: number; session: MonitorSession } | null>(null)
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  const snapRef = useRef<MonitorSnapshot | null>(null)
  const inFlight = useRef(false)

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setLoading(true)
    try {
      const next = await adapter.load()
      setPrev(snapRef.current)
      snapRef.current = next
      setSnap(next)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      inFlight.current = false
      setLoading(false)
    }
  }, [adapter])

  useEffect(() => {
    void refresh()
    if (!interval) return
    const timer = setInterval(() => void refresh(), interval * 1000)
    return () => clearInterval(timer)
  }, [refresh, interval])

  const act = async (s: MonitorSession, kind: 'cancel' | 'kill') => {
    const what = kind === 'cancel' ? 'Cancel the running query' : adapter.killLabel
    const ok = await confirmAction({
      title: `${what}?`,
      subtitle: `${label} · ${engine === 'mongodb' ? 'operation' : engine === 'redis' ? 'client' : 'session'} ${s.id}${s.user ? ` (${s.user})` : ''}`,
      message: kind === 'cancel'
        ? 'The statement stops with an error; the connection stays open and its transaction (if any) is still there.'
        : engine === 'mongodb' ? 'The operation is stopped.' : 'The connection is closed. Anything it hadn’t committed is rolled back, and the application using it will see an error.',
      details: s.query || undefined,
      confirmLabel: kind === 'cancel' ? 'Cancel Query' : adapter.killLabel,
      danger: kind === 'kill',
    })
    if (!ok) return
    setBusyIds(prevIds => new Set(prevIds).add(s.id))
    try {
      await (kind === 'cancel' ? adapter.cancel!(s.id) : adapter.kill(s.id))
      toast.success(kind === 'cancel' ? `Cancelled the query of ${s.id}` : engine === 'mongodb' ? `Stopped operation ${s.id}` : `Closed ${engine === 'redis' ? 'client' : 'session'} ${s.id}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyIds(prevIds => { const n = new Set(prevIds); n.delete(s.id); return n })
      void refresh()
    }
  }

  const sessions = useMemo(() => {
    const all = snap?.sessions ?? []
    const needle = filter.trim().toLowerCase()
    const blocking = new Set(all.flatMap(s => s.blockedBy))
    const shown = all.filter(s =>
      (showSystem || !s.system) &&
      // Idle sessions that block others always show
      (showIdle || s.state !== 'idle' || blocking.has(s.id)) &&
      (!needle || [s.id, s.user, s.database, s.client, s.app, s.stateLabel, s.query].some(v => v.toLowerCase().includes(needle))))
    const order: Record<SessionState, number> = { blocked: 0, waiting: 1, active: 2, 'idle-tx': 3, idle: 4 }
    const val = (s: MonitorSession): string | number => {
      switch (sort.key) {
        case 'id': return Number.isFinite(Number(s.id)) ? Number(s.id) : s.id
        case 'user': return s.user.toLowerCase()
        case 'database': return s.database.toLowerCase()
        case 'state': return order[s.state]
        case 'duration': return s.durationMs ?? -1
      }
    }
    return [...shown].sort((a, b) => {
      const x = val(a), y = val(b)
      const c = x < y ? -1 : x > y ? 1 : 0
      return sort.dir === 'asc' ? c : -c
    })
  }, [snap, filter, showIdle, showSystem, sort])

  const hiddenCount = (snap?.sessions.length ?? 0) - sessions.length
  const blockingCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of snap?.sessions ?? []) for (const b of s.blockedBy) m.set(b, (m.get(b) ?? 0) + 1)
    return m
  }, [snap])
  const tiles = snap ? monitorTiles(engine, prev, snap) : []
  // MongoDB shows commands as JSON and Redis command names; only SQL gets highlighted
  const isSql = engine === 'postgres' || engine === 'mysql'

  const copy = (text: string, what: string) => void navigator.clipboard.writeText(text).then(() => toast.success(`Copied ${what}`))
  const menuEntries = (s: MonitorSession): MenuEntry[] => [
    { label: 'Copy Query', icon: <Copy className="h-3.5 w-3.5" />, disabled: !s.query, onSelect: () => copy(s.query, 'query') },
    ...(onOpenQuery && engine !== 'redis' ? [{ label: 'Open in Query Tab', icon: <FileCode className="h-3.5 w-3.5" />, disabled: !s.query || engine === 'mongodb', onSelect: () => onOpenQuery(s.query) }] : []),
    { label: 'Copy ID', icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => copy(s.id, 'ID') },
    { kind: 'separator' },
    ...(adapter.cancel ? [{
      label: 'Cancel Query', icon: <Square className="h-3.5 w-3.5" />, disabled: s.self || s.state === 'idle',
      hint: s.self ? 'this monitor' : undefined, onSelect: () => void act(s, 'cancel'),
    }] : []),
    { label: adapter.killLabel, icon: <XCircle className="h-3.5 w-3.5" />, destructive: true, disabled: s.self, hint: s.self ? 'this monitor' : undefined, onSelect: () => void act(s, 'kill') },
  ]

  const header = (key: SortKey | null, text: string, cls = '') => (
    <th className={cn('text-left font-medium px-2 py-1.5 whitespace-nowrap', key && 'cursor-pointer hover:text-foreground select-none', cls)}
      onClick={() => key && setSort(s => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))}>
      {text}{key && sort.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  )
  const toggle = (on: boolean, set: (v: boolean) => void, text: string) => (
    <button onClick={() => set(!on)}
      className={cn('px-2 h-6 rounded text-xs border transition-colors', on ? 'border-primary/50 bg-primary/15 text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}>
      {text}
    </button>
  )

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between gap-3 px-3 h-9 border-b border-border bg-muted/10 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Activity className="h-3.5 w-3.5 text-primary shrink-0" />
          <span className="text-xs font-semibold text-foreground truncate">{label}</span>
          {snap && <span className="text-[11px] text-muted-foreground truncate">{snap.version}</span>}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {snap ? `Updated ${new Date(snap.at).toLocaleTimeString()}` : ''}
          </span>
          <button onClick={() => setIntervalS(interval ? 0 : 5)} title={interval ? 'Pause' : 'Resume'}
            className="flex items-center justify-center h-6 w-6 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40">
            {interval ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
          </button>
          <select value={interval} onChange={e => setIntervalS(Number(e.target.value))} title="Refresh every"
            className="h-6 bg-background border border-border rounded px-1 text-xs text-foreground outline-none">
            {INTERVALS.map(s => <option key={s} value={s}>{s ? `Every ${s}s` : 'Paused'}</option>)}
          </select>
          <button onClick={() => void refresh()} disabled={loading}
            className="flex items-center gap-1 px-2 h-6 rounded text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40 disabled:opacity-40">
            <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} /> Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 px-3 py-1.5 border-b border-red-500/30 bg-red-500/10 text-xs text-red-300 shrink-0">
          <X className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span className="whitespace-pre-wrap break-words">{error}</span>
        </div>
      )}

      {!snap && !error ? (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</div>
      ) : snap && (
        <>
          <div className="grid gap-2 p-3 shrink-0" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))' }}>
            {tiles.map(t => (
              <div key={t.label} className="rounded-md border border-border bg-card px-3 py-2 min-w-0">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground truncate">{t.label}</div>
                <div className={cn('text-base font-semibold tabular-nums truncate', t.tone === 'bad' ? 'text-red-400' : t.tone === 'warn' ? 'text-amber-400' : 'text-foreground')}>{t.value}</div>
                {t.hint && <div className="text-[10px] text-muted-foreground/70 truncate tabular-nums">{t.hint}</div>}
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2 px-3 pb-2 shrink-0 flex-wrap">
            <div className="flex items-center gap-1.5 h-6 px-2 rounded border border-border bg-background w-56">
              <Search className="h-3 w-3 text-muted-foreground shrink-0" />
              <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter sessions"
                className="flex-1 min-w-0 bg-transparent text-xs outline-none text-foreground placeholder:text-muted-foreground/50" />
              {filter && <button onClick={() => setFilter('')} className="text-muted-foreground hover:text-foreground"><X className="h-3 w-3" /></button>}
            </div>
            {toggle(showIdle, setShowIdle, 'Idle')}
            {toggle(showSystem, setShowSystem, engine === 'mongodb' ? 'Internal' : 'Background')}
            <span className="text-[11px] text-muted-foreground">
              {sessions.length} {engine === 'mongodb' ? 'operation' : engine === 'redis' ? 'client' : 'session'}{sessions.length === 1 ? '' : 's'}
              {hiddenCount > 0 ? ` (${hiddenCount} hidden)` : ''}
            </span>
          </div>

          <div className="flex-1 min-h-0 overflow-auto border-t border-border">
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 bg-card text-muted-foreground z-10 shadow-[0_1px_0_var(--border)]">
                <tr>
                  <th className="w-6" />
                  {header('id', engine === 'mongodb' ? 'Op' : engine === 'redis' ? 'Client' : 'PID')}
                  {header('user', 'User')}
                  {header('database', 'Database')}
                  {header(null, 'Client')}
                  {engine !== 'mysql' && header(null, 'Application')}
                  {header('state', 'State')}
                  {header('duration', engine === 'redis' ? 'Idle' : 'Duration')}
                  {header(null, engine === 'redis' ? 'Last command' : 'Query', 'w-full')}
                  <th className="w-16" />
                </tr>
              </thead>
              <tbody>
                {sessions.length === 0 && (
                  <tr><td colSpan={10} className="px-3 py-6 text-center text-muted-foreground">Nothing to show{hiddenCount ? '; some are hidden by the filters above' : ''}</td></tr>
                )}
                {sessions.map(s => {
                  const open = expanded.has(s.id)
                  const st = STATE_STYLE[s.state]
                  const blocks = blockingCounts.get(s.id) ?? 0
                  const busy = busyIds.has(s.id)
                  return (
                    <React.Fragment key={s.id}>
                      <tr
                        onClick={() => setExpanded(prevSet => { const n = new Set(prevSet); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n })}
                        onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, session: s }) }}
                        className={cn('group border-b border-border/50 cursor-pointer hover:bg-accent/15', s.state === 'blocked' && 'bg-red-500/5', blocks > 0 && 'bg-amber-500/5')}>
                        <td className="pl-2 text-muted-foreground">{open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}</td>
                        <td className="px-2 py-1 font-mono whitespace-nowrap">
                          {s.id}
                          {s.self && <span className="ml-1.5 text-[9px] px-1 rounded bg-primary/20 text-primary font-sans">this monitor</span>}
                        </td>
                        <td className="px-2 py-1 whitespace-nowrap">{s.user}</td>
                        <td className="px-2 py-1 whitespace-nowrap">{s.database}</td>
                        <td className="px-2 py-1 whitespace-nowrap font-mono text-muted-foreground">{s.client}</td>
                        {engine !== 'mysql' && <td className="px-2 py-1 whitespace-nowrap max-w-40 truncate text-muted-foreground" title={s.app}>{s.app}</td>}
                        <td className="px-2 py-1 whitespace-nowrap">
                          <span className={cn('inline-flex items-center gap-1.5', st.text)}>
                            <span className={cn('h-1.5 w-1.5 rounded-full', st.dot)} />{s.stateLabel}
                          </span>
                          {s.blockedBy.length > 0 && <span className="ml-1.5 text-[10px] px-1 rounded bg-red-500/20 text-red-300">blocked by {s.blockedBy.join(', ')}</span>}
                          {blocks > 0 && <span className="ml-1.5 text-[10px] px-1 rounded bg-amber-500/20 text-amber-300">blocking {blocks}</span>}
                        </td>
                        <td className={cn('px-2 py-1 whitespace-nowrap tabular-nums text-right', s.state !== 'idle' && (s.durationMs ?? 0) > 60_000 && 'text-amber-400')}>{fmtDuration(s.durationMs)}</td>
                        <td className="px-2 py-1 max-w-0 w-full">
                          {isSql && s.query
                            ? <div title={s.query}><SqlHighlight sql={s.query.replace(/\s+/g, ' ').slice(0, 400)} className="truncate m-0 text-xs" /></div>
                            : <div className="truncate font-mono text-muted-foreground" title={s.query}>{s.query.replace(/\s+/g, ' ')}</div>}
                        </td>
                        <td className="px-2 py-1 whitespace-nowrap text-right">
                          {busy ? <Loader2 className="h-3 w-3 animate-spin inline" /> : !s.self && (
                            <span className="opacity-0 group-hover:opacity-100 transition-opacity inline-flex gap-1">
                              {adapter.cancel && s.state !== 'idle' && (
                                <button title="Cancel query" onClick={e => { e.stopPropagation(); void act(s, 'cancel') }}
                                  className="p-0.5 rounded hover:bg-accent/40 text-muted-foreground hover:text-foreground"><Square className="h-3 w-3" /></button>
                              )}
                              <button title={adapter.killLabel} onClick={e => { e.stopPropagation(); void act(s, 'kill') }}
                                className="p-0.5 rounded hover:bg-red-500/20 text-muted-foreground hover:text-red-400"><XCircle className="h-3 w-3" /></button>
                            </span>
                          )}
                        </td>
                      </tr>
                      {open && (
                        <tr className="border-b border-border/50 bg-muted/10">
                          <td />
                          <td colSpan={9} className="px-2 py-2">
                            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-muted-foreground mb-1.5">
                              <span>State: <span className="text-foreground">{s.stateLabel}</span></span>
                              {s.wait && <span>Waiting on: <span className="text-foreground">{s.wait}</span></span>}
                              {s.connectedMs !== null && <span>Connected for: <span className="text-foreground">{fmtDuration(s.connectedMs)}</span></span>}
                              {s.blockedBy.length > 0 && <span>Blocked by: <span className="text-red-300">{s.blockedBy.join(', ')}</span></span>}
                              {s.app && <span>Application: <span className="text-foreground">{s.app}</span></span>}
                            </div>
                            {s.query && isSql
                              ? <SqlHighlight sql={s.query} className="text-[11px] whitespace-pre-wrap break-words bg-background border border-border rounded px-2 py-1.5 max-h-60 overflow-auto select-text cursor-text text-foreground m-0" />
                              : s.query
                              ? <pre className="text-[11px] font-mono whitespace-pre-wrap break-words bg-background border border-border rounded px-2 py-1.5 max-h-60 overflow-auto select-text cursor-text text-foreground">{s.query}</pre>
                              : <span className="text-[11px] text-muted-foreground/60">No query</span>}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {menu && <ContextMenuAt x={menu.x} y={menu.y} entries={menuEntries(menu.session)} onClose={() => setMenu(null)} />}
    </div>
  )
}
