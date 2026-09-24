'use client'

import React, { useEffect, useRef, useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatCellDate, monthGrid, sameDay, type DateColumnKind } from '@/lib/date-cell'

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const WIDTH = 264

const timeText = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`

function withTime(day: Date, time: string): Date {
  const [h = 0, m = 0, s = 0] = time.split(':').map(Number)
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h || 0, m || 0, s || 0)
}

// Calendar popup for a date cell. Clicking a day picks it (with the time field for timestamp columns).
export function DatePickerPopover({ anchor, kind, value, column, onPick, onClose }: {
  anchor: DOMRect
  kind: DateColumnKind
  value: Date | null
  column: string
  onPick: (date: Date) => void
  onClose: () => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const hasTime = kind !== 'date'
  const [view, setView] = useState(() => { const d = value ?? new Date(); return { year: d.getFullYear(), month: d.getMonth() } })
  const [time, setTime] = useState(() => timeText(value ?? new Date(new Date().setHours(0, 0, 0, 0))))
  // Days → click the title for months → click again for years; picking goes back down
  const [layer, setLayer] = useState<'days' | 'months' | 'years'>('days')
  const today = new Date()

  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose() }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose])

  const shiftMonth = (delta: number) => setView(v => {
    const d = new Date(v.year, v.month + delta, 1)
    return { year: d.getFullYear(), month: d.getMonth() }
  })

  const pickDay = (day: Date) => onPick(hasTime ? withTime(day, time) : day)
  const days = monthGrid(view.year, view.month)
  const firstYear = view.year - (((view.year % 12) + 12) % 12) // pages of 12 aligned years, e.g. 2016–2027

  const nav = layer === 'days'
    ? { step: 1, unit: 'month', title: new Date(view.year, view.month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }), up: 'months' as const }
    : layer === 'months'
      ? { step: 12, unit: 'year', title: String(view.year), up: 'years' as const }
      : { step: 144, unit: '12 years', title: `${firstYear} – ${firstYear + 11}`, up: null }
  const cellClass = (selected: boolean, current: boolean) => cn('rounded text-xs tabular-nums transition-colors',
    selected ? 'bg-primary text-primary-foreground font-semibold'
      : current ? 'ring-1 ring-inset ring-primary/60 text-foreground hover:bg-accent/30'
        : 'text-foreground hover:bg-accent/30')
  const height = hasTime ? 348 : 314
  const top = anchor.bottom + height + 8 > window.innerHeight ? Math.max(8, anchor.top - height - 4) : anchor.bottom + 4
  const left = Math.min(Math.max(8, anchor.left), window.innerWidth - WIDTH - 8)
  const navBtn = 'p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/30'

  return (
    <div
      ref={rootRef}
      // The grid moves its selection on arrow keys and starts editing on typing; keep keys in here
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); onClose() } }}
      className="fixed z-50 flex flex-col gap-2 rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl p-3"
      style={{ top, left, width: WIDTH }}
    >
      <div className="flex items-center gap-1">
        <CalendarDays className="h-3.5 w-3.5 text-primary shrink-0" />
        <span className="text-xs font-mono text-muted-foreground truncate flex-1">{column}</span>
        <button onClick={onClose} className={navBtn}><X className="h-3.5 w-3.5" /></button>
      </div>

      <div className="flex items-center">
        <button onClick={() => shiftMonth(-nav.step)} title={`Previous ${nav.unit}`} className={navBtn}><ChevronLeft className="h-3.5 w-3.5" /></button>
        <button
          onClick={() => nav.up && setLayer(nav.up)}
          disabled={!nav.up}
          title={nav.up ? `Choose a ${nav.up === 'months' ? 'month' : 'year'}` : undefined}
          className="flex-1 mx-1 h-6 rounded text-center text-xs font-semibold text-foreground hover:bg-accent/30 disabled:hover:bg-transparent disabled:cursor-default"
        >
          {nav.title}
        </button>
        <button onClick={() => shiftMonth(nav.step)} title={`Next ${nav.unit}`} className={navBtn}><ChevronRight className="h-3.5 w-3.5" /></button>
      </div>

      <div className="h-[204px]">
        {layer === 'days' && (
          <div className="grid grid-cols-7 gap-0.5 text-center">
            {WEEKDAYS.map(d => <span key={d} className="text-[10px] text-muted-foreground/70 py-0.5">{d}</span>)}
            {days.map(day => {
              const inMonth = day.getMonth() === view.month
              const selected = !!value && sameDay(day, value)
              return (
                <button
                  key={day.getTime()}
                  onClick={() => pickDay(day)}
                  className={cn('h-7', cellClass(selected, sameDay(day, today)), !selected && !inMonth && 'text-muted-foreground/40')}
                >
                  {day.getDate()}
                </button>
              )
            })}
          </div>
        )}
        {layer === 'months' && (
          <div className="grid grid-cols-3 gap-1 h-full">
            {Array.from({ length: 12 }, (_, month) => (
              <button
                key={month}
                onClick={() => { setView({ year: view.year, month }); setLayer('days') }}
                className={cellClass(
                  !!value && value.getFullYear() === view.year && value.getMonth() === month,
                  today.getFullYear() === view.year && today.getMonth() === month,
                )}
              >
                {new Date(view.year, month, 1).toLocaleDateString(undefined, { month: 'short' })}
              </button>
            ))}
          </div>
        )}
        {layer === 'years' && (
          <div className="grid grid-cols-3 gap-1 h-full">
            {Array.from({ length: 12 }, (_, i) => firstYear + i).map(year => (
              <button
                key={year}
                onClick={() => { setView(v => ({ year, month: v.month })); setLayer('months') }}
                className={cellClass(!!value && value.getFullYear() === year, today.getFullYear() === year)}
              >
                {year}
              </button>
            ))}
          </div>
        )}
      </div>

      {hasTime && (
        <label className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Time</span>
          <input
            type="time"
            step={1}
            value={time}
            onChange={e => setTime(e.target.value.length === 5 ? `${e.target.value}:00` : e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && value) { e.preventDefault(); onPick(withTime(value, time)) } }}
            className="flex-1 h-6 rounded border border-border bg-background px-1.5 font-mono text-foreground outline-none focus:border-primary [color-scheme:dark]"
          />
          {value && (
            <button onClick={() => onPick(withTime(value, time))} title="Keep the day, change the time" className="px-2 h-6 rounded text-[11px] border border-border text-muted-foreground hover:text-foreground hover:bg-accent/30">
              Set
            </button>
          )}
        </label>
      )}

      <div className="flex items-center gap-1 pt-1 border-t border-border">
        <button onClick={() => pickDay(today)} className="px-2 h-6 rounded text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/30">Today</button>
        {hasTime && <button onClick={() => onPick(new Date())} className="px-2 h-6 rounded text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/30">Now</button>}
        <span className="flex-1 text-right text-[10px] text-muted-foreground/60 font-mono truncate" title="What gets saved">
          {value ? formatCellDate(value, kind) : 'no value'}
        </span>
      </div>
    </div>
  )
}
