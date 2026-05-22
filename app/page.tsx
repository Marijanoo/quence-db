'use client'

import { useEffect, useState } from 'react'
import { Minus, Square, X, Settings2 } from 'lucide-react'
import Image from 'next/image'
import { DatabaseView } from '@/components/database-view'
import { UpdateBar } from '@/components/update-bar'
import { SettingsPanel, applySettings, DEFAULTS } from '@/components/settings-panel'

const version = '0.1.0'

export default function Home() {
  const [updateProgress, setUpdateProgress] = useState<number | null>(null)
  const [updateDownloaded, setUpdateDownloaded] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    try {
      const raw = localStorage.getItem('quence-db-theme')
      if (raw) applySettings({ ...DEFAULTS, ...JSON.parse(raw) })
      else applySettings(DEFAULTS)
    } catch {}
  }, [])

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
        className="flex items-stretch h-9 bg-card border-b border-border shrink-0 select-none overflow-hidden"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex items-center gap-2 px-3 flex-1 min-w-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
          <Image src="/logo.png" alt="QuenceDB" width={16} height={16} className="shrink-0" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties} />
          <span className="text-sm font-semibold text-foreground truncate">QuenceDB</span>
        </div>
        <div className="flex items-stretch shrink-0" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button onClick={() => window.electronAPI?.minimize()}
            className="flex items-center justify-center h-full w-9 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors" tabIndex={-1}>
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button onClick={() => window.electronAPI?.maximize()}
            className="flex items-center justify-center h-full w-9 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors" tabIndex={-1}>
            <Square className="h-3 w-3" />
          </button>
          <button onClick={() => window.electronAPI?.close()}
            className="flex items-center justify-center h-full w-9 text-muted-foreground hover:bg-[oklch(0.65_0.22_25)] hover:text-white transition-colors" tabIndex={-1}>
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

      {/* Main workspace area with sidebar settings option */}
      <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
        <div className="flex-1 flex flex-col min-h-0 min-w-0">
          <DatabaseView />
        </div>
        <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      </div>

      {/* Bottom bar */}
      <div className="flex items-center gap-2 px-3 h-7 border-t border-border bg-card shrink-0 overflow-hidden">
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setSettingsOpen(o => !o)}
            title="Appearance settings"
            className={`flex items-center gap-1.5 px-2 h-5 rounded text-xs transition-colors ${
              settingsOpen
                ? 'text-foreground bg-accent/20'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/20'
            }`}
          >
            <Settings2 className="h-3.5 w-3.5 shrink-0" />
            <span>Appearance</span>
          </button>
          <span className="text-xs text-muted-foreground/40 select-none">v{version}</span>
        </div>
      </div>
    </div>
  )
}
