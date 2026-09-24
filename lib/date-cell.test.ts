import { describe, it, expect } from 'vitest'
import { cellDateKind, dateColumnKind, formatCellDate, monthGrid, parseCellDate, sameDay } from './date-cell'

describe('dateColumnKind', () => {
  it('recognises PostgreSQL and MySQL date columns, but not time-only ones', () => {
    expect(['date', 'DATE'].map(dateColumnKind)).toEqual(['date', 'date'])
    expect(['timestamp', 'timestamp without time zone', 'datetime', 'datetime(3)', 'timestamp(6)'].map(dateColumnKind)).toEqual(Array(5).fill('timestamp'))
    expect(['timestamptz', 'timestamp with time zone'].map(dateColumnKind)).toEqual(['timestamptz', 'timestamptz'])
    expect(['time', 'timetz', 'interval', 'year', 'text', undefined].map(dateColumnKind)).toEqual(Array(6).fill(null))
  })
})

describe('cellDateKind', () => {
  it('uses the column type, or a MongoDB value that is a Date', () => {
    expect(cellDateKind('timestamptz', undefined)).toBe('timestamptz')
    expect(cellDateKind(undefined, 'date')).toBe('bsonDate')
    expect(cellDateKind(undefined, 'string')).toBeUndefined()
    expect(cellDateKind(undefined, undefined)).toBeUndefined()
  })
})

describe('parseCellDate', () => {
  it('reads driver Dates and zone-less text as local time', () => {
    const d = new Date(2026, 8, 24, 14, 30, 5)
    expect(parseCellDate(d)?.getTime()).toBe(d.getTime())
    expect(parseCellDate('2026-09-24')?.getTime()).toBe(new Date(2026, 8, 24).getTime())
    expect(parseCellDate('2026-09-24 14:30')?.getTime()).toBe(new Date(2026, 8, 24, 14, 30).getTime())
    expect(parseCellDate('2026-09-24T14:30:05.250')?.getTime()).toBe(new Date(2026, 8, 24, 14, 30, 5, 250).getTime())
  })

  it('honours an explicit zone and rejects garbage', () => {
    expect(parseCellDate('2026-09-24T12:00:00Z')?.toISOString()).toBe('2026-09-24T12:00:00.000Z')
    expect(parseCellDate('not a date')).toBeNull()
    expect(parseCellDate('')).toBeNull()
    expect(parseCellDate(null)).toBeNull()
  })
})

describe('formatCellDate', () => {
  const d = new Date(2026, 0, 5, 9, 7, 3)
  it('writes the form each column kind expects', () => {
    expect(formatCellDate(d, 'date')).toBe('2026-01-05')
    expect(formatCellDate(d, 'timestamp')).toBe('2026-01-05 09:07:03')
    expect(formatCellDate(d, 'timestamptz')).toMatch(/^2026-01-05 09:07:03[+-]\d{2}:\d{2}$/)
  })

  it('writes MongoDB dates as exact ISO instants', () => {
    expect(formatCellDate(new Date(Date.UTC(2026, 0, 5, 9, 7, 3)), 'bsonDate')).toBe('2026-01-05T09:07:03.000Z')
  })

  it('round-trips through parseCellDate to the same instant', () => {
    for (const kind of ['timestamp', 'timestamptz', 'bsonDate'] as const) {
      expect(parseCellDate(formatCellDate(d, kind))?.getTime()).toBe(d.getTime())
    }
  })
})

describe('monthGrid', () => {
  it('covers the month in six Monday-first weeks', () => {
    const days = monthGrid(2026, 8) // September 2026 starts on a Tuesday
    expect(days).toHaveLength(42)
    expect(days[0].getDay()).toBe(1)
    expect(sameDay(days[1], new Date(2026, 8, 1))).toBe(true)
    expect(days.filter(x => x.getMonth() === 8)).toHaveLength(30)
  })
})
