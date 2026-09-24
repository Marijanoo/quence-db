'use client'

// Import Wizard for one table: choose a CSV/TSV or JSON file, map its fields onto the table's
// columns, import in one transaction. The work is lib/table-import's runTableImport.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { FileUp, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { EXPORT_COLUMNS_SQL, parseExportColumns, type ExportColumn } from '@/lib/table-export'
import { autoMap, readPreview, runTableImport, TableImportCancelled, type ColumnMapping, type Preview, type SourceFormat } from '@/lib/table-import'
import type { TableRef } from '@/components/table-actions'
import { buttonCls, Check, DialogShell, ErrorBox, inputCls, openFileReader, primaryCls, Progress, useElapsed } from '@/components/database-transfer'

type Phase =
  | { kind: 'options' }
  | { kind: 'running' }
  | { kind: 'done'; rows: number; seconds: number }
  | { kind: 'failed'; message: string }

const api = (t: TableRef) => t.dbType === 'mysql' ? window.electronAPI!.mysql : window.electronAPI!.pg

function formatFor(path: string, delimiter: string, header: boolean): SourceFormat {
  return /\.(json|jsonl|ndjson)$/i.test(path) ? { kind: 'json' } : { kind: 'csv', delimiter, header }
}

export function TableImportDialog({ target, onClose, onDone }: { target: TableRef; onClose: () => void; onDone?: () => void }) {
  const { dbType, connectionId, database, schema, table } = target
  const [columns, setColumns] = useState<ExportColumn[] | null>(null)
  const [filePath, setFilePath] = useState<string | null>(null)
  const [csv, setCsv] = useState({ delimiter: ',', header: true })
  const [values, setValues] = useState({ emptyIsNull: true, nullText: '' })
  const [deleteFirst, setDeleteFirst] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [mapping, setMapping] = useState<Record<string, string>>({}) // column → source field
  const [phase, setPhase] = useState<Phase>({ kind: 'options' })
  const [progress, setProgress] = useState({ rows: 0, bytes: 0, size: 0 })
  const cancelled = useRef(false)
  const running = phase.kind === 'running'
  const elapsed = useElapsed(running)

  useEffect(() => {
    let stale = false
    api(target).query(connectionId, EXPORT_COLUMNS_SQL[dbType], database, [schema, table]).then(res => {
      if (!stale) setColumns(res.ok ? parseExportColumns(dbType, res.rows ?? []) : [])
    })
    return () => { stale = true }
  }, [target, dbType, connectionId, database, schema, table])

  const format = useMemo(() => filePath ? formatFor(filePath, csv.delimiter, csv.header) : null, [filePath, csv.delimiter, csv.header])

  // Re-read the preview whenever the file or how it's parsed changes
  useEffect(() => {
    if (!filePath || !format || !columns) return
    let stale = false
    ;(async () => {
      const file = await openFileReader(filePath)
      try {
        const p = await readPreview(file.read, format, 8)
        if (stale) return
        setPreview(p)
        setPreviewError(null)
        setMapping(Object.fromEntries(autoMap(p.fields, columns).map(m => [m.target, m.source])))
      } finally {
        await file.close()
      }
    })().catch(err => { if (!stale) { setPreview(null); setPreviewError(err instanceof Error ? err.message : String(err)) } })
    return () => { stale = true }
  }, [filePath, format, columns])

  async function choose() {
    const picked = await window.electronAPI?.files?.openDialog?.({
      title: 'Import Wizard',
      filters: [{ name: 'CSV, TSV or JSON', extensions: ['csv', 'tsv', 'txt', 'json', 'jsonl', 'ndjson'] }, { name: 'All Files', extensions: ['*'] }],
    })
    const path = picked?.[0]
    if (!path) return
    if (/\.tsv$/i.test(path)) setCsv(c => ({ ...c, delimiter: '\t' }))
    setFilePath(path)
  }

  async function start() {
    if (!filePath || !format || !columns) return
    const map: ColumnMapping[] = Object.entries(mapping).filter(([, source]) => source).map(([target, source]) => ({ source, target }))
    let file
    try { file = await openFileReader(filePath) } catch (err) { setPhase({ kind: 'failed', message: String(err) }); return }
    const opened = dbType === 'mysql'
      ? await window.electronAPI!.mysql.sessionOpen(connectionId, database)
      : await window.electronAPI!.pg.sessionOpen(connectionId, database)
    if (!opened.ok || !opened.sessionId) { await file.close(); setPhase({ kind: 'failed', message: opened.error ?? 'Could not open a session' }); return }
    const sessionId = opened.sessionId
    const session = {
      execute: async (sql: string, params?: unknown[]) => {
        const r = await api(target).sessionQuery(sessionId, sql, params)
        if (!r.ok) throw new Error(r.error)
        return { rowCount: r.rowCount }
      },
    }
    cancelled.current = false
    setProgress({ rows: 0, bytes: 0, size: file.size })
    setPhase({ kind: 'running' })
    const began = Date.now()
    try {
      const res = await runTableImport(file.read, session, {
        dbType, schema, table, format, mapping: map, columns, values, deleteFirst,
      }, {
        onProgress: p => setProgress({ rows: p.rows, bytes: p.bytes, size: file.size }),
        isCancelled: () => cancelled.current,
      })
      const closed = await api(target).sessionClose(sessionId, true)
      if (!closed.ok) throw new Error(closed.error)
      setPhase({ kind: 'done', rows: res.rows, seconds: (Date.now() - began) / 1000 })
      onDone?.()
    } catch (err) {
      await api(target).sessionClose(sessionId, false).catch(() => {})
      const message = cancelled.current || err instanceof TableImportCancelled ? 'Cancelled.' : err instanceof Error ? err.message : String(err)
      setPhase({ kind: 'failed', message: `${message}\n\nNothing was imported (the transaction was rolled back).` })
    } finally {
      await file.close()
    }
  }

  const insertable = columns?.filter(c => !c.generated) ?? []
  const mappedCount = Object.values(mapping).filter(Boolean).length
  const fileName = filePath?.split(/[\\/]/).pop()

  return (
    <DialogShell title="Import Wizard" subtitle={`${schema}.${table}`} busy={running} onClose={onClose} width="w-[640px]">
      {phase.kind === 'options' && (
        <>
          <div className="px-5 py-4 space-y-4 overflow-y-auto">
            <div className="flex items-center gap-2">
              <button onClick={() => void choose()} className={cn(buttonCls, 'flex items-center gap-1.5 shrink-0')}><FileUp className="h-3.5 w-3.5" /> Choose File…</button>
              <span className="text-xs text-muted-foreground truncate" title={filePath ?? undefined}>{fileName ?? 'CSV, TSV, JSON array or JSON Lines'}</span>
            </div>

            {format?.kind === 'csv' && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                <label className="flex items-center gap-1.5">Delimiter
                  <select className={inputCls} value={csv.delimiter} onChange={e => setCsv({ ...csv, delimiter: e.target.value })}>
                    <option value=",">Comma ,</option>
                    <option value=";">Semicolon ;</option>
                    <option value={'\t'}>Tab</option>
                    <option value="|">Pipe |</option>
                  </select>
                </label>
                <Check label="First row is the header" checked={csv.header} onChange={v => setCsv({ ...csv, header: v })} />
                <Check label="Empty field is NULL" checked={values.emptyIsNull} onChange={v => setValues({ ...values, emptyIsNull: v })} />
                <label className="flex items-center gap-1.5">NULL text
                  <input className={cn(inputCls, 'w-16 font-mono')} value={values.nullText} placeholder="none" onChange={e => setValues({ ...values, nullText: e.target.value })} />
                </label>
              </div>
            )}

            {previewError && <ErrorBox message={previewError} />}

            {preview && columns && (
              <div>
                <div className="text-xs text-muted-foreground mb-1.5">Columns ({mappedCount} of {insertable.length} filled from the file)</div>
                <div className="max-h-64 overflow-y-auto border border-border rounded">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-card">
                      <tr className="text-left text-muted-foreground border-b border-border">
                        <th className="px-2 py-1 font-medium">Column</th>
                        <th className="px-2 py-1 font-medium">From field</th>
                        <th className="px-2 py-1 font-medium">First value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {insertable.map(c => {
                        const source = mapping[c.name] ?? ''
                        const sample = source ? preview.rows.find(r => r[source] !== undefined && r[source] !== '')?.[source] : undefined
                        return (
                          <tr key={c.name} className="border-b border-border/50 last:border-0">
                            <td className="px-2 py-1"><span className="font-mono">{c.name}</span> <span className="text-[10px] text-muted-foreground">{c.type}</span></td>
                            <td className="px-2 py-1">
                              <select className={cn(inputCls, 'w-full')} value={source} onChange={e => setMapping(m => ({ ...m, [c.name]: e.target.value }))}>
                                <option value="">(skip: default / NULL)</option>
                                {preview.fields.map(f => <option key={f} value={f}>{f}</option>)}
                              </select>
                            </td>
                            <td className="px-2 py-1 font-mono text-muted-foreground truncate max-w-40">
                              {sample === undefined ? '' : typeof sample === 'object' ? JSON.stringify(sample) : String(sample)}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {filePath && !preview && !previewError && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}

            <Check label="Delete the table's existing rows first" checked={deleteFirst} onChange={setDeleteFirst} hint="Otherwise rows are added to what's there" />
            <p className="text-[11px] text-muted-foreground/70">The import runs in one transaction: if any row fails, nothing is imported and the failing line is shown.</p>
          </div>
          <div className="flex justify-end gap-2 px-5 py-3 border-t border-border shrink-0">
            <button onClick={onClose} className={buttonCls}>Cancel</button>
            <button onClick={() => void start()} disabled={!preview || mappedCount === 0} className={primaryCls}>Import</button>
          </div>
        </>
      )}
      {phase.kind === 'running' && (
        <div className="px-5 py-5 space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            {progress.rows.toLocaleString()} rows · {elapsed}s
          </div>
          <Progress value={progress.size ? progress.bytes / progress.size : null} />
          <div className="flex justify-end"><button onClick={() => { cancelled.current = true }} className={buttonCls}>Cancel</button></div>
        </div>
      )}
      {phase.kind === 'done' && (
        <div className="px-5 py-5 space-y-3">
          <div className="text-sm">Imported {phase.rows.toLocaleString()} row{phase.rows === 1 ? '' : 's'} in {phase.seconds.toFixed(1)}s</div>
          <div className="flex justify-end"><button onClick={onClose} className={primaryCls}>Close</button></div>
        </div>
      )}
      {phase.kind === 'failed' && (
        <div className="px-5 py-5 space-y-3">
          <ErrorBox message={phase.message} />
          <div className="flex justify-end gap-2">
            <button onClick={() => setPhase({ kind: 'options' })} className={buttonCls}>Back</button>
            <button onClick={onClose} className={primaryCls}>Close</button>
          </div>
        </div>
      )}
    </DialogShell>
  )
}
