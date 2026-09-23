'use client'

import React, { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle, Brush, ChevronDown, Copy, CopyPlus, Eraser, Gauge, Loader2, Pencil, Play, RefreshCw, Scissors, Square, Table2, Trash2, Wrench, X,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  ActionCancelled, TABLE_COLUMNS_SQL, TABLE_STATS_SQL, formatBytes, mysqlAutoCommits, runInTransaction, runsOutsideTransaction,
  tableActionAvailable, tableActionStatements,
  type ActionRun, type TableActionKind, type TableActionOptions, type TableColumnInfo, type TableDbType, type TxSession,
} from '@/lib/table-actions'
import { fetchSchemaSnapshot, snapshotSearchPath, tableDisplayDdl } from '@/lib/structure-sync'
import { SqlHighlight } from '@/components/sql-highlight'
import { RESTART_MESSAGE } from '@/components/structure-sync'

export type TableChange =
  | { kind: 'renamed'; newName: string }
  | { kind: 'dropped' }
  | { kind: 'created'; name: string }
  | { kind: 'data' }
  | { kind: 'maintenance' }

interface TableRef { dbType: TableDbType; connectionId: string; database: string; schema: string; table: string }

// ── IPC ───────────────────────────────────────────────────────────────────────

async function query(t: TableRef, sql: string, params?: unknown[]) {
  const api = t.dbType === 'mysql' ? window.electronAPI!.mysql : window.electronAPI!.pg
  const res = await api.query(t.connectionId, sql, t.database, params)
  if (!res.ok) throw new Error(res.error)
  return res.rows ?? []
}

// Runs an action in a transaction session that can be cancelled mid-statement (and rolls back).
// VACUUM can't run inside a transaction, so it runs directly and can't be cancelled.
function startAction(t: TableRef, kind: TableActionKind, statements: string[], onCommitting: () => void): ActionRun & { cancellable: boolean } {
  if (t.dbType === 'postgres' && runsOutsideTransaction(kind)) {
    return { cancellable: false, cancel: () => {}, done: (async () => { for (const s of statements) await query(t, s) })() }
  }
  const api = t.dbType === 'mysql' ? window.electronAPI!.mysql : window.electronAPI!.pg
  if (typeof api.sessionCancel !== 'function') throw new Error(RESTART_MESSAGE)
  const open = async (): Promise<TxSession> => {
    const res = t.dbType === 'mysql'
      ? await window.electronAPI!.mysql.sessionOpen(t.connectionId, t.database)
      : await window.electronAPI!.pg.sessionOpen(t.connectionId, t.database)
    if (!res.ok || !res.sessionId) throw new Error(res.error ?? 'Could not start a transaction')
    const id = res.sessionId
    return {
      query: async sql => { const r = await api.sessionQuery(id, sql); if (!r.ok) throw new Error(r.error) },
      close: async commit => { const r = await api.sessionClose(id, commit); if (!r.ok) throw new Error(r.error) },
      cancel: async () => { await api.sessionCancel(id) },
    }
  }
  return { cancellable: true, ...runInTransaction(open, statements, onCommitting) }
}

async function createStatement(t: TableRef): Promise<string> {
  if (t.dbType === 'mysql') {
    const rows = await query(t, `SHOW CREATE TABLE \`${t.schema.replace(/`/g, '``')}\`.\`${t.table.replace(/`/g, '``')}\``)
    return String(rows[0]?.['Create Table'] ?? '') + ';'
  }
  const snapshot = await fetchSchemaSnapshot(async (sql, params) => {
    const res = await window.electronAPI!.pg.query(t.connectionId, sql, t.database, params, { searchPath: snapshotSearchPath(t.schema) })
    if (!res.ok) throw new Error(res.error)
    return res.rows ?? []
  }, t.schema)
  const table = snapshot.tables.find(x => x.name === t.table)
  if (!table) throw new Error(`Table ${t.table} not found`)
  return tableDisplayDdl(table)
}

// ── Dialog ────────────────────────────────────────────────────────────────────

interface ActionSpec {
  title: string
  description: string
  danger?: boolean
  confirmByName?: boolean
}

const SPECS: Record<TableActionKind, ActionSpec> = {
  rename: { title: 'Rename table', description: 'Queries, views and application code that use the old name will need updating.' },
  duplicate: { title: 'Duplicate table', description: 'Creates a new table with the same columns, defaults, constraints and indexes. Foreign keys and triggers are not copied.' },
  empty: { title: 'Empty table', description: 'Deletes every row with DELETE. Triggers fire and foreign keys are checked; on large tables Truncate is much faster. Identity/serial counters keep counting.', danger: true, confirmByName: true },
  truncate: { title: 'Truncate table', description: 'Removes every row instantly. Row-level DELETE triggers do not fire.', danger: true, confirmByName: true },
  drop: { title: 'Drop table', description: 'Permanently deletes the table, its data, indexes and constraints.', danger: true, confirmByName: true },
  analyze: { title: 'Analyze table', description: 'Refreshes the statistics the query planner uses. Safe to run at any time.' },
  vacuum: { title: 'Vacuum table', description: 'Reclaims space from deleted and updated rows and refreshes statistics. VACUUM FULL rewrites the table and locks it while it runs.' },
  reindex: { title: 'Reindex table', description: 'Rebuilds all indexes of the table. Writes to the table are blocked while it runs.' },
  optimize: { title: 'Optimize table', description: 'Rebuilds the table and its indexes to reclaim space. The table may be locked while it runs.' },
}

function ActionDialog({ kind, target, onClose, onDone }: {
  kind: TableActionKind
  target: TableRef
  onClose: () => void
  onDone: (change: TableChange) => void
}) {
  const spec = SPECS[kind]
  const isPg = target.dbType === 'postgres'
  const [opts, setOpts] = useState<TableActionOptions>(() => ({
    newName: kind === 'rename' ? target.table : kind === 'duplicate' ? `${target.table}_copy` : undefined,
    withData: kind === 'duplicate' ? true : undefined,
  }))
  const [columns, setColumns] = useState<TableColumnInfo[] | null>(null)
  const [confirmText, setConfirmText] = useState('')
  const [phase, setPhase] = useState<'idle' | 'running' | 'cancelling' | 'committing'>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const runRef = useRef<(ActionRun & { cancellable: boolean }) | null>(null)
  const busy = phase !== 'idle'
  const autoCommits = !isPg && mysqlAutoCommits(kind)
  const cancellable = !(isPg && runsOutsideTransaction(kind))

  useEffect(() => {
    if (!busy) return
    const start = Date.now()
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 250)
    return () => clearInterval(timer)
  }, [busy])

  const { dbType, connectionId, database, schema, table } = target
  useEffect(() => {
    if (kind !== 'duplicate') return
    query({ dbType, connectionId, database, schema, table }, TABLE_COLUMNS_SQL[dbType], [schema, table])
      // pg returns booleans, MySQL returns 0/1
      .then(rows => setColumns(rows.map(r => ({ name: String(r.name), generated: !!Number(r.generated), identity: (r.identity ?? '') as TableColumnInfo['identity'] }))))
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
  }, [kind, dbType, connectionId, database, schema, table])

  let statements: string[] = []
  let buildError: string | null = null
  try {
    statements = tableActionStatements(target.dbType, target.schema, target.table, kind, opts, columns ?? [])
  } catch (err) {
    buildError = err instanceof Error ? err.message : String(err)
  }
  const renameUnchanged = kind === 'rename' && opts.newName?.trim() === target.table
  const confirmed = !spec.confirmByName || confirmText === target.table
  const canRun = !busy && !buildError && !renameUnchanged && confirmed

  const run = async () => {
    setPhase('running')
    setElapsed(0)
    setError(null)
    try {
      const action = startAction(target, kind, statements, () => setPhase('committing'))
      runRef.current = action
      await action.done
      const newName = opts.newName?.trim() ?? ''
      onDone(
        kind === 'rename' ? { kind: 'renamed', newName }
          : kind === 'duplicate' ? { kind: 'created', name: newName }
            : kind === 'drop' ? { kind: 'dropped' }
              : kind === 'empty' || kind === 'truncate' ? { kind: 'data' }
                : { kind: 'maintenance' })
    } catch (err) {
      setError(err instanceof ActionCancelled
        ? autoCommits
          ? 'Cancelled. MySQL cannot roll this statement back, so if it had already finished its change stays; refresh to check.'
          : 'Cancelled. Everything was rolled back; nothing was changed.'
        : err instanceof Error ? err.message : String(err))
      setPhase('idle')
    } finally {
      runRef.current = null
    }
  }

  const cancel = () => {
    setPhase('cancelling')
    runRef.current?.cancel()
  }

  const check = (key: keyof TableActionOptions, label: string, hint?: string) => (
    <label className="flex items-start gap-2 text-xs cursor-pointer select-none">
      <input type="checkbox" className="accent-primary mt-0.5" checked={!!opts[key]} onChange={e => setOpts(o => ({ ...o, [key]: e.target.checked }))} />
      <span className="flex flex-col">
        <span className="text-foreground">{label}</span>
        {hint && <span className="text-muted-foreground/70">{hint}</span>}
      </span>
    </label>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => !busy && onClose()}>
      <div className="bg-card border border-border rounded-lg shadow-2xl w-[min(560px,92vw)] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex flex-col min-w-0">
            <span className={cn('text-sm font-semibold', spec.danger ? 'text-red-400' : 'text-foreground')}>{spec.title}</span>
            <span className="text-xs text-muted-foreground font-mono truncate">{target.schema}.{target.table}</span>
          </div>
          <button onClick={onClose} disabled={busy} className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 disabled:opacity-40"><X className="h-4 w-4" /></button>
        </div>

        <div className="flex flex-col gap-3 px-4 py-3">
          <p className={cn('text-xs', spec.danger ? 'text-amber-300' : 'text-muted-foreground')}>
            {spec.danger && <AlertTriangle className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />}
            {spec.description}
          </p>

          {(kind === 'rename' || kind === 'duplicate') && (
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">{kind === 'rename' ? 'New name' : 'Name of the copy'}</span>
              <input
                autoFocus
                value={opts.newName ?? ''}
                onChange={e => setOpts(o => ({ ...o, newName: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter' && canRun) run() }}
                className="h-7 rounded border border-border bg-background px-2 font-mono text-foreground outline-none focus:border-primary"
              />
            </label>
          )}
          {kind === 'duplicate' && check('withData', 'Copy data', columns === null && opts.withData ? 'Reading columns…' : undefined)}
          {kind === 'truncate' && isPg && check('restartIdentity', 'Restart identity', 'Reset identity and serial counters owned by the table')}
          {(kind === 'truncate' || kind === 'drop') && isPg && check('cascade', 'Cascade',
            kind === 'drop' ? 'Also drop views and foreign keys that depend on this table' : 'Also truncate tables with foreign keys referencing this table')}
          {kind === 'vacuum' && check('full', 'VACUUM FULL', 'Rewrites the table to return space to the operating system; locks the table')}

          {statements.length > 0 && (
            <SqlHighlight
              sql={statements.map(s => s + ';').join('\n')}
              className="rounded border border-border bg-background p-2 text-[12px] leading-[1.6] whitespace-pre-wrap text-foreground max-h-48 overflow-auto"
            />
          )}

          {spec.confirmByName && (
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Type <span className="font-mono text-foreground">{target.table}</span> to confirm</span>
              <input
                autoFocus
                value={confirmText}
                onChange={e => setConfirmText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && canRun) run() }}
                className="h-7 rounded border border-border bg-background px-2 font-mono text-foreground outline-none focus:border-red-400"
              />
            </label>
          )}

          <p className="text-[11px] text-muted-foreground/70">
            {!cancellable
              ? 'VACUUM cannot run inside a transaction and cannot be cancelled once started.'
              : autoCommits
                ? 'MySQL commits this statement immediately and cannot roll it back. Cancel only helps while it is waiting to start (for example on a lock).'
                : 'Runs in a transaction: you can cancel at any time before it commits, and nothing will change.'}
          </p>

          {phase === 'running' && elapsed >= 3 && (
            <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              Still running after {elapsed}s. It may be waiting for a lock held by another session (an open transaction or a long query on this table).
              {cancellable && ' Cancel stops it and rolls everything back.'}
            </div>
          )}

          {(error || (buildError && !(kind === 'duplicate' && columns === null))) && (
            <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300 whitespace-pre-wrap">{error ?? buildError}</div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
          {busy ? (
            <button
              onClick={cancel}
              disabled={!cancellable || phase !== 'running'}
              title={phase === 'committing' ? 'Already committing; too late to cancel' : undefined}
              className="flex items-center gap-1 px-3 h-7 rounded text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20 disabled:opacity-40"
            >
              <Square className="h-3 w-3" /> {phase === 'cancelling' ? 'Cancelling…' : 'Cancel & roll back'}
            </button>
          ) : (
            <button onClick={onClose} className="px-3 h-7 rounded text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20">Cancel</button>
          )}
          <button
            onClick={run}
            disabled={!canRun}
            className={cn('flex items-center gap-1 px-3 h-7 rounded text-xs font-medium disabled:opacity-40',
              spec.danger ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : 'bg-primary text-primary-foreground hover:bg-primary/90')}
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            {phase === 'committing' ? 'Committing…' : busy ? `Running… ${elapsed}s` : spec.title.split(' ')[0]}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Header bar ────────────────────────────────────────────────────────────────

export function TableActionsBar({ target, onOpenData, onChanged }: {
  target: TableRef
  onOpenData: () => void
  onChanged: (change: TableChange) => void
}) {
  const [dialog, setDialog] = useState<TableActionKind | null>(null)
  const [stats, setStats] = useState<{ rows: number; bytes: number } | null>(null)
  const [statsVersion, setStatsVersion] = useState(0)

  const { dbType, connectionId, database, schema, table } = target
  useEffect(() => {
    let cancelled = false
    query({ dbType, connectionId, database, schema, table }, TABLE_STATS_SQL[dbType], [schema, table])
      .then(rows => { if (!cancelled && rows[0]) setStats({ rows: Number(rows[0].row_estimate) || 0, bytes: Number(rows[0].total_bytes) || 0 }) })
      .catch(() => { if (!cancelled) setStats(null) })
    return () => { cancelled = true }
  }, [dbType, connectionId, database, schema, table, statsVersion])

  const copyCreate = async () => {
    try {
      await navigator.clipboard.writeText(await createStatement(target))
      toast.success('CREATE statement copied')
    } catch (err) {
      toast.error(`Could not build the CREATE statement: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const item = (kind: TableActionKind, icon: React.ReactNode, label: string, danger = false) =>
    tableActionAvailable(dbType, kind) && (
      <DropdownMenuItem onSelect={() => setDialog(kind)} className={cn('text-xs gap-2', danger && 'text-red-400 focus:text-red-300')}>
        {icon}{label}…
      </DropdownMenuItem>
    )

  return (
    <>
      {stats && (
        <span className="text-[11px] text-muted-foreground tabular-nums" title="Estimated row count and total size including indexes">
          ≈ {stats.rows.toLocaleString()} rows · {formatBytes(stats.bytes)}
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20">
            <Wrench className="h-3.5 w-3.5" /> Table actions <ChevronDown className="h-3 w-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onSelect={onOpenData} className="text-xs gap-2"><Table2 className="h-3.5 w-3.5" />Open data</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => { void copyCreate() }} className="text-xs gap-2"><Copy className="h-3.5 w-3.5" />Copy CREATE statement</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => { void navigator.clipboard.writeText(`${schema}.${table}`).then(() => toast.success('Name copied')) }} className="text-xs gap-2">
            <Copy className="h-3.5 w-3.5" />Copy name
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {item('rename', <Pencil className="h-3.5 w-3.5" />, 'Rename')}
          {item('duplicate', <CopyPlus className="h-3.5 w-3.5" />, 'Duplicate')}
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground/70">Maintenance</DropdownMenuLabel>
          {item('analyze', <Gauge className="h-3.5 w-3.5" />, 'Analyze')}
          {item('vacuum', <Brush className="h-3.5 w-3.5" />, 'Vacuum')}
          {item('reindex', <RefreshCw className="h-3.5 w-3.5" />, 'Reindex')}
          {item('optimize', <Brush className="h-3.5 w-3.5" />, 'Optimize')}
          <DropdownMenuSeparator />
          {item('empty', <Eraser className="h-3.5 w-3.5" />, 'Empty table', true)}
          {item('truncate', <Scissors className="h-3.5 w-3.5" />, 'Truncate table', true)}
          {item('drop', <Trash2 className="h-3.5 w-3.5" />, 'Drop table', true)}
        </DropdownMenuContent>
      </DropdownMenu>

      {dialog && (
        <ActionDialog
          kind={dialog}
          target={target}
          onClose={() => setDialog(null)}
          onDone={change => {
            setDialog(null)
            setStatsVersion(v => v + 1)
            // Duplicates get their own toast (with an Open button) from the parent
            if (change.kind !== 'created') toast.success(`${SPECS[dialog].title} finished`)
            onChanged(change)
          }}
        />
      )}
    </>
  )
}
