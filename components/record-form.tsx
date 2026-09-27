'use client'

// Form view of a table: one record at a time, each column as a labelled field. Edits become the
// same pending changes as the grid's (amber, saved with Ctrl+S).
import React, { useState } from 'react'
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, KeyRound } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toBytes, valueText } from '@/components/value-viewer'

interface Col { name: string; type?: string; nullable?: boolean }

export function RecordForm({ fields, columns, rows, rowIndex, pending, primaryKeys, editable, onEdit, onNavigate, onSelectField }: {
  fields: string[]
  columns?: Col[]
  rows: Record<string, unknown>[]
  rowIndex: number
  // Unsaved values of this record, by column (null: set to NULL)
  pending: Record<string, string | null>
  primaryKeys: string[]
  editable: boolean
  onEdit: (col: string, value: string | null | undefined) => void
  onNavigate: (rowIndex: number) => void
  onSelectField: (col: string) => void
}) {
  const row = rows[rowIndex]
  if (!row) {
    return <div className="h-full flex items-center justify-center text-xs text-muted-foreground">No rows on this page</div>
  }
  const last = rows.length - 1
  const nav = (to: number) => onNavigate(Math.max(0, Math.min(last, to)))
  const btn = 'p-1 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20 disabled:opacity-40'
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-1.5 px-3 h-8 border-b border-border shrink-0 text-xs">
        <button className={btn} disabled={rowIndex === 0} onClick={() => nav(0)} title="First record"><ChevronsLeft className="h-3 w-3" /></button>
        <button className={btn} disabled={rowIndex === 0} onClick={() => nav(rowIndex - 1)} title="Previous record (Alt+↑)"><ChevronLeft className="h-3 w-3" /></button>
        <span className="tabular-nums text-muted-foreground px-1">Record {rowIndex + 1} of {rows.length} on this page</span>
        <button className={btn} disabled={rowIndex >= last} onClick={() => nav(rowIndex + 1)} title="Next record (Alt+↓)"><ChevronRight className="h-3 w-3" /></button>
        <button className={btn} disabled={rowIndex >= last} onClick={() => nav(last)} title="Last record"><ChevronsRight className="h-3 w-3" /></button>
        {Object.keys(pending).length > 0 && <span className="ml-2 text-[11px] text-amber-400">{Object.keys(pending).length} unsaved in this record</span>}
      </div>
      <div
        className="flex-1 min-h-0 overflow-auto p-3"
        onKeyDown={e => {
          if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); nav(rowIndex + 1) }
          if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); nav(rowIndex - 1) }
        }}
      >
        <div className="grid gap-x-3 gap-y-2 max-w-3xl" style={{ gridTemplateColumns: 'minmax(120px, max-content) 1fr' }}>
          {fields.map(f => {
            const col = columns?.find(c => c.name === f)
            const has = f in pending
            return (
              <Field
                key={`${rowIndex}:${f}`}
                name={f}
                type={col?.type}
                nullable={col?.nullable}
                isKey={primaryKeys.includes(f)}
                value={row[f]}
                pending={has ? pending[f] : undefined}
                editable={editable && !toBytes(row[f])}
                onEdit={v => onEdit(f, v)}
                onFocus={() => onSelectField(f)}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}

function Field({ name, type, nullable, isKey, value, pending, editable, onEdit, onFocus }: {
  name: string
  type?: string
  nullable?: boolean
  isKey: boolean
  value: unknown
  pending: string | null | undefined
  editable: boolean
  onEdit: (value: string | null | undefined) => void
  onFocus: () => void
}) {
  const current = pending !== undefined ? pending : value
  const isNull = current === null || current === undefined
  const text = valueText(current)
  const [draft, setDraft] = useState<string | null>(null)
  const long = text.length > 80 || text.includes('\n') || /^(json|jsonb|text|longtext|mediumtext)$/i.test(type ?? '')
  const isBool = /^(bool|boolean)$/i.test(type ?? '')
  const commit = (v: string) => {
    setDraft(null)
    if (v === text && !(isNull && v === '')) return
    if (isNull && v === '') return
    onEdit(v === valueText(value) && value !== null && value !== undefined ? undefined : v)
  }
  const fieldCls = cn(
    'w-full bg-background border rounded px-2 py-1 text-xs font-mono text-foreground outline-none focus:ring-1 focus:ring-primary',
    pending !== undefined ? 'border-amber-500/60 bg-amber-500/10' : 'border-border',
  )
  return (
    <>
      <label className="flex items-start gap-1.5 pt-1 text-xs min-w-0">
        {isKey && <KeyRound className="h-3 w-3 text-amber-400 mt-0.5 shrink-0" />}
        <span className="font-mono text-foreground truncate" title={name}>{name}</span>
        {type && <span className="text-[9px] text-muted-foreground uppercase mt-0.5 shrink-0">{type}</span>}
      </label>
      <div className="flex items-start gap-1 min-w-0">
        {isBool && editable ? (
          <select value={isNull ? '' : String(current)} onFocus={onFocus}
            onChange={e => onEdit(e.target.value === '' ? (value === null ? undefined : null) : e.target.value === String(value) ? undefined : e.target.value)}
            className={cn(fieldCls, 'w-32')}>
            <option value="">NULL</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : long ? (
          <textarea value={draft ?? text} readOnly={!editable} rows={Math.min(8, Math.max(2, text.split('\n').length))}
            placeholder={isNull ? 'NULL' : undefined} onFocus={onFocus}
            onChange={e => setDraft(e.target.value)} onBlur={e => { if (draft !== null) commit(e.target.value) }}
            className={cn(fieldCls, 'resize-y')} />
        ) : (
          <input value={draft ?? text} readOnly={!editable} placeholder={isNull ? 'NULL' : undefined} onFocus={onFocus}
            onChange={e => setDraft(e.target.value)} onBlur={e => { if (draft !== null) commit(e.target.value) }}
            onKeyDown={e => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') { setDraft(null); (e.target as HTMLInputElement).blur() }
            }}
            className={fieldCls} />
        )}
        {editable && nullable !== false && !isNull && (
          <button onClick={() => onEdit(value === null ? undefined : null)} title="Set to NULL"
            className="shrink-0 px-1.5 h-6 rounded border border-border text-[10px] text-muted-foreground hover:text-foreground">NULL</button>
        )}
        {pending !== undefined && (
          <button onClick={() => { setDraft(null); onEdit(undefined) }} title="Revert"
            className="shrink-0 px-1.5 h-6 rounded border border-border text-[10px] text-muted-foreground hover:text-foreground">Revert</button>
        )}
      </div>
    </>
  )
}
