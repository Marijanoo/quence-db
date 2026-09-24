// Date picking for grid cells: which columns hold dates, reading a cell's current value, and
// writing a picked date in the form the column expects.

// bsonDate: a MongoDB Date, an exact instant written as ISO text (UTC)
export type DateColumnKind = 'date' | 'timestamp' | 'timestamptz' | 'bsonDate'

// PostgreSQL udt_name / format_type, MySQL COLUMN_TYPE. Time-only and interval columns have no calendar.
export function dateColumnKind(type: string | undefined): DateColumnKind | null {
  if (!type) return null
  const t = type.toLowerCase().replace(/\(.*?\)/g, '').trim()
  if (t === 'date') return 'date'
  if (t === 'timestamptz' || t === 'timestamp with time zone') return 'timestamptz'
  if (t === 'timestamp' || t === 'timestamp without time zone' || t === 'datetime') return 'timestamp'
  return null
}

// The calendar for one cell: SQL columns by their type; MongoDB fields by the value's BSON type,
// which can differ between documents
export function cellDateKind(columnKind: DateColumnKind | undefined, bsonType: string | undefined): DateColumnKind | undefined {
  return columnKind ?? (bsonType === 'date' ? 'bsonDate' : undefined)
}

const pad = (n: number, width = 2) => String(Math.trunc(Math.abs(n))).padStart(width, '0')

// A Date from what a cell holds: a Date from the driver, or text typed/picked earlier. Text
// without a zone is local wall-clock time (how the drivers present date and timestamp values).
export function parseCellDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value.getTime())
  if (typeof value !== 'string' || !value.trim()) return null
  const text = value.trim()
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?$/.exec(text)
  if (local) {
    const [, y, mo, d, h = '0', mi = '0', s = '0', frac = '0'] = local
    const date = new Date(+y, +mo - 1, +d, +h, +mi, +s, Math.round(+`0.${frac}` * 1000))
    return Number.isNaN(date.getTime()) ? null : date
  }
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

// Local wall-clock parts; timestamptz adds the local UTC offset so the stored instant is exact
export function formatCellDate(date: Date, kind: DateColumnKind): string {
  if (kind === 'bsonDate') return date.toISOString()
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  if (kind === 'date') return day
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  if (kind === 'timestamp') return `${day} ${time}`
  const offset = -date.getTimezoneOffset()
  return `${day} ${time}${offset >= 0 ? '+' : '-'}${pad(offset / 60)}:${pad(offset % 60)}`
}

export const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

// The 6×7 days shown for a month, weeks starting on Monday
export function monthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1)
  const offset = (first.getDay() + 6) % 7
  return Array.from({ length: 42 }, (_, i) => new Date(year, month, 1 - offset + i))
}
