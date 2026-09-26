'use client'

// A confirmation any code can await: `if (!await confirmAction({...})) return`. The dialog is drawn
// by <ConfirmHost />, mounted once in the database view.
import React, { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DialogShell, buttonCls, primaryCls } from '@/components/database-transfer'

export interface ConfirmOptions {
  title: string
  subtitle?: string
  message?: React.ReactNode
  details?: string          // shown in a code box (SQL, a list of changes)
  confirmLabel?: string
  danger?: boolean
}

type Request = ConfirmOptions & { resolve: (ok: boolean) => void }
let enqueue: ((r: Request) => void) | null = null

export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return new Promise(resolve => {
    if (!enqueue) { resolve(window.confirm(options.title)); return }
    enqueue({ ...options, resolve })
  })
}

export function ConfirmHost() {
  const [queue, setQueue] = useState<Request[]>([])
  useEffect(() => {
    enqueue = r => setQueue(q => [...q, r])
    return () => { enqueue = null }
  }, [])
  const current = queue[0]
  if (!current) return null
  const answer = (ok: boolean) => { current.resolve(ok); setQueue(q => q.slice(1)) }
  return (
    <DialogShell title={current.title} subtitle={current.subtitle} busy={false} onClose={() => answer(false)} width="w-[540px]">
      <div className="px-5 py-4 space-y-3 overflow-y-auto">
        {current.message && (
          <div className={cn('flex items-start gap-2 text-xs', current.danger ? 'text-amber-300' : 'text-muted-foreground')}>
            {current.danger && <AlertTriangle className="h-4 w-4 shrink-0 mt-px" />}
            <div>{current.message}</div>
          </div>
        )}
        {current.details && (
          <pre className="text-[11px] font-mono bg-background border border-border rounded px-2 py-1.5 whitespace-pre-wrap break-words max-h-72 overflow-y-auto">{current.details}</pre>
        )}
      </div>
      <div className="flex justify-end gap-2 px-5 py-3 border-t border-border shrink-0">
        <button onClick={() => answer(false)} className={buttonCls} autoFocus>Cancel</button>
        <button onClick={() => answer(true)}
          className={current.danger ? 'flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-destructive text-white hover:bg-destructive/90 transition-colors' : primaryCls}>
          {current.confirmLabel ?? 'Continue'}
        </button>
      </div>
    </DialogShell>
  )
}
