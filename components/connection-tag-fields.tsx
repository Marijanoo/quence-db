'use client'

// Environment and color pickers for the connection dialogs
import React from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  CONNECTION_COLORS, ENVIRONMENTS, connectionColor, environmentInfo,
  type ConnectionColorKey, type ConnectionEnvironment, type ConnectionOptions,
} from '@/lib/connection-options'

export function ConnectionTagFields({ value, onChange }: { value: ConnectionOptions; onChange: (v: ConnectionOptions) => void }) {
  const effective = connectionColor(value)
  const setEnv = (environment: ConnectionEnvironment | undefined) => onChange({ ...value, environment })
  const setColor = (color: ConnectionColorKey | undefined) => onChange({ ...value, color })
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Environment</label>
        <div className="flex flex-wrap gap-1">
          {[{ key: undefined, label: 'None' }, ...ENVIRONMENTS].map(e => (
            <button
              key={e.key ?? 'none'} type="button" onClick={() => setEnv(e.key)}
              className={cn(
                'px-2.5 py-1 rounded text-xs border transition-colors',
                value.environment === e.key ? 'border-primary bg-primary/15 text-foreground' : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {e.label}
            </button>
          ))}
        </div>
        {value.environment === 'production' && (
          <p className="text-[11px] text-muted-foreground/70">Production connections are marked red everywhere, and queries that change data run in Safe Run (you review before anything is committed).</p>
        )}
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Color <span className="text-muted-foreground/50">{value.color ? '' : value.environment ? `(${environmentInfo(value.environment)!.label.toLowerCase()} default)` : '(none)'}</span></label>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => setColor(undefined)} title={value.environment ? 'Environment default' : 'No color'}
            className={cn('h-5 w-5 rounded-full border border-border flex items-center justify-center text-[9px] text-muted-foreground', !value.color && 'ring-2 ring-offset-1 ring-offset-card ring-foreground/70')}>
            A
          </button>
          {(Object.keys(CONNECTION_COLORS) as ConnectionColorKey[]).map(c => (
            <button key={c} type="button" onClick={() => setColor(c)} title={c}
              className={cn('h-5 w-5 rounded-full flex items-center justify-center', value.color === c && 'ring-2 ring-offset-1 ring-offset-card ring-foreground/70')}
              style={{ background: CONNECTION_COLORS[c] }}>
              {value.color === c && <Check className="h-3 w-3 text-black/70" />}
            </button>
          ))}
          {effective && <span className="ml-1 h-3 w-8 rounded-sm" style={{ background: effective }} title="How the connection will be marked" />}
        </div>
      </div>
    </div>
  )
}

// A small tag like PROD in the connection's color
export function EnvironmentBadge({ options, className }: { options?: ConnectionOptions; className?: string }) {
  const env = environmentInfo(options?.environment)
  const color = connectionColor(options)
  if (!env || !color) return null
  return (
    <span className={cn('shrink-0 text-[9px] font-bold px-1 rounded leading-4 tracking-wide', className)}
      style={{ color, background: `color-mix(in oklch, ${color} 18%, transparent)` }}>
      {env.short}
    </span>
  )
}
