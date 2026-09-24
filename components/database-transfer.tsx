'use client'

// Whole-database transfers: Dump SQL File (PostgreSQL/MySQL), Execute SQL File, and MongoDB
// export/import. The work is done by lib/database-export, lib/sql-import and lib/mongo-transfer;
// these dialogs wire them to the IPC and show options, progress and results.
import React, { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, FileUp, FolderOpen, Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { databaseDumpFileName, runDatabaseExport, type DatabaseExportIO } from '@/lib/database-export'
import { ExportCancelled } from '@/lib/table-export'
import { ImportCancelled, runSqlImport, type ImportResult } from '@/lib/sql-import'
import {
  parseCollections, planFolderImport, runMongoExport, runMongoImport, TransferCancelled,
  type CollectionInfo, type FolderIO, type ImportEntry, type MongoImportResult, type MongoTransferIO,
} from '@/lib/mongo-transfer'
import { RESTART_MESSAGE } from '@/components/structure-sync'

export type SqlDbType = 'postgres' | 'mysql'

// ── Shared pieces ─────────────────────────────────────────────────────────────

export const inputCls = 'bg-background border border-border rounded px-2 py-1 text-xs text-foreground outline-none focus:ring-1 focus:ring-primary'
export const buttonCls = 'px-3 py-1.5 text-xs rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20 transition-colors disabled:opacity-40'
export const primaryCls = 'flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50'

export function DialogShell({ title, subtitle, busy, onClose, width = 'w-[520px]', children }: {
  title: string; subtitle?: string; busy: boolean; onClose: () => void; width?: string; children: React.ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onMouseDown={() => { if (!busy) onClose() }}>
      <div className={cn('bg-card border border-border rounded-lg shadow-xl max-h-[90vh] flex flex-col', width)} onMouseDown={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border shrink-0">
          <div className="min-w-0">
            <div className="text-sm font-semibold">{title}</div>
            {subtitle && <div className="text-xs text-muted-foreground truncate">{subtitle}</div>}
          </div>
          <button onClick={onClose} disabled={busy} className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30"><X className="h-4 w-4" /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Check({ label, checked, onChange, hint, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string; disabled?: boolean }) {
  return (
    <label className={cn('flex items-start gap-2 text-xs select-none', disabled ? 'opacity-50' : 'cursor-pointer')}>
      <input type="checkbox" className="mt-0.5" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      <span><span className="text-foreground">{label}</span>{hint && <span className="block text-[11px] text-muted-foreground/70">{hint}</span>}</span>
    </label>
  )
}

export function ErrorBox({ message }: { message: string }) {
  return <div className="px-2 py-1.5 rounded border border-red-500/30 bg-red-950/60 text-[11px] text-red-300 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">{message}</div>
}

export function Progress({ value }: { value: number | null }) {
  return (
    <div className="h-1.5 rounded bg-muted overflow-hidden">
      {value === null
        ? <div className="h-full w-1/3 bg-primary/60 animate-pulse" />
        : <div className="h-full bg-primary transition-all" style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }} />}
    </div>
  )
}

export function useElapsed(running: boolean) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!running) return
    const start = Date.now()
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 250)
    return () => clearInterval(timer)
  }, [running])
  return elapsed
}

const formatBytes = (n: number) => n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : n < 1 << 30 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / (1 << 30)).toFixed(2)} GB`
const messageOf = (err: unknown) => err instanceof Error ? err.message : String(err)

function files() {
  const f = window.electronAPI?.files
  if (!f?.openRead) throw new Error(RESTART_MESSAGE)
  return f
}

// Reads a file in 1 MB chunks
export async function openFileReader(filePath: string) {
  const f = files()
  const opened = await f.openRead(filePath)
  if (!opened.ok || !opened.fileId) throw new Error(opened.error ?? 'Could not open the file')
  const fileId = opened.fileId
  return {
    size: opened.size ?? 0,
    read: async () => {
      const r = await f.read(fileId, 1 << 20)
      if (!r.ok) throw new Error(r.error)
      return { text: r.text ?? '', done: !!r.done, position: r.position ?? 0 }
    },
    close: () => f.closeRead(fileId).then(() => {}),
  }
}

const sqlApi = (dbType: SqlDbType) => dbType === 'mysql' ? window.electronAPI!.mysql : window.electronAPI!.pg

async function openSession(dbType: SqlDbType, connectionId: string, database: string, opts: { autocommit?: boolean; readOnly?: boolean }) {
  const res = dbType === 'mysql'
    ? await window.electronAPI!.mysql.sessionOpen(connectionId, database, opts.readOnly ? { consistentSnapshot: true } : { autocommit: opts.autocommit })
    : await window.electronAPI!.pg.sessionOpen(connectionId, database, undefined, opts.readOnly, opts.autocommit)
  if (!res.ok || !res.sessionId) throw new Error(res.error ?? 'Could not open a database session')
  const id = res.sessionId
  const api = sqlApi(dbType)
  return {
    execute: async (sql: string, params?: unknown[]) => {
      const r = await api.sessionQuery(id, sql, params)
      if (!r.ok) throw new Error(r.error)
      return { rowCount: r.rowCount, rows: r.rows ?? [] }
    },
    close: async (commit: boolean) => {
      const r = await api.sessionClose(id, commit)
      if (!r.ok) throw new Error(r.error)
    },
    cancel: () => { void api.sessionCancel(id).catch(() => {}) },
  }
}

type Phase<Done> =
  | { kind: 'options' }
  | { kind: 'running' }
  | { kind: 'done'; result: Done; seconds: number; path?: string }
  | { kind: 'failed'; message: string }

// ── Dump SQL File (whole database) ────────────────────────────────────────────

export interface DatabaseTarget { dbType: SqlDbType; connectionId: string; database: string }

const SCHEMAS_SQL = `SELECT nspname AS name FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' ORDER BY nspname = 'public' DESC, nspname`

export function DatabaseExportDialog({ target, onClose }: { target: DatabaseTarget; onClose: () => void }) {
  const { dbType, connectionId, database } = target
  const [schemas, setSchemas] = useState<string[] | null>(dbType === 'mysql' ? [] : null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [opts, setOpts] = useState({ structure: true, data: true, dropObjects: false, transaction: true, rowsPerStatement: 100 })
  const [phase, setPhase] = useState<Phase<{ tables: number; rows: number }>>({ kind: 'options' })
  const [progress, setProgress] = useState({ table: '', tablesDone: 0, tablesTotal: 0, rows: 0 })
  const control = useRef<{ cancelled: boolean; cancel: () => void } | null>(null)
  const running = phase.kind === 'running'
  const elapsed = useElapsed(running)

  useEffect(() => {
    if (dbType !== 'postgres') return
    let cancelled = false
    window.electronAPI!.pg.query(connectionId, SCHEMAS_SQL, database).then(res => {
      if (cancelled) return
      const names = res.ok ? (res.rows ?? []).map(r => String(r.name)) : []
      setSchemas(names)
      setSelected(new Set(names))
    })
    return () => { cancelled = true }
  }, [dbType, connectionId, database])

  async function start() {
    let f
    try { f = files() } catch (err) { setPhase({ kind: 'failed', message: messageOf(err) }); return }
    const filePath = await f.saveDialog({
      title: 'Dump SQL File', defaultName: databaseDumpFileName(database),
      filters: [{ name: 'SQL', extensions: ['sql'] }, { name: 'All Files', extensions: ['*'] }],
    })
    if (!filePath) return
    const opened = await f.openWrite(filePath)
    if (!opened.ok || !opened.fileId) { setPhase({ kind: 'failed', message: opened.error ?? 'Could not open the file' }); return }
    const fileId = opened.fileId
    let snapshotCancel: (() => void) | null = null
    const ctl = { cancelled: false, cancel: () => { ctl.cancelled = true; snapshotCancel?.() } }
    control.current = ctl
    const io: DatabaseExportIO = {
      query: async (sql, params, searchPath) => {
        const res = dbType === 'mysql'
          ? await window.electronAPI!.mysql.query(connectionId, sql, database, params)
          : await window.electronAPI!.pg.query(connectionId, sql, database, params, searchPath ? { searchPath } : undefined)
        if (!res.ok) throw new Error(res.error)
        return res.rows ?? []
      },
      openSnapshot: async () => {
        const s = await openSession(dbType, connectionId, database, { readOnly: true })
        snapshotCancel = s.cancel
        return { query: async sql => (await s.execute(sql)).rows, close: async () => { snapshotCancel = null; await s.close(false).catch(() => {}) } }
      },
      write: async text => {
        const r = await f.write(fileId, text)
        if (!r.ok) throw new Error(r.error)
      },
    }
    setPhase({ kind: 'running' })
    const began = Date.now()
    try {
      const result = await runDatabaseExport(io, { dbType, database, schemas: [...selected], ...opts }, {
        onProgress: setProgress, isCancelled: () => ctl.cancelled,
      })
      await f.close(fileId)
      setPhase({ kind: 'done', result, seconds: (Date.now() - began) / 1000, path: filePath })
    } catch (err) {
      await f.close(fileId, true)
      if (ctl.cancelled || err instanceof ExportCancelled) setPhase({ kind: 'options' })
      else setPhase({ kind: 'failed', message: messageOf(err) })
    } finally {
      control.current = null
    }
  }

  const toggle = (s: string) => setSelected(prev => { const next = new Set(prev); if (next.has(s)) next.delete(s); else next.add(s); return next })

  return (
    <DialogShell title="Dump SQL File" subtitle={`Database ${database}`} busy={running} onClose={onClose}>
      {phase.kind === 'options' && (
        <>
          <div className="px-5 py-4 space-y-4 overflow-y-auto">
            {dbType === 'postgres' && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs text-muted-foreground">Schemas ({selected.size}/{schemas?.length ?? 0})</span>
                  {schemas && schemas.length > 1 && (
                    <span className="flex gap-2 text-[11px]">
                      <button className="text-primary hover:underline" onClick={() => setSelected(new Set(schemas))}>All</button>
                      <button className="text-primary hover:underline" onClick={() => setSelected(new Set())}>None</button>
                    </span>
                  )}
                </div>
                {!schemas ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : (
                  <div className="max-h-32 overflow-y-auto border border-border rounded px-2 py-1 grid grid-cols-2 gap-x-3">
                    {schemas.map(s => (
                      <label key={s} className="flex items-center gap-1.5 text-xs py-0.5 cursor-pointer select-none truncate">
                        <input type="checkbox" checked={selected.has(s)} onChange={() => toggle(s)} />
                        <span className="font-mono truncate">{s}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="space-y-2">
              <Check label="Structure" checked={opts.structure} onChange={v => setOpts({ ...opts, structure: v })}
                hint={dbType === 'postgres' ? 'Tables, keys, indexes, types, sequences, views, functions, triggers and comments' : 'Tables, views, procedures, functions and triggers'} />
              {opts.structure && <div className="pl-5"><Check label="DROP existing objects first" checked={opts.dropObjects} onChange={v => setOpts({ ...opts, dropObjects: v })} hint="Loading the file replaces what is already there" /></div>}
              <Check label="Data" checked={opts.data} onChange={v => setOpts({ ...opts, data: v })} hint="All rows, read from one consistent snapshot" />
              {opts.data && (
                <label className="pl-5 flex items-center gap-1.5 text-xs text-muted-foreground">Rows per INSERT
                  <select className={inputCls} value={opts.rowsPerStatement} onChange={e => setOpts({ ...opts, rowsPerStatement: Number(e.target.value) })}>
                    {[1, 100, 500, 1000].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
              )}
              {dbType === 'postgres' && <Check label="Wrap in a transaction" checked={opts.transaction} onChange={v => setOpts({ ...opts, transaction: v })} hint="Loading the file applies everything or nothing" />}
            </div>
            {dbType === 'postgres' && <p className="text-[11px] text-muted-foreground/70">Roles, privileges, row security policies and partitioned tables are not included; the file lists anything it skipped.</p>}
          </div>
          <div className="flex justify-end gap-2 px-5 py-3 border-t border-border shrink-0">
            <button onClick={onClose} className={buttonCls}>Cancel</button>
            <button onClick={() => void start()} className={primaryCls}
              disabled={(!opts.structure && !opts.data) || (dbType === 'postgres' && selected.size === 0)}>Dump…</button>
          </div>
        </>
      )}
      {phase.kind === 'running' && (
        <div className="px-5 py-5 space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            {progress.rows.toLocaleString()} rows written · {elapsed}s
          </div>
          <Progress value={progress.tablesTotal ? progress.tablesDone / progress.tablesTotal : null} />
          <div className="text-[11px] text-muted-foreground truncate">
            {progress.table ? `Table ${progress.tablesDone + 1} of ${progress.tablesTotal}: ${progress.table}` : 'Reading the structure…'}
          </div>
          <div className="flex justify-end"><button onClick={() => control.current?.cancel()} className={buttonCls}>Cancel</button></div>
        </div>
      )}
      {phase.kind === 'done' && (
        <DoneFooter path={phase.path} onClose={onClose}>
          Dumped {phase.result.tables} table{phase.result.tables === 1 ? '' : 's'} and {phase.result.rows.toLocaleString()} row{phase.result.rows === 1 ? '' : 's'} in {phase.seconds.toFixed(1)}s
        </DoneFooter>
      )}
      {phase.kind === 'failed' && <FailedFooter message={phase.message} onBack={() => setPhase({ kind: 'options' })} onClose={onClose} />}
    </DialogShell>
  )
}

function DoneFooter({ path, onClose, children, warning }: { path?: string; onClose: () => void; children: React.ReactNode; warning?: React.ReactNode }) {
  return (
    <div className="px-5 py-5 space-y-3">
      <div className="flex items-center gap-2 text-sm">
        {warning ? <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" /> : <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />}
        <span>{children}</span>
      </div>
      {warning}
      {path && <div className="text-[11px] text-muted-foreground break-all">{path}</div>}
      <div className="flex justify-end gap-2">
        {path && (
          <button onClick={() => void window.electronAPI?.files?.showInFolder(path)} className={cn(buttonCls, 'flex items-center gap-1.5')}>
            <FolderOpen className="h-3.5 w-3.5" /> Show in Folder
          </button>
        )}
        <button onClick={onClose} className={primaryCls}>Close</button>
      </div>
    </div>
  )
}

function FailedFooter({ message, onBack, onClose }: { message: string; onBack: () => void; onClose: () => void }) {
  return (
    <div className="px-5 py-5 space-y-3">
      <ErrorBox message={message} />
      <div className="flex justify-end gap-2">
        <button onClick={onBack} className={buttonCls}>Back</button>
        <button onClick={onClose} className={primaryCls}>Close</button>
      </div>
    </div>
  )
}

function ErrorList({ errors, total }: { errors: { title: string; detail?: string }[]; total: number }) {
  if (total === 0) return null
  return (
    <div className="max-h-48 overflow-y-auto rounded border border-red-500/30 bg-red-950/40 divide-y divide-red-500/20">
      {errors.map((e, i) => (
        <div key={i} className="px-2 py-1.5 text-[11px]">
          <div className="text-red-300 break-words">{e.title}</div>
          {e.detail && <div className="font-mono text-red-300/60 truncate" title={e.detail}>{e.detail}</div>}
        </div>
      ))}
      {total > errors.length && <div className="px-2 py-1 text-[11px] text-red-300/70">…and {total - errors.length} more</div>}
    </div>
  )
}

// ── Execute SQL File ──────────────────────────────────────────────────────────

export function SqlFileImportDialog({ target, onClose, onDone }: { target: DatabaseTarget; onClose: () => void; onDone?: () => void }) {
  const { dbType, connectionId, database } = target
  const [filePath, setFilePath] = useState<string | null>(null)
  const [opts, setOpts] = useState({ transaction: dbType === 'postgres', continueOnError: false })
  const [phase, setPhase] = useState<Phase<ImportResult & { committed: boolean }>>({ kind: 'options' })
  const [progress, setProgress] = useState({ bytes: 0, size: 0, statements: 0 })
  const control = useRef<{ cancelled: boolean; cancel: () => void } | null>(null)
  const running = phase.kind === 'running'
  const elapsed = useElapsed(running)

  async function choose() {
    const picked = await window.electronAPI?.files?.openDialog?.({ title: 'Execute SQL File', filters: [{ name: 'SQL', extensions: ['sql', 'txt'] }, { name: 'All Files', extensions: ['*'] }] })
    if (picked?.[0]) setFilePath(picked[0])
  }

  async function start() {
    if (!filePath) return
    let file
    try { file = await openFileReader(filePath) } catch (err) { setPhase({ kind: 'failed', message: messageOf(err) }); return }
    let session
    try { session = await openSession(dbType, connectionId, database, { autocommit: !opts.transaction }) } catch (err) {
      await file.close(); setPhase({ kind: 'failed', message: messageOf(err) }); return
    }
    const s = session
    const ctl = { cancelled: false, cancel: () => { ctl.cancelled = true; s.cancel() } }
    control.current = ctl
    setProgress({ bytes: 0, size: file.size, statements: 0 })
    setPhase({ kind: 'running' })
    const began = Date.now()
    try {
      const result = await runSqlImport(file.read, s, { dialect: dbType, ...opts }, {
        onProgress: p => setProgress({ bytes: p.bytes, size: file.size, statements: p.statements + p.copyRows }),
        isCancelled: () => ctl.cancelled,
      })
      // In a transaction, a stopped import is rolled back; otherwise what ran stays
      const commit = !result.stoppedAt
      await s.close(opts.transaction ? commit : true)
      setPhase({ kind: 'done', result: { ...result, committed: !opts.transaction || commit }, seconds: (Date.now() - began) / 1000 })
      onDone?.()
    } catch (err) {
      await s.close(false).catch(() => {})
      if (ctl.cancelled || err instanceof ImportCancelled) {
        setPhase({ kind: 'failed', message: opts.transaction ? 'Cancelled. Nothing was changed (the transaction was rolled back).' : 'Cancelled. Statements that already ran were kept.' })
      } else {
        setPhase({ kind: 'failed', message: messageOf(err) })
      }
      onDone?.()
    } finally {
      await file.close()
      control.current = null
    }
  }

  const fileName = filePath?.split(/[\\/]/).pop()
  return (
    <DialogShell title="Execute SQL File" subtitle={`Database ${database}`} busy={running} onClose={onClose}>
      {phase.kind === 'options' && (
        <>
          <div className="px-5 py-4 space-y-4">
            <div className="flex items-center gap-2">
              <button onClick={() => void choose()} className={cn(buttonCls, 'flex items-center gap-1.5 shrink-0')}><FileUp className="h-3.5 w-3.5" /> Choose File…</button>
              <span className="text-xs text-muted-foreground truncate" title={filePath ?? undefined}>{fileName ?? 'No file chosen'}</span>
            </div>
            <div className="space-y-2">
              <Check label="Run in one transaction" checked={opts.transaction} onChange={v => setOpts({ ...opts, transaction: v })}
                hint={dbType === 'mysql'
                  ? 'MySQL commits CREATE/ALTER/DROP statements immediately, so only data changes roll back'
                  : "All or nothing. The file's own BEGIN/COMMIT are skipped; statements such as CREATE DATABASE or VACUUM can't run inside a transaction"} />
              <Check label="Continue after errors" checked={opts.continueOnError} onChange={v => setOpts({ ...opts, continueOnError: v })}
                hint="Failing statements are listed at the end instead of stopping the import" />
            </div>
            <p className="text-[11px] text-muted-foreground/70">
              {dbType === 'postgres'
                ? 'Reads QuenceDB dumps and plain-format pg_dump files, including COPY data. psql commands (\\connect, …) are skipped.'
                : 'Reads QuenceDB dumps and mysqldump files, including DELIMITER blocks. For tables with binary columns, create mysqldump files with --hex-blob.'}
            </p>
          </div>
          <div className="flex justify-end gap-2 px-5 py-3 border-t border-border shrink-0">
            <button onClick={onClose} className={buttonCls}>Cancel</button>
            <button onClick={() => void start()} disabled={!filePath} className={primaryCls}>Execute</button>
          </div>
        </>
      )}
      {phase.kind === 'running' && (
        <div className="px-5 py-5 space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            {progress.statements.toLocaleString()} statements · {formatBytes(progress.bytes)} of {formatBytes(progress.size)} · {elapsed}s
          </div>
          <Progress value={progress.size ? progress.bytes / progress.size : null} />
          <div className="text-[11px] text-muted-foreground truncate">{fileName}</div>
          <div className="flex justify-end"><button onClick={() => control.current?.cancel()} className={buttonCls}>Cancel</button></div>
        </div>
      )}
      {phase.kind === 'done' && (() => {
        const r = phase.result
        const summary = `${r.statements.toLocaleString()} statement${r.statements === 1 ? '' : 's'}${r.copyRows ? ` and ${r.copyRows.toLocaleString()} COPY rows` : ''} in ${phase.seconds.toFixed(1)}s`
        return (
          <DoneFooter onClose={onClose} warning={r.failed > 0 ? (
            <div className="space-y-2">
              <ErrorList total={r.failed} errors={r.errors.map(e => ({ title: `Line ${e.line}: ${e.message}`, detail: e.sql }))} />
              {r.skipped.length > 0 && <div className="text-[11px] text-muted-foreground">Skipped: {r.skipped.slice(0, 5).join('; ')}{r.skipped.length > 5 ? ` and ${r.skipped.length - 5} more` : ''}</div>}
            </div>
          ) : undefined}>
            {r.stoppedAt
              ? (r.committed ? `Stopped at line ${r.stoppedAt.line} after ${summary}. Statements before it were kept.` : `Stopped at line ${r.stoppedAt.line}. Nothing was changed (rolled back).`)
              : r.failed > 0 ? `Ran ${summary}; ${r.failed} failed` : `Ran ${summary}`}
          </DoneFooter>
        )
      })()}
      {phase.kind === 'failed' && <FailedFooter message={phase.message} onBack={() => setPhase({ kind: 'options' })} onClose={onClose} />}
    </DialogShell>
  )
}

// ── MongoDB ───────────────────────────────────────────────────────────────────

function mongoIO(connectionId: string, database: string): MongoTransferIO {
  const m = window.electronAPI!.mongodb
  const ok = <T extends { ok: boolean; error?: string }>(r: T) => { if (!r.ok) throw new Error(r.error); return r }
  return {
    exportCollections: async () => ok(await m.exportCollections(connectionId, database)).collections ?? [],
    exportOpen: async c => ok(await m.exportOpen(connectionId, database, c)).cursorId!,
    exportRead: async (id, n) => { const r = ok(await m.exportRead(id, n)); return { lines: r.lines ?? [], done: !!r.done } },
    exportClose: async id => { await m.exportClose(id) },
    importPrepare: async (meta, drop) => { ok(await m.importPrepare(connectionId, database, meta, drop)) },
    importDocuments: async (c, docs) => { const r = ok(await m.importDocuments(connectionId, database, c, docs)); return { inserted: r.inserted ?? 0, errors: r.errors ?? [] } },
    importIndexes: async meta => ok(await m.importIndexes(connectionId, database, meta)).created ?? 0,
  }
}

// Files in a folder; single files picked one by one are addressed by their full path
function folderIO(dir: string | null): FolderIO {
  const f = files()
  const full = (name: string) => dir ? f.join(dir, name) : Promise.resolve(name)
  return {
    create: async name => {
      const opened = await f.openWrite(await full(name))
      if (!opened.ok || !opened.fileId) throw new Error(opened.error ?? `Could not create ${name}`)
      const id = opened.fileId
      return {
        write: async t => { const r = await f.write(id, t); if (!r.ok) throw new Error(r.error) },
        close: async discard => { await f.close(id, discard) },
      }
    },
    open: async name => openFileReader(await full(name)),
  }
}

export function MongoExportDialog({ connectionId, database, only, onClose }: { connectionId: string; database: string; only?: string; onClose: () => void }) {
  const [collections, setCollections] = useState<CollectionInfo[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [phase, setPhase] = useState<Phase<{ collections: number; documents: number }>>({ kind: 'options' })
  const [progress, setProgress] = useState({ collection: '', done: 0, total: 0, documents: 0 })
  const control = useRef<{ cancelled: boolean } | null>(null)
  const running = phase.kind === 'running'
  const elapsed = useElapsed(running)

  useEffect(() => {
    let cancelled = false
    mongoIO(connectionId, database).exportCollections().then(list => {
      if (cancelled) return
      const parsed = parseCollections(list)
      setCollections(parsed)
      setSelected(new Set(parsed.filter(c => !only || c.name === only).map(c => c.name)))
    }, err => { if (!cancelled) setPhase({ kind: 'failed', message: messageOf(err) }) })
    return () => { cancelled = true }
  }, [connectionId, database, only])

  async function start() {
    const picked = await window.electronAPI?.files?.openDialog?.({ title: 'Choose an empty folder for the export', directory: true })
    const dir = picked?.[0]
    if (!dir) return
    const existing = await files().listDir(dir)
    if (existing.ok && existing.files?.some(f => /\.json$/i.test(f.name))
      && !window.confirm('This folder already has JSON files. Files with the same names will be overwritten. Continue?')) return
    const ctl = { cancelled: false }
    control.current = ctl
    setPhase({ kind: 'running' })
    const began = Date.now()
    try {
      const result = await runMongoExport(mongoIO(connectionId, database), folderIO(dir), collections!.filter(c => selected.has(c.name)), {
        onProgress: setProgress, isCancelled: () => ctl.cancelled,
      })
      setPhase({ kind: 'done', result, seconds: (Date.now() - began) / 1000, path: dir })
    } catch (err) {
      if (ctl.cancelled || err instanceof TransferCancelled) setPhase({ kind: 'options' })
      else setPhase({ kind: 'failed', message: messageOf(err) })
    } finally {
      control.current = null
    }
  }

  const toggle = (s: string) => setSelected(prev => { const next = new Set(prev); if (next.has(s)) next.delete(s); else next.add(s); return next })
  const docs = collections?.filter(c => selected.has(c.name)).reduce((n, c) => n + c.estimate, 0) ?? 0

  return (
    <DialogShell title={only ? 'Export Collection' : 'Export Database'} subtitle={`Database ${database}`} busy={running} onClose={onClose}>
      {phase.kind === 'options' && (
        <>
          <div className="px-5 py-4 space-y-3 overflow-y-auto">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Collections ({selected.size}/{collections?.length ?? 0})</span>
              {collections && collections.length > 1 && (
                <span className="flex gap-2 text-[11px]">
                  <button className="text-primary hover:underline" onClick={() => setSelected(new Set(collections.map(c => c.name)))}>All</button>
                  <button className="text-primary hover:underline" onClick={() => setSelected(new Set())}>None</button>
                </span>
              )}
            </div>
            {!collections ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : collections.length === 0 ? (
              <p className="text-xs text-muted-foreground">This database has no collections.</p>
            ) : (
              <div className="max-h-56 overflow-y-auto border border-border rounded divide-y divide-border/50">
                {collections.map(c => (
                  <label key={c.name} className="flex items-center gap-2 px-2 py-1 text-xs cursor-pointer select-none">
                    <input type="checkbox" checked={selected.has(c.name)} onChange={() => toggle(c.name)} />
                    <span className="font-mono truncate flex-1">{c.name}</span>
                    <span className="text-[10px] text-muted-foreground shrink-0">{c.type === 'view' ? 'view' : `~${c.estimate.toLocaleString()} docs`}</span>
                  </label>
                ))}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground/70">
              Writes one file per collection in the mongoexport format (canonical Extended JSON, so ObjectIds, dates and number types are kept),
              plus a .metadata.json file with its options and indexes. Views are exported as definitions.
            </p>
          </div>
          <div className="flex justify-end gap-2 px-5 py-3 border-t border-border shrink-0">
            <button onClick={onClose} className={buttonCls}>Cancel</button>
            <button onClick={() => void start()} disabled={selected.size === 0} className={primaryCls}>Choose Folder and Export…</button>
          </div>
        </>
      )}
      {phase.kind === 'running' && (
        <div className="px-5 py-5 space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            {progress.documents.toLocaleString()} documents{docs ? ` of about ${docs.toLocaleString()}` : ''} · {elapsed}s
          </div>
          <Progress value={docs ? progress.documents / docs : progress.total ? progress.done / progress.total : null} />
          <div className="text-[11px] text-muted-foreground truncate">{progress.collection && `Collection ${progress.done + 1} of ${progress.total}: ${progress.collection}`}</div>
          <div className="flex justify-end"><button onClick={() => { if (control.current) control.current.cancelled = true }} className={buttonCls}>Cancel</button></div>
        </div>
      )}
      {phase.kind === 'done' && (
        <DoneFooter path={phase.path} onClose={onClose}>
          Exported {phase.result.collections} collection{phase.result.collections === 1 ? '' : 's'} and {phase.result.documents.toLocaleString()} documents in {phase.seconds.toFixed(1)}s
        </DoneFooter>
      )}
      {phase.kind === 'failed' && <FailedFooter message={phase.message} onBack={() => setPhase({ kind: 'options' })} onClose={onClose} />}
    </DialogShell>
  )
}

export function MongoImportDialog({ connectionId, database, collection, onClose, onDone }: {
  connectionId: string; database: string
  collection?: string   // import files into this collection
  onClose: () => void; onDone?: () => void
}) {
  const [source, setSource] = useState<{ dir: string | null; entries: ImportEntry[] } | null>(null)
  const [drop, setDrop] = useState(false)
  const [phase, setPhase] = useState<Phase<MongoImportResult>>({ kind: 'options' })
  const [progress, setProgress] = useState({ collection: '', done: 0, total: 0, documents: 0, bytes: 0, totalBytes: 0 })
  const control = useRef<{ cancelled: boolean } | null>(null)
  const running = phase.kind === 'running'
  const elapsed = useElapsed(running)

  async function chooseFolder() {
    try {
      const picked = await window.electronAPI?.files?.openDialog?.({ title: 'Choose an export folder', directory: true })
      const dir = picked?.[0]
      if (!dir) return
      const listed = await files().listDir(dir)
      if (!listed.ok) throw new Error(listed.error)
      const folder = folderIO(dir)
      const entries = await planFolderImport(listed.files ?? [], async name => {
        const f = await folder.open(name)
        let text = ''
        try { for (;;) { const c = await f.read(); text += c.text; if (c.done) break } } finally { await f.close() }
        return text
      })
      if (entries.length === 0) throw new Error('No .json, .jsonl or .metadata.json files in this folder')
      setSource({ dir, entries })
    } catch (err) {
      setPhase({ kind: 'failed', message: messageOf(err) })
    }
  }

  async function chooseFiles() {
    const picked = await window.electronAPI?.files?.openDialog?.({
      title: 'Choose JSON files', multiple: !collection,
      filters: [{ name: 'JSON', extensions: ['json', 'jsonl', 'ndjson'] }, { name: 'All Files', extensions: ['*'] }],
    })
    if (!picked?.length) return
    setSource({
      dir: null,
      entries: picked.map(p => ({ collection: collection ?? p.split(/[\\/]/).pop()!.replace(/\.(json|jsonl|ndjson)$/i, ''), dataFile: p, isView: false, size: 0 })),
    })
  }

  async function start() {
    if (!source) return
    const ctl = { cancelled: false }
    control.current = ctl
    setPhase({ kind: 'running' })
    const began = Date.now()
    try {
      const result = await runMongoImport(mongoIO(connectionId, database), folderIO(source.dir), source.entries, {
        drop, onProgress: setProgress, isCancelled: () => ctl.cancelled,
      })
      setPhase({ kind: 'done', result, seconds: (Date.now() - began) / 1000 })
    } catch (err) {
      setPhase({ kind: 'failed', message: ctl.cancelled || err instanceof TransferCancelled ? 'Cancelled. Documents imported so far were kept.' : messageOf(err) })
    } finally {
      control.current = null
      onDone?.()
    }
  }

  const rename = (i: number, name: string) => setSource(s => s && { ...s, entries: s.entries.map((e, j) => j === i ? { ...e, collection: name } : e) })
  const invalid = source?.entries.some(e => !e.collection.trim() || e.collection.includes('$') || e.collection.startsWith('system.'))

  return (
    <DialogShell title={collection ? `Import into ${collection}` : 'Import'} subtitle={`Database ${database}`} busy={running} onClose={onClose}>
      {phase.kind === 'options' && (
        <>
          <div className="px-5 py-4 space-y-3 overflow-y-auto">
            <div className="flex gap-2">
              {!collection && <button onClick={() => void chooseFolder()} className={cn(buttonCls, 'flex items-center gap-1.5')}><FolderOpen className="h-3.5 w-3.5" /> Export Folder…</button>}
              <button onClick={() => void chooseFiles()} className={cn(buttonCls, 'flex items-center gap-1.5')}><FileUp className="h-3.5 w-3.5" /> {collection ? 'JSON File…' : 'JSON Files…'}</button>
            </div>
            {source ? (
              <div className="max-h-56 overflow-y-auto border border-border rounded divide-y divide-border/50">
                {source.entries.map((e, i) => (
                  <div key={i} className="flex items-center gap-2 px-2 py-1 text-xs">
                    {source.dir || collection
                      ? <span className="font-mono truncate flex-1">{e.collection}</span>
                      : <input className={cn(inputCls, 'flex-1 font-mono')} value={e.collection} onChange={ev => rename(i, ev.target.value)} />}
                    <span className="text-[10px] text-muted-foreground shrink-0 truncate max-w-48" title={e.dataFile}>
                      {e.isView ? 'view' : e.dataFile ? e.dataFile.split(/[\\/]/).pop() : 'metadata only'}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground/70">
                {collection
                  ? 'A JSON array, JSON Lines or mongoexport file. Extended JSON ($oid, $date, $numberLong, …) is understood.'
                  : 'An export folder (from QuenceDB, or mongoexport files), or JSON / JSON Lines files: each file goes into the collection named after it (editable).'}
              </p>
            )}
            <Check label="Drop existing collections first" checked={drop} onChange={setDrop}
              hint={drop ? 'Collections with these names are deleted and recreated' : 'Documents are added to existing collections; ones with an existing _id are reported and skipped'} />
          </div>
          <div className="flex justify-end gap-2 px-5 py-3 border-t border-border shrink-0">
            <button onClick={onClose} className={buttonCls}>Cancel</button>
            <button onClick={() => void start()} disabled={!source || invalid} className={primaryCls}>Import</button>
          </div>
        </>
      )}
      {phase.kind === 'running' && (
        <div className="px-5 py-5 space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            {progress.documents.toLocaleString()} documents · {elapsed}s
          </div>
          <Progress value={progress.totalBytes ? progress.bytes / progress.totalBytes : progress.total ? progress.done / progress.total : null} />
          <div className="text-[11px] text-muted-foreground truncate">{progress.collection && `Collection ${progress.done + 1} of ${progress.total}: ${progress.collection}`}</div>
          <div className="flex justify-end"><button onClick={() => { if (control.current) control.current.cancelled = true }} className={buttonCls}>Cancel</button></div>
        </div>
      )}
      {phase.kind === 'done' && (
        <DoneFooter onClose={onClose} warning={phase.result.failed > 0
          ? <ErrorList total={phase.result.failed} errors={phase.result.errors.map(e => ({ title: e }))} />
          : undefined}>
          Imported {phase.result.documents.toLocaleString()} documents into {phase.result.collections} collection{phase.result.collections === 1 ? '' : 's'} in {phase.seconds.toFixed(1)}s
          {phase.result.failed > 0 && `; ${phase.result.failed} failed`}
        </DoneFooter>
      )}
      {phase.kind === 'failed' && <FailedFooter message={phase.message} onBack={() => setPhase({ kind: 'options' })} onClose={onClose} />}
    </DialogShell>
  )
}
