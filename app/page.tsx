'use client'

import { useEffect, useState } from 'react'
import { Minus, Square, X, Database } from 'lucide-react'
import { DatabaseView } from '@/components/database-view'
import { UpdateBar } from '@/components/update-bar'

export default function Home() {
  const [updateProgress, setUpdateProgress] = useState<number | null>(null)
  const [updateDownloaded, setUpdateDownloaded] = useState(false)

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onUpdateDownloaded) return
    api.onUpdateAvailable?.(() => setUpdateProgress(0))
    api.onUpdateProgress?.((p) => setUpdateProgress(p))
    api.onUpdateDownloaded(() => { setUpdateProgress(100); setUpdateDownloaded(true) })
  }, [])

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Title bar */}
      <div
        className="flex items-center gap-2 px-3 h-9 bg-card border-b border-border shrink-0 select-none overflow-hidden"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <Database className="h-4 w-4 text-blue-400 shrink-0" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties} />
        <span className="text-sm font-semibold text-foreground truncate flex-1">QuenceDB</span>
        <div className="flex items-center gap-1 shrink-0" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            onClick={() => window.electronAPI?.minimize()}
            className="flex items-center justify-center h-6 w-6 rounded hover:bg-white/10 text-muted-foreground hover:text-foreground transition-colors"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => window.electronAPI?.maximize()}
            className="flex items-center justify-center h-6 w-6 rounded hover:bg-white/10 text-muted-foreground hover:text-foreground transition-colors"
          >
            <Square className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => window.electronAPI?.close()}
            className="flex items-center justify-center h-6 w-6 rounded hover:bg-red-500/80 text-muted-foreground hover:text-white transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Update bar */}
      {updateProgress !== null && (
        <UpdateBar
          progress={updateProgress}
          downloaded={updateDownloaded}
          onInstall={() => window.electronAPI?.installUpdate?.()}
          onDismiss={() => { setUpdateProgress(null); setUpdateDownloaded(false) }}
        />
      )}

      {/* Database view fills the rest */}
      <div className="flex-1 min-h-0">
        <DatabaseView />
      </div>
    </div>
  )
}
