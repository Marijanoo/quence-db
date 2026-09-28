'use client'

// Shown when the page crashes while rendering: the error itself, so it can be copied into a bug
// report, and a way back without losing the saved connections and tabs.
import { useState } from 'react'

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [copied, setCopied] = useState(false)
  const details = `${error.name}: ${error.message}\n\n${error.stack ?? ''}${error.digest ? `\n\ndigest: ${error.digest}` : ''}`
  const copy = () => void navigator.clipboard.writeText(details).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
  return (
    <div className="h-screen flex items-center justify-center bg-background p-6">
      <div className="w-full max-w-2xl rounded-lg border border-red-500/30 bg-card p-5 space-y-3">
        <div className="text-sm font-semibold text-red-400">QuenceDB ran into an error</div>
        <p className="text-xs text-muted-foreground">Your connections and tabs are saved. Try again, or reload the window. If it keeps happening, copy the details below.</p>
        <pre className="text-[11px] font-mono text-red-300 bg-background border border-border rounded p-2 max-h-72 overflow-auto whitespace-pre-wrap break-words select-text">{details}</pre>
        <div className="flex gap-2">
          <button onClick={reset} className="px-3 h-7 rounded bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90">Try Again</button>
          <button onClick={() => window.location.reload()} className="px-3 h-7 rounded border border-border text-xs text-muted-foreground hover:text-foreground">Reload</button>
          <button onClick={copy} className="px-3 h-7 rounded border border-border text-xs text-muted-foreground hover:text-foreground">{copied ? 'Copied' : 'Copy Details'}</button>
        </div>
      </div>
    </div>
  )
}
