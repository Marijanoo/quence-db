'use client'

// MCP server settings: turn the local server on, choose which connections Claude (or another MCP
// client) may read, copy the setup for the client, and watch the calls it makes.
import React, { useCallback, useEffect, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Copy, Eye, EyeOff, RefreshCw, X } from 'lucide-react'
import { toast } from 'sonner'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { DATA_TOOLS, DATA_TOOL_LABELS, dataToolEnabled, type DataTool } from '@/lib/mcp-data-tools'

type LogEntry = Awaited<ReturnType<NonNullable<NonNullable<Window['electronAPI']>['mcp']>['log']>>[number]

const TYPE_BADGE: Record<string, { label: string; cls: string }> = {
  pg: { label: 'PgSQL', cls: 'bg-blue-500/20 text-blue-400' },
  mysql: { label: 'MySQL', cls: 'bg-orange-500/20 text-orange-400' },
  mongodb: { label: 'Mongo', cls: 'bg-emerald-500/20 text-emerald-400' },
}

function CopyBlock({ label, value, secret }: { label: string; value: string; secret?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }, () => toast.error('Could not copy to the clipboard'))
  }
  // The token is shown masked; the copied text has it in full
  const shown = secret ? value.split(secret).join('••••••••') : value
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">{label}</span>
        <button onClick={copy} className="flex items-center gap-1 text-[11px] text-primary hover:underline">
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}{copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="text-[10px] font-mono bg-background border border-border rounded px-2 py-1.5 whitespace-pre-wrap break-all text-muted-foreground max-h-40 overflow-y-auto">{shown}</pre>
    </div>
  )
}

export function McpPanel({ open, onClose, onStatus }: { open: boolean; onClose: () => void; onStatus?: (s: McpServerStatus) => void }) {
  const [status, setStatus] = useState<McpServerStatus | null>(null)
  const [log, setLog] = useState<LogEntry[]>([])
  const [portText, setPortText] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [expandedConns, setExpandedConns] = useState<Set<string>>(new Set())
  const api = typeof window !== 'undefined' ? window.electronAPI?.mcp : undefined

  const apply = useCallback((s: McpServerStatus) => {
    setStatus(s)
    setPortText(String(s.port))
    onStatus?.(s)
  }, [onStatus])

  // Refresh while open: connection states and the call log change underneath
  useEffect(() => {
    if (!open || !api) return
    let stale = false
    // A failed poll keeps the last state; the next one tries again
    const tick = () => {
      api.status().then(s => { if (!stale) { setStatus(s); onStatus?.(s) } }, () => {})
      api.log().then(l => { if (!stale) setLog(l) }, () => {})
    }
    api.status().then(s => { if (!stale) apply(s) }, () => {})
    api.log().then(l => { if (!stale) setLog(l) }, () => {})
    const timer = setInterval(tick, 2000)
    return () => { stale = true; clearInterval(timer) }
  }, [open, api, apply, onStatus])

  if (!open) return null

  const update = (patch: { enabled?: boolean; port?: number; sharedConnectionIds?: string[]; writeMode?: 'off' | 'ask' | 'allow' }) => { void api?.update(patch).then(apply) }
  const shared = new Set(status?.sharedConnectionIds ?? [])
  const toggleShared = (id: string) => {
    const next = new Set(shared)
    if (next.has(id)) next.delete(id); else next.add(id)
    update({ sharedConnectionIds: [...next] })
  }
  const sharedConns = (status?.connections ?? []).filter(c => shared.has(c.id))
  // enabled: null resets a per-connection override back to following the global switch
  const setDataTool = (tool: DataTool, connectionId: string | undefined, enabled: boolean | null) => {
    void api?.setDataTool({ tool, connectionId, enabled }).then(apply)
  }
  const commitPort = () => {
    const port = Number(portText)
    if (!status || port === status.port) return
    if (!Number.isInteger(port) || port < 1024 || port > 65535) { toast.error('Choose a port between 1024 and 65535'); setPortText(String(status.port)); return }
    update({ port })
  }

  const token = status?.token ?? ''
  const url = status?.url ?? ''
  const claudeCode = `claude mcp add --transport http quence-db ${url} --header "Authorization: Bearer ${token}"`
  const clientJson = JSON.stringify({ mcpServers: { 'quence-db': { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)
  const desktopJson = JSON.stringify({
    mcpServers: { 'quence-db': { command: 'npx', args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${QUENCE_AUTH}'], env: { QUENCE_AUTH: `Bearer ${token}` } } },
  }, null, 2)

  return (
    <div className="w-80 bg-card border-l border-border flex flex-col h-full shrink-0">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <span className="text-sm font-medium">MCP Server</span>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-0.5 rounded hover:bg-accent/20 transition-colors">
          <X className="h-4 w-4" />
        </button>
      </div>

      {!api ? (
        <p className="p-4 text-xs text-muted-foreground">Restart QuenceDB to use the MCP server (the app was updated while running).</p>
      ) : !status ? null : (
        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-foreground">Local MCP server</span>
              <Switch checked={status.enabled} onCheckedChange={v => update({ enabled: v })} />
            </div>
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', status.running ? 'bg-green-500' : status.error ? 'bg-destructive' : 'bg-muted-foreground/40')} />
              <span className={cn('break-all', status.error ? 'text-destructive' : 'text-muted-foreground')}>
                {status.error ?? (status.running ? `Running at ${status.url}` : 'Off')}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground/70">
              Lets Claude and other MCP clients work with the connections you share below: read and query them, and drive
              this window (open tables and queries, page, sort, point at cells). It only listens on this computer, and only
              while QuenceDB is open.
            </p>
          </section>

          <section className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Changing data</p>
            <div className="space-y-1.5">
              {([
                ['off', 'Off', 'Read only. Clients can look, not change.'],
                ['ask', 'Ask every time', 'Edits, inserts, deletes and SQL wait for your Allow in a dialog here, showing exactly what will change.'],
                ['allow', 'Allow without asking', 'Changes run right away. Only for databases you can afford to lose data in.'],
              ] as const).map(([mode, label, hint]) => (
                <label key={mode} className="flex items-start gap-2 text-xs cursor-pointer select-none">
                  <input type="radio" className="mt-0.5" checked={status.writeMode === mode} onChange={() => update({ writeMode: mode })} />
                  <span>
                    <span className={cn('text-foreground', mode === 'allow' && status.writeMode === 'allow' && 'text-amber-400')}>{label}</span>
                    <span className="block text-[11px] text-muted-foreground/70">{hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Access</p>
            <label className="flex items-center justify-between text-xs text-muted-foreground">Port
              <input value={portText} onChange={e => setPortText(e.target.value.replace(/\D/g, ''))} onBlur={commitPort}
                onKeyDown={e => { if (e.key === 'Enter') commitPort() }}
                className="w-20 bg-background border border-border rounded px-2 py-0.5 text-xs text-foreground font-mono outline-none focus:ring-1 focus:ring-primary" />
            </label>
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Access token</span>
                <span className="flex items-center gap-2">
                  <button onClick={() => setShowToken(v => !v)} title={showToken ? 'Hide' : 'Show'} className="hover:text-foreground">
                    {showToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                  <button title="New token (clients using the old one stop working)"
                    onClick={() => { if (window.confirm('Create a new token? MCP clients set up with the current one will need the new one.')) void api.newToken().then(apply) }}
                    className="hover:text-foreground"><RefreshCw className="h-3.5 w-3.5" /></button>
                </span>
              </div>
              <div className="text-[10px] font-mono bg-background border border-border rounded px-2 py-1 break-all text-muted-foreground">
                {showToken ? token : '•'.repeat(24)}
              </div>
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Shared connections</p>
              {status.connections.length > 1 && (
                <span className="flex gap-2 text-[11px]">
                  <button className="text-primary hover:underline" onClick={() => update({ sharedConnectionIds: status.connections.map(c => c.id) })}>All</button>
                  <button className="text-primary hover:underline" onClick={() => update({ sharedConnectionIds: [] })}>None</button>
                </span>
              )}
            </div>
            {status.connections.length === 0 ? (
              <p className="text-[11px] text-muted-foreground/70">No saved connections yet.</p>
            ) : (
              <div className="border border-border rounded divide-y divide-border/50">
                {status.connections.map(c => (
                  <label key={c.id} className="flex items-center gap-2 px-2 py-1 text-xs cursor-pointer select-none">
                    <input type="checkbox" checked={shared.has(c.id)} onChange={() => toggleShared(c.id)} />
                    <span className="truncate flex-1">{c.name}</span>
                    <span className={cn('shrink-0 text-[9px] font-semibold px-1 rounded leading-4', TYPE_BADGE[c.dbType]?.cls)}>{TYPE_BADGE[c.dbType]?.label}</span>
                    <span title={c.connected ? 'Connected' : 'Not connected: tools will ask you to connect it'}
                      className={cn('h-1.5 w-1.5 rounded-full shrink-0', c.connected ? 'bg-green-500' : 'bg-muted-foreground/40')} />
                  </label>
                ))}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground/70">
              Claude sees connection names only, never hosts or passwords, and only the tabs of shared connections.
              With changing data off, queries run read-only; for a hard guarantee, connect with a database user that can only read.
            </p>
          </section>

          <section className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Data tools</p>
            <p className="text-[11px] text-muted-foreground/70">
              Turn off the tools that read or write row data. Everything else (opening tables, paging, sorting, …) stays on.
            </p>
            <div className="border border-border rounded divide-y divide-border/50">
              {DATA_TOOLS.map(t => (
                <label key={t} className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs cursor-pointer select-none">
                  <span>
                    <span className="text-foreground">{DATA_TOOL_LABELS[t]}</span>
                    <span className="block text-[10px] font-mono text-muted-foreground/60">{t}</span>
                  </span>
                  <Switch checked={status.dataTools.global[t]} onCheckedChange={v => setDataTool(t, undefined, v)} />
                </label>
              ))}
            </div>

            {sharedConns.length > 0 && (
              <div className="space-y-1 pt-1">
                <p className="text-[11px] text-muted-foreground/70">Per-connection overrides win over the switches above.</p>
                <div className="border border-border rounded divide-y divide-border/50">
                  {sharedConns.map(c => {
                    const overrides = status.dataTools.perConnection[c.id] ?? {}
                    const overrideCount = Object.keys(overrides).length
                    const expanded = expandedConns.has(c.id)
                    return (
                      <div key={c.id}>
                        <button
                          onClick={() => setExpandedConns(prev => { const next = new Set(prev); if (next.has(c.id)) next.delete(c.id); else next.add(c.id); return next })}
                          className="w-full flex items-center gap-1.5 px-2 py-1 text-xs text-left hover:bg-accent/20 transition-colors"
                        >
                          {expanded ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />}
                          <span className="truncate flex-1">{c.name}</span>
                          {overrideCount > 0 && <span className="shrink-0 text-[10px] text-amber-400">{overrideCount} override{overrideCount === 1 ? '' : 's'}</span>}
                          <span className={cn('shrink-0 text-[9px] font-semibold px-1 rounded leading-4', TYPE_BADGE[c.dbType]?.cls)}>{TYPE_BADGE[c.dbType]?.label}</span>
                        </button>
                        {expanded && (
                          <div className="pb-1.5 pl-6 pr-2 space-y-1">
                            {DATA_TOOLS.map(t => {
                              const override = overrides[t]
                              const effective = dataToolEnabled(status.dataTools, t, c.id)
                              return (
                                <div key={t} className="flex items-center justify-between gap-2 text-[11px] py-0.5">
                                  <span className={cn(override === undefined ? 'text-muted-foreground' : 'text-foreground')}>{DATA_TOOL_LABELS[t]}</span>
                                  <span className="flex items-center gap-2 shrink-0">
                                    {override !== undefined && (
                                      <button className="text-primary hover:underline text-[10px]" onClick={() => setDataTool(t, c.id, null)}>Reset</button>
                                    )}
                                    <Switch checked={effective} onCheckedChange={v => setDataTool(t, c.id, v)} />
                                  </span>
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </section>

          <section className="space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Set up a client</p>
            <CopyBlock label="Claude Code (run in a terminal)" value={claudeCode} secret={showToken ? undefined : token} />
            <CopyBlock label="Claude Desktop (claude_desktop_config.json, via the mcp-remote bridge; needs Node.js)" value={desktopJson} secret={showToken ? undefined : token} />
            <CopyBlock label="Other clients that support Streamable HTTP" value={clientJson} secret={showToken ? undefined : token} />
            <p className="text-[11px] text-muted-foreground/70">The token is in these snippets in full when copied. Keep it private.</p>
          </section>

          <section className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Recent calls</p>
            {log.length === 0 ? (
              <p className="text-[11px] text-muted-foreground/70">No calls yet.</p>
            ) : (
              <div className="space-y-1">
                {log.slice(0, 50).map((e, i) => (
                  <div key={`${e.at}-${i}`} className="text-[11px] border border-border/60 rounded px-2 py-1">
                    <div className="flex items-center gap-1.5">
                      <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', e.ok ? 'bg-green-500' : 'bg-destructive')} />
                      <span className="font-mono text-foreground">{e.tool}</span>
                      {e.connection && <span className="text-muted-foreground truncate">· {e.connection}</span>}
                      <span className="ml-auto text-muted-foreground/60 shrink-0">{new Date(e.at).toLocaleTimeString()} · {e.ms}ms</span>
                    </div>
                    {e.detail && <div className="font-mono text-muted-foreground/80 truncate mt-0.5" title={e.detail}>{e.detail}</div>}
                    {e.error && <div className="text-destructive/90 mt-0.5 break-words">{e.error}</div>}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
