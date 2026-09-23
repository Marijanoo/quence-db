'use client'

import React, { useState } from 'react'
import { AlertTriangle, ArrowLeftRight, Check, DatabaseZap, Loader2, Play, Square, Table2, X } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  compareTable, dataSyncSettings, deployData, loadDataMeta, planTables, DataSyncCancelled, SAMPLE_LIMIT,
  type ApplyResult, type DataTableMeta, type DeployProgress, type Endpoint, type Row, type SqlRunner, type TableDiff, type TableOps, type TablePlan,
} from '@/lib/data-sync'
import {
  EndpointPicker, EMPTY_ENDPOINT, RESTART_MESSAGE, isComplete, sameEndpoint,
  type EndpointComplete, type SyncConnectionOption, type SyncEndpoint,
} from '@/components/structure-sync'
import { SQL_FONT_FAMILY } from '@/components/sql-highlight'

// ── State ─────────────────────────────────────────────────────────────────────

export interface DataSyncConfig { source: SyncEndpoint; target: SyncEndpoint; defaults: TableOps }

export interface DataSyncTable {
  plan: TablePlan
  status: 'pending' | 'comparing' | 'done' | 'error' | 'skipped'
  scanned: number
  diff?: TableDiff
  error?: string
  selected: boolean
  ops: TableOps
}

export interface DataSyncState {
  config: DataSyncConfig
  status: 'idle' | 'comparing'
  error?: string
  tables?: DataSyncTable[]
  targetMeta?: DataTableMeta[]
  comparedConfig?: DataSyncConfig
  activeTable?: string
  runId?: string
}

export const DEFAULT_TABLE_OPS: TableOps = { insert: true, update: true, delete: false }

export function initialDataSyncState(config?: DataSyncConfig): DataSyncState {
  return { config: config ?? { source: EMPTY_ENDPOINT, target: EMPTY_ENDPOINT, defaults: DEFAULT_TABLE_OPS }, status: 'idle' }
}

// Compare runs outlive the component (switching tabs unmounts it), so their cancel handles live here
const runControllers = new Map<string, AbortController>()

// ── IPC helpers ───────────────────────────────────────────────────────────────

async function openSession(e: EndpointComplete, readOnly: boolean): Promise<{ runner: SqlRunner; close: (commit: boolean) => Promise<void> }> {
  const pg = window.electronAPI?.pg
  if (typeof pg?.sessionOpen !== 'function') throw new Error(RESTART_MESSAGE)
  const res = await pg.sessionOpen(e.connectionId, e.database, dataSyncSettings(e.schema), readOnly)
  if (!res.ok || !res.sessionId) throw new Error(res.error ?? 'Could not open a transaction')
  const sessionId = res.sessionId
  return {
    runner: {
      query: async (sql, params) => {
        const r = await pg.sessionQuery(sessionId, sql, params)
        if (!r.ok) throw new Error(r.error)
        return { rows: r.rows ?? [], rowCount: r.rowCount ?? 0 }
      },
    },
    close: async commit => {
      const r = await pg.sessionClose(sessionId, commit)
      if (!r.ok) throw new Error(r.error)
    },
  }
}

const errorMessage = (err: unknown) => err instanceof Error ? err.message : String(err)
const fmt = (n: number) => n.toLocaleString()
const opCount = (t: DataSyncTable) => t.diff
  ? (t.ops.insert ? t.diff.inserts : 0) + (t.ops.update ? t.diff.updates : 0) + (t.ops.delete ? t.diff.deletes : 0)
  : 0

// ── Row preview ───────────────────────────────────────────────────────────────

function Cell({ value, changed }: { value: string | null | undefined; changed?: boolean }) {
  return (
    <td
      title={value ?? 'NULL'}
      className={cn('px-2 py-0.5 border-r border-border/50 whitespace-nowrap max-w-[240px] truncate', changed && 'bg-amber-500/20 text-amber-300')}
    >
      {value === null || value === undefined ? <span className="italic text-muted-foreground/50">NULL</span> : value}
    </td>
  )
}

function RowsPreview({ columns, kind, diff }: { columns: string[]; kind: 'inserts' | 'updates' | 'deletes'; diff: TableDiff }) {
  const total = diff[kind]
  const shown = diff.samples[kind].length
  if (total === 0) return <div className="p-4 text-xs text-muted-foreground">No rows.</div>
  const head = 'px-2 py-1 text-left font-medium text-muted-foreground border-r border-b border-border whitespace-nowrap'
  return (
    <div className="flex flex-col min-h-0">
      <div className="px-3 py-1 text-[11px] text-muted-foreground/70">
        {shown < total ? `Showing the first ${fmt(shown)} of ${fmt(total)} rows` : `${fmt(total)} row${total === 1 ? '' : 's'}`}
        {kind === 'updates' && ' · changed values are highlighted; each change shows the source row, then the current target row'}
      </div>
      <div className="overflow-auto border-t border-border">
        <table className="text-[12px] border-collapse" style={{ fontFamily: SQL_FONT_FAMILY }}>
          <thead className="sticky top-0 bg-card">
            <tr>
              {kind === 'updates' && <th className={head} />}
              {columns.map(c => <th key={c} className={head}>{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {kind === 'updates'
              ? diff.samples.updates.map((u, i) => (
                <React.Fragment key={i}>
                  <tr className="border-t border-border">
                    <td className="px-2 text-[10px] uppercase text-green-400 border-r border-border/50">source</td>
                    {columns.map(c => <Cell key={c} value={u.source[c]} changed={u.source[c] !== u.target[c]} />)}
                  </tr>
                  <tr className="border-b border-border/50 text-muted-foreground">
                    <td className="px-2 text-[10px] uppercase text-red-400 border-r border-border/50">target</td>
                    {columns.map(c => <Cell key={c} value={u.target[c]} />)}
                  </tr>
                </React.Fragment>
              ))
              : (diff.samples[kind] as Row[]).map((r, i) => (
                <tr key={i} className="border-b border-border/50">
                  {columns.map(c => <Cell key={c} value={r[c]} />)}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function TableDetail({ table, onOps }: { table: DataSyncTable; onOps: (ops: TableOps) => void }) {
  const [tab, setTab] = useState<'inserts' | 'updates' | 'deletes'>(() => table.diff?.inserts ? 'inserts' : table.diff?.updates ? 'updates' : 'deletes')
  const { plan, diff } = table
  const opRows: { op: keyof TableOps; kind: 'inserts' | 'updates' | 'deletes'; label: string; className: string }[] = [
    { op: 'insert', kind: 'inserts', label: 'Insert', className: 'text-green-400' },
    { op: 'update', kind: 'updates', label: 'Update', className: 'text-amber-400' },
    { op: 'delete', kind: 'deletes', label: 'Delete', className: 'text-red-400' },
  ]
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex flex-col gap-2 p-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <Table2 className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold font-mono text-foreground">{plan.table}</span>
          {diff && <span className="text-xs text-muted-foreground">source {fmt(diff.sourceRows)} rows · target {fmt(diff.targetRows)} rows · {fmt(diff.identical)} identical</span>}
        </div>
        {plan.skipped && <div className="text-xs text-muted-foreground">{plan.skipped}</div>}
        {table.error && <div className="text-xs text-red-400">{table.error}</div>}
        {plan.warnings.length > 0 && (
          <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 flex flex-col gap-0.5">
            {plan.warnings.map((w, i) => <div key={i} className="flex items-start gap-1.5 text-xs text-amber-300"><AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />{w}</div>)}
          </div>
        )}
        {diff && (
          <div className="flex items-center gap-4 text-xs">
            {opRows.map(o => (
              <label key={o.op} className="flex items-center gap-1.5 cursor-pointer select-none">
                <input type="checkbox" className="accent-primary" checked={table.ops[o.op]} onChange={e => onOps({ ...table.ops, [o.op]: e.target.checked })} />
                <span className={o.className}>{o.label} {fmt(diff[o.kind])}</span>
              </label>
            ))}
            <span className="text-muted-foreground/60">Key: {plan.key.join(', ')}</span>
          </div>
        )}
      </div>
      {diff && (
        <>
          <div className="flex items-center border-b border-border shrink-0">
            {opRows.map(o => (
              <button
                key={o.kind}
                onClick={() => setTab(o.kind)}
                className={cn('px-3 h-7 text-xs border-r border-border', tab === o.kind ? 'bg-background text-foreground' : 'text-muted-foreground hover:text-foreground')}
              >
                {o.kind === 'inserts' ? 'Only in source' : o.kind === 'updates' ? 'Different' : 'Only in target'} ({fmt(diff[o.kind])})
              </button>
            ))}
          </div>
          <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
            <RowsPreview columns={plan.columns} kind={tab} diff={diff} />
          </div>
        </>
      )}
    </div>
  )
}

// ── Deploy dialog ─────────────────────────────────────────────────────────────

function DeployDialog({ tables, source, target, targetMeta, targetLabel, onClose, onDeployed }: {
  tables: DataSyncTable[]
  source: EndpointComplete
  target: EndpointComplete
  targetMeta: DataTableMeta[]
  targetLabel: string
  onClose: () => void
  onDeployed: () => void
}) {
  const [phase, setPhase] = useState<'review' | 'running' | 'done' | 'failed'>('review')
  const [progress, setProgress] = useState<DeployProgress | null>(null)
  const [results, setResults] = useState<Record<string, ApplyResult> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [controller] = useState(() => new AbortController())

  const deletes = tables.filter(t => t.ops.delete && (t.diff?.deletes ?? 0) > 0)
  const warnings = tables.flatMap(t => t.plan.warnings.map(w => `${t.plan.table}: ${w}`))
  const needsConfirm = deletes.length > 0 || warnings.length > 0
  const tableIndex = progress ? tables.findIndex(t => t.plan.table === progress.table) : -1

  const execute = async () => {
    setPhase('running')
    setError(null)
    let src: Awaited<ReturnType<typeof openSession>> | undefined
    let dst: Awaited<ReturnType<typeof openSession>> | undefined
    try {
      src = await openSession(source, true)
      dst = await openSession(target, false)
      const srcEndpoint: Endpoint = { runner: src.runner, schema: source.schema }
      const dstEndpoint: Endpoint = { runner: dst.runner, schema: target.schema }
      const res = await deployData(srcEndpoint, dstEndpoint, tables.map(t => ({ plan: t.plan, ops: t.ops })), targetMeta, {
        signal: controller.signal,
        onProgress: setProgress,
      })
      await dst.close(true)
      dst = undefined
      setResults(res)
      setPhase('done')
      const total = Object.values(res).reduce((n, r) => n + r.inserted + r.updated + r.deleted, 0)
      toast.success(`Data sync finished: ${fmt(total)} row${total === 1 ? '' : 's'} changed`)
    } catch (err) {
      setError(err instanceof DataSyncCancelled ? 'Cancelled. All changes were rolled back.' : `${errorMessage(err)}\n\nAll changes were rolled back; the target is unchanged.`)
      setPhase('failed')
    } finally {
      await dst?.close(false).catch(() => {})
      await src?.close(false).catch(() => {})
    }
  }

  const busy = phase === 'running'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => !busy && onClose()}>
      <div className="bg-card border border-border rounded-lg shadow-2xl w-[min(760px,92vw)] max-h-[88vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-semibold text-foreground">Deploy data changes</span>
            <span className="text-xs text-muted-foreground truncate">Target: {targetLabel} / {target.database} / {target.schema}</span>
          </div>
          <button onClick={onClose} disabled={busy} className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 disabled:opacity-40"><X className="h-4 w-4" /></button>
        </div>

        <div className="overflow-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="border-b border-border">
                <th className="text-left font-medium px-4 py-1.5">Table</th>
                <th className="text-right font-medium px-2">Insert</th>
                <th className="text-right font-medium px-2">Update</th>
                <th className="text-right font-medium px-4">Delete</th>
              </tr>
            </thead>
            <tbody>
              {tables.map(t => {
                const r = results?.[t.plan.table]
                const cellValue = (op: keyof TableOps, planned: number, actual?: number) =>
                  !t.ops[op] ? <span className="text-muted-foreground/40">off</span> : fmt(actual ?? planned)
                return (
                  <tr key={t.plan.table} className={cn('border-b border-border/50', progress?.table === t.plan.table && busy && 'bg-primary/10')}>
                    <td className="px-4 py-1 font-mono">{t.plan.table}</td>
                    <td className="px-2 text-right text-green-400">{cellValue('insert', t.diff?.inserts ?? 0, r?.inserted)}</td>
                    <td className="px-2 text-right text-amber-400">{cellValue('update', t.diff?.updates ?? 0, r?.updated)}</td>
                    <td className="px-4 text-right text-red-400">{cellValue('delete', t.diff?.deletes ?? 0, r?.deleted)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {phase === 'review' && (
          <div className="px-4 py-2 text-xs text-muted-foreground border-t border-border">
            Changes are re-checked while deploying and applied in batches inside one transaction. If anything fails or you cancel, nothing is changed.
            Counts above are from the comparison and may shift if data changed since.
          </div>
        )}
        {phase === 'review' && (warnings.length > 0 || deletes.length > 0) && (
          <div className="px-4 py-2 border-t border-amber-500/30 bg-amber-500/10 max-h-32 overflow-auto flex flex-col gap-0.5">
            {deletes.length > 0 && (
              <div className="flex items-start gap-1.5 text-xs text-amber-300">
                <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                Deletes rows in {deletes.map(t => t.plan.table).join(', ')} that don&apos;t exist in the source
              </div>
            )}
            {warnings.map((w, i) => <div key={i} className="flex items-start gap-1.5 text-xs text-amber-300"><AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />{w}</div>)}
          </div>
        )}
        {busy && progress && (
          <div className="px-4 py-3 border-t border-border flex flex-col gap-1.5">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Table {tableIndex + 1} of {tables.length}: <span className="font-mono text-foreground">{progress.table}</span>
              · {progress.phase === 'delete' ? 'removing rows' : 'inserting & updating'} · {fmt(progress.scanned)} rows checked
            </div>
            <div className="h-1.5 rounded bg-border overflow-hidden">
              <div className="h-full bg-primary transition-all" style={{ width: `${progress.estimatedRows ? Math.min(100, (progress.scanned / progress.estimatedRows) * 100) : 50}%` }} />
            </div>
          </div>
        )}
        {phase === 'done' && (
          <div className="px-4 py-2 border-t border-green-500/30 bg-green-500/10 text-xs text-green-300 flex items-center gap-1.5">
            <Check className="h-3.5 w-3.5" /> Committed. The numbers above are the rows actually changed.
          </div>
        )}
        {phase === 'failed' && error && (
          <div className="px-4 py-2 border-t border-red-500/30 bg-red-500/10 text-xs text-red-300 whitespace-pre-wrap">{error}</div>
        )}

        <div className="flex items-center gap-2 px-4 py-3 border-t border-border">
          {phase === 'review' && needsConfirm && (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
              <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} className="accent-primary" />
              I understand this changes data in the target
            </label>
          )}
          <div className="flex-1" />
          {busy ? (
            <button onClick={() => controller.abort()} className="flex items-center gap-1 px-3 h-7 rounded text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20">
              <Square className="h-3 w-3" /> Cancel &amp; roll back
            </button>
          ) : phase === 'done' ? (
            <button onClick={onDeployed} className="px-3 h-7 rounded text-xs bg-primary text-primary-foreground font-medium hover:bg-primary/90">Close &amp; compare again</button>
          ) : (
            <>
              <button onClick={onClose} className="px-3 h-7 rounded text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20">Cancel</button>
              <button
                onClick={execute}
                disabled={phase === 'failed' ? false : needsConfirm && !confirmed}
                className={cn('flex items-center gap-1 px-3 h-7 rounded text-xs font-medium disabled:opacity-40',
                  deletes.length > 0 ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : 'bg-primary text-primary-foreground hover:bg-primary/90')}
              >
                <Play className="h-3 w-3" /> {phase === 'failed' ? 'Retry' : 'Execute'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────

export function DataSyncView({ state, update, connections, onDeployed }: {
  state: DataSyncState
  update: (fn: (s: DataSyncState) => DataSyncState) => void
  connections: SyncConnectionOption[]
  onDeployed: (connectionId: string, database: string) => void
}) {
  const { config, tables } = state
  const [deployOpen, setDeployOpen] = useState(false)
  const setSource = React.useCallback((source: SyncEndpoint) => update(s => ({ ...s, config: { ...s.config, source } })), [update])
  const setTarget = React.useCallback((target: SyncEndpoint) => update(s => ({ ...s, config: { ...s.config, target } })), [update])
  const patchTable = (name: string, patch: (t: DataSyncTable) => Partial<DataSyncTable>) =>
    update(s => ({ ...s, tables: s.tables?.map(t => t.plan.table === name ? { ...t, ...patch(t) } : t) }))

  const comparing = state.status === 'comparing'
  const stale = !!tables && JSON.stringify(state.comparedConfig) !== JSON.stringify(config)
  const canCompare = isComplete(config.source) && isComplete(config.target) && !sameEndpoint(config.source, config.target) && !comparing
  const labelOf = (id: string | null) => connections.find(c => c.id === id)?.label ?? ''

  const compare = async () => {
    const { source, target } = config
    if (!isComplete(source) || !isComplete(target)) return
    const runId = Math.random().toString(36).slice(2)
    const controller = new AbortController()
    runControllers.set(runId, controller)
    const compared = config
    update(s => ({ ...s, status: 'comparing', error: undefined, runId, tables: undefined, comparedConfig: compared }))

    let src: Awaited<ReturnType<typeof openSession>> | undefined
    let dst: Awaited<ReturnType<typeof openSession>> | undefined
    try {
      src = await openSession(source, true)
      dst = await openSession(target, true)
      const srcEndpoint: Endpoint = { runner: src.runner, schema: source.schema }
      const dstEndpoint: Endpoint = { runner: dst.runner, schema: target.schema }
      const [srcMeta, dstMeta] = await Promise.all([loadDataMeta(src.runner, source.schema), loadDataMeta(dst.runner, target.schema)])
      const plans = planTables(srcMeta, dstMeta)
      update(s => ({
        ...s,
        targetMeta: dstMeta,
        activeTable: plans.find(p => !p.skipped)?.table,
        tables: plans.map(plan => ({ plan, status: plan.skipped ? 'skipped' : 'pending', scanned: 0, selected: false, ops: compared.defaults })),
      }))

      for (const plan of plans.filter(p => !p.skipped)) {
        if (controller.signal.aborted) break
        patchTable(plan.table, () => ({ status: 'comparing' }))
        try {
          const diff = await compareTable(srcEndpoint, dstEndpoint, plan, {
            signal: controller.signal,
            onProgress: scanned => patchTable(plan.table, () => ({ scanned })),
          })
          patchTable(plan.table, t => {
            const next = { ...t, status: 'done' as const, diff }
            return { status: 'done', diff, selected: opCount(next) > 0 }
          })
        } catch (err) {
          if (err instanceof DataSyncCancelled) throw err
          patchTable(plan.table, () => ({ status: 'error', error: errorMessage(err) }))
        }
      }
      update(s => ({ ...s, status: 'idle' }))
    } catch (err) {
      update(s => ({
        ...s,
        status: 'idle',
        error: err instanceof DataSyncCancelled ? 'Comparison cancelled.' : errorMessage(err),
        tables: s.tables?.map(t => t.status === 'comparing' || t.status === 'pending' ? { ...t, status: 'error', error: 'Not compared' } : t),
      }))
    } finally {
      runControllers.delete(runId)
      await src?.close(false).catch(() => {})
      await dst?.close(false).catch(() => {})
    }
  }

  const selectedTables = tables?.filter(t => t.selected && t.status === 'done' && opCount(t) > 0) ?? []
  const active = tables?.find(t => t.plan.table === state.activeTable)
  const compared = state.comparedConfig
  const totals = selectedTables.reduce((acc, t) => ({
    ins: acc.ins + (t.ops.insert ? t.diff!.inserts : 0),
    upd: acc.upd + (t.ops.update ? t.diff!.updates : 0),
    del: acc.del + (t.ops.delete ? t.diff!.deletes : 0),
  }), { ins: 0, upd: 0, del: 0 })

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-stretch gap-2 p-3 border-b border-border shrink-0">
        <EndpointPicker title="Source" subtitle="the data to copy" endpoint={config.source} connections={connections} onChange={setSource} />
        <button
          onClick={() => update(s => ({ ...s, config: { ...s.config, source: s.config.target, target: s.config.source } }))}
          title="Swap source and target"
          className="self-center p-2 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20"
        >
          <ArrowLeftRight className="h-4 w-4" />
        </button>
        <EndpointPicker title="Target" subtitle="gets changed to match" endpoint={config.target} connections={connections} onChange={setTarget} />
      </div>

      <div className="flex items-center gap-4 px-3 py-2 border-b border-border shrink-0 text-xs">
        <span className="text-muted-foreground/70">By default:</span>
        {([['insert', 'Insert missing rows'], ['update', 'Update changed rows'], ['delete', 'Delete rows not in source']] as const).map(([op, label]) => (
          <label key={op} className="flex items-center gap-1.5 cursor-pointer select-none text-muted-foreground hover:text-foreground">
            <input
              type="checkbox"
              className="accent-primary"
              checked={config.defaults[op]}
              onChange={e => update(s => ({
                ...s,
                config: { ...s.config, defaults: { ...s.config.defaults, [op]: e.target.checked } },
                // Applies to every compared table, like changing a column of checkboxes at once
                tables: s.tables?.map(t => {
                  const next = { ...t, ops: { ...t.ops, [op]: e.target.checked } }
                  return { ...next, selected: t.status === 'done' && opCount(next) > 0 }
                }),
                comparedConfig: s.comparedConfig && { ...s.comparedConfig, defaults: { ...s.comparedConfig.defaults, [op]: e.target.checked } },
              }))}
            />
            {label}
          </label>
        ))}
        <div className="flex-1" />
        {sameEndpoint(config.source, config.target) && isComplete(config.source) && <span className="text-amber-400">Source and target are the same schema</span>}
        {comparing ? (
          <button
            onClick={() => state.runId && runControllers.get(state.runId)?.abort()}
            className="flex items-center gap-1.5 px-3 h-7 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20"
          >
            <Square className="h-3 w-3" /> Cancel
          </button>
        ) : (
          <button
            onClick={compare}
            disabled={!canCompare}
            className="flex items-center gap-1.5 px-3 h-7 rounded bg-primary text-primary-foreground font-medium hover:bg-primary/90 disabled:opacity-40"
          >
            <DatabaseZap className="h-3.5 w-3.5" /> {tables ? 'Compare again' : 'Compare'}
          </button>
        )}
      </div>

      {state.error && <div className="px-3 py-2 border-b border-red-500/30 bg-red-500/10 text-xs text-red-300 shrink-0">{state.error}</div>}
      {stale && !comparing && (
        <div className="px-3 py-1.5 border-b border-amber-500/30 bg-amber-500/10 text-xs text-amber-400 shrink-0">
          Source or target changed since the last comparison. Compare again before deploying.
        </div>
      )}

      {!tables ? (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground p-6 text-center">
          {comparing
            ? <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Reading table definitions…</span>
            : 'Pick a source and a target schema (PostgreSQL), then press Compare. Tables are matched by name and rows by primary key.'}
        </div>
      ) : (
        <div className="flex flex-1 min-h-0">
          <div className="w-80 shrink-0 border-r border-border overflow-auto py-1">
            {tables.map(t => {
              const d = t.diff
              return (
                <div
                  key={t.plan.table}
                  role="button" tabIndex={0}
                  onClick={() => update(s => ({ ...s, activeTable: t.plan.table }))}
                  className={cn('flex items-center gap-1.5 px-2 py-1 text-xs cursor-pointer',
                    state.activeTable === t.plan.table ? 'bg-primary/20 text-foreground' : 'text-muted-foreground hover:bg-accent/20 hover:text-foreground')}
                >
                  <input
                    type="checkbox"
                    className="accent-primary"
                    disabled={t.status !== 'done' || opCount(t) === 0}
                    checked={t.selected && t.status === 'done' && opCount(t) > 0}
                    onClick={e => e.stopPropagation()}
                    onChange={e => patchTable(t.plan.table, () => ({ selected: e.target.checked }))}
                  />
                  <Table2 className={cn('h-3.5 w-3.5 shrink-0', t.status === 'skipped' ? 'text-muted-foreground/40' : 'text-primary')} />
                  <span className={cn('truncate flex-1 font-mono', t.status === 'skipped' && 'text-muted-foreground/50')}>{t.plan.table}</span>
                  {t.status === 'comparing' && <span className="flex items-center gap-1 text-[10px] text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />{fmt(t.scanned)}</span>}
                  {t.status === 'pending' && <span className="text-[10px] text-muted-foreground/50">waiting</span>}
                  {t.status === 'skipped' && <span className="text-[10px] text-muted-foreground/50" title={t.plan.skipped}>skipped</span>}
                  {t.status === 'error' && <span title={t.error}><AlertTriangle className="h-3 w-3 text-red-400" /></span>}
                  {d && t.status === 'done' && (
                    d.inserts + d.updates + d.deletes === 0
                      ? <span className="text-[10px] text-muted-foreground/60">identical</span>
                      : <span className="flex items-center gap-1 text-[10px] tabular-nums">
                          {d.inserts > 0 && <span className={cn('text-green-400', !t.ops.insert && 'opacity-40 line-through')}>+{fmt(d.inserts)}</span>}
                          {d.updates > 0 && <span className={cn('text-amber-400', !t.ops.update && 'opacity-40 line-through')}>~{fmt(d.updates)}</span>}
                          {d.deletes > 0 && <span className={cn('text-red-400', !t.ops.delete && 'opacity-40 line-through')}>−{fmt(d.deletes)}</span>}
                        </span>
                  )}
                  {t.plan.warnings.length > 0 && <AlertTriangle className="h-3 w-3 text-amber-400 shrink-0" />}
                </div>
              )
            })}
          </div>
          <div className="flex-1 min-w-0 min-h-0">
            {active
              ? <TableDetail
                  key={active.plan.table}
                  table={active}
                  onOps={ops => patchTable(active.plan.table, t => {
                    const next = { ...t, ops }
                    return { ops, selected: opCount(next) > 0 }
                  })}
                />
              : <div className="p-4 text-xs text-muted-foreground">Select a table to see its differences.</div>}
          </div>
        </div>
      )}

      {tables && (
        <div className="flex items-center gap-3 px-3 h-10 border-t border-border bg-card shrink-0 text-xs">
          <span className="text-muted-foreground">
            {!comparing && tables.every(t => t.status !== 'done' || (t.diff!.inserts + t.diff!.updates + t.diff!.deletes) === 0)
              ? <span className="flex items-center gap-1 text-green-400"><Check className="h-3.5 w-3.5" /> No data differences in the compared tables</span>
              : <>
                  {selectedTables.length} table{selectedTables.length === 1 ? '' : 's'} selected ·{' '}
                  <span className="text-green-400">+{fmt(totals.ins)}</span>{' '}
                  <span className="text-amber-400">~{fmt(totals.upd)}</span>{' '}
                  <span className="text-red-400">−{fmt(totals.del)}</span> rows
                </>}
          </span>
          <div className="flex-1" />
          <span className="text-muted-foreground/60">Previews show up to {SAMPLE_LIMIT} rows per table</span>
          <button
            onClick={() => setDeployOpen(true)}
            disabled={selectedTables.length === 0 || stale || comparing || !compared || !isComplete(compared.source) || !isComplete(compared.target) || !state.targetMeta}
            className="flex items-center gap-1.5 px-3 h-7 rounded bg-primary text-primary-foreground font-medium hover:bg-primary/90 disabled:opacity-40"
          >
            <Play className="h-3.5 w-3.5" /> Deploy…
          </button>
        </div>
      )}

      {deployOpen && compared && isComplete(compared.source) && isComplete(compared.target) && state.targetMeta && (() => {
        const target = compared.target
        return (
          <DeployDialog
            tables={selectedTables}
            source={compared.source}
            target={target}
            targetMeta={state.targetMeta}
            targetLabel={labelOf(target.connectionId)}
            onClose={() => setDeployOpen(false)}
            onDeployed={() => {
              setDeployOpen(false)
              onDeployed(target.connectionId, target.database)
              void compare()
            }}
          />
        )
      })()}
    </div>
  )
}
