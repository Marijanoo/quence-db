'use client'

// The value panel beside a table grid: the selected cell in full. Text wraps and can be edited
// (as a pending change, saved with the others), JSON is pretty-printed, binary shows its size, a
// hex dump and, for images, a preview.
import React, { useEffect, useMemo, useState } from 'react'
import { Copy, ExternalLink, Globe, Loader2, MonitorPlay, RefreshCw, WrapText, X } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

export function toBytes(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v
  if (v && typeof v === 'object' && (v as { type?: string }).type === 'Buffer' && Array.isArray((v as { data?: unknown }).data)) {
    return Uint8Array.from((v as { data: number[] }).data)
  }
  return null
}

function imageType(b: Uint8Array): string | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp'
  return null
}

export function hexDump(b: Uint8Array, limit = 4096): string {
  const lines: string[] = []
  const n = Math.min(b.length, limit)
  for (let off = 0; off < n; off += 16) {
    const chunk = b.subarray(off, Math.min(off + 16, n))
    const hex = Array.from(chunk, x => x.toString(16).padStart(2, '0')).join(' ')
    const ascii = Array.from(chunk, x => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('')
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`)
  }
  if (b.length > limit) lines.push(`… ${(b.length - limit).toLocaleString()} more bytes`)
  return lines.join('\n')
}

const fmtSize = (n: number) => n < 1024 ? `${n} bytes` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

// The text a value is edited as (the same as the grid's cell editor)
export function valueText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function parseJson(v: unknown, type: string | undefined): unknown | undefined {
  if (v !== null && typeof v === 'object' && !(v instanceof Date) && !toBytes(v)) return v
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  if (!(/^jsonb?$/i.test(type ?? '') || /^[[{]/.test(t))) return undefined
  try { return JSON.parse(t) } catch { return undefined }
}

// A cell holding just a web address
export function linkIn(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return /^https?:\/\/[^\s]+$/i.test(t) && t.length < 4000 ? t : null
}

type Preview = NonNullable<Awaited<ReturnType<NonNullable<NonNullable<Window['electronAPI']>['links']>['preview']>>['preview']>
// Previews already fetched this session, by URL
const previewCache = new Map<string, { preview?: Preview; error?: string }>()

function LinkPreviewBox({ url }: { url: string }) {
  const [state, setState] = useState<{ url: string; preview?: Preview; error?: string; loading: boolean }>(() => ({ url, ...previewCache.get(url), loading: !previewCache.has(url) }))
  const [live, setLive] = useState(false)
  const [reload, setReload] = useState(0)
  const api = typeof window !== 'undefined' ? window.electronAPI?.links : undefined
  useEffect(() => {
    const cached = reload === 0 ? previewCache.get(url) : undefined
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLive(false)
    if (cached) { setState({ url, ...cached, loading: false }); return }
    if (!api) { setState({ url, error: 'Restart QuenceDB to preview links (the app was updated while running).', loading: false }); return }
    setState({ url, loading: true })
    let stale = false
    // Waits a moment, so moving through cells doesn't fetch every link passed over
    const timer = setTimeout(() => {
      void api.preview(url).then(res => {
        const entry = res.ok ? { preview: res.preview } : { error: res.error ?? 'Preview failed' }
        previewCache.set(url, entry)
        if (!stale) setState({ url, ...entry, loading: false })
      })
    }, 350)
    return () => { stale = true; clearTimeout(timer) }
  }, [url, reload, api])

  const host = (() => { try { return new URL(state.preview?.url ?? url).host } catch { return url } })()
  const p = state.preview
  return (
    <div className="rounded-md border border-border bg-background overflow-hidden mb-2">
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border text-[11px]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {p?.icon ? <img src={p.icon} alt="" className="h-3.5 w-3.5 shrink-0" /> : <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
        <span className="text-muted-foreground truncate">{p?.siteName ?? host}</span>
        <span className="ml-auto flex items-center gap-0.5 shrink-0">
          {state.loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
          <button onClick={() => { previewCache.delete(url); setReload(r => r + 1) }} title="Load the preview again" className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40"><RefreshCw className="h-3 w-3" /></button>
          {!p?.isImage && (
            <button onClick={() => setLive(v => !v)} title="Show the live page here (some sites refuse to be shown inside other apps)"
              className={cn('p-0.5 rounded hover:bg-accent/40', live ? 'text-primary' : 'text-muted-foreground hover:text-foreground')}><MonitorPlay className="h-3 w-3" /></button>
          )}
          <button onClick={() => void api?.open(url)} title="Open in your browser" className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40"><ExternalLink className="h-3 w-3" /></button>
        </span>
      </div>
      {live ? (
        // Sandboxed: its scripts run, but it can't navigate the app, open windows or reach QuenceDB
        <iframe src={url} title={url} sandbox="allow-scripts allow-same-origin allow-forms" referrerPolicy="no-referrer"
          className="w-full h-80 bg-white border-0" />
      ) : state.error ? (
        <p className="px-2 py-2 text-[11px] text-red-300 break-words">{state.error}</p>
      ) : p ? (
        <div className="p-2 space-y-1.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {p.image && <img src={p.image} alt="" className="w-full max-h-56 object-contain rounded bg-muted/30" />}
          {p.title && <div className="text-xs font-semibold text-foreground break-words">{p.title}</div>}
          {p.description && <div className="text-[11px] text-muted-foreground break-words line-clamp-4">{p.description}</div>}
          {!p.title && !p.image && <div className="text-[11px] text-muted-foreground">{p.contentType || 'No preview'} · HTTP {p.status}</div>}
          {p.status >= 400 && <div className="text-[11px] text-amber-400">The site answered HTTP {p.status}</div>}
          {p.url !== url && <div className="text-[10px] text-muted-foreground/70 break-all">Redirects to {p.url}</div>}
        </div>
      ) : (
        <div className="h-16" />
      )}
    </div>
  )
}

export function ValueViewer({ column, type, value, pending, editable, onEdit, onClose }: {
  column: string | null
  type?: string
  value: unknown
  // The unsaved value, if the cell has one (null: set to NULL)
  pending?: string | null
  editable: boolean
  onEdit: (value: string | null | undefined) => void
  onClose: () => void
}) {
  const shown: unknown = pending !== undefined ? pending : value
  const bytes = toBytes(shown)
  const json = useMemo(() => bytes ? undefined : parseJson(shown, type), [shown, type, bytes])
  const [view, setView] = useState<'text' | 'json'>('text')
  const [wrap, setWrap] = useState(true)
  const [draft, setDraft] = useState(valueText(shown))
  const [dirty, setDirty] = useState(false)
  // A different cell (or a saved/reverted value): start over from it
  const shownKey = `${column}\u0000${valueText(shown)}\u0000${shown === null}`
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(valueText(shown)); setDirty(false)
    setView(json !== undefined ? 'json' : 'text')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey])

  const imgUrl = useMemo(() => {
    const kind = bytes && imageType(bytes)
    return kind ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: kind })) : null
  }, [bytes])
  useEffect(() => () => { if (imgUrl) URL.revokeObjectURL(imgUrl) }, [imgUrl])

  const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => toast.success('Copied value'))
  const link = linkIn(shown)
  const canEdit = editable && !bytes && column !== null

  return (
    <div className="flex flex-col h-full min-h-0 bg-card">
      <div className="flex items-center gap-2 px-3 h-8 border-b border-border shrink-0 text-xs">
        <span className="font-semibold text-foreground truncate font-mono">{column ?? 'Value'}</span>
        {type && <span className="text-[10px] text-muted-foreground uppercase shrink-0">{type}</span>}
        {pending !== undefined && <span className="text-[10px] px-1 rounded bg-amber-500/20 text-amber-300 shrink-0">unsaved</span>}
        <span className="ml-auto flex items-center gap-1 shrink-0">
          {json !== undefined && (
            <span className="flex rounded border border-border overflow-hidden">
              {(['json', 'text'] as const).map(v => (
                <button key={v} onClick={() => setView(v)} className={cn('px-1.5 h-5 text-[10px]', view === v ? 'bg-accent/40 text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                  {v === 'json' ? 'JSON' : 'Text'}
                </button>
              ))}
            </span>
          )}
          <button onClick={() => setWrap(w => !w)} title="Wrap long lines" className={cn('p-0.5 rounded hover:bg-accent/40', wrap ? 'text-foreground' : 'text-muted-foreground')}><WrapText className="h-3.5 w-3.5" /></button>
          <button onClick={() => copy(bytes ? hexDump(bytes, Infinity) : json !== undefined && view === 'json' ? JSON.stringify(json, null, 2) : valueText(shown))}
            title="Copy" disabled={column === null} className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 disabled:opacity-40"><Copy className="h-3.5 w-3.5" /></button>
          <button onClick={onClose} title="Close" className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40"><X className="h-3.5 w-3.5" /></button>
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-2">
        {column === null ? (
          <p className="text-[11px] text-muted-foreground p-2">Select a cell to see its value here.</p>
        ) : bytes ? (
          <div className="space-y-2">
            <p className="text-[11px] text-muted-foreground">Binary, {fmtSize(bytes.length)}{imgUrl ? ' (image)' : ''}</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {imgUrl && <img src={imgUrl} alt={column} className="max-w-full max-h-64 rounded border border-border bg-[repeating-conic-gradient(#8882_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]" />}
            <pre className="text-[10px] font-mono text-foreground whitespace-pre select-text">{hexDump(bytes)}</pre>
          </div>
        ) : shown === null || shown === undefined ? (
          canEdit
            ? <textarea value={draft} onChange={e => { setDraft(e.target.value); setDirty(true) }} placeholder="NULL"
                className="w-full h-full min-h-40 bg-background border border-border rounded p-2 text-xs font-mono text-foreground outline-none focus:ring-1 focus:ring-primary resize-none" />
            : <span className="text-xs italic text-muted-foreground">NULL</span>
        ) : link && !dirty ? (
          <>
            <LinkPreviewBox key={link} url={link} />
            {canEdit
              ? <textarea value={draft} onChange={e => { setDraft(e.target.value); setDirty(true) }} spellCheck={false} rows={3}
                  className="w-full bg-background border border-border rounded p-2 text-xs font-mono text-foreground outline-none focus:ring-1 focus:ring-primary resize-y" />
              : <pre className="text-xs font-mono text-foreground whitespace-pre-wrap break-all select-text">{link}</pre>}
          </>
        ) : view === 'json' && json !== undefined && !dirty ? (
          <pre className={cn('text-[11px] font-mono text-foreground select-text', wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre')}>
            <JsonTree value={json} />
          </pre>
        ) : canEdit ? (
          <textarea value={draft} onChange={e => { setDraft(e.target.value); setDirty(true) }} spellCheck={false}
            className={cn('w-full h-full min-h-40 bg-background border border-border rounded p-2 text-xs font-mono text-foreground outline-none focus:ring-1 focus:ring-primary resize-none', !wrap && 'whitespace-pre overflow-x-auto')}
            style={wrap ? undefined : { wordWrap: 'normal' }} />
        ) : (
          <pre className={cn('text-xs font-mono text-foreground select-text', wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre')}>{valueText(shown)}</pre>
        )}
      </div>

      {canEdit && (
        <div className="flex items-center gap-1.5 px-2 py-1.5 border-t border-border shrink-0">
          <button onClick={() => { onEdit(draft === valueText(value) && value !== null ? undefined : draft); setDirty(false) }} disabled={!dirty}
            className="px-2 h-5 rounded bg-primary text-primary-foreground text-[11px] font-medium hover:bg-primary/90 disabled:opacity-40">Apply</button>
          <button onClick={() => { onEdit(value === null ? undefined : null); setDirty(false) }} disabled={shown === null}
            className="px-2 h-5 rounded border border-border text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40">Set NULL</button>
          {pending !== undefined && (
            <button onClick={() => { onEdit(undefined); setDirty(false) }}
              className="px-2 h-5 rounded border border-border text-[11px] text-muted-foreground hover:text-foreground">Revert</button>
          )}
          <span className="ml-auto text-[10px] text-muted-foreground/60">{valueText(shown).length.toLocaleString()} chars</span>
        </div>
      )}
    </div>
  )
}

// Pretty-printed JSON with colors for keys, strings, numbers and literals
function JsonTree({ value, indent = 0 }: { value: unknown; indent?: number }): React.ReactElement {
  const pad = '  '.repeat(indent)
  if (value === null) return <span className="text-purple-300">null</span>
  if (typeof value === 'string') return <span className="text-green-300">{JSON.stringify(value)}</span>
  if (typeof value === 'number') return <span className="text-sky-300">{value}</span>
  if (typeof value === 'boolean') return <span className="text-purple-300">{String(value)}</span>
  if (Array.isArray(value)) {
    if (value.length === 0) return <>[]</>
    return <>[{'\n'}{value.map((v, i) => <React.Fragment key={i}>{pad}  <JsonTree value={v} indent={indent + 1} />{i < value.length - 1 ? ',' : ''}{'\n'}</React.Fragment>)}{pad}]</>
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return <>{'{}'}</>
    return <>{'{'}{'\n'}{entries.map(([k, v], i) => (
      <React.Fragment key={k}>{pad}  <span className="text-amber-200">{JSON.stringify(k)}</span>: <JsonTree value={v} indent={indent + 1} />{i < entries.length - 1 ? ',' : ''}{'\n'}</React.Fragment>
    ))}{pad}{'}'}</>
  }
  return <>{String(value)}</>
}
