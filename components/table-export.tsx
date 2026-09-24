'use client'

// Export Wizard and Dump SQL File for one table: options → save dialog → progress → done.
// The export itself is lib/table-export's runExport; this wires it to the IPC and the file writer.
import React, { useEffect, useRef, useState } from 'react'
import { CheckCircle2, FolderOpen, Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  DEFAULT_CSV, EXPORT_COLUMNS_SQL, ExportCancelled, exportFileName, parseExportColumns, runExport,
  type CsvOptions, type ExportFormat, type ExportIO, type JsonLayout,
} from '@/lib/table-export'
import { TABLE_STATS_SQL } from '@/lib/table-actions'
import { createStatement, type TableRef } from '@/components/table-actions'
import { RESTART_MESSAGE } from '@/components/structure-sync'

export type ExportPreset = 'dump-data' | 'dump-structure'

type FormatKind = ExportFormat['kind']

const FILTERS: Record<string, { name: string; extensions: string[] }> = {
  sql: { name: 'SQL', extensions: ['sql'] },
  csv: { name: 'CSV', extensions: ['csv'] },
  tsv: { name: 'TSV', extensions: ['tsv', 'txt'] },
  json: { name: 'JSON', extensions: ['json'] },
  jsonl: { name: 'JSON Lines', extensions: ['jsonl', 'ndjson'] },
}

const inputCls = 'bg-background border border-border rounded px-2 py-1 text-xs text-foreground outline-none focus:ring-1 focus:ring-primary'
const buttonCls = 'px-3 py-1.5 text-xs rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20 transition-colors disabled:opacity-40'
const primaryCls = 'flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50'

function api(t: TableRef) {
  return t.dbType === 'mysql' ? window.electronAPI!.mysql : window.electronAPI!.pg
}

// The IO runExport needs, over IPC. cancel() interrupts the running FETCH.
function exportIO(t: TableRef, fileId: string) {
  let sessionId: string | null = null
  const files = window.electronAPI!.files!
  const io: ExportIO = {
    query: async (sql, params) => {
      const res = await api(t).query(t.connectionId, sql, t.database, params)
      if (!res.ok) throw new Error(res.error)
      return res.rows ?? []
    },
    openSnapshot: async () => {
      const res = t.dbType === 'mysql'
        ? await window.electronAPI!.mysql.sessionOpen(t.connectionId, t.database)
        : await window.electronAPI!.pg.sessionOpen(t.connectionId, t.database, undefined, true)
      if (!res.ok || !res.sessionId) throw new Error(res.error ?? 'Could not open a read session')
      const id = res.sessionId
      sessionId = id
      return {
        query: async sql => {
          const r = await api(t).sessionQuery(id, sql)
          if (!r.ok) throw new Error(r.error)
          return r.rows ?? []
        },
        close: async () => { sessionId = null; await api(t).sessionClose(id, false).catch(() => {}) },
      }
    },
    createStatement: () => createStatement(t),
    write: async text => {
      const r = await files.write(fileId, text)
      if (!r.ok) throw new Error(r.error)
    },
  }
  return { io, cancel: () => { if (sessionId) void api(t).sessionCancel(sessionId).catch(() => {}) } }
}

type Phase =
  | { kind: 'options' }
  | { kind: 'running'; filePath: string; rows: number }
  | { kind: 'done'; filePath: string; rows: number; seconds: number }
  | { kind: 'failed'; message: string }

export function ExportDialog({ target, preset, onClose }: {
  target: TableRef
  preset?: ExportPreset   // Dump SQL File: skip the options, go straight to the save dialog
  onClose: () => void
}) {
  const [formatKind, setFormatKind] = useState<FormatKind>('csv')
  const [csv, setCsv] = useState<CsvOptions>(DEFAULT_CSV)
  const [jsonLayout, setJsonLayout] = useState<JsonLayout>('array')
  const [pretty, setPretty] = useState(true)
  const [sqlOpts, setSqlOpts] = useState({ structure: true, data: true, dropTable: false, rowsPerStatement: 100, transaction: true })
  const [columns, setColumns] = useState<string[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [estimate, setEstimate] = useState<number | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'options' })
  const [elapsed, setElapsed] = useState(0)
  const cancelRef = useRef<{ cancelled: boolean; cancel: () => void } | null>(null)
  const startedRef = useRef(false)

  const { dbType, connectionId, database, schema, table } = target

  useEffect(() => {
    let cancelled = false
    const t = { dbType, connectionId, database, schema, table }
    api(t).query(connectionId, EXPORT_COLUMNS_SQL[dbType], database, [schema, table]).then(res => {
      if (cancelled || !res.ok) return
      const names = parseExportColumns(dbType, res.rows ?? []).map(c => c.name)
      setColumns(names)
      setSelected(new Set(names))
    })
    api(t).query(connectionId, TABLE_STATS_SQL[dbType], database, [schema, table]).then(res => {
      const n = Number(res.rows?.[0]?.row_estimate)
      if (!cancelled && res.ok && n > 0) setEstimate(n)
    })
    return () => { cancelled = true }
  }, [dbType, connectionId, database, schema, table])

  const running = phase.kind === 'running'
  useEffect(() => {
    if (!running) return
    const start = Date.now()
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 250)
    return () => clearInterval(timer)
  }, [running])

  const buildFormat = (): ExportFormat => {
    if (preset) return { kind: 'sql', structure: true, data: preset === 'dump-data', dropTable: false, rowsPerStatement: 100, transaction: true }
    if (formatKind === 'sql') return { kind: 'sql', ...sqlOpts }
    if (formatKind === 'csv') return { kind: 'csv', csv }
    return { kind: 'json', layout: jsonLayout, pretty }
  }

  async function start() {
    const files = window.electronAPI?.files
    if (!files) { setPhase({ kind: 'failed', message: RESTART_MESSAGE }); return }
    const format = buildFormat()
    const name = exportFileName(table, format)
    const ext = name.slice(name.lastIndexOf('.') + 1)
    const filePath = await files.saveDialog({
      title: preset ? 'Dump SQL File' : 'Export',
      defaultName: name,
      filters: [FILTERS[ext] ?? FILTERS.sql, { name: 'All Files', extensions: ['*'] }],
    })
    if (!filePath) { if (preset) onClose(); return }

    const opened = await files.openWrite(filePath)
    if (!opened.ok || !opened.fileId) { setPhase({ kind: 'failed', message: opened.error ?? 'Could not open the file' }); return }
    const fileId = opened.fileId
    const { io, cancel } = exportIO(target, fileId)
    const control = { cancelled: false, cancel: () => { control.cancelled = true; cancel() } }
    cancelRef.current = control
    setPhase({ kind: 'running', filePath, rows: 0 })
    const began = Date.now()
    try {
      const res = await runExport(io, {
        dbType, schema, table, format,
        columns: format.kind === 'sql' || !columns ? undefined : columns.filter(c => selected.has(c)),
      }, {
        onProgress: rows => setPhase(p => p.kind === 'running' ? { ...p, rows } : p),
        isCancelled: () => control.cancelled,
      })
      await files.close(fileId)
      setPhase({ kind: 'done', filePath, rows: res.rows, seconds: (Date.now() - began) / 1000 })
    } catch (err) {
      await files.close(fileId, true) // don't leave a half-written file behind
      if (control.cancelled || err instanceof ExportCancelled) { if (preset) onClose(); else setPhase({ kind: 'options' }); return }
      setPhase({ kind: 'failed', message: err instanceof Error ? err.message : String(err) })
    } finally {
      cancelRef.current = null
    }
  }

  // Dump SQL File starts right away
  useEffect(() => {
    if (!preset || startedRef.current) return
    startedRef.current = true
    void start()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset])

  const close = () => {
    if (running) return
    onClose()
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !running) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [running, onClose])

  const title = preset ? (preset === 'dump-data' ? 'Dump SQL File (Structure and Data)' : 'Dump SQL File (Structure Only)') : 'Export Wizard'
  // A preset dump shows nothing until the save dialog has a path
  if (preset && phase.kind === 'options') return null

  const toggleColumn = (c: string) => setSelected(prev => {
    const next = new Set(prev)
    if (next.has(c)) next.delete(c)
    else next.add(c)
    return next
  })

  const check = (label: string, checked: boolean, onChange: (v: boolean) => void, hint?: string) => (
    <label className="flex items-start gap-2 text-xs cursor-pointer select-none">
      <input type="checkbox" className="mt-0.5" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span><span className="text-foreground">{label}</span>{hint && <span className="block text-[11px] text-muted-foreground/70">{hint}</span>}</span>
    </label>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onMouseDown={close}>
      <div className="bg-card border border-border rounded-lg shadow-xl w-[520px] max-h-[90vh] flex flex-col" onMouseDown={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border shrink-0">
          <div className="min-w-0">
            <div className="text-sm font-semibold">{title}</div>
            <div className="text-xs text-muted-foreground truncate">{schema}.{table}</div>
          </div>
          <button onClick={close} disabled={running} className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30"><X className="h-4 w-4" /></button>
        </div>

        {phase.kind === 'options' && (
          <>
            <div className="px-5 py-4 space-y-4 overflow-y-auto">
              <div>
                <div className="text-xs text-muted-foreground mb-1.5">Format</div>
                <div className="flex gap-1">
                  {([['csv', 'CSV / TSV'], ['json', 'JSON'], ['sql', 'SQL']] as const).map(([k, label]) => (
                    <button key={k} onClick={() => setFormatKind(k)}
                      className={cn('px-3 py-1 rounded text-xs border transition-colors', formatKind === k ? 'border-primary bg-primary/15 text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {formatKind === 'csv' && (
                <div className="space-y-2">
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <label className="flex items-center gap-1.5">Delimiter
                      <select className={inputCls} value={csv.delimiter} onChange={e => setCsv({ ...csv, delimiter: e.target.value })}>
                        <option value=",">Comma ,</option>
                        <option value=";">Semicolon ;</option>
                        <option value={'\t'}>Tab</option>
                        <option value="|">Pipe |</option>
                      </select>
                    </label>
                    <label className="flex items-center gap-1.5">NULL as
                      <select className={inputCls} value={csv.nullAs} onChange={e => setCsv({ ...csv, nullAs: e.target.value })}>
                        <option value="">empty</option>
                        <option value="NULL">NULL</option>
                        <option value="\N">\N</option>
                      </select>
                    </label>
                  </div>
                  {check('Header row', csv.header, v => setCsv({ ...csv, header: v }))}
                  {check('Quote every field', csv.quoteAll, v => setCsv({ ...csv, quoteAll: v }))}
                  {check('UTF-8 BOM', csv.bom, v => setCsv({ ...csv, bom: v }), 'Makes Excel read accented and non-Latin characters correctly')}
                </div>
              )}

              {formatKind === 'json' && (
                <div className="space-y-2">
                  <div className="flex gap-4 text-xs">
                    {([['array', 'Array of objects'], ['lines', 'JSON Lines (one object per line)']] as const).map(([k, label]) => (
                      <label key={k} className="flex items-center gap-1.5 cursor-pointer">
                        <input type="radio" checked={jsonLayout === k} onChange={() => setJsonLayout(k)} />{label}
                      </label>
                    ))}
                  </div>
                  {jsonLayout === 'array' && check('Pretty-print', pretty, setPretty)}
                  <p className="text-[11px] text-muted-foreground/70">Numbers too long for JSON to hold exactly (bigint ids, precise decimals) are written as strings.</p>
                </div>
              )}

              {formatKind === 'sql' && (
                <div className="space-y-2">
                  {check('CREATE TABLE statement', sqlOpts.structure, v => setSqlOpts({ ...sqlOpts, structure: v }))}
                  {sqlOpts.structure && <div className="pl-5">{check('DROP TABLE IF EXISTS first', sqlOpts.dropTable, v => setSqlOpts({ ...sqlOpts, dropTable: v }))}</div>}
                  {check('INSERT statements for the rows', sqlOpts.data, v => setSqlOpts({ ...sqlOpts, data: v }))}
                  {sqlOpts.data && (
                    <div className="pl-5 space-y-2">
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">Rows per INSERT
                        <select className={inputCls} value={sqlOpts.rowsPerStatement} onChange={e => setSqlOpts({ ...sqlOpts, rowsPerStatement: Number(e.target.value) })}>
                          {[1, 100, 500, 1000].map(n => <option key={n} value={n}>{n}</option>)}
                        </select>
                      </label>
                      {check('Wrap in a transaction', sqlOpts.transaction, v => setSqlOpts({ ...sqlOpts, transaction: v }), 'Loading the file inserts all rows or none')}
                    </div>
                  )}
                </div>
              )}

              {formatKind !== 'sql' && (
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs text-muted-foreground">Columns ({selected.size}/{columns?.length ?? 0})</span>
                    {columns && (
                      <span className="flex gap-2 text-[11px]">
                        <button className="text-primary hover:underline" onClick={() => setSelected(new Set(columns))}>All</button>
                        <button className="text-primary hover:underline" onClick={() => setSelected(new Set())}>None</button>
                      </span>
                    )}
                  </div>
                  {!columns ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  ) : (
                    <div className="max-h-40 overflow-y-auto border border-border rounded px-2 py-1 grid grid-cols-2 gap-x-3">
                      {columns.map(c => (
                        <label key={c} className="flex items-center gap-1.5 text-xs py-0.5 cursor-pointer select-none truncate">
                          <input type="checkbox" checked={selected.has(c)} onChange={() => toggleColumn(c)} />
                          <span className="font-mono truncate">{c}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {estimate !== null && <p className="text-[11px] text-muted-foreground/70">About {estimate.toLocaleString()} rows</p>}
            </div>
            <div className="flex justify-end gap-2 px-5 py-3 border-t border-border shrink-0">
              <button onClick={onClose} className={buttonCls}>Cancel</button>
              <button
                onClick={() => void start()}
                disabled={formatKind === 'sql' ? !sqlOpts.structure && !sqlOpts.data : selected.size === 0}
                className={primaryCls}
              >
                Export…
              </button>
            </div>
          </>
        )}

        {phase.kind === 'running' && (
          <div className="px-5 py-5 space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              {phase.rows.toLocaleString()} rows written{estimate ? ` of about ${estimate.toLocaleString()}` : ''} · {elapsed}s
            </div>
            {estimate !== null && (
              <div className="h-1.5 rounded bg-muted overflow-hidden">
                <div className="h-full bg-primary transition-all" style={{ width: `${Math.min(100, (phase.rows / estimate) * 100)}%` }} />
              </div>
            )}
            <div className="text-[11px] text-muted-foreground truncate" title={phase.filePath}>{phase.filePath}</div>
            <div className="flex justify-end">
              <button onClick={() => cancelRef.current?.cancel()} className={buttonCls}>Cancel</button>
            </div>
          </div>
        )}

        {phase.kind === 'done' && (
          <div className="px-5 py-5 space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              Exported {phase.rows.toLocaleString()} row{phase.rows === 1 ? '' : 's'} in {phase.seconds.toFixed(1)}s
            </div>
            <div className="text-[11px] text-muted-foreground break-all">{phase.filePath}</div>
            <div className="flex justify-end gap-2">
              <button onClick={() => void window.electronAPI?.files?.showInFolder(phase.filePath)} className={cn(buttonCls, 'flex items-center gap-1.5')}>
                <FolderOpen className="h-3.5 w-3.5" /> Show in Folder
              </button>
              <button onClick={onClose} className={primaryCls}>Close</button>
            </div>
          </div>
        )}

        {phase.kind === 'failed' && (
          <div className="px-5 py-5 space-y-3">
            <div className="px-2 py-1.5 rounded border border-red-500/30 bg-red-950/60 text-[11px] text-red-300 whitespace-pre-wrap break-words">{phase.message}</div>
            <div className="flex justify-end gap-2">
              {!preset && <button onClick={() => setPhase({ kind: 'options' })} className={buttonCls}>Back</button>}
              <button onClick={onClose} className={primaryCls}>Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
