// Importing a CSV/TSV or JSON file into an existing table (the Import Wizard): the file streams
// in, its fields are mapped onto the table's columns, and rows go in as parameterized multi-row
// INSERTs inside one transaction, so the import lands completely or not at all. Values are sent
// as text; the database converts them to each column's type.

import { JsonDocumentSplitter } from './json-stream'
import type { ExportColumn } from './table-export'

export type ImportDbType = 'postgres' | 'mysql'

// ── CSV ───────────────────────────────────────────────────────────────────────

// RFC 4180 CSV, fed in chunks: quoted fields may hold delimiters, quotes ("") and line breaks
export class CsvParser {
  private field = ''
  private row: string[] = []
  private inQuotes = false
  private quoteSeen = false   // a quote inside quotes: either "" or the closing quote
  private started = false     // the current row has any content
  private first = true

  constructor(private readonly delimiter: string) {}

  push(chunk: string): string[][] {
    const rows: string[][] = []
    let text = chunk
    if (this.first && text.length) { text = text.replace(/^﻿/, ''); this.first = false }
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      if (this.inQuotes) {
        if (this.quoteSeen) {
          this.quoteSeen = false
          if (ch === '"') { this.field += '"'; continue }
          this.inQuotes = false // the quote closed the field; fall through to handle ch
        } else if (ch === '"') { this.quoteSeen = true; continue }
        else { this.field += ch; continue }
      }
      if (ch === this.delimiter) { this.row.push(this.field); this.field = ''; this.started = true }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++
        else if (ch === '\r' && i + 1 === text.length) { /* a \n may follow in the next chunk; handled as an empty line */ }
        if (this.started || this.field !== '') { this.row.push(this.field); rows.push(this.row) }
        this.row = []; this.field = ''; this.started = false
      } else if (ch === '"' && this.field === '') { this.inQuotes = true; this.started = true }
      else { this.field += ch; this.started = true }
    }
    return rows
  }

  end(): string[][] {
    if (this.inQuotes && !this.quoteSeen) throw new Error('The file ends inside a quoted field')
    if (!this.started && this.field === '') return []
    this.row.push(this.field)
    const row = this.row
    this.row = []; this.field = ''; this.started = false; this.inQuotes = false; this.quoteSeen = false
    return [row]
  }
}

// ── Source files ──────────────────────────────────────────────────────────────

export type SourceFormat =
  | { kind: 'csv'; delimiter: string; header: boolean }
  | { kind: 'json' }

export type SourceRecord = { get(field: string): unknown; keys(): string[] }

export type ChunkReader = () => Promise<{ text: string; done: boolean; position: number }>

// Streams the records of a file. CSV fields come from the header (or are "Column 1", …).
export async function* readRecords(read: ChunkReader, format: SourceFormat, onFields?: (fields: string[]) => void): AsyncGenerator<{ record: SourceRecord; line: number; position: number }> {
  if (format.kind === 'csv') {
    const parser = new CsvParser(format.delimiter)
    let fields: string[] | null = null
    let line = 0
    for (;;) {
      const chunk = await read()
      const rows = chunk.done ? [...parser.push(chunk.text), ...parser.end()] : parser.push(chunk.text)
      for (const row of rows) {
        line++
        if (!fields) {
          fields = format.header ? row.map((f, i) => f.trim() || `Column ${i + 1}`) : row.map((_, i) => `Column ${i + 1}`)
          onFields?.(fields)
          if (format.header) continue
        }
        const index = new Map(fields.map((f, i) => [f, i]))
        yield { record: { get: f => { const i = index.get(f); return i === undefined ? undefined : row[i] }, keys: () => fields! }, line, position: chunk.position }
      }
      if (chunk.done) return
    }
  }
  const splitter = new JsonDocumentSplitter()
  let n = 0
  for (;;) {
    const chunk = await read()
    const docs = chunk.done ? [...splitter.push(chunk.text), ...splitter.end()] : splitter.push(chunk.text)
    for (const text of docs) {
      n++
      let doc: unknown
      try { doc = JSON.parse(text) } catch (err) { throw new Error(`Record ${n}: ${err instanceof Error ? err.message : String(err)}`) }
      if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`Record ${n} is not an object`)
      const obj = doc as Record<string, unknown>
      yield { record: { get: f => obj[f], keys: () => Object.keys(obj) }, line: n, position: chunk.position }
    }
    if (chunk.done) return
  }
}

export interface Preview { fields: string[]; rows: Record<string, unknown>[] }

// The first records, and the fields found in them (JSON: every key seen, in order)
export async function readPreview(read: ChunkReader, format: SourceFormat, maxRows = 20): Promise<Preview> {
  const fields: string[] = []
  const seen = new Set<string>()
  const records: SourceRecord[] = []
  for await (const { record } of readRecords(read, format)) {
    for (const k of record.keys()) if (!seen.has(k)) { seen.add(k); fields.push(k) }
    records.push(record)
    if (records.length >= maxRows) break
  }
  return { fields, rows: records.map(r => Object.fromEntries(fields.map(f => [f, r.get(f)]))) }
}

// ── Mapping ───────────────────────────────────────────────────────────────────

export interface ColumnMapping { source: string; target: string }

const normalize = (s: string) => s.toLowerCase().replace(/[\s_\-.]+/g, '')

// Pairs file fields with same-named columns (ignoring case, spaces, _ and -)
export function autoMap(fields: string[], columns: ExportColumn[]): ColumnMapping[] {
  const byName = new Map(columns.filter(c => !c.generated).map(c => [normalize(c.name), c.name]))
  const used = new Set<string>()
  const out: ColumnMapping[] = []
  for (const f of fields) {
    const target = byName.get(normalize(f))
    if (target && !used.has(target)) { used.add(target); out.push({ source: f, target }) }
  }
  return out
}

// ── Values ────────────────────────────────────────────────────────────────────

export interface ValueOptions {
  emptyIsNull: boolean   // CSV: an empty field is NULL (otherwise an empty string)
  nullText: string       // CSV: this exact text is NULL too (e.g. \N or NULL); '' for none
}

export function toParam(value: unknown, dbType: ImportDbType, opts: ValueOptions): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    if (opts.emptyIsNull && value === '') return null
    if (opts.nullText && value === opts.nullText) return null
    return value
  }
  if (typeof value === 'boolean') return dbType === 'mysql' ? (value ? '1' : '0') : String(value)
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return JSON.stringify(value)
}

// ── Running an import ─────────────────────────────────────────────────────────

export interface TableImportSession {
  execute(sql: string, params?: unknown[]): Promise<{ rowCount?: number | null }>
}

export interface TableImportJob {
  dbType: ImportDbType
  schema: string
  table: string
  format: SourceFormat
  mapping: ColumnMapping[]
  columns: ExportColumn[]      // the table's columns (for identity handling and sequence resets)
  values: ValueOptions
  deleteFirst: boolean         // empty the table before importing
  batchRows?: number
}

export interface TableImportProgress { rows: number; bytes: number }

export class TableImportCancelled extends Error {
  constructor() { super('Import cancelled') }
}

const quote = (dbType: ImportDbType) => dbType === 'mysql'
  ? (s: string) => '`' + s.replace(/`/g, '``') + '`'
  : (s: string) => '"' + s.replace(/"/g, '""') + '"'

export function buildInsert(dbType: ImportDbType, schema: string, table: string, targets: string[], rows: (string | null)[][]): { sql: string; params: (string | null)[] } {
  const q = quote(dbType)
  const params: (string | null)[] = []
  const values = rows.map(r => `(${r.map(v => { params.push(v); return dbType === 'mysql' ? '?' : `$${params.length}` }).join(', ')})`)
  // Explicit values for GENERATED ALWAYS identity columns need OVERRIDING (a no-op otherwise)
  const overriding = dbType === 'postgres' ? ' OVERRIDING SYSTEM VALUE' : ''
  return { sql: `INSERT INTO ${q(schema)}.${q(table)} (${targets.map(q).join(', ')})${overriding} VALUES ${values.join(', ')}`, params }
}

// After explicit ids went in, move serial/identity sequences past them (MySQL's auto_increment follows by itself)
export function sequenceResets(dbType: ImportDbType, schema: string, table: string, columns: ExportColumn[], targets: string[]): string[] {
  if (dbType !== 'postgres') return []
  const q = quote(dbType)
  const target = `${q(schema)}.${q(table)}`
  const lit = (s: string) => `'${s.replace(/'/g, "''")}'`
  return columns.filter(c => (c.identity || c.serial) && targets.includes(c.name)).map(c =>
    `SELECT setval(pg_get_serial_sequence(${lit(target)}, ${lit(c.name)}), COALESCE(max(${q(c.name)}), 1), max(${q(c.name)}) IS NOT NULL) FROM ${target}`)
}

// Runs inside a transaction the caller opened. Stops at the first row that fails and says which
// one; the caller then rolls back.
export async function runTableImport(read: ChunkReader, session: TableImportSession, job: TableImportJob, hooks: {
  onProgress?: (p: TableImportProgress) => void
  isCancelled?: () => boolean
} = {}): Promise<{ rows: number }> {
  if (job.mapping.length === 0) throw new Error('Map at least one field to a column')
  const q = quote(job.dbType)
  const targets = job.mapping.map(m => m.target)
  const perStatement = Math.max(1, Math.min(job.batchRows ?? 500, Math.floor(30000 / targets.length)))
  if (job.deleteFirst) await session.execute(`DELETE FROM ${q(job.schema)}.${q(job.table)}`)

  let rows = 0
  let batch: { values: (string | null)[]; line: number }[] = []
  let position = 0
  const flush = async () => {
    if (!batch.length) return
    const { sql, params } = buildInsert(job.dbType, job.schema, job.table, targets, batch.map(b => b.values))
    await session.execute('SAVEPOINT quence_import')
    try {
      await session.execute(sql, params)
      await session.execute('RELEASE SAVEPOINT quence_import')
    } catch (batchError) {
      // Find the row that fails, to name it in the error
      await session.execute('ROLLBACK TO SAVEPOINT quence_import')
      for (const b of batch) {
        const single = buildInsert(job.dbType, job.schema, job.table, targets, [b.values])
        try {
          await session.execute(single.sql, single.params)
        } catch (err) {
          throw new Error(`${job.format.kind === 'csv' ? 'Line' : 'Record'} ${b.line}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      throw batchError
    }
    rows += batch.length
    batch = []
    hooks.onProgress?.({ rows, bytes: position })
  }

  for await (const { record, line, position: pos } of readRecords(read, job.format)) {
    if (hooks.isCancelled?.()) throw new TableImportCancelled()
    position = pos
    batch.push({ values: job.mapping.map(m => toParam(record.get(m.source), job.dbType, job.values)), line })
    if (batch.length >= perStatement) await flush()
  }
  await flush()
  for (const sql of sequenceResets(job.dbType, job.schema, job.table, job.columns, targets)) await session.execute(sql)
  hooks.onProgress?.({ rows, bytes: position })
  return { rows }
}
