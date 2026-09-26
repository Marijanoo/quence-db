'use client'

// The Redis key browser: find keys (SCAN by pattern and type), and view and edit a key's value
// whatever its type. Works on one logical database (db0, db1, …) of a connection.
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Clock, KeyRound, Loader2, Pencil, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { confirmAction } from '@/components/confirm-dialog'

type Key = { key: string; type: string; ttl: number }

const TYPES = ['string', 'hash', 'list', 'set', 'zset', 'stream'] as const
const TYPE_STYLE: Record<string, string> = {
  string: 'bg-sky-500/20 text-sky-300',
  hash: 'bg-violet-500/20 text-violet-300',
  list: 'bg-emerald-500/20 text-emerald-300',
  set: 'bg-amber-500/20 text-amber-300',
  zset: 'bg-rose-500/20 text-rose-300',
  stream: 'bg-teal-500/20 text-teal-300',
}
const input = 'bg-background border border-border rounded px-2 py-1 text-xs text-foreground outline-none focus:ring-1 focus:ring-primary'
const smallBtn = 'flex items-center gap-1 px-2 h-6 rounded border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-accent/20 transition-colors disabled:opacity-40'

export function formatTtl(ms: number): string {
  if (ms < 0) return 'no expiry'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
}

function TypeBadge({ type }: { type: string }) {
  return <span className={cn('shrink-0 text-[9px] font-semibold px-1 rounded leading-4 uppercase', TYPE_STYLE[type] ?? 'bg-muted text-muted-foreground')}>{type === 'ReJSON-RL' ? 'json' : type}</span>
}

const api = () => window.electronAPI!.redis

async function run<T extends { ok: boolean; error?: string }>(p: Promise<T>): Promise<T | null> {
  const res = await p
  if (!res.ok) { toast.error(res.error ?? 'Redis command failed'); return null }
  return res
}

export function RedisBrowser({ connectionId, db, label }: { connectionId: string; db: number; label: string }) {
  const [pattern, setPattern] = useState('*')
  const [typeFilter, setTypeFilter] = useState('')
  const [keys, setKeys] = useState<Key[]>([])
  const [cursor, setCursor] = useState<string | null>(null) // null: finished
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  // Scans until a page of keys has been found (a SCAN step can return few or none)
  const scan = useCallback(async (from: string, replace: boolean) => {
    setLoading(true)
    const found: Key[] = []
    let next = from
    try {
      do {
        const res = await run(api().scan(connectionId, db, { pattern: pattern || '*', cursor: next, count: 1000, type: typeFilter || undefined }))
        if (!res) break
        found.push(...(res.keys ?? []))
        next = res.cursor ?? '0'
      } while (next !== '0' && found.length < 200)
      setKeys(prev => {
        const merged = replace ? found : [...prev, ...found]
        const seen = new Set<string>()
        return merged.filter(k => !seen.has(k.key) && !!seen.add(k.key)).sort((a, b) => a.key.localeCompare(b.key))
      })
      setCursor(next === '0' ? null : next)
    } finally {
      setLoading(false)
    }
  }, [connectionId, db, pattern, typeFilter])

  // Scans again when the database or the type filter changes (the pattern waits for Enter)
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { void scan('0', true) }, [connectionId, db, typeFilter])

  const refreshList = () => void scan('0', true)

  return (
    <div className="flex h-full min-h-0">
      <div className="w-72 shrink-0 border-r border-border flex flex-col min-h-0">
        <div className="p-2 space-y-1.5 border-b border-border">
          <div className="flex items-center gap-1.5">
            <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <input value={pattern} onChange={e => setPattern(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') refreshList() }}
              placeholder="Pattern, e.g. user:*" className={cn(input, 'flex-1 font-mono')} />
          </div>
          <div className="flex items-center gap-1.5">
            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} className={cn(input, 'flex-1')}>
              <option value="">All types</option>
              {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <button onClick={refreshList} title="Search again" className={smallBtn}><RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} /></button>
            <button onClick={() => { setCreating(true); setSelected(null) }} title="New key" className={smallBtn}><Plus className="h-3 w-3" /> Key</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {keys.map(k => (
            <button key={k.key} onClick={() => { setSelected(k.key); setCreating(false) }}
              className={cn('w-full flex items-center gap-1.5 px-2 py-1 text-left text-xs border-b border-border/40', selected === k.key ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-accent/10 hover:text-foreground')}>
              <TypeBadge type={k.type} />
              <span className="truncate font-mono flex-1" title={k.key}>{k.key}</span>
              {k.ttl >= 0 && <span title={`Expires in ${formatTtl(k.ttl)}`}><Clock className="h-3 w-3 text-amber-400/80" /></span>}
            </button>
          ))}
          {!loading && keys.length === 0 && <p className="p-3 text-xs text-muted-foreground">No keys match.</p>}
          {cursor && (
            <button onClick={() => void scan(cursor, false)} disabled={loading} className="w-full py-1.5 text-xs text-primary hover:underline disabled:opacity-50">
              {loading ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
        <div className="px-2 py-1 border-t border-border text-[10px] text-muted-foreground">
          {keys.length.toLocaleString()} key{keys.length === 1 ? '' : 's'}{cursor ? ' so far' : ''} · {label} · db{db}
        </div>
      </div>
      <div className="flex-1 min-w-0 min-h-0">
        {creating ? (
          <NewKeyForm connectionId={connectionId} db={db} onCreated={key => { setCreating(false); refreshList(); setSelected(key) }} onCancel={() => setCreating(false)} />
        ) : selected ? (
          <KeyView key={selected} connectionId={connectionId} db={db} name={selected}
            onRenamed={key => { refreshList(); setSelected(key) }}
            onDeleted={() => { setSelected(null); refreshList() }} />
        ) : (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-muted-foreground">
            <KeyRound className="h-6 w-6 opacity-40" />
            <p className="text-xs">Select a key to see its value</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ── One key ───────────────────────────────────────────────────────────────────

function KeyView({ connectionId, db, name, onRenamed, onDeleted }: {
  connectionId: string; db: number; name: string; onRenamed: (key: string) => void; onDeleted: () => void
}) {
  const [value, setValue] = useState<RedisKeyValue | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [ttlInput, setTtlInput] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await api().get(connectionId, db, name)
    if (res.ok && res.value) { setValue(res.value); setError(null) } else { setError(res.error ?? 'Could not read the key'); setValue(null) }
  }, [connectionId, db, name])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])

  const edit = useCallback(async (e: Record<string, unknown>) => {
    const res = await run(api().edit(connectionId, db, { key: name, ...e }))
    if (res) await load()
    return !!res
  }, [connectionId, db, name, load])

  if (error) return <p className="p-4 text-xs text-destructive">{error}</p>
  if (!value) return <div className="p-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>

  const remove = async () => {
    if (!await confirmAction({ title: 'Delete key?', subtitle: name, danger: true, confirmLabel: 'Delete', message: `The ${value.type} and its ${value.size.toLocaleString()} item(s) are deleted.` })) return
    const res = await run(api().edit(connectionId, db, { op: 'delete', keys: [name] }))
    if (res) onDeleted()
  }
  const rename = async () => {
    if (!renaming || renaming === name) { setRenaming(null); return }
    const res = await run(api().edit(connectionId, db, { op: 'rename', key: name, newKey: renaming }))
    if (res) { setRenaming(null); onRenamed(renaming) }
  }
  const setTtl = async () => {
    const text = (ttlInput ?? '').trim()
    const seconds = text === '' ? null : Number(text)
    if (seconds !== null && (!Number.isFinite(seconds) || seconds <= 0)) { toast.error('Enter a number of seconds, or leave it empty for no expiry'); return }
    if (await edit({ op: 'expire', seconds })) setTtlInput(null)
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 h-10 border-b border-border shrink-0">
        <TypeBadge type={value.type} />
        {renaming !== null ? (
          <>
            <input autoFocus value={renaming} onChange={e => setRenaming(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void rename(); if (e.key === 'Escape') setRenaming(null) }}
              className={cn(input, 'flex-1 font-mono')} />
            <button onClick={() => void rename()} className={smallBtn}><Check className="h-3 w-3" /></button>
            <button onClick={() => setRenaming(null)} className={smallBtn}><X className="h-3 w-3" /></button>
          </>
        ) : (
          <>
            <span className="font-mono text-sm truncate flex-1" title={name}>{name}</span>
            <button onClick={() => setRenaming(name)} title="Rename" className={smallBtn}><Pencil className="h-3 w-3" /></button>
          </>
        )}
        <span className="text-[11px] text-muted-foreground shrink-0">{value.size.toLocaleString()} {value.type === 'string' ? 'bytes' : 'items'}</span>
        {ttlInput !== null ? (
          <span className="flex items-center gap-1 shrink-0">
            <input autoFocus value={ttlInput} onChange={e => setTtlInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void setTtl(); if (e.key === 'Escape') setTtlInput(null) }}
              placeholder="seconds" className={cn(input, 'w-20')} />
            <button onClick={() => void setTtl()} className={smallBtn}><Check className="h-3 w-3" /></button>
          </span>
        ) : (
          <button onClick={() => setTtlInput(value.ttl >= 0 ? String(Math.round(value.ttl / 1000)) : '')} title="Set expiry (empty: none)" className={smallBtn}>
            <Clock className="h-3 w-3" /> {formatTtl(value.ttl)}
          </button>
        )}
        <button onClick={() => void load()} title="Reload" className={smallBtn}><RefreshCw className="h-3 w-3" /></button>
        <button onClick={() => void remove()} title="Delete key" className={cn(smallBtn, 'hover:text-destructive')}><Trash2 className="h-3 w-3" /></button>
      </div>
      {value.truncated && (
        <div className="px-3 py-1 text-[11px] text-amber-300 bg-amber-500/10 border-b border-amber-500/30 shrink-0">
          Showing part of this {value.type} ({value.type === 'string' ? `first ${(256).toLocaleString()} KB` : `first ${(value.fields ?? value.items ?? value.members ?? value.entries ?? []).length.toLocaleString()} of ${value.size.toLocaleString()}`}). Use the console for the rest.
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto">
        {value.type === 'string' || value.type === 'ReJSON-RL' ? <StringEditor key={value.value} value={value} onSave={v => edit({ op: 'setString', value: v })} readOnly={value.truncated || value.type === 'ReJSON-RL'} />
          : value.type === 'hash' ? <PairTable
              rows={(value.fields ?? []).map(f => ({ id: f.field, a: f.field, b: f.value }))} labels={['Field', 'Value']}
              onSave={(row, b) => edit({ op: 'hashSet', field: row.a, value: b })}
              onAdd={(a, b) => edit({ op: 'hashSet', field: a, value: b })}
              onRemove={row => edit({ op: 'hashDelete', field: row.a })} />
          : value.type === 'list' ? <PairTable
              rows={(value.items ?? []).map(i => ({ id: String(i.index), a: String(i.index), b: i.value }))} labels={['Index', 'Value']} fixedA
              onSave={(row, b) => edit({ op: 'listSet', index: Number(row.a), value: b })}
              onAdd={(_a, b, end) => edit({ op: 'listPush', value: b, end: end ?? 'tail' })} listEnds
              onRemove={row => edit({ op: 'listRemove', index: Number(row.a) })} />
          : value.type === 'set' ? <PairTable
              rows={(value.members as string[] ?? []).map(m => ({ id: m, a: m, b: '' }))} labels={['Member']} single
              onAdd={a => edit({ op: 'setAdd', member: a })}
              onRemove={row => edit({ op: 'setRemove', member: row.a })} />
          : value.type === 'zset' ? <PairTable
              rows={((value.members ?? []) as { member: string; score: string }[]).map(m => ({ id: m.member, a: m.member, b: m.score }))} labels={['Member', 'Score']}
              onSave={(row, b) => zscore(b, s => edit({ op: 'zsetAdd', member: row.a, score: s }))}
              onAdd={(a, b) => zscore(b, s => edit({ op: 'zsetAdd', member: a, score: s }))}
              onRemove={row => edit({ op: 'zsetRemove', member: row.a })} />
          : value.type === 'stream' ? <StreamView value={value}
              onAdd={fields => edit({ op: 'streamAdd', fields })}
              onRemove={entryId => edit({ op: 'streamDelete', id: entryId })} />
          : <p className="p-4 text-xs text-muted-foreground">Values of type {value.type} can be read with the console.</p>}
      </div>
    </div>
  )
}

function zscore(text: string, then: (score: number) => Promise<boolean>): Promise<boolean> {
  const score = Number(text)
  if (text.trim() === '' || !Number.isFinite(score)) { toast.error('The score must be a number'); return Promise.resolve(false) }
  return then(score)
}

function StringEditor({ value, onSave, readOnly }: { value: RedisKeyValue; onSave: (v: string) => Promise<boolean>; readOnly: boolean }) {
  const original = value.value ?? ''
  // A new value remounts the editor (see the key where it's used), so this starts from it
  const [text, setText] = useState(original)
  const json = useMemo(() => { try { const v = JSON.parse(original); return typeof v === 'object' && v !== null ? v : null } catch { return null } }, [original])
  return (
    <div className="flex flex-col h-full p-3 gap-2">
      <textarea value={text} onChange={e => setText(e.target.value)} readOnly={readOnly} spellCheck={false}
        className={cn(input, 'flex-1 font-mono resize-none min-h-40')} />
      <div className="flex items-center gap-2">
        {json && <button onClick={() => setText(JSON.stringify(json, null, 2))} className={smallBtn}>Format JSON</button>}
        <div className="flex-1" />
        {!readOnly && (
          <>
            <button onClick={() => setText(original)} disabled={text === original} className={smallBtn}>Revert</button>
            <button onClick={() => void onSave(text)} disabled={text === original}
              className="px-3 h-6 rounded bg-primary text-primary-foreground text-xs hover:bg-primary/90 disabled:opacity-40">Save</button>
          </>
        )}
      </div>
    </div>
  )
}

type PairRow = { id: string; a: string; b: string }

// A two-column (or one-column) editable list: hash fields, list items, set members, sorted-set scores
function PairTable({ rows, labels, fixedA, single, listEnds, onSave, onAdd, onRemove }: {
  rows: PairRow[]
  labels: string[]
  fixedA?: boolean      // the first column can't be typed (list indexes)
  single?: boolean      // one column (set members)
  listEnds?: boolean    // adding goes to the head or tail (lists)
  onSave?: (row: PairRow, b: string) => Promise<boolean>
  onAdd: (a: string, b: string, end?: 'head' | 'tail') => Promise<boolean>
  onRemove: (row: PairRow) => Promise<boolean>
}) {
  const [editing, setEditing] = useState<{ id: string; b: string } | null>(null)
  const [newA, setNewA] = useState('')
  const [newB, setNewB] = useState('')
  const add = async (end?: 'head' | 'tail') => {
    if (!listEnds && !newA) { toast.error(`${labels[0]} is empty`); return }
    if (await onAdd(newA, newB, end)) { setNewA(''); setNewB('') }
  }
  return (
    <table className="w-full text-xs">
      <thead className="sticky top-0 bg-card">
        <tr className="text-left text-muted-foreground border-b border-border">
          {labels.map(l => <th key={l} className="px-3 py-1.5 font-medium">{l}</th>)}
          <th className="w-16" />
        </tr>
      </thead>
      <tbody>
        {rows.map(row => (
          <tr key={row.id} className="border-b border-border/40 group">
            <td className={cn('px-3 py-1 font-mono align-top', fixedA ? 'text-muted-foreground w-16' : 'break-all')}>{row.a}</td>
            {!single && (
              <td className="px-3 py-1 font-mono break-all">
                {editing?.id === row.id ? (
                  <input autoFocus value={editing.b} onChange={e => setEditing({ id: row.id, b: e.target.value })}
                    onKeyDown={async e => {
                      if (e.key === 'Escape') setEditing(null)
                      if (e.key === 'Enter' && onSave && await onSave(row, editing.b)) setEditing(null)
                    }}
                    onBlur={() => setEditing(null)}
                    className={cn(input, 'w-full font-mono')} />
                ) : (
                  <span onDoubleClick={() => onSave && setEditing({ id: row.id, b: row.b })} className={onSave ? 'cursor-text' : undefined} title={onSave ? 'Double-click to edit' : undefined}>
                    {row.b}
                  </span>
                )}
              </td>
            )}
            <td className="px-2 text-right">
              <button onClick={() => void onRemove(row)} title="Remove" className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive">
                <Trash2 className="h-3 w-3" />
              </button>
            </td>
          </tr>
        ))}
        <tr>
          <td className="px-3 py-1.5">
            {listEnds ? <span className="text-muted-foreground">new</span> : <input value={newA} onChange={e => setNewA(e.target.value)} placeholder={labels[0]} className={cn(input, 'w-full font-mono')} />}
          </td>
          {!single && (
            <td className="px-3 py-1.5">
              <input value={newB} onChange={e => setNewB(e.target.value)} placeholder={labels[1]} className={cn(input, 'w-full font-mono')}
                onKeyDown={e => { if (e.key === 'Enter' && !listEnds) void add() }} />
            </td>
          )}
          <td className="px-2 py-1.5 whitespace-nowrap text-right">
            {listEnds ? (
              <span className="flex gap-1 justify-end">
                <button onClick={() => void add('head')} className={smallBtn} title="Add at the start">Head</button>
                <button onClick={() => void add('tail')} className={smallBtn} title="Add at the end">Tail</button>
              </span>
            ) : (
              <button onClick={() => void add()} className={smallBtn}><Plus className="h-3 w-3" /></button>
            )}
          </td>
        </tr>
      </tbody>
    </table>
  )
}

function StreamView({ value, onAdd, onRemove }: { value: RedisKeyValue; onAdd: (fields: Record<string, string>) => Promise<boolean>; onRemove: (id: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState('{\n  "field": "value"\n}')
  const add = async () => {
    let fields: Record<string, string>
    try {
      const parsed = JSON.parse(draft)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
      fields = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]))
    } catch { toast.error('Write the entry as a JSON object of fields'); return }
    await onAdd(fields)
  }
  return (
    <div className="p-3 space-y-3">
      <div className="space-y-1.5">
        <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={3} spellCheck={false} className={cn(input, 'w-full font-mono')} />
        <button onClick={() => void add()} className={smallBtn}><Plus className="h-3 w-3" /> Add entry</button>
      </div>
      <p className="text-[11px] text-muted-foreground">Newest first</p>
      {(value.entries ?? []).map(e => (
        <div key={e.id} className="border border-border rounded p-2 group">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono text-[11px] text-muted-foreground">{e.id}</span>
            <div className="flex-1" />
            <button onClick={() => void onRemove(e.id)} className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"><Trash2 className="h-3 w-3" /></button>
          </div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 text-xs font-mono">
            {Object.entries(e.fields).map(([k, v]) => <React.Fragment key={k}><span className="text-muted-foreground">{k}</span><span className="break-all">{v}</span></React.Fragment>)}
          </div>
        </div>
      ))}
    </div>
  )
}

function NewKeyForm({ connectionId, db, onCreated, onCancel }: { connectionId: string; db: number; onCreated: (key: string) => void; onCancel: () => void }) {
  const [type, setType] = useState<typeof TYPES[number]>('string')
  const [key, setKey] = useState('')
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [ttl, setTtl] = useState('')

  const create = async () => {
    if (!key) { toast.error('Name the key'); return }
    const exists = await api().command(connectionId, db, `EXISTS ${JSON.stringify(key)}`)
    if (exists.ok && Number(exists.reply) > 0) { toast.error('A key with that name already exists'); return }
    const edit = type === 'string' ? { op: 'setString', value: a }
      : type === 'hash' ? { op: 'hashSet', field: a, value: b }
      : type === 'list' ? { op: 'listPush', value: a, end: 'tail' }
      : type === 'set' ? { op: 'setAdd', member: a }
      : type === 'zset' ? { op: 'zsetAdd', member: a, score: Number(b) || 0 }
      : { op: 'streamAdd', fields: { [a || 'field']: b } }
    if ((type === 'hash' || type === 'set' || type === 'zset') && !a) { toast.error('The first entry needs a name'); return }
    if (!await run(api().edit(connectionId, db, { key, ...edit }))) return
    const seconds = Number(ttl)
    if (ttl.trim() && seconds > 0) await run(api().edit(connectionId, db, { op: 'expire', key, seconds }))
    onCreated(key)
  }

  const [la, lb] = type === 'string' ? ['Value'] : type === 'hash' ? ['Field', 'Value'] : type === 'list' ? ['First item'] : type === 'set' ? ['First member'] : type === 'zset' ? ['First member', 'Score'] : ['Field', 'Value']
  return (
    <div className="p-4 space-y-3 max-w-lg">
      <div className="text-sm font-semibold">New key</div>
      <div className="flex gap-2">
        <select value={type} onChange={e => setType(e.target.value as typeof TYPES[number])} className={input}>
          {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <input autoFocus value={key} onChange={e => setKey(e.target.value)} placeholder="Key name" className={cn(input, 'flex-1 font-mono')} />
      </div>
      {type === 'string'
        ? <textarea value={a} onChange={e => setA(e.target.value)} placeholder="Value" rows={4} className={cn(input, 'w-full font-mono')} />
        : (
          <div className="flex gap-2">
            <input value={a} onChange={e => setA(e.target.value)} placeholder={la} className={cn(input, 'flex-1 font-mono')} />
            {lb && <input value={b} onChange={e => setB(e.target.value)} placeholder={lb} className={cn(input, 'flex-1 font-mono')} />}
          </div>
        )}
      <input value={ttl} onChange={e => setTtl(e.target.value)} placeholder="Expire after (seconds, optional)" className={cn(input, 'w-full')} />
      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className={smallBtn}>Cancel</button>
        <button onClick={() => void create()} className="px-3 h-6 rounded bg-primary text-primary-foreground text-xs hover:bg-primary/90">Create</button>
      </div>
    </div>
  )
}
