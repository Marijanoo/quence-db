// PostgreSQL data synchronization between two schemas (same or different servers).
//
// Rows are matched by primary key and compared by an md5 hash computed in the database, so only
// keys and hashes cross the network. Each side is walked in key order in batches (keyset
// pagination on the PK index) and every batch is looked up by key on the other side, so no
// cross-server ordering or collation assumptions are needed and memory stays flat.
//
// All values travel as PostgreSQL text under fixed session settings (DATA_SYNC_SETTINGS): hashes
// are comparable across servers, and writing the text back through the target column types
// round-trips every type exactly (json, bytea, arrays, timestamps, enums, ...).

import { quoteIdent } from './structure-sync'

export interface SqlRunner {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, any>[]; rowCount: number }>
}

export function dataSyncSettings(schema: string): Record<string, string> {
  return {
    search_path: `${quoteIdent(schema)}, public`,
    TimeZone: 'UTC',
    DateStyle: 'ISO, YMD',
    IntervalStyle: 'postgres',
    extra_float_digits: '3',
    bytea_output: 'hex',
  }
}

// ── Metadata ──────────────────────────────────────────────────────────────────

export interface DataColumn {
  name: string
  type: string
  generated: boolean
  identity: '' | 'a' | 'd'
  notNull: boolean
  hasDefault: boolean
  ownsSequence: boolean
  pkPosition: number // 1-based position in the primary key, 0 when not part of it
}

export interface SelfReference { columns: string[]; refColumns: string[] }

export interface DataTableMeta {
  name: string
  columns: DataColumn[]
  estimatedRows: number | null
  references: string[] // same-schema tables this table has foreign keys to
  selfReferences: SelfReference[] // foreign keys from the table to itself (e.g. reply_to -> id)
}

export const DATA_META_QUERIES = {
  columns: `
    SELECT c.relname AS table_name, a.attname AS name,
      format_type(a.atttypid, a.atttypmod) AS type,
      a.attgenerated <> '' AS generated,
      a.attidentity::text AS identity,
      a.attnotnull AS not_null,
      a.atthasdef AS has_default,
      pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) IS NOT NULL AS owns_sequence,
      coalesce(array_position(pk.conkey, a.attnum), 0) AS pk_position,
      c.reltuples::bigint AS estimated_rows
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_constraint pk ON pk.conrelid = c.oid AND pk.contype = 'p'
    WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum`,
  references: `
    SELECT DISTINCT c.relname AS table_name, f.relname AS ref_table
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class f ON f.oid = con.confrelid
    WHERE con.contype = 'f' AND n.nspname = $1 AND f.relnamespace = c.relnamespace AND f.oid <> c.oid`,
  selfReferences: `
    SELECT c.relname AS table_name,
      ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY AS k(num, ord)
            JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.num ORDER BY k.ord) AS columns,
      ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY AS k(num, ord)
            JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.num ORDER BY k.ord) AS ref_columns
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.contype = 'f' AND con.conrelid = con.confrelid AND n.nspname = $1`,
} as const

export function buildDataMeta(columnRows: Record<string, any>[], referenceRows: Record<string, any>[], selfReferenceRows: Record<string, any>[] = []): DataTableMeta[] {
  const tables = new Map<string, DataTableMeta>()
  for (const r of columnRows) {
    let t = tables.get(r.table_name)
    if (!t) {
      const est = Number(r.estimated_rows)
      t = { name: r.table_name, columns: [], estimatedRows: Number.isFinite(est) && est >= 0 ? est : null, references: [], selfReferences: [] }
      tables.set(r.table_name, t)
    }
    t.columns.push({
      name: r.name, type: r.type, generated: !!r.generated, identity: (r.identity ?? '') as DataColumn['identity'],
      notNull: !!r.not_null, hasDefault: !!r.has_default, ownsSequence: !!r.owns_sequence, pkPosition: Number(r.pk_position) || 0,
    })
  }
  for (const r of referenceRows) tables.get(r.table_name)?.references.push(r.ref_table)
  for (const r of selfReferenceRows) tables.get(r.table_name)?.selfReferences.push({ columns: r.columns, refColumns: r.ref_columns })
  return [...tables.values()]
}

export async function loadDataMeta(runner: SqlRunner, schema: string): Promise<DataTableMeta[]> {
  // Sequential: a transaction session runs one query at a time anyway
  const cols = await runner.query(DATA_META_QUERIES.columns, [schema])
  const refs = await runner.query(DATA_META_QUERIES.references, [schema])
  const selfRefs = await runner.query(DATA_META_QUERIES.selfReferences, [schema])
  return buildDataMeta(cols.rows, refs.rows, selfRefs.rows)
}

// ── Planning ──────────────────────────────────────────────────────────────────

export interface TablePlan {
  table: string
  key: string[]            // primary key columns (source), in key order
  columns: string[]        // columns compared and copied: in both tables, not generated, source order
  updateColumns: string[]  // columns written by UPDATE: non-key, and not GENERATED ALWAYS identity in the target
  targetTypes: Record<string, string>
  overridingSystemValue: boolean // inserts must override a GENERATED ALWAYS identity in the target
  sequenceColumns: string[] // target columns backed by a sequence, reset after inserting
  // Self-references (target FKs from the table to its own key) that are written as NULL first and
  // filled in once all rows exist, so rows can reference rows with a later key
  selfReferences: SelfReference[]
  estimatedRows: number | null
  warnings: string[]
  skipped?: string          // why this table can't be synced
}

export function planTables(source: DataTableMeta[], target: DataTableMeta[]): TablePlan[] {
  const targetByName = new Map(target.map(t => [t.name, t]))
  return source.map(s => {
    const plan: TablePlan = {
      table: s.name, key: [], columns: [], updateColumns: [], targetTypes: {}, overridingSystemValue: false,
      sequenceColumns: [], selfReferences: [], estimatedRows: s.estimatedRows, warnings: [],
    }
    const t = targetByName.get(s.name)
    if (!t) { plan.skipped = 'Table does not exist in the target. Run Structure Sync first.'; return plan }

    plan.key = s.columns.filter(c => c.pkPosition > 0).sort((a, b) => a.pkPosition - b.pkPosition).map(c => c.name)
    if (plan.key.length === 0) { plan.skipped = 'Table has no primary key, so rows cannot be matched.'; return plan }

    const targetCols = new Map(t.columns.map(c => [c.name, c]))
    const missingKey = plan.key.filter(k => !targetCols.has(k))
    if (missingKey.length > 0) { plan.skipped = `Primary key column(s) ${missingKey.join(', ')} missing in the target.`; return plan }

    for (const c of s.columns) {
      const tc = targetCols.get(c.name)
      if (!tc) { plan.warnings.push(`Column ${c.name} does not exist in the target and is not copied`); continue }
      if (c.generated || tc.generated) continue
      plan.columns.push(c.name)
      plan.targetTypes[c.name] = tc.type
      if (tc.identity === 'a') plan.overridingSystemValue = true
      if (tc.ownsSequence) plan.sequenceColumns.push(c.name)
      if (!plan.key.includes(c.name)) {
        if (tc.identity === 'a') plan.warnings.push(`Column ${c.name} is GENERATED ALWAYS in the target; existing rows keep their value`)
        else plan.updateColumns.push(c.name)
      }
    }
    const sourceNames = new Set(s.columns.map(c => c.name))
    for (const tc of t.columns) {
      if (sourceNames.has(tc.name) || tc.generated) continue
      if (tc.notNull && !tc.hasDefault && !tc.identity) {
        plan.warnings.push(`Target-only column ${tc.name} is NOT NULL without a default, so inserts will fail`)
      }
    }

    for (const ref of t.selfReferences) {
      const label = ref.columns.join(', ')
      const problem =
        ref.refColumns.join('\u0000') !== plan.key.join('\u0000') ? 'it references columns other than the primary key'
          : ref.columns.some(c => !plan.updateColumns.includes(c)) ? 'its columns are not all synced'
            : ref.columns.some(c => targetCols.get(c)!.notNull) ? 'its columns are NOT NULL in the target'
              : null
      if (problem) {
        plan.warnings.push(`Self-reference (${label}) can't be deferred because ${problem}; a row pointing at a row that is written later may fail`)
      } else {
        plan.selfReferences.push(ref)
      }
    }
    return plan
  })
}

// Parent tables first (for inserts/updates); reverse it for deletes. Cycles fall back to name order.
export function orderByDependencies(tables: string[], meta: DataTableMeta[]): string[] {
  const refs = new Map(meta.map(m => [m.name, m.references]))
  const wanted = new Set(tables)
  const ordered: string[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (name: string) => {
    if (state.get(name)) return
    state.set(name, 'visiting')
    for (const ref of refs.get(name) ?? []) if (wanted.has(ref)) visit(ref)
    state.set(name, 'done')
    ordered.push(name)
  }
  for (const t of [...tables].sort()) visit(t)
  return ordered
}

// ── SQL builders ──────────────────────────────────────────────────────────────

const q = quoteIdent
const tableRef = (schema: string, table: string) => `${q(schema)}.${q(table)}`
const keyAlias = (i: number) => `__k${i}`

function keyTuple(key: string[]) {
  return key.length === 1 ? q(key[0]) : `(${key.map(q).join(', ')})`
}

function placeholders(count: number, width: number, start = 1) {
  return Array.from({ length: count }, (_, r) =>
    width === 1 ? `$${start + r}` : `(${Array.from({ length: width }, (_, c) => `$${start + r * width + c}`).join(', ')})`)
}

function hashExpr(columns: string[]) {
  return `md5(ROW(${columns.map(q).join(', ')})::text)`
}

function keySelect(key: string[]) {
  return key.map((k, i) => `${q(k)}::text AS ${q(keyAlias(i))}`).join(', ')
}

// Next batch of keys and row hashes after `cursor` (a key tuple), in key order
export function scanSql(schema: string, plan: Pick<TablePlan, 'table' | 'key' | 'columns'>, hasCursor: boolean, limit: number) {
  const where = hasCursor ? ` WHERE ${keyTuple(plan.key)} > ${placeholders(1, plan.key.length)[0]}` : ''
  return `SELECT ${keySelect(plan.key)}, ${hashExpr(plan.columns)} AS "__h" FROM ${tableRef(schema, plan.table)}${where} ORDER BY ${plan.key.map(q).join(', ')} LIMIT ${limit}`
}

export function lookupSql(schema: string, plan: Pick<TablePlan, 'table' | 'key' | 'columns'>, count: number) {
  return `SELECT ${keySelect(plan.key)}, ${hashExpr(plan.columns)} AS "__h" FROM ${tableRef(schema, plan.table)} WHERE ${keyTuple(plan.key)} IN (${placeholders(count, plan.key.length).join(', ')})`
}

export function fetchRowsSql(schema: string, plan: Pick<TablePlan, 'table' | 'key' | 'columns'>, count: number) {
  const cols = plan.columns.map(c => `${q(c)}::text AS ${q(c)}`).join(', ')
  return `SELECT ${keySelect(plan.key)}, ${cols} FROM ${tableRef(schema, plan.table)} WHERE ${keyTuple(plan.key)} IN (${placeholders(count, plan.key.length).join(', ')})`
}

export function insertSql(schema: string, plan: Pick<TablePlan, 'table' | 'columns' | 'overridingSystemValue'>, count: number) {
  const overriding = plan.overridingSystemValue ? ' OVERRIDING SYSTEM VALUE' : ''
  return `INSERT INTO ${tableRef(schema, plan.table)} (${plan.columns.map(q).join(', ')})${overriding} VALUES ${placeholders(count, plan.columns.length).join(', ')}`
}

// VALUES parameters arrive as text, so every value is cast to the target column's type
export function updateSql(schema: string, plan: Pick<TablePlan, 'table' | 'key' | 'updateColumns' | 'targetTypes'>, count: number) {
  const width = plan.key.length + plan.updateColumns.length
  const valueNames = [...plan.key.map((_, i) => keyAlias(i)), ...plan.updateColumns]
  const sets = plan.updateColumns.map(c => `${q(c)} = v.${q(c)}::${plan.targetTypes[c]}`).join(', ')
  const match = plan.key.map((k, i) => `x.${q(k)} = v.${q(keyAlias(i))}::${plan.targetTypes[k]}`).join(' AND ')
  const values = Array.from({ length: count }, (_, r) => `(${Array.from({ length: width }, (_, c) => `$${r * width + c + 1}`).join(', ')})`)
  return `UPDATE ${tableRef(schema, plan.table)} AS x SET ${sets} FROM (VALUES ${values.join(', ')}) AS v(${valueNames.map(q).join(', ')}) WHERE ${match}`
}

// Clears references to rows that are about to be deleted (from those rows and from rows that stay)
export function clearReferencesSql(schema: string, table: string, columns: string[], count: number) {
  return `UPDATE ${tableRef(schema, table)} SET ${columns.map(c => `${q(c)} = NULL`).join(', ')} WHERE ${keyTuple(columns)} IN (${placeholders(count, columns.length).join(', ')})`
}

export function deleteSql(schema: string, plan: Pick<TablePlan, 'table' | 'key'>, count: number) {
  return `DELETE FROM ${tableRef(schema, plan.table)} WHERE ${keyTuple(plan.key)} IN (${placeholders(count, plan.key.length).join(', ')})`
}

// Moves the column's sequence past the highest value now in the table (never backwards)
export function resetSequenceSql(schema: string, table: string, column: string) {
  return `SELECT setval(s.seq, s.max_value) FROM (
    SELECT pg_get_serial_sequence($1, $2)::regclass AS seq, (SELECT max(${q(column)}) FROM ${tableRef(schema, table)})::bigint AS max_value
  ) s WHERE s.seq IS NOT NULL AND s.max_value IS NOT NULL AND s.max_value > coalesce(pg_sequence_last_value(s.seq), 0)`
}

// ── Streaming comparison ──────────────────────────────────────────────────────

export type Row = Record<string, string | null>
export class DataSyncCancelled extends Error { constructor() { super('Cancelled') } }

export const SCAN_BATCH = 5000
export const SAMPLE_LIMIT = 100
// Lookups bind one parameter per key column per row; stay well under PostgreSQL's 65535 limit
const scanBatchSize = (keyLength: number) => Math.min(SCAN_BATCH, Math.floor(60000 / Math.max(1, keyLength)))
// PostgreSQL allows 65535 bind parameters per statement
const writeBatchSize = (width: number) => Math.max(1, Math.min(1000, Math.floor(30000 / Math.max(1, width))))

const keyOf = (row: Record<string, any>, keyLength: number) =>
  JSON.stringify(Array.from({ length: keyLength }, (_, i) => row[keyAlias(i)]))
const keyValues = (keyString: string) => JSON.parse(keyString) as (string | null)[]

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DataSyncCancelled()
}

export interface ScanStep {
  // keys (as JSON strings of text values) found only on the scanned side, and on both sides but different
  onlyHere: string[]
  different: string[]
  identical: number
  scanned: number
}

// Walks `scanned` in key order; for each batch looks the keys up in `other`
async function* scanAgainst(scanned: SqlRunner, scannedSchema: string, other: SqlRunner, otherSchema: string, plan: TablePlan, signal?: AbortSignal): AsyncGenerator<ScanStep> {
  let cursor: (string | null)[] | null = null
  const limit = scanBatchSize(plan.key.length)
  for (;;) {
    checkAbort(signal)
    const batch = (await scanned.query(scanSql(scannedSchema, plan, cursor !== null, limit), cursor ?? [])).rows
    if (batch.length === 0) return
    const keys = batch.map(r => keyOf(r, plan.key.length))
    const found = (await other.query(lookupSql(otherSchema, plan, keys.length), keys.flatMap(keyValues))).rows
    const otherHash = new Map(found.map(r => [keyOf(r, plan.key.length), r.__h as string]))
    const step: ScanStep = { onlyHere: [], different: [], identical: 0, scanned: batch.length }
    batch.forEach((r, i) => {
      const h = otherHash.get(keys[i])
      if (h === undefined) step.onlyHere.push(keys[i])
      else if (h !== r.__h) step.different.push(keys[i])
      else step.identical++
    })
    yield step
    cursor = keyValues(keys[keys.length - 1])
    if (batch.length < limit) return
  }
}

async function fetchRows(runner: SqlRunner, schema: string, plan: TablePlan, keys: string[]): Promise<Map<string, Row>> {
  const result = new Map<string, Row>()
  const size = writeBatchSize(plan.key.length + plan.columns.length)
  for (let i = 0; i < keys.length; i += size) {
    const chunk = keys.slice(i, i + size)
    const rows = (await runner.query(fetchRowsSql(schema, plan, chunk.length), chunk.flatMap(keyValues))).rows
    for (const r of rows) result.set(keyOf(r, plan.key.length), Object.fromEntries(plan.columns.map(c => [c, r[c]])) as Row)
  }
  return result
}

// Rows for the given keys, skipping keys whose row disappeared since it was scanned
const rowsFor = (rows: Map<string, Row>, keys: string[]): Row[] =>
  keys.map(k => rows.get(k)).filter((r): r is Row => r !== undefined)

export interface TableDiff {
  table: string
  sourceRows: number
  targetRows: number
  inserts: number
  updates: number
  deletes: number
  identical: number
  samples: { inserts: Row[]; updates: { source: Row; target: Row }[]; deletes: Row[] }
}

export interface Endpoint { runner: SqlRunner; schema: string }

export async function compareTable(source: Endpoint, target: Endpoint, plan: TablePlan, opts: { signal?: AbortSignal; onProgress?: (scanned: number) => void } = {}): Promise<TableDiff> {
  const diff: TableDiff = { table: plan.table, sourceRows: 0, targetRows: 0, inserts: 0, updates: 0, deletes: 0, identical: 0, samples: { inserts: [], updates: [], deletes: [] } }
  const sample = { inserts: [] as string[], updates: [] as string[], deletes: [] as string[] }
  let scanned = 0

  for await (const step of scanAgainst(source.runner, source.schema, target.runner, target.schema, plan, opts.signal)) {
    diff.sourceRows += step.scanned
    diff.inserts += step.onlyHere.length
    diff.updates += step.different.length
    diff.identical += step.identical
    sample.inserts.push(...step.onlyHere.slice(0, SAMPLE_LIMIT - sample.inserts.length))
    sample.updates.push(...step.different.slice(0, SAMPLE_LIMIT - sample.updates.length))
    opts.onProgress?.(scanned += step.scanned)
  }
  for await (const step of scanAgainst(target.runner, target.schema, source.runner, source.schema, plan, opts.signal)) {
    diff.targetRows += step.scanned
    diff.deletes += step.onlyHere.length
    sample.deletes.push(...step.onlyHere.slice(0, SAMPLE_LIMIT - sample.deletes.length))
    opts.onProgress?.(scanned += step.scanned)
  }

  checkAbort(opts.signal)
  const [srcRows, dstRows] = await Promise.all([
    fetchRows(source.runner, source.schema, plan, [...sample.inserts, ...sample.updates]),
    fetchRows(target.runner, target.schema, plan, [...sample.updates, ...sample.deletes]),
  ])
  diff.samples.inserts = rowsFor(srcRows, sample.inserts)
  diff.samples.updates = sample.updates.flatMap(k => {
    const s = srcRows.get(k)
    const t = dstRows.get(k)
    return s && t ? [{ source: s, target: t }] : []
  })
  diff.samples.deletes = rowsFor(dstRows, sample.deletes)
  return diff
}

// ── Apply ─────────────────────────────────────────────────────────────────────

export interface TableOps { insert: boolean; update: boolean; delete: boolean }
export interface ApplyResult { inserted: number; updated: number; deleted: number }

async function writeRows(target: Endpoint, plan: TablePlan, rows: Row[], mode: 'insert' | 'update', keysByRow?: string[]) {
  if (rows.length === 0) return
  const width = mode === 'insert' ? plan.columns.length : plan.key.length + plan.updateColumns.length
  const size = writeBatchSize(width)
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size)
    if (mode === 'insert') {
      await target.runner.query(insertSql(target.schema, plan, chunk.length), chunk.flatMap(r => plan.columns.map(c => r[c])))
    } else {
      const chunkKeys = keysByRow!.slice(i, i + size)
      const params = chunk.flatMap((r, j) => [...keyValues(chunkKeys[j]), ...plan.updateColumns.map(c => r[c])])
      await target.runner.query(updateSql(target.schema, plan, chunk.length), params)
    }
  }
}

// Inserts source-only rows and updates changed rows. The target runner should be a transaction
// session so all batches commit or roll back together.
export async function applyUpserts(source: Endpoint, target: Endpoint, plan: TablePlan, ops: TableOps, opts: { signal?: AbortSignal; onProgress?: (scanned: number) => void } = {}): Promise<ApplyResult> {
  const result: ApplyResult = { inserted: 0, updated: 0, deleted: 0 }
  if (!ops.insert && !ops.update) return result
  const canUpdate = ops.update && plan.updateColumns.length > 0

  // Self-references are written as NULL first and filled in after the whole table is written, so
  // a row may point at a row that comes later in key order (e.g. UUID keys). Only rows that
  // actually reference something are remembered.
  const selfRefColumns = plan.selfReferences.flatMap(r => r.columns)
  const deferred = new Map<string, Row>()
  const deferSelfRefs = (key: string, row: Row): Row => {
    if (selfRefColumns.length === 0) return row
    if (selfRefColumns.some(c => row[c] !== null)) deferred.set(key, Object.fromEntries(selfRefColumns.map(c => [c, row[c]])))
    return { ...row, ...Object.fromEntries(selfRefColumns.map(c => [c, null])) }
  }

  let scanned = 0
  for await (const step of scanAgainst(source.runner, source.schema, target.runner, target.schema, plan, opts.signal)) {
    const insertKeys = ops.insert ? step.onlyHere : []
    const updateKeys = canUpdate ? step.different : []
    if (insertKeys.length + updateKeys.length > 0) {
      const rows = await fetchRows(source.runner, source.schema, plan, [...insertKeys, ...updateKeys])
      checkAbort(opts.signal)
      const insKeys = insertKeys.filter(k => rows.has(k))
      await writeRows(target, plan, insKeys.map(k => deferSelfRefs(k, rows.get(k)!)), 'insert')
      const updKeys = updateKeys.filter(k => rows.has(k))
      await writeRows(target, plan, updKeys.map(k => deferSelfRefs(k, rows.get(k)!)), 'update', updKeys)
      result.inserted += insKeys.length
      result.updated += updKeys.length
    }
    opts.onProgress?.(scanned += step.scanned)
  }
  if (deferred.size > 0) {
    checkAbort(opts.signal)
    const keys = [...deferred.keys()]
    await writeRows(target, { ...plan, updateColumns: selfRefColumns }, keys.map(k => deferred.get(k)!), 'update', keys)
  }
  if (result.inserted > 0) {
    for (const column of plan.sequenceColumns) {
      await target.runner.query(resetSequenceSql(target.schema, plan.table, column), [tableRef(target.schema, plan.table), column])
    }
  }
  return result
}

export async function applyDeletes(source: Endpoint, target: Endpoint, plan: TablePlan, opts: { signal?: AbortSignal; onProgress?: (scanned: number) => void } = {}): Promise<number> {
  let deleted = 0
  let scanned = 0
  const size = writeBatchSize(plan.key.length)
  for await (const step of scanAgainst(target.runner, target.schema, source.runner, source.schema, plan, opts.signal)) {
    for (let i = 0; i < step.onlyHere.length; i += size) {
      const chunk = step.onlyHere.slice(i, i + size)
      const params = chunk.flatMap(keyValues)
      // Rows (deleted or kept) still pointing at the rows being deleted would block the delete
      for (const ref of plan.selfReferences) {
        await target.runner.query(clearReferencesSql(target.schema, plan.table, ref.columns, chunk.length), params)
      }
      const res = await target.runner.query(deleteSql(target.schema, plan, chunk.length), params)
      deleted += res.rowCount
    }
    opts.onProgress?.(scanned += step.scanned)
  }
  return deleted
}

export interface DeployTable { plan: TablePlan; ops: TableOps }
export interface DeployProgress { table: string; phase: 'delete' | 'upsert'; scanned: number; estimatedRows: number | null }

// Runs every selected table against a target that is already inside one transaction: deletes
// child tables first, then inserts/updates parent tables first, so foreign keys hold at each step.
export async function deployData(source: Endpoint, target: Endpoint, tables: DeployTable[], targetMeta: DataTableMeta[], opts: { signal?: AbortSignal; onProgress?: (p: DeployProgress) => void } = {}): Promise<Record<string, ApplyResult>> {
  const byName = new Map(tables.map(t => [t.plan.table, t]))
  const parentFirst = orderByDependencies([...byName.keys()], targetMeta)
  const results: Record<string, ApplyResult> = Object.fromEntries(parentFirst.map(t => [t, { inserted: 0, updated: 0, deleted: 0 }]))

  for (const name of [...parentFirst].reverse()) {
    const { plan, ops } = byName.get(name)!
    if (!ops.delete) continue
    results[name].deleted = await applyDeletes(source, target, plan, {
      signal: opts.signal,
      onProgress: scanned => opts.onProgress?.({ table: name, phase: 'delete', scanned, estimatedRows: plan.estimatedRows }),
    })
  }
  for (const name of parentFirst) {
    const { plan, ops } = byName.get(name)!
    const r = await applyUpserts(source, target, plan, ops, {
      signal: opts.signal,
      onProgress: scanned => opts.onProgress?.({ table: name, phase: 'upsert', scanned, estimatedRows: plan.estimatedRows }),
    })
    results[name].inserted = r.inserted
    results[name].updated = r.updated
  }
  return results
}
