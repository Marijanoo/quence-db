'use client'

// Visual EXPLAIN: the query plan as a tree of steps, each with its share of the time (or, without
// ANALYZE, of the estimated cost), row counts, and warnings; index suggestions on top.
import React, { useMemo, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Copy, FileCode, Flame, Lightbulb, Loader2, Play, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { confirmAction } from '@/components/confirm-dialog'
import { SqlHighlight } from '@/components/sql-highlight'
import { hottestNode, type ExplainPlan, type IndexSuggestion, type PlanNode } from '@/lib/explain'

const fmtMs = (ms: number | null) => ms === null ? '–' : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : ms >= 10 ? `${ms.toFixed(0)} ms` : `${ms.toFixed(ms >= 1 ? 1 : 2)} ms`
const fmtRows = (n: number | null) => n === null ? '–' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(0)}k` : Math.round(n).toLocaleString('en-US')
const fmtCost = (n: number | null) => n === null ? '–' : n >= 1e4 ? `${(n / 1e3).toFixed(0)}k` : n.toFixed(n >= 100 ? 0 : 1)

function heat(share: number) {
  return share >= 0.5 ? 'bg-red-500' : share >= 0.2 ? 'bg-orange-500' : share >= 0.05 ? 'bg-amber-400' : 'bg-muted-foreground/40'
}

export function PlanView({ plan, running, onReExplain, onOpenQuery, onRunSql }: {
  plan: ExplainPlan
  running: boolean
  onReExplain: (analyze: boolean) => void
  onOpenQuery: (sql: string) => void
  // Runs a statement (creating a suggested index)
  onRunSql: (sql: string) => Promise<{ ok: boolean; error?: string }>
}) {
  const [view, setView] = useState<'tree' | 'raw'>('tree')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [openDetails, setOpenDetails] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState<string | null>(null)
  const hot = useMemo(() => hottestNode(plan), [plan])
  const timed = plan.analyzed
  const total = timed ? (plan.executionMs ?? plan.root.totalMs ?? 0) : (plan.root.totalCost ?? 0)
  const suggestionFor = useMemo(() => new Map(plan.suggestions.map(s => [s.nodeId, s])), [plan.suggestions])
  const warningCount = useMemo(() => { let n = 0; const w = (x: PlanNode) => { n += x.warnings.length; x.children.forEach(w) }; w(plan.root); return n }, [plan])

  const copy = (text: string, what: string) => void navigator.clipboard.writeText(text).then(() => toast.success(`Copied ${what}`))
  const toggle = (set: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) =>
    set(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const createIndex = async (s: IndexSuggestion) => {
    const ok = await confirmAction({
      title: `Create an index on ${s.table}?`,
      message: plan.engine === 'postgres'
        ? 'Built CONCURRENTLY: the table stays readable and writable meanwhile, but on a big table it takes a while and uses extra I/O. Afterwards the query is explained again.'
        : 'On a big table this takes a while. Afterwards the query is explained again.',
      details: s.sql,
      confirmLabel: 'Create Index',
    })
    if (!ok) return
    setCreating(s.sql)
    const res = await onRunSql(s.sql)
    setCreating(null)
    if (!res.ok) { toast.error(`Couldn't create the index: ${res.error}`); return }
    toast.success(`Created the index on ${s.table}`)
    onReExplain(plan.analyzed)
  }

  const renderNode = (n: PlanNode, depth: number): React.ReactNode => {
    const self = timed ? n.selfMs : n.selfCost
    const share = total > 0 && self !== null ? Math.min(1, self / total) : 0
    const isCollapsed = collapsed.has(n.id)
    const detailsOpen = openDetails.has(n.id)
    const misestimate = n.warnings.some(w => w.startsWith('Estimated'))
    const sug = suggestionFor.get(n.id)
    return (
      <React.Fragment key={n.id}>
        <div
          className={cn('group flex items-center gap-2 pr-3 py-1 border-b border-border/40 hover:bg-accent/10 cursor-pointer', n.id === hot && 'bg-red-500/5')}
          style={{ paddingLeft: 8 + depth * 18 }}
          onClick={() => toggle(setOpenDetails, n.id)}
        >
          <span className="w-3.5 shrink-0 flex justify-center text-muted-foreground"
            onClick={e => { if (n.children.length) { e.stopPropagation(); toggle(setCollapsed, n.id) } }}>
            {n.children.length > 0 && (isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
          </span>
          {/* Share of the whole query spent in this step itself */}
          <span className="w-14 h-1.5 rounded-full bg-muted/60 overflow-hidden shrink-0" title={`${Math.round(share * 100)}% of the ${timed ? 'time' : 'estimated cost'}`}>
            <span className={cn('block h-full rounded-full', heat(share))} style={{ width: `${Math.max(share > 0 ? 4 : 0, share * 100)}%` }} />
          </span>
          <span className="w-9 text-right text-[10px] tabular-nums text-muted-foreground shrink-0">{share >= 0.005 ? `${Math.round(share * 100)}%` : ''}</span>
          <span className={cn('text-xs font-semibold whitespace-nowrap', n.fullScan ? 'text-amber-300' : 'text-foreground')}>{n.title}</span>
          <span className="text-xs font-mono text-muted-foreground truncate min-w-0">{n.subtitle}</span>
          {n.id === hot && <span className="shrink-0 inline-flex items-center gap-0.5 text-[10px] px-1 rounded bg-red-500/20 text-red-300"><Flame className="h-2.5 w-2.5" />slowest step</span>}
          {n.warnings.length > 0 && <AlertTriangle className="h-3 w-3 text-amber-400 shrink-0" />}
          {sug && <Lightbulb className="h-3 w-3 text-sky-300 shrink-0" />}
          <span className="ml-auto flex items-center gap-3 shrink-0 text-[11px] tabular-nums text-muted-foreground">
            <span title={timed ? 'Rows: estimated → actual (per loop)' : 'Estimated rows'} className={cn(misestimate && 'text-amber-400')}>
              {timed && n.actualRows !== null ? `${fmtRows(n.estRows)} → ${fmtRows(n.actualRows)}` : fmtRows(n.estRows)} rows
              {n.loops !== null && n.loops > 1 ? ` × ${fmtRows(n.loops)}` : ''}
            </span>
            {timed
              ? <span className="w-28 text-right" title="Time in this step itself (including children)">{fmtMs(n.selfMs)} <span className="text-muted-foreground/50">({fmtMs(n.totalMs)})</span></span>
              : <span className="w-20 text-right" title="Estimated cost (including children)">cost {fmtCost(n.totalCost)}</span>}
          </span>
        </div>
        {detailsOpen && (
          <div className="border-b border-border/40 bg-muted/10 py-2 pr-3 text-[11px]" style={{ paddingLeft: 8 + depth * 18 + 30 }}>
            {n.warnings.map((w, i) => (
              <div key={i} className="flex items-start gap-1.5 text-amber-300 mb-1"><AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />{w}</div>
            ))}
            <div className="grid gap-x-4 gap-y-0.5" style={{ gridTemplateColumns: 'max-content 1fr' }}>
              {n.details.map(([k, v]) => (
                <React.Fragment key={k}>
                  <span className="text-muted-foreground">{k}</span>
                  {n.sqlDetails.includes(k)
                    ? <SqlHighlight sql={v} className="m-0 text-[11px] whitespace-pre-wrap break-words select-text" />
                    : <span className="text-foreground break-words select-text">{v}</span>}
                </React.Fragment>
              ))}
            </div>
          </div>
        )}
        {!isCollapsed && n.children.map(c => renderNode(c, depth + 1))}
      </React.Fragment>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-3 px-3 h-8 border-b border-border bg-muted/10 shrink-0 text-xs">
        <span className="font-semibold text-foreground">Query plan</span>
        <span className={cn('text-[10px] px-1.5 rounded', timed ? 'bg-green-500/15 text-green-400' : 'bg-muted text-muted-foreground')}>
          {timed ? 'measured (ran the query)' : 'estimates only'}
        </span>
        {plan.executionMs !== null && <span className="text-muted-foreground">Execution <span className="text-foreground tabular-nums">{fmtMs(plan.executionMs)}</span></span>}
        {plan.planningMs !== null && <span className="text-muted-foreground">Planning <span className="text-foreground tabular-nums">{fmtMs(plan.planningMs)}</span></span>}
        {!timed && plan.root.totalCost !== null && <span className="text-muted-foreground">Total cost <span className="text-foreground tabular-nums">{fmtCost(plan.root.totalCost)}</span></span>}
        {warningCount > 0 && <span className="text-amber-400">{warningCount} warning{warningCount === 1 ? '' : 's'}</span>}
        <span className="ml-auto flex items-center gap-1.5">
          {plan.engine === 'postgres' && (
            <button onClick={() => onReExplain(!timed)} disabled={running}
              title={timed ? 'Explain again from estimates, without running the query' : 'Run the query and measure each step (writes are rolled back)'}
              className="flex items-center gap-1 px-2 h-5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20 disabled:opacity-40">
              {timed ? <RefreshCw className="h-3 w-3" /> : <Play className="h-3 w-3" />}{timed ? 'Estimates only' : 'Measure'}
            </button>
          )}
          <button onClick={() => onReExplain(timed)} disabled={running} title="Explain again"
            className="flex items-center justify-center h-5 w-5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20 disabled:opacity-40">
            {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          </button>
          <span className="flex rounded border border-border overflow-hidden">
            {(['tree', 'raw'] as const).map(v => (
              <button key={v} onClick={() => setView(v)}
                className={cn('px-2 h-5 text-[11px]', view === v ? 'bg-accent/40 text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                {v === 'tree' ? 'Plan' : 'Raw'}
              </button>
            ))}
          </span>
          <button onClick={() => copy(plan.raw, 'plan')} title="Copy the plan"
            className="flex items-center justify-center h-5 w-5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20">
            <Copy className="h-3 w-3" />
          </button>
        </span>
      </div>

      {view === 'raw' ? (
        <pre className="flex-1 min-h-0 overflow-auto m-0 p-3 text-[11px] font-mono text-foreground select-text whitespace-pre">{plan.raw}</pre>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto">
          {(plan.suggestions.length > 0 || plan.notes.length > 0) && (
            <div className="p-3 space-y-2 border-b border-border">
              {plan.suggestions.map(s => (
                <div key={s.sql} className="rounded-md border border-sky-500/30 bg-sky-500/5 p-2.5 space-y-1.5">
                  <div className="flex items-center gap-2 text-xs">
                    <Lightbulb className="h-3.5 w-3.5 text-sky-300 shrink-0" />
                    <span className="font-semibold text-foreground">Index on {s.table} ({s.columns.join(', ')})</span>
                    {s.priority === 'high' && <span className="text-[10px] px-1 rounded bg-sky-500/20 text-sky-300">likely a big win</span>}
                  </div>
                  <p className="text-[11px] text-muted-foreground">{s.reason}</p>
                  <SqlHighlight sql={s.sql} className="m-0 text-[11px] bg-background border border-border rounded px-2 py-1 whitespace-pre-wrap break-words select-text" />
                  <div className="flex items-center gap-1.5">
                    <button onClick={() => void createIndex(s)} disabled={creating !== null || running}
                      className="flex items-center gap-1 px-2 h-5 rounded bg-primary text-primary-foreground text-[11px] font-medium hover:bg-primary/90 disabled:opacity-40">
                      {creating === s.sql ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}Create Index…
                    </button>
                    <button onClick={() => onOpenQuery(s.sql)}
                      className="flex items-center gap-1 px-2 h-5 rounded border border-border text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/20">
                      <FileCode className="h-3 w-3" />Open in Query Tab
                    </button>
                    <button onClick={() => copy(s.sql, 'statement')}
                      className="flex items-center gap-1 px-2 h-5 rounded border border-border text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/20">
                      <Copy className="h-3 w-3" />Copy
                    </button>
                  </div>
                </div>
              ))}
              {plan.notes.map((n, i) => <p key={i} className="text-[11px] text-muted-foreground">{n}</p>)}
              {plan.suggestions.length > 0 && (
                <p className="text-[10px] text-muted-foreground/60">Suggestions come from this one query’s plan. Every index also slows down writes to its table a little, so check it fits your other queries too.</p>
              )}
            </div>
          )}
          <div className="min-w-[640px]">{renderNode(plan.root, 0)}</div>
        </div>
      )}
    </div>
  )
}
