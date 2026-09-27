'use client'

// The table tab's filter: a builder (column, operator, value rows joined by AND or OR) or a
// WHERE clause typed by hand. Nothing runs until Apply; the filter covers the whole table.
import React, { useState } from 'react'
import { Filter, Plus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  FILTER_OPS, activeConditions, describeFilter, emptyFilter, filterIsActive, opInfo,
  type FilterCondition, type FilterOp, type TableFilter,
} from '@/lib/table-filter'

const inputCls = 'h-6 bg-background border border-border rounded px-1.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-primary'
let nextId = 0
const newCondition = (column: string, op: FilterOp = 'eq', value = ''): FilterCondition => ({ id: `c${++nextId}`, enabled: true, column, op, value })

export function TableFilterPanel({ filter, columns, isMongo, disabledReason, onApply, onClose }: {
  filter: TableFilter | undefined
  columns: { name: string; type?: string }[]
  isMongo: boolean
  // e.g. unsaved changes: applying reloads the rows
  disabledReason?: string
  onApply: (filter: TableFilter | undefined) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<TableFilter>(() => {
    const f = filter ?? emptyFilter()
    return f.mode === 'builder' && f.conditions.length === 0 ? { ...f, conditions: [newCondition(columns[0]?.name ?? '')] } : f
  })
  const set = (patch: Partial<TableFilter>) => setDraft(d => ({ ...d, ...patch }))
  const setCond = (id: string, patch: Partial<FilterCondition>) =>
    setDraft(d => ({ ...d, conditions: d.conditions.map(c => c.id === id ? { ...c, ...patch } : c) }))
  const apply = () => { if (!disabledReason) onApply(filterIsActive(draft) ? draft : undefined) }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement && e.shiftKey)) { e.preventDefault(); apply() }
    if (e.key === 'Escape') onClose()
  }

  return (
    <div className="border-b border-border bg-muted/10 px-3 py-2 space-y-2 shrink-0" onKeyDown={onKey}>
      <div className="flex items-center gap-2 text-xs">
        <Filter className="h-3.5 w-3.5 text-primary" />
        <span className="font-semibold text-foreground">Filter</span>
        <span className="flex rounded border border-border overflow-hidden ml-2">
          {(['builder', 'sql'] as const).map(m => (
            <button key={m} onClick={() => set({ mode: m })}
              className={cn('px-2 h-5 text-[11px]', draft.mode === m ? 'bg-accent/40 text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              {m === 'builder' ? 'Builder' : isMongo ? 'Query' : 'WHERE'}
            </button>
          ))}
        </span>
        {draft.mode === 'builder' && draft.conditions.length > 1 && (
          <span className="flex items-center gap-1 text-muted-foreground">
            Match
            <select value={draft.match} onChange={e => set({ match: e.target.value as 'all' | 'any' })} className={inputCls}>
              <option value="all">all conditions (AND)</option>
              <option value="any">any condition (OR)</option>
            </select>
          </span>
        )}
        <button onClick={onClose} title="Close (Esc)" className="ml-auto text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
      </div>

      {draft.mode === 'sql' ? (
        <div className="space-y-1">
          <textarea
            autoFocus value={draft.raw} onChange={e => set({ raw: e.target.value })} rows={2} spellCheck={false}
            placeholder={isMongo ? '{ "status": "open", "qty": { "$gt": 5 } }' : "status = 'pending' AND total > 100"}
            className="w-full bg-background border border-border rounded px-2 py-1 text-xs font-mono text-foreground outline-none focus:ring-1 focus:ring-primary resize-y"
          />
          <p className="text-[10px] text-muted-foreground/70">
            {isMongo ? 'A find() filter document, in shell syntax (ObjectId(…), ISODate(…) work).' : 'Goes after WHERE as it is. Enter applies, Shift+Enter adds a line.'}
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          {draft.conditions.map((c, i) => {
            const info = opInfo(c.op)
            const type = columns.find(col => col.name === c.column)?.type
            return (
              <div key={c.id} className="flex items-center gap-1.5">
                <span className="w-9 text-right text-[10px] text-muted-foreground shrink-0">{i === 0 ? 'where' : draft.match === 'all' ? 'and' : 'or'}</span>
                <input type="checkbox" checked={c.enabled} onChange={e => setCond(c.id, { enabled: e.target.checked })} title="Use this condition" />
                <select value={c.column} onChange={e => setCond(c.id, { column: e.target.value })} className={cn(inputCls, 'w-44 font-mono')}>
                  {!columns.some(col => col.name === c.column) && <option value={c.column}>{c.column || 'Choose a column'}</option>}
                  {columns.map(col => <option key={col.name} value={col.name}>{col.name}</option>)}
                </select>
                <select value={c.op} onChange={e => setCond(c.id, { op: e.target.value as FilterOp })} className={cn(inputCls, 'w-32')}>
                  {FILTER_OPS.map(o => <option key={o.op} value={o.op}>{o.label}</option>)}
                </select>
                {info.values !== 0 && (
                  <input autoFocus={i === draft.conditions.length - 1} value={c.value} onChange={e => setCond(c.id, { value: e.target.value })}
                    placeholder={info.values === 'list' ? 'a, b, c' : type ?? 'value'} className={cn(inputCls, 'w-48 font-mono')} />
                )}
                {info.values === 2 && (
                  <>
                    <span className="text-[11px] text-muted-foreground">and</span>
                    <input value={c.value2 ?? ''} onChange={e => setCond(c.id, { value2: e.target.value })} placeholder={type ?? 'value'} className={cn(inputCls, 'w-40 font-mono')} />
                  </>
                )}
                <button onClick={() => setDraft(d => ({ ...d, conditions: d.conditions.filter(x => x.id !== c.id) }))} title="Remove"
                  className="p-0.5 rounded text-muted-foreground hover:text-red-400 hover:bg-red-500/10"><X className="h-3 w-3" /></button>
              </div>
            )
          })}
          <button onClick={() => setDraft(d => ({ ...d, conditions: [...d.conditions, newCondition(columns[0]?.name ?? '')] }))}
            className="ml-11 flex items-center gap-1 text-[11px] text-primary hover:underline">
            <Plus className="h-3 w-3" /> Add condition
          </button>
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <button onClick={apply} disabled={!!disabledReason}
          title={disabledReason ?? 'Apply (Enter)'}
          className="px-2.5 h-6 rounded bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-40">Apply</button>
        <button onClick={() => { if (!disabledReason) { setDraft({ ...emptyFilter(), conditions: [newCondition(columns[0]?.name ?? '')] }); onApply(undefined) } }}
          disabled={!!disabledReason || !filterIsActive(filter)}
          className="px-2.5 h-6 rounded border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-accent/20 disabled:opacity-40">Clear</button>
        {disabledReason && <span className="text-[11px] text-amber-400">{disabledReason}</span>}
      </div>
    </div>
  )
}

// The active filter, shown under the header when the panel is closed
export function FilterSummary({ filter, onEdit, onClear, disabled }: { filter: TableFilter; onEdit: () => void; onClear: () => void; disabled?: boolean }) {
  const count = filter.mode === 'sql' ? 1 : activeConditions(filter).length
  return (
    <div className="flex items-center gap-2 px-3 h-7 border-b border-primary/30 bg-primary/10 shrink-0 text-xs">
      <Filter className="h-3 w-3 text-primary shrink-0" />
      <button onClick={onEdit} className="text-primary font-medium shrink-0 hover:underline">
        {count === 1 ? 'Filtered' : `Filtered (${count} conditions)`}
      </button>
      <span className="font-mono text-muted-foreground truncate" title={describeFilter(filter)}>{describeFilter(filter)}</span>
      <button onClick={onClear} disabled={disabled} title="Remove the filter"
        className="ml-auto shrink-0 flex items-center gap-1 text-muted-foreground hover:text-foreground disabled:opacity-40"><X className="h-3 w-3" /> Clear</button>
    </div>
  )
}
