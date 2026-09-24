'use client'

// Dialogs behind the sidebar's database menu (PostgreSQL): new / edit / delete database, new
// schema and extensions. They build SQL with lib/database-admin and run it through `run`.
import React, { useEffect, useMemo, useState } from 'react'
import { Loader2, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  COMMON_ENCODINGS, EXTENSIONS_SQL, ROLES_SQL, TEMPLATES_SQL, buildAlterDatabase, buildCreateDatabase, buildCreateSchema,
  buildDropExtension, buildInstallExtension, buildUpdateExtension, parseExtensions, type DatabaseSettings, type ExtensionInfo,
} from '@/lib/database-admin'

export type RunSql = (sql: string) => Promise<{ ok: boolean; rows?: Record<string, unknown>[]; error?: string }>

const inputCls = 'w-full bg-background border border-border rounded px-2 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary disabled:opacity-50'
const labelCls = 'block text-xs text-muted-foreground mb-1'
const buttonCls = 'px-3 py-1.5 text-xs rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20 transition-colors disabled:opacity-40'
const primaryCls = 'flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50'
const dangerCls = 'flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors disabled:opacity-50'

function Dialog({ title, subtitle, width = 'w-[440px]', onClose, children }: {
  title: string; subtitle?: string; width?: string; onClose: () => void; children: React.ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onMouseDown={onClose}>
      <div className={cn('bg-card border border-border rounded-lg shadow-xl max-h-[90vh] flex flex-col', width)} onMouseDown={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border shrink-0">
          <div className="min-w-0">
            <div className="text-sm font-semibold">{title}</div>
            {subtitle && <div className="text-xs text-muted-foreground truncate">{subtitle}</div>}
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors"><X className="h-4 w-4" /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

function ErrorBox({ error }: { error: string }) {
  return <div className="px-2 py-1.5 rounded border border-red-500/30 bg-red-950/60 text-[11px] text-red-300 whitespace-pre-wrap break-words">{error}</div>
}

function SqlPreview({ statements }: { statements: string[] }) {
  if (statements.length === 0) return <div className="text-[11px] text-muted-foreground/60 italic">No changes</div>
  return <pre className="px-2 py-1.5 rounded border border-border bg-background text-[11px] font-mono text-muted-foreground whitespace-pre-wrap break-all max-h-28 overflow-auto">{statements.map(s => s + ';').join('\n')}</pre>
}

// Rows of a lookup query, loaded once when the dialog opens
function useLookup(run: RunSql, sql: string, column: string): string[] {
  const [values, setValues] = useState<string[]>([])
  useEffect(() => {
    let cancelled = false
    run(sql).then(res => { if (!cancelled && res.ok) setValues((res.rows ?? []).map(r => String(r[column]))) }).catch(() => {})
    return () => { cancelled = true }
  }, [run, sql, column])
  return values
}

// ── New / Edit Database ──────────────────────────────────────────────────────

export function DatabaseDialog({ mode, initial, lockedName, run, onSubmit, onClose }: {
  mode: 'create' | 'edit'
  initial: DatabaseSettings
  // Why the name can't change (e.g. the connection itself uses this database)
  lockedName?: string
  run: RunSql
  onSubmit: (statements: string[], settings: DatabaseSettings) => Promise<void>
  onClose: () => void
}) {
  const [db, setDb] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const roles = useLookup(run, ROLES_SQL, 'rolname')
  const templates = useLookup(run, TEMPLATES_SQL, 'datname')
  const set = (patch: Partial<DatabaseSettings>) => { setDb(prev => ({ ...prev, ...patch })); setError('') }

  const { statements, invalid } = useMemo(() => {
    try {
      return { statements: mode === 'create' ? buildCreateDatabase(db) : buildAlterDatabase(initial, db), invalid: '' }
    } catch (err) {
      return { statements: [], invalid: err instanceof Error ? err.message : String(err) }
    }
  }, [db, initial, mode])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (invalid || statements.length === 0) return
    setBusy(true)
    try {
      await onSubmit(statements, db)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const ownerOptions = db.owner && !roles.includes(db.owner) ? [db.owner, ...roles] : roles
  return (
    <Dialog title={mode === 'create' ? 'New Database' : 'Edit Database'} subtitle={mode === 'edit' ? initial.name : undefined} onClose={onClose}>
      <form onSubmit={submit} className="px-5 py-4 space-y-3 overflow-y-auto">
        <div>
          <label className={labelCls}>Name</label>
          <input autoFocus={!lockedName} className={inputCls} value={db.name} disabled={!!lockedName} onChange={e => set({ name: e.target.value })} />
          {lockedName && <p className="text-[11px] text-muted-foreground/70 mt-1">{lockedName}</p>}
        </div>
        <div>
          <label className={labelCls}>Owner</label>
          <select className={inputCls} value={db.owner} onChange={e => set({ owner: e.target.value })}>
            {mode === 'create' && <option value="">(current user)</option>}
            {ownerOptions.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        {mode === 'create' ? (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Encoding</label>
              <select className={inputCls} value={db.encoding} onChange={e => set({ encoding: e.target.value })}>
                <option value="">(server default)</option>
                {COMMON_ENCODINGS.map(enc => <option key={enc} value={enc}>{enc}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Template</label>
              <select className={inputCls} value={db.template} onChange={e => set({ template: e.target.value })}>
                <option value="">(template1)</option>
                {templates.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
        ) : (
          <div>
            <label className={labelCls}>Encoding</label>
            <input className={inputCls} value={db.encoding} disabled />
          </div>
        )}
        {mode === 'create' && db.encoding && db.template !== 'template0' && (
          <p className="text-[11px] text-muted-foreground/70">A different encoding than the template&apos;s needs template0.</p>
        )}
        <div>
          <label className={labelCls}>Connection limit</label>
          <input
            type="number" min={-1} className={inputCls} value={db.connectionLimit}
            onChange={e => set({ connectionLimit: e.target.value === '' ? -1 : Math.max(-1, parseInt(e.target.value) || 0) })}
          />
          <p className="text-[11px] text-muted-foreground/70 mt-1">-1 means no limit</p>
        </div>
        <div>
          <label className={labelCls}>Comment</label>
          <textarea className={cn(inputCls, 'resize-none h-14')} value={db.comment} onChange={e => set({ comment: e.target.value })} />
        </div>
        <div>
          <label className={labelCls}>SQL</label>
          {invalid ? <div className="text-[11px] text-muted-foreground/60 italic">{invalid}</div> : <SqlPreview statements={statements} />}
        </div>
        {error && <ErrorBox error={error} />}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className={buttonCls}>Cancel</button>
          <button type="submit" disabled={busy || !!invalid || statements.length === 0} className={primaryCls}>
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
            {mode === 'create' ? 'Create' : 'Save'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

// ── Delete Database ──────────────────────────────────────────────────────────

export function DropDatabaseDialog({ name, openTabs, onDrop, onClose }: {
  name: string
  openTabs: number
  onDrop: (force: boolean) => Promise<void>
  onClose: () => void
}) {
  const [typed, setTyped] = useState('')
  const [force, setForce] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (typed !== name) return
    setBusy(true)
    setError('')
    try {
      await onDrop(force)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <Dialog title="Delete Database" subtitle={name} width="w-[400px]" onClose={onClose}>
      <form onSubmit={submit} className="px-5 py-4 space-y-3">
        <p className="text-sm text-muted-foreground">
          This permanently deletes the database <span className="font-mono text-foreground">{name}</span> and everything in it. This cannot be undone.
          {openTabs > 0 && ` Its ${openTabs} open tab${openTabs === 1 ? '' : 's'} for tables and functions will close.`}
        </p>
        <div>
          <label className={labelCls}>Type the database name to confirm</label>
          <input autoFocus className={inputCls} value={typed} onChange={e => setTyped(e.target.value)} placeholder={name} />
        </div>
        <label className="flex items-start gap-2 text-xs text-muted-foreground cursor-pointer select-none">
          <input type="checkbox" className="mt-0.5" checked={force} onChange={e => setForce(e.target.checked)} />
          <span>Disconnect other sessions using it (PostgreSQL 13+). Without this, the delete fails while anyone else is connected.</span>
        </label>
        {error && <ErrorBox error={error} />}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className={buttonCls}>Cancel</button>
          <button type="submit" disabled={busy || typed !== name} className={dangerCls}>
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
            Delete
          </button>
        </div>
      </form>
    </Dialog>
  )
}

// ── New Schema ───────────────────────────────────────────────────────────────

export function SchemaDialog({ database, run, onCreate, onClose }: {
  database: string
  run: RunSql
  onCreate: (sql: string) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [owner, setOwner] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const roles = useLookup(run, ROLES_SQL, 'rolname')
  const sql = name.trim() ? buildCreateSchema(name.trim(), owner) : ''

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!sql) return
    setBusy(true)
    setError('')
    try {
      await onCreate(sql)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <Dialog title="New Schema" subtitle={database} width="w-[380px]" onClose={onClose}>
      <form onSubmit={submit} className="px-5 py-4 space-y-3">
        <div>
          <label className={labelCls}>Name</label>
          <input autoFocus className={inputCls} value={name} onChange={e => { setName(e.target.value); setError('') }} />
        </div>
        <div>
          <label className={labelCls}>Owner</label>
          <select className={inputCls} value={owner} onChange={e => setOwner(e.target.value)}>
            <option value="">(current user)</option>
            {roles.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        {sql && <SqlPreview statements={[sql]} />}
        {error && <ErrorBox error={error} />}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className={buttonCls}>Cancel</button>
          <button type="submit" disabled={busy || !sql} className={primaryCls}>
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
            Create
          </button>
        </div>
      </form>
    </Dialog>
  )
}

// ── Manage Extensions ────────────────────────────────────────────────────────

export function ExtensionsDialog({ database, schemas, run, onChanged, onClose }: {
  database: string
  schemas: string[]
  run: RunSql
  onChanged: () => void   // an extension was installed/removed/updated (refresh the sidebar on close)
  onClose: () => void
}) {
  const [extensions, setExtensions] = useState<ExtensionInfo[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [filter, setFilter] = useState('')
  const [schema, setSchema] = useState(schemas.includes('public') ? 'public' : '')
  const [cascade, setCascade] = useState(false)
  const [busyName, setBusyName] = useState<string | null>(null)
  const [confirmDrop, setConfirmDrop] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let cancelled = false
    run(EXTENSIONS_SQL).then(res => {
      if (cancelled) return
      if (res.ok) setExtensions(parseExtensions(res.rows ?? []))
      else setLoadError(res.error ?? 'Could not list extensions')
    })
    return () => { cancelled = true }
  }, [run, reload])

  async function apply(name: string, sql: string) {
    setBusyName(name)
    setError('')
    setConfirmDrop(null)
    const res = await run(sql)
    setBusyName(null)
    if (!res.ok) { setError(res.error ?? 'Failed'); return }
    onChanged()
    setReload(n => n + 1)
  }

  const needle = filter.trim().toLowerCase()
  const shown = (extensions ?? []).filter(e => !needle || e.name.toLowerCase().includes(needle) || e.comment.toLowerCase().includes(needle))
  const installedCount = (extensions ?? []).filter(e => e.installedVersion).length

  return (
    <Dialog title="Manage Extensions" subtitle={database} width="w-[640px]" onClose={onClose}>
      <div className="px-5 pt-3 pb-2 space-y-2 shrink-0 border-b border-border">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
            <input autoFocus className={cn(inputCls, 'pl-7 py-1')} placeholder="Filter extensions" value={filter} onChange={e => setFilter(e.target.value)} />
          </div>
          <span className="text-[11px] text-muted-foreground shrink-0">{installedCount} installed</span>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <label className="flex items-center gap-1.5">
            Install into
            <select className="bg-background border border-border rounded px-1.5 py-0.5 text-xs text-foreground outline-none" value={schema} onChange={e => setSchema(e.target.value)}>
              <option value="">(extension default)</option>
              {schemas.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer select-none" title="Install: also install required extensions. Uninstall: also drop objects that use it.">
            <input type="checkbox" checked={cascade} onChange={e => setCascade(e.target.checked)} />
            Cascade
          </label>
        </div>
        {error && <ErrorBox error={error} />}
      </div>
      <div className="overflow-y-auto min-h-48 flex-1">
        {loadError ? (
          <div className="p-5"><ErrorBox error={loadError} /></div>
        ) : !extensions ? (
          <div className="flex items-center justify-center h-40 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /></div>
        ) : shown.length === 0 ? (
          <div className="p-5 text-xs text-muted-foreground italic">No extensions match</div>
        ) : (
          <table className="w-full text-xs">
            <tbody>
              {shown.map(ext => {
                const installed = ext.installedVersion !== null
                const updatable = installed && ext.installedVersion !== ext.defaultVersion
                const busy = busyName === ext.name
                return (
                  <tr key={ext.name} className="border-b border-border/50 hover:bg-accent/10 align-top">
                    <td className="px-5 py-1.5 w-full">
                      <div className="flex items-center gap-2">
                        <span className={cn('font-mono', installed ? 'text-foreground' : 'text-muted-foreground')}>{ext.name}</span>
                        <span className="text-[10px] text-muted-foreground/70">
                          {installed ? `${ext.installedVersion}${ext.schema ? ` · ${ext.schema}` : ''}` : ext.defaultVersion}
                        </span>
                        {installed && <span className="text-[9px] font-semibold px-1 rounded bg-green-500/15 text-green-400 leading-4">INSTALLED</span>}
                      </div>
                      {ext.comment && <div className="text-[11px] text-muted-foreground/70 leading-snug">{ext.comment}</div>}
                    </td>
                    <td className="pr-5 py-1.5 whitespace-nowrap text-right">
                      {busy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin inline text-muted-foreground" />
                      ) : !installed ? (
                        <button className={cn(buttonCls, 'py-0.5 px-2')} disabled={!!busyName} onClick={() => apply(ext.name, buildInstallExtension(ext.name, schema, cascade))}>Install</button>
                      ) : confirmDrop === ext.name ? (
                        <span className="inline-flex gap-1">
                          <button className={cn(buttonCls, 'py-0.5 px-2')} onClick={() => setConfirmDrop(null)}>Keep</button>
                          <button className={cn(dangerCls, 'py-0.5 px-2 inline-flex')} onClick={() => apply(ext.name, buildDropExtension(ext.name, cascade))}>
                            Uninstall{cascade ? ' (cascade)' : ''}
                          </button>
                        </span>
                      ) : (
                        <span className="inline-flex gap-1">
                          {updatable && (
                            <button className={cn(buttonCls, 'py-0.5 px-2')} disabled={!!busyName} onClick={() => apply(ext.name, buildUpdateExtension(ext.name))} title={`Update to ${ext.defaultVersion}`}>
                              Update
                            </button>
                          )}
                          {ext.name !== 'plpgsql' && (
                            <button className={cn(buttonCls, 'py-0.5 px-2 hover:text-destructive')} disabled={!!busyName} onClick={() => setConfirmDrop(ext.name)}>Uninstall</button>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
      <div className="flex justify-end px-5 py-3 border-t border-border shrink-0">
        <button onClick={onClose} className={buttonCls}>Close</button>
      </div>
    </Dialog>
  )
}
