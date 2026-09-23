'use client'

import React, { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, ArrowLeftRight, Check, ChevronDown, ChevronRight, Copy, GitCompareArrows, Loader2, Play, Puzzle, Shapes, Table2, View, X,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  buildSyncScript, compareSchemas, defaultSelection, fetchSchemaSnapshot, isSelectable, snapshotSearchPath,
  DEFAULT_SYNC_OPTIONS, type SyncAction, type SyncItem, type SyncOptions,
} from '@/lib/structure-sync'
import { sideBySideDiff } from '@/lib/line-diff'
import { SQL_FONT_FAMILY, SqlCodeEditor, SqlHighlight, highlightSqlLines } from '@/components/sql-highlight'

export interface SyncConnectionOption {
  id: string
  label: string
  dbType: 'postgres' | 'mysql' | 'mongodb'
  status: 'connected' | 'connecting' | 'disconnected' | 'error'
  databases: string[]
}

export interface SyncEndpoint { connectionId: string | null; database: string | null; schema: string | null }
export interface StructureSyncConfig { source: SyncEndpoint; target: SyncEndpoint; options: SyncOptions }

export interface StructureSyncState {
  config: StructureSyncConfig
  status: 'idle' | 'comparing' | 'deploying'
  error?: string
  items?: SyncItem[]
  comparedConfig?: StructureSyncConfig // the config the current items were computed from
  selected: string[]
  activeKey?: string
}

export const EMPTY_ENDPOINT: SyncEndpoint = { connectionId: null, database: null, schema: null }

export function initialSyncState(config?: StructureSyncConfig): StructureSyncState {
  return {
    config: config ?? { source: EMPTY_ENDPOINT, target: EMPTY_ENDPOINT, options: DEFAULT_SYNC_OPTIONS },
    status: 'idle',
    selected: [],
  }
}

export type EndpointComplete = { connectionId: string; database: string; schema: string }
export const isComplete = (e: SyncEndpoint): e is EndpointComplete => !!(e.connectionId && e.database && e.schema)
export const sameEndpoint = (a: SyncEndpoint, b: SyncEndpoint) => a.connectionId === b.connectionId && a.database === b.database && a.schema === b.schema

const ACTION_GROUPS: { action: SyncAction; label: string; className: string }[] = [
  { action: 'create', label: 'To create', className: 'text-green-400' },
  { action: 'modify', label: 'To modify', className: 'text-amber-400' },
  { action: 'drop', label: 'To drop', className: 'text-red-400' },
  { action: 'same', label: 'Identical', className: 'text-muted-foreground' },
]

function KindIcon({ kind, className }: { kind: SyncItem['kind']; className?: string }) {
  if (kind === 'extension') return <Puzzle className={cn('h-3.5 w-3.5 text-emerald-400 shrink-0', className)} />
  if (kind === 'view') return <View className={cn('h-3.5 w-3.5 text-sky-300 shrink-0', className)} />
  if (kind === 'enum') return <Shapes className={cn('h-3.5 w-3.5 text-orange-400 shrink-0', className)} />
  return <Table2 className={cn('h-3.5 w-3.5 text-primary shrink-0', className)} />
}

// The page hot-reloads but Electron's preload/main only load at startup, so after an update the
// renderer can be newer than the IPC bridge. An older bridge also drops the searchPath option,
// which would make comparisons wrong, so refuse to run instead.
export const RESTART_MESSAGE = 'QuenceDB needs a restart to finish updating (its background process is older than this screen). Restart the app, then compare again.'
function assertSyncApiAvailable() {
  if (typeof window.electronAPI?.pg.executeScript !== 'function') throw new Error(RESTART_MESSAGE)
}

async function querySchemaNames(connId: string, database: string): Promise<string[]> {
  const res = await window.electronAPI!.pg.query(connId, `SELECT nspname FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' ORDER BY 1`, database)
  if (!res.ok) throw new Error(res.error)
  return (res.rows ?? []).map(r => String(r.nspname))
}

function snapshotEndpoint(e: EndpointComplete) {
  return fetchSchemaSnapshot(async (sql, params) => {
    const res = await window.electronAPI!.pg.query(e.connectionId, sql, e.database, params, { searchPath: snapshotSearchPath(e.schema) })
    if (!res.ok) throw new Error(res.error)
    return res.rows ?? []
  }, e.schema)
}

// ── Endpoint picker ───────────────────────────────────────────────────────────

const selectClass = 'h-7 w-full rounded border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary disabled:opacity-50'

export function EndpointPicker({ title, subtitle, endpoint, connections, onChange }: {
  title: string
  subtitle: string
  endpoint: SyncEndpoint
  connections: SyncConnectionOption[]
  onChange: (e: SyncEndpoint) => void
}) {
  const conn = connections.find(c => c.id === endpoint.connectionId)
  const [schemas, setSchemas] = useState<{ key: string; names: string[]; error?: string } | null>(null)
  const schemaKey = conn?.status === 'connected' && endpoint.database ? `${conn.id}::${endpoint.database}` : null

  useEffect(() => {
    if (!schemaKey || !endpoint.connectionId || !endpoint.database) return
    let cancelled = false
    querySchemaNames(endpoint.connectionId, endpoint.database)
      .then(names => { if (!cancelled) setSchemas({ key: schemaKey, names }) })
      .catch(err => { if (!cancelled) setSchemas({ key: schemaKey, names: [], error: String(err?.message ?? err) }) })
    return () => { cancelled = true }
  }, [schemaKey, endpoint.connectionId, endpoint.database])

  const schemaNames = useMemo(() => (schemas?.key === schemaKey ? schemas.names : []), [schemas, schemaKey])
  const schemaLoading = !!schemaKey && schemas?.key !== schemaKey

  // Default to "public" once the schema list arrives
  useEffect(() => {
    if (!endpoint.schema && schemaNames.includes('public')) onChange({ ...endpoint, schema: 'public' })
  }, [schemaNames, endpoint, onChange])

  return (
    <div className="flex-1 min-w-0 rounded border border-border bg-card/60 p-3 flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-semibold text-foreground">{title}</span>
        <span className="text-[11px] text-muted-foreground/70">{subtitle}</span>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">Connection</span>
        <select
          className={selectClass}
          value={endpoint.connectionId ?? ''}
          onChange={e => onChange({ connectionId: e.target.value || null, database: null, schema: null })}
        >
          <option value="">Select a PostgreSQL connection…</option>
          {connections.filter(c => c.dbType === 'postgres').map(c => (
            <option key={c.id} value={c.id} disabled={c.status !== 'connected'}>
              {c.label}{c.status !== 'connected' ? ` (${c.status})` : ''}
            </option>
          ))}
        </select>
      </label>
      <div className="flex gap-2">
        <label className="flex-1 min-w-0 flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">Database</span>
          <select
            className={selectClass}
            value={endpoint.database ?? ''}
            disabled={!conn || conn.status !== 'connected'}
            onChange={e => onChange({ ...endpoint, database: e.target.value || null, schema: null })}
          >
            <option value="">Select…</option>
            {(conn?.databases ?? []).map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
        <label className="flex-1 min-w-0 flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70 flex items-center gap-1">
            Schema {schemaLoading && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
          </span>
          <select
            className={selectClass}
            value={endpoint.schema ?? ''}
            disabled={!schemaKey || schemaLoading}
            onChange={e => onChange({ ...endpoint, schema: e.target.value || null })}
          >
            <option value="">Select…</option>
            {endpoint.schema && !schemaNames.includes(endpoint.schema) && <option value={endpoint.schema}>{endpoint.schema}</option>}
            {schemaNames.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      </div>
      {schemas?.key === schemaKey && schemas?.error && <span className="text-[11px] text-red-400">{schemas.error}</span>}
    </div>
  )
}

// ── Detail pane ───────────────────────────────────────────────────────────────

function DdlDiff({ source, target }: { source: string; target: string }) {
  const rows = useMemo(() => sideBySideDiff(source, target), [source, target])
  const sourceLines = useMemo(() => highlightSqlLines(source), [source])
  const targetLines = useMemo(() => highlightSqlLines(target), [target])
  const cell = 'px-2 whitespace-pre text-[12px] leading-[1.6] align-top'
  return (
    <div className="rounded border border-border overflow-auto bg-background" style={{ fontFamily: SQL_FONT_FAMILY }}>
      <table className="w-full border-collapse">
        <thead>
          <tr className="sticky top-0 bg-card text-[10px] uppercase tracking-wide text-muted-foreground font-sans">
            <th className="text-left px-2 py-1 w-1/2 border-b border-r border-border font-medium">Source</th>
            <th className="text-left px-2 py-1 w-1/2 border-b border-border font-medium">Target</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className={cn(cell, 'border-r border-border',
                r.kind === 'changed' && 'bg-amber-500/15', r.kind === 'left' && 'bg-green-500/15')}>{r.left !== null ? sourceLines[r.left] : null}</td>
              <td className={cn(cell,
                r.kind === 'changed' && 'bg-amber-500/15', r.kind === 'right' && 'bg-red-500/15')}>{r.right !== null ? targetLines[r.right] : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ItemDetail({ item }: { item: SyncItem }) {
  const group = ACTION_GROUPS.find(g => g.action === item.action)!
  return (
    <div className="flex flex-col gap-3 p-3 min-w-0">
      <div className="flex items-center gap-2">
        <KindIcon kind={item.kind} className="h-4 w-4" />
        <span className="text-sm font-semibold font-mono text-foreground truncate">{item.name}</span>
        <span className={cn('text-[10px] font-semibold uppercase px-1.5 rounded border border-current/30', group.className)}>{item.action === 'same' ? 'identical' : item.action}</span>
      </div>

      {item.warnings.length > 0 && (
        <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 flex flex-col gap-1">
          {item.warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-1.5 text-xs text-amber-300">
              <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />{w}
            </div>
          ))}
        </div>
      )}
      {(item.changes.length > 0 || item.notes.length > 0) && (
        <ul className="flex flex-col gap-0.5 text-xs">
          {item.changes.map((c, i) => <li key={`c${i}`} className="text-foreground">• {c}</li>)}
          {item.notes.map((n, i) => <li key={`n${i}`} className="text-muted-foreground">• {n}</li>)}
        </ul>
      )}

      <DdlDiff source={item.sourceDdl} target={item.targetDdl} />

      {item.statements.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">Statements for this object</span>
          <SqlHighlight
            sql={item.statements.map(s => s.sql + ';').join('\n\n')}
            className="rounded border border-border bg-background p-2 text-[12px] leading-[1.6] whitespace-pre-wrap text-foreground"
          />
        </div>
      )}
    </div>
  )
}

// ── Deploy dialog ─────────────────────────────────────────────────────────────

function describeScriptError(script: string, error: string, position?: number) {
  if (!position) return { message: error }
  const before = script.slice(0, position - 1)
  const lineNo = before.split('\n').length
  const line = script.split('\n')[lineNo - 1] ?? ''
  const part2At = script.indexOf('-- Part 2 of')
  const partNote = part2At >= 0 && position > part2At
    ? 'Part 1 (new enum values) was already committed; part 2 was rolled back.'
    : 'The whole script was rolled back; the target is unchanged.'
  return { message: error, location: `Line ${lineNo}: ${line.trim()}`, partNote }
}

function DeployDialog({ items, selected, target, targetLabel, onClose, onDeployed }: {
  items: SyncItem[]
  selected: string[]
  target: EndpointComplete
  targetLabel: string
  onClose: () => void
  onDeployed: () => void
}) {
  const [script, setScript] = useState(() => buildSyncScript(items, selected, target.schema))
  const [running, setRunning] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [failure, setFailure] = useState<ReturnType<typeof describeScriptError> | null>(null)

  const chosen = items.filter(i => selected.includes(i.key) && isSelectable(i))
  const counts = ACTION_GROUPS.map(g => ({ ...g, n: chosen.filter(i => i.action === g.action).length })).filter(g => g.n > 0)
  const warnings = chosen.flatMap(i => i.warnings.map(w => `${i.name}: ${w}`))
  const needsConfirm = warnings.length > 0 || chosen.some(i => i.action === 'drop')

  const execute = async () => {
    setRunning(true)
    setFailure(null)
    let res: { ok: boolean; error?: string; position?: number }
    try {
      assertSyncApiAvailable()
      res = await window.electronAPI!.pg.executeScript(target.connectionId, script, target.database)
    } catch (err) {
      res = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    setRunning(false)
    if (!res.ok) {
      setFailure(describeScriptError(script, res.error ?? 'Unknown error', res.position))
      return
    }
    toast.success(`Deployed ${chosen.length} object${chosen.length === 1 ? '' : 's'} to ${target.schema}`)
    onDeployed()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => !running && onClose()}>
      <div className="bg-card border border-border rounded-lg shadow-2xl w-[min(900px,92vw)] h-[min(720px,88vh)] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-semibold text-foreground">Deploy structure changes</span>
            <span className="text-xs text-muted-foreground truncate">Target: {targetLabel} / {target.database} / {target.schema}</span>
          </div>
          <button onClick={onClose} disabled={running} className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 disabled:opacity-40"><X className="h-4 w-4" /></button>
        </div>

        <div className="flex items-center gap-3 px-4 py-2 border-b border-border text-xs">
          {counts.map(g => <span key={g.action} className={g.className}>{g.n} {g.label.toLowerCase()}</span>)}
          <span className="text-muted-foreground/70 ml-auto">You can edit the script before running it</span>
        </div>

        {warnings.length > 0 && (
          <div className="px-4 py-2 border-b border-amber-500/30 bg-amber-500/10 max-h-28 overflow-auto flex flex-col gap-0.5">
            {warnings.map((w, i) => (
              <div key={i} className="flex items-start gap-1.5 text-xs text-amber-300"><AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />{w}</div>
            ))}
          </div>
        )}

        <div className="flex-1 min-h-0">
          <SqlCodeEditor value={script} onChange={setScript} readOnly={running} />
        </div>

        {failure && (
          <div className="px-4 py-2 border-t border-red-500/30 bg-red-500/10 text-xs flex flex-col gap-0.5">
            <span className="text-red-300 font-medium">{failure.message}</span>
            {failure.location && <span className="font-mono text-red-300/80 truncate">{failure.location}</span>}
            {failure.partNote && <span className="text-red-300/80">{failure.partNote}</span>}
          </div>
        )}

        <div className="flex items-center gap-2 px-4 py-3 border-t border-border">
          {needsConfirm && (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
              <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} className="accent-primary" />
              I have reviewed the warnings and the script
            </label>
          )}
          <div className="flex-1" />
          <button
            onClick={() => navigator.clipboard.writeText(script).then(() => toast.success('Script copied'))}
            className="flex items-center gap-1 px-3 h-7 rounded text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20"
          >
            <Copy className="h-3 w-3" /> Copy
          </button>
          <button onClick={onClose} disabled={running} className="px-3 h-7 rounded text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20 disabled:opacity-40">Cancel</button>
          <button
            onClick={execute}
            disabled={running || !script.trim() || (needsConfirm && !confirmed)}
            className={cn('flex items-center gap-1 px-3 h-7 rounded text-xs font-medium disabled:opacity-40',
              chosen.some(i => i.action === 'drop') ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : 'bg-primary text-primary-foreground hover:bg-primary/90')}
          >
            {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            {running ? 'Running…' : 'Execute'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────

export function StructureSyncView({ state, update, connections, onDeployed }: {
  state: StructureSyncState
  update: (fn: (s: StructureSyncState) => StructureSyncState) => void
  connections: SyncConnectionOption[]
  onDeployed: (connectionId: string, database: string) => void
}) {
  const { config, items } = state
  const [collapsed, setCollapsed] = useState<Set<SyncAction>>(() => new Set(['same']))
  const [deployOpen, setDeployOpen] = useState(false)

  const setConfig = (patch: Partial<StructureSyncConfig>) => update(s => ({ ...s, config: { ...s.config, ...patch } }))
  const setSource = React.useCallback((source: SyncEndpoint) => update(s => ({ ...s, config: { ...s.config, source } })), [update])
  const setTarget = React.useCallback((target: SyncEndpoint) => update(s => ({ ...s, config: { ...s.config, target } })), [update])

  const stale = !!items && JSON.stringify(state.comparedConfig) !== JSON.stringify(config)
  const canCompare = isComplete(config.source) && isComplete(config.target) && !sameEndpoint(config.source, config.target) && state.status === 'idle'
  const labelOf = (id: string | null) => connections.find(c => c.id === id)?.label ?? ''

  const compare = async () => {
    const { source, target } = config
    if (!isComplete(source) || !isComplete(target)) return
    const snapshotConfig = config
    update(s => ({ ...s, status: 'comparing', error: undefined }))
    try {
      assertSyncApiAvailable()
      const [src, dst] = await Promise.all([snapshotEndpoint(source), snapshotEndpoint(target)])
      const result = compareSchemas(src, dst, target.schema, snapshotConfig.options)
      update(s => ({
        ...s,
        status: 'idle',
        items: result,
        comparedConfig: snapshotConfig,
        selected: defaultSelection(result),
        activeKey: result.find(i => i.action !== 'same')?.key ?? result[0]?.key,
      }))
    } catch (err) {
      update(s => ({ ...s, status: 'idle', error: err instanceof Error ? err.message : String(err) }))
    }
  }

  const toggle = (keys: string[], on: boolean) => update(s => {
    const next = new Set(s.selected)
    for (const k of keys) { if (on) next.add(k); else next.delete(k) }
    return { ...s, selected: [...next] }
  })

  const selectedCount = items?.filter(i => state.selected.includes(i.key) && isSelectable(i)).length ?? 0
  const active = items?.find(i => i.key === state.activeKey)
  const comparedTarget = state.comparedConfig?.target

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Endpoints */}
      <div className="flex items-stretch gap-2 p-3 border-b border-border shrink-0">
        <EndpointPicker title="Source" subtitle="the structure to copy" endpoint={config.source} connections={connections} onChange={setSource} />
        <button
          onClick={() => setConfig({ source: config.target, target: config.source })}
          title="Swap source and target"
          className="self-center p-2 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20"
        >
          <ArrowLeftRight className="h-4 w-4" />
        </button>
        <EndpointPicker title="Target" subtitle="gets changed to match" endpoint={config.target} connections={connections} onChange={setTarget} />
      </div>

      {/* Options */}
      <div className="flex items-center gap-4 px-3 py-2 border-b border-border shrink-0 text-xs">
        {(['tables', 'views', 'enums'] as const).map(k => (
          <label key={k} className="flex items-center gap-1.5 cursor-pointer select-none text-muted-foreground hover:text-foreground">
            <input type="checkbox" className="accent-primary" checked={config.options[k]} onChange={e => setConfig({ options: { ...config.options, [k]: e.target.checked } })} />
            {k[0].toUpperCase() + k.slice(1)}
          </label>
        ))}
        <div className="w-px h-4 bg-border" />
        <label className="flex items-center gap-1.5 cursor-pointer select-none text-muted-foreground hover:text-foreground" title="Target columns that don't exist in the source are dropped, deleting their data">
          <input type="checkbox" className="accent-primary" checked={config.options.dropColumns} onChange={e => setConfig({ options: { ...config.options, dropColumns: e.target.checked } })} />
          Drop columns missing from source
        </label>
        <div className="flex-1" />
        {sameEndpoint(config.source, config.target) && isComplete(config.source) && (
          <span className="text-amber-400">Source and target are the same schema</span>
        )}
        <button
          onClick={compare}
          disabled={!canCompare}
          className="flex items-center gap-1.5 px-3 h-7 rounded bg-primary text-primary-foreground font-medium hover:bg-primary/90 disabled:opacity-40"
        >
          {state.status === 'comparing' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitCompareArrows className="h-3.5 w-3.5" />}
          {state.status === 'comparing' ? 'Comparing…' : items ? 'Compare again' : 'Compare'}
        </button>
      </div>

      {state.error && (
        <div className="px-3 py-2 border-b border-red-500/30 bg-red-500/10 text-xs text-red-300 shrink-0">{state.error}</div>
      )}
      {stale && (
        <div className="px-3 py-1.5 border-b border-amber-500/30 bg-amber-500/10 text-xs text-amber-400 shrink-0">
          Source, target or options changed since the last comparison. Compare again before deploying.
        </div>
      )}

      {/* Results */}
      {!items ? (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground p-6 text-center">
          {state.status === 'comparing'
            ? <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Reading both schemas…</span>
            : 'Pick a source and a target schema (PostgreSQL), then press Compare.'}
        </div>
      ) : (
        <div className="flex flex-1 min-h-0">
          <div className="w-80 shrink-0 border-r border-border overflow-auto py-1">
            {items.length === 0 && <div className="p-4 text-xs text-muted-foreground">Nothing to compare in these schemas.</div>}
            {ACTION_GROUPS.map(group => {
              const groupItems = items.filter(i => i.action === group.action)
              if (groupItems.length === 0) return null
              const selectable = groupItems.filter(isSelectable).map(i => i.key)
              const checkedCount = selectable.filter(k => state.selected.includes(k)).length
              const isCollapsed = collapsed.has(group.action)
              return (
                <div key={group.action}>
                  <div className="flex items-center gap-1.5 px-2 py-1 text-xs select-none">
                    <button onClick={() => setCollapsed(prev => { const n = new Set(prev); if (n.has(group.action)) n.delete(group.action); else n.add(group.action); return n })} className="text-muted-foreground hover:text-foreground">
                      {isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                    </button>
                    {selectable.length > 0 && (
                      <input
                        type="checkbox"
                        className="accent-primary"
                        checked={checkedCount === selectable.length}
                        ref={el => { if (el) el.indeterminate = checkedCount > 0 && checkedCount < selectable.length }}
                        onChange={e => toggle(selectable, e.target.checked)}
                      />
                    )}
                    <span className={cn('font-semibold', group.className)}>{group.label}</span>
                    <span className="text-muted-foreground/60">{groupItems.length}</span>
                  </div>
                  {!isCollapsed && groupItems.map(i => (
                    <div
                      key={i.key}
                      role="button" tabIndex={0}
                      onClick={() => update(s => ({ ...s, activeKey: i.key }))}
                      className={cn('flex items-center gap-1.5 pl-6 pr-2 py-0.5 text-xs cursor-pointer',
                        state.activeKey === i.key ? 'bg-primary/20 text-foreground' : 'text-muted-foreground hover:bg-accent/20 hover:text-foreground')}
                    >
                      <input
                        type="checkbox"
                        className="accent-primary"
                        disabled={!isSelectable(i)}
                        checked={isSelectable(i) && state.selected.includes(i.key)}
                        onClick={e => e.stopPropagation()}
                        onChange={e => toggle([i.key], e.target.checked)}
                      />
                      <KindIcon kind={i.kind} />
                      <span className="truncate flex-1 font-mono">{i.name}</span>
                      {i.unsupported && <span className="text-[9px] px-1 rounded bg-amber-500/20 text-amber-400" title="Some differences must be changed manually">manual</span>}
                      {i.warnings.length > 0 && <AlertTriangle className="h-3 w-3 text-amber-400 shrink-0" />}
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
          <div className="flex-1 min-w-0 overflow-auto">
            {active ? <ItemDetail item={active} /> : <div className="p-4 text-xs text-muted-foreground">Select an object to see its differences.</div>}
          </div>
        </div>
      )}

      {/* Footer */}
      {items && (
        <div className="flex items-center gap-3 px-3 h-10 border-t border-border bg-card shrink-0 text-xs">
          <span className="text-muted-foreground">
            {items.every(i => i.action === 'same')
              ? <span className="flex items-center gap-1 text-green-400"><Check className="h-3.5 w-3.5" /> The target matches the source</span>
              : `${selectedCount} of ${items.filter(isSelectable).length} changes selected`}
          </span>
          <div className="flex-1" />
          <button
            onClick={() => setDeployOpen(true)}
            disabled={selectedCount === 0 || stale || state.status !== 'idle' || !comparedTarget || !isComplete(comparedTarget)}
            className="flex items-center gap-1.5 px-3 h-7 rounded bg-primary text-primary-foreground font-medium hover:bg-primary/90 disabled:opacity-40"
          >
            <Play className="h-3.5 w-3.5" /> Preview &amp; deploy
          </button>
        </div>
      )}

      {deployOpen && items && comparedTarget && isComplete(comparedTarget) && (
        <DeployDialog
          items={items}
          selected={state.selected}
          target={comparedTarget}
          targetLabel={labelOf(comparedTarget.connectionId)}
          onClose={() => setDeployOpen(false)}
          onDeployed={() => {
            setDeployOpen(false)
            onDeployed(comparedTarget.connectionId, comparedTarget.database)
            void compare()
          }}
        />
      )}
    </div>
  )
}
