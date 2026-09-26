'use client'

// A redis-cli style console for one database of a Redis connection
import React, { useEffect, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { confirmAction } from '@/components/confirm-dialog'

// Replies written the way redis-cli shows them
export function formatReply(reply: unknown, indent = ''): string {
  if (reply === null || reply === undefined) return '(nil)'
  if (typeof reply === 'number') return `(integer) ${reply}`
  if (typeof reply === 'string') return JSON.stringify(reply)
  if (Array.isArray(reply)) {
    if (reply.length === 0) return '(empty array)'
    const width = String(reply.length).length
    return reply.map((item, i) => {
      const prefix = `${String(i + 1).padStart(width)}) `
      const body = formatReply(item, indent + ' '.repeat(prefix.length))
      return (i === 0 ? '' : indent) + prefix + body
    }).join('\n')
  }
  return String(reply)
}

// Commands that change data (asked about on connections with Safe Run on)
const WRITES = /^(set|setnx|setex|psetex|mset|msetnx|getset|getdel|getex|append|incr\w*|decr\w*|del|unlink|rename\w*|expire\w*|pexpire\w*|persist|h(set|setnx|mset|del|incr\w*)|[lr](push|pushx|pop|set|rem|trim|insert|move)|lmove|blmove|rpoplpush|s(add|rem|pop|move|\w+store)|z(add|rem\w*|incrby|pop\w*|\w+store|rangestore)|x(add|del|trim|group|ack|claim|autoclaim)|flushdb|flushall|copy|move|restore|json\.\w+|eval\w*|fcall\w*|script)$/i

type Entry = { command: string; output: string; error?: boolean; ms?: number }

export function RedisConsole({ connectionId, db, label, safe }: { connectionId: string; db: number; label: string; safe: boolean }) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [line, setLine] = useState('')
  const [busy, setBusy] = useState(false)
  const history = useRef<string[]>([])
  const historyPos = useRef(-1)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }) }, [entries])

  const submit = async () => {
    const command = line.trim()
    if (!command || busy) return
    history.current = [command, ...history.current.filter(h => h !== command)].slice(0, 200)
    historyPos.current = -1
    setLine('')
    if (safe && WRITES.test(command.split(/\s+/)[0]) && !await confirmAction({
      title: 'Run this command?', subtitle: `${label} · db${db}`, danger: true, confirmLabel: 'Run',
      message: 'This connection uses Safe Run, and this command changes data. Redis can’t undo it.',
      details: command,
    })) return
    setBusy(true)
    const res = await window.electronAPI!.redis.command(connectionId, db, command)
    setBusy(false)
    setEntries(prev => [...prev, res.ok
      ? { command, output: formatReply(res.reply), ms: res.ms }
      : { command, output: `(error) ${res.error}`, error: true }])
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); void submit(); return }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const h = history.current
      const pos = Math.max(-1, Math.min(h.length - 1, historyPos.current + (e.key === 'ArrowUp' ? 1 : -1)))
      historyPos.current = pos
      setLine(pos < 0 ? '' : h[pos])
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0 font-mono text-xs">
      <div className="flex items-center gap-2 px-3 h-8 border-b border-border shrink-0 font-sans">
        <span className="text-muted-foreground">{label} · db{db}</span>
        <div className="flex-1" />
        <button onClick={() => setEntries([])} title="Clear" className="text-muted-foreground hover:text-foreground"><Trash2 className="h-3.5 w-3.5" /></button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-2">
        {entries.length === 0 && <p className="text-muted-foreground font-sans">Type a Redis command, e.g. <span className="font-mono">GET mykey</span> or <span className="font-mono">HGETALL user:1</span>. Up/Down browse the history.</p>}
        {entries.map((e, i) => (
          <div key={i}>
            <div className="text-muted-foreground"><span className="text-primary">db{db}&gt;</span> {e.command}{e.ms !== undefined && <span className="ml-2 text-[10px] opacity-60">{e.ms}ms</span>}</div>
            <pre className={cn('whitespace-pre-wrap break-all', e.error ? 'text-destructive' : 'text-foreground')}>{e.output}</pre>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <div className="flex items-center gap-2 px-3 h-9 border-t border-border shrink-0">
        <span className="text-primary">db{db}&gt;</span>
        <input autoFocus value={line} onChange={e => setLine(e.target.value)} onKeyDown={onKeyDown} disabled={busy} spellCheck={false}
          className="flex-1 bg-transparent outline-none text-foreground disabled:opacity-60" placeholder="command" />
      </div>
    </div>
  )
}
