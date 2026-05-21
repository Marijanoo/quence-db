'use client'

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)

interface UpdateBarProps {
  progress: number
  downloaded: boolean
  onInstall: () => void
  onDismiss: () => void
}

export function UpdateBar({ progress, downloaded, onInstall, onDismiss }: UpdateBarProps) {
  return (
    <div className="flex items-center gap-2 px-4 h-7 bg-primary/10 border-b border-primary/20 shrink-0">
      <style>{`
        @keyframes shimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(400%); } }
        .progress-shimmer { animation: shimmer 1.2s ease-in-out infinite; }
      `}</style>
      <div className="relative flex-1 h-1 rounded-full bg-primary/20 overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 bg-primary rounded-full transition-all duration-300 overflow-hidden"
          style={{ width: `${progress}%` }}
        >
          {!downloaded && (
            <div
              className="progress-shimmer absolute inset-y-0 w-1/3"
              style={{ background: 'linear-gradient(to right, transparent, rgba(255,255,255,0.9) 50%, transparent)' }}
            />
          )}
        </div>
      </div>
      {downloaded ? (
        <div className="flex items-center gap-2">
          <button onClick={onInstall} className="text-xs font-medium text-primary hover:text-primary/80 transition-colors whitespace-nowrap">
            {isMac ? 'Quit & update' : 'Restart to update'}
          </button>
          <span className="text-primary/30">·</span>
          <button onClick={onDismiss} className="text-xs text-primary/60 hover:text-primary transition-colors whitespace-nowrap">
            Later
          </button>
        </div>
      ) : (
        <span className="text-xs text-primary whitespace-nowrap">Updating… {Math.round(progress)}%</span>
      )}
    </div>
  )
}
