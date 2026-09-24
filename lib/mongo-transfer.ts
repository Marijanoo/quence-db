// MongoDB database export/import, in mongodump/mongoexport's layout: a folder with, per
// collection, <name>.json (one canonical Extended JSON document per line) and
// <name>.metadata.json (options and indexes). Folders from mongoexport (no metadata files) and
// single JSON / JSON Lines files import too; their collection names come from the file names.
// The database side lives in the Electron main process (electron/mongo-transfer.ts); this drives it.

import { JsonDocumentSplitter } from './json-stream'

export interface MongoTransferIO {
  exportCollections(): Promise<{ metadata: string; estimate: number }[]>
  exportOpen(collection: string): Promise<string>
  exportRead(cursorId: string, limit: number): Promise<{ lines: string[]; done: boolean }>
  exportClose(cursorId: string): Promise<void>
  importPrepare(metadata: string, drop: boolean): Promise<void>
  importDocuments(collection: string, documents: string[]): Promise<{ inserted: number; errors: string[] }>
  importIndexes(metadata: string): Promise<number>
}

export interface FolderIO {
  create(name: string): Promise<{ write(text: string): Promise<void>; close(discard?: boolean): Promise<void> }>
  // Reads a file in chunks; done once everything was returned
  open(name: string): Promise<{ read(): Promise<{ text: string; done: boolean; position: number }>; close(): Promise<void>; size: number }>
}

export interface CollectionInfo { name: string; type: string; estimate: number; metadata: string }

export class TransferCancelled extends Error {
  constructor() { super('Cancelled') }
}

export function parseCollections(list: { metadata: string; estimate: number }[]): CollectionInfo[] {
  return list.map(c => {
    const meta = JSON.parse(c.metadata) as { name: string; type?: string }
    return { name: meta.name, type: meta.type ?? 'collection', estimate: c.estimate, metadata: c.metadata }
  })
}

// Collection names may hold characters Windows forbids in file names (mongodump escapes them too)
export function collectionFileBase(name: string, taken: Set<string>): string {
  let base = name.replace(/[\\/:*?"<>|%]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
  if (/^\.|\.$/.test(base)) base = `_${base}`
  let candidate = base
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base}~${n}`
  taken.add(candidate.toLowerCase())
  return candidate
}

export interface TransferProgress { collection: string; done: number; total: number; documents: number }

export async function runMongoExport(io: MongoTransferIO, folder: FolderIO, collections: CollectionInfo[], opts: {
  onProgress?: (p: TransferProgress) => void
  isCancelled?: () => boolean
  batchSize?: number
} = {}): Promise<{ collections: number; documents: number }> {
  const check = () => { if (opts.isCancelled?.()) throw new TransferCancelled() }
  const taken = new Set<string>()
  let documents = 0
  for (const [index, c] of collections.entries()) {
    check()
    opts.onProgress?.({ collection: c.name, done: index, total: collections.length, documents })
    const base = collectionFileBase(c.name, taken)
    const meta = await folder.create(`${base}.metadata.json`)
    await meta.write(c.metadata + '\n')
    await meta.close()
    if (c.type === 'view') continue

    const file = await folder.create(`${base}.json`)
    const cursorId = await io.exportOpen(c.name)
    try {
      for (;;) {
        check()
        const { lines, done } = await io.exportRead(cursorId, opts.batchSize ?? 1000)
        if (lines.length) await file.write(lines.join('\n') + '\n')
        documents += lines.length
        opts.onProgress?.({ collection: c.name, done: index, total: collections.length, documents })
        if (done) break
      }
      await file.close()
    } catch (err) {
      await io.exportClose(cursorId).catch(() => {})
      await file.close(true)
      throw err
    }
  }
  opts.onProgress?.({ collection: '', done: collections.length, total: collections.length, documents })
  return { collections: collections.length, documents }
}

// ── Import ────────────────────────────────────────────────────────────────────

export interface ImportEntry {
  collection: string
  metadataFile?: string
  dataFile?: string
  isView: boolean
  size: number
}

const DATA_FILE = /\.(json|jsonl|ndjson)$/i
const METADATA_FILE = /\.metadata\.json$/i

// Pairs the files of an export folder into collections. Metadata files name their collection;
// other files are named by their file name. Views load last, after what they read from.
export async function planFolderImport(files: { name: string; size: number }[], readText: (name: string) => Promise<string>): Promise<ImportEntry[]> {
  const byBase = new Map<string, ImportEntry>()
  const entry = (base: string) => {
    let e = byBase.get(base)
    if (!e) byBase.set(base, e = { collection: base, isView: false, size: 0 })
    return e
  }
  for (const f of files) {
    if (METADATA_FILE.test(f.name)) {
      const e = entry(f.name.replace(METADATA_FILE, ''))
      e.metadataFile = f.name
      try {
        const meta = JSON.parse(await readText(f.name)) as { name?: string; type?: string }
        if (meta.name) e.collection = meta.name
        e.isView = meta.type === 'view'
      } catch { /* treated as data-only */ }
    } else if (DATA_FILE.test(f.name)) {
      const e = entry(f.name.replace(DATA_FILE, ''))
      e.dataFile = f.name
      e.size = f.size
    }
  }
  return [...byBase.values()]
    .filter(e => e.dataFile || e.metadataFile)
    .sort((a, b) => Number(a.isView) - Number(b.isView) || a.collection.localeCompare(b.collection))
}

export function defaultMetadata(collection: string): string {
  return JSON.stringify({ name: collection, type: 'collection', options: {}, indexes: [] })
}

export interface MongoImportResult { collections: number; documents: number; failed: number; errors: string[] }

export async function runMongoImport(io: MongoTransferIO, folder: FolderIO, entries: ImportEntry[], opts: {
  drop: boolean
  onProgress?: (p: TransferProgress & { bytes: number; totalBytes: number }) => void
  isCancelled?: () => boolean
  batchSize?: number
  maxRecordedErrors?: number
}): Promise<MongoImportResult> {
  const check = () => { if (opts.isCancelled?.()) throw new TransferCancelled() }
  const result: MongoImportResult = { collections: 0, documents: 0, failed: 0, errors: [] }
  const totalBytes = entries.reduce((n, e) => n + e.size, 0)
  let bytesBefore = 0
  const record = (collection: string, messages: string[]) => {
    result.failed += messages.length
    for (const m of messages) if (result.errors.length < (opts.maxRecordedErrors ?? 100)) result.errors.push(`${collection}: ${m}`)
  }

  for (const [index, e] of entries.entries()) {
    check()
    const progress = (bytes: number) => opts.onProgress?.({ collection: e.collection, done: index, total: entries.length, documents: result.documents, bytes: bytesBefore + bytes, totalBytes })
    progress(0)
    let metadata = defaultMetadata(e.collection)
    if (e.metadataFile) {
      const f = await folder.open(e.metadataFile)
      let text = ''
      try { for (;;) { const c = await f.read(); text += c.text; if (c.done) break } } finally { await f.close() }
      metadata = text.trim()
    }
    // The collection's name is the one chosen for the import (a file may be imported under another name)
    const meta = JSON.parse(metadata) as Record<string, unknown>
    if (meta.name !== e.collection) metadata = JSON.stringify({ ...meta, name: e.collection })
    await io.importPrepare(metadata, opts.drop)

    if (e.dataFile && !e.isView) {
      const f = await folder.open(e.dataFile)
      const splitter = new JsonDocumentSplitter()
      let batch: string[] = []
      const flush = async () => {
        if (!batch.length) return
        const res = await io.importDocuments(e.collection, batch)
        result.documents += res.inserted
        record(e.collection, res.errors)
        batch = []
      }
      try {
        for (;;) {
          check()
          const chunk = await f.read()
          const docs = chunk.done ? [...splitter.push(chunk.text), ...splitter.end()] : splitter.push(chunk.text)
          for (const d of docs) {
            batch.push(d)
            if (batch.length >= (opts.batchSize ?? 1000)) await flush()
          }
          progress(chunk.position)
          if (chunk.done) break
        }
        await flush()
      } finally {
        await f.close()
      }
    }
    try {
      await io.importIndexes(metadata)
    } catch (err) {
      record(e.collection, [`indexes: ${err instanceof Error ? err.message : String(err)}`])
    }
    bytesBefore += e.size
    result.collections++
  }
  opts.onProgress?.({ collection: '', done: entries.length, total: entries.length, documents: result.documents, bytes: totalBytes, totalBytes })
  return result
}
