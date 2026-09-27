// Undo for saved table data changes. Each save or delete records what it changed: the rows before
// and after. Undoing replays the reverse in one transaction, after checking the rows still look the
// way the change left them, so someone else's later edit isn't silently overwritten.
import { quoteIdent } from './grid-copy'

export type Row = Record<string, unknown>
export type UndoEngine = 'postgres' | 'mysql' | 'sqlite'

export type UndoStep =
  // `before` / `after`: the edited columns only; `key`: the row's primary key after the change
  | { kind: 'update'; key: Row; before: Row; after: Row }
  // `after`: the column values known after the insert (all of them when the database returned the row)
  | { kind: 'insert'; key: Row; after: Row }
  // The whole deleted row
  | { kind: 'delete'; row: Row }

export interface DataChange {
  id: string
  at: number
  label: string // e.g. "Edited 2 rows"
  engine: UndoEngine
  schema: string
  table: string
  primaryKeys: string[]
  // Postgres json/jsonb columns: their values go back as JSON text (a JS array would become a Postgres array)
  jsonColumns: string[]
  steps: UndoStep[]
}

export interface UndoTx {
  query(sql: string, params?: unknown[]): Promise<{ ok: boolean; rows?: Row[]; rowCount?: number | null; error?: string }>
}

export type UndoResult =
  | { ok: true; skipped: string[] }
  | { ok: false; conflicts: string[] }
  | { ok: false; error: string }

export const tableKeyOf = (connId: string, database: string | null | undefined, schema: string, table: string) =>
  JSON.stringify([connId, database ?? '', schema, table])

// Values compared as the drivers return them: the snapshot and the re-read come from the same driver
function norm(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (v instanceof Date) return `d:${v.getTime()}`
  if (v instanceof Uint8Array) return `b:${Array.from(v).join(',')}`
  if (typeof v === 'object') return `j:${JSON.stringify(v)}`
  return `s:${String(v)}`
}
export const sameValue = (a: unknown, b: unknown) => norm(a) === norm(b)

export const keyText = (key: Row) => Object.entries(key).map(([k, v]) => `${k}=${v instanceof Date ? v.toISOString() : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`).join(', ')

export function describeStep(step: UndoStep): string {
  if (step.kind === 'update') return `restore ${Object.keys(step.before).join(', ')} of row ${keyText(step.key)}`
  if (step.kind === 'insert') return `delete inserted row ${keyText(step.key)}`
  return `re-insert deleted row ${keyText(pickKey(step.row, Object.keys(step.row)))}`
}

function pickKey(row: Row, keys: string[]): Row {
  return Object.fromEntries(keys.map(k => [k, row[k]]))
}

// The statements, exported for tests
export function undoSql(change: DataChange) {
  const dialect = change.engine === 'mysql' ? 'mysql' : 'postgres'
  const q = quoteIdent(dialect)
  const target = `${q(change.schema)}.${q(change.table)}`
  const builder = () => {
    const params: unknown[] = []
    const ph = (col: string, v: unknown) => { params.push(toParam(change, col, v)); return dialect === 'mysql' ? '?' : `$${params.length}` }
    return { params, ph }
  }
  const where = (key: Row, ph: (c: string, v: unknown) => string) =>
    change.primaryKeys.map(pk => `${q(pk)} = ${ph(pk, key[pk])}`).join(' AND ')
  return {
    select(key: Row) {
      const { params, ph } = builder()
      const lock = change.engine === 'sqlite' ? '' : ' FOR UPDATE'
      return { sql: `SELECT * FROM ${target} WHERE ${where(key, ph)}${lock}`, params }
    },
    update(key: Row, values: Row) {
      const { params, ph } = builder()
      const sets = Object.entries(values).map(([c, v]) => `${q(c)} = ${ph(c, v)}`).join(', ')
      return { sql: `UPDATE ${target} SET ${sets} WHERE ${where(key, ph)}`, params }
    },
    delete(key: Row) {
      const { params, ph } = builder()
      return { sql: `DELETE FROM ${target} WHERE ${where(key, ph)}`, params }
    },
    insert(row: Row) {
      const { params, ph } = builder()
      const cols = Object.keys(row)
      // Identity columns keep the row's original id
      const overriding = change.engine === 'postgres' ? ' OVERRIDING SYSTEM VALUE' : ''
      return { sql: `INSERT INTO ${target} (${cols.map(q).join(', ')})${overriding} VALUES (${cols.map(c => ph(c, row[c])).join(', ')})`, params }
    },
    // Columns computed by the database, which can't be written
    generatedColumns() {
      if (change.engine === 'postgres') return { sql: `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND is_generated = 'ALWAYS'`, params: [change.schema, change.table] }
      if (change.engine === 'mysql') return { sql: `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND EXTRA LIKE '%GENERATED%'`, params: [change.schema, change.table] }
      return { sql: `SELECT name AS c FROM pragma_table_xinfo($1, $2) WHERE hidden IN (2, 3)`, params: [change.table, change.schema] }
    },
  }
}

function toParam(change: DataChange, col: string, v: unknown): unknown {
  if (v === undefined) return null
  if (v === null || v instanceof Date || v instanceof Uint8Array || typeof v !== 'object') return v
  // Postgres arrays go as JS arrays (the driver writes array literals); JSON goes as text
  if (change.engine === 'postgres' && !change.jsonColumns.includes(col)) return v
  return JSON.stringify(v)
}

// Runs inside a transaction the caller opens and then commits (ok) or rolls back (anything else).
// Conflicts, rows changed or deleted since, stop it unless `force`; with `force` a deleted row is
// skipped and a changed one is restored anyway.
export async function undoChange(tx: UndoTx, change: DataChange, opts: { force?: boolean } = {}): Promise<UndoResult> {
  const sql = undoSql(change)
  const conflicts: string[] = []
  const skipped: string[] = []
  let generated: string[] | undefined

  const run = async (s: { sql: string; params: unknown[] }) => {
    const res = await tx.query(s.sql, s.params)
    if (!res.ok) throw new Error(res.error ?? 'Unknown error')
    return res
  }

  try {
    for (const step of [...change.steps].reverse()) {
      if (step.kind === 'delete') {
        if (!generated) generated = ((await run(sql.generatedColumns())).rows ?? []).map(r => String(r.c))
        const row = Object.fromEntries(Object.entries(step.row).filter(([c]) => !generated!.includes(c)))
        try {
          await run(sql.insert(row))
        } catch (err) {
          const key = keyText(pickKey(step.row, change.primaryKeys))
          throw new Error(`Couldn't re-insert row ${key}: ${err instanceof Error ? err.message : String(err)}`)
        }
        continue
      }
      const current = (await run(sql.select(step.key))).rows?.[0]
      const label = keyText(step.key)
      if (!current) {
        // An inserted row that is already gone needs nothing
        if (step.kind === 'insert') { skipped.push(`row ${label} was already deleted`); continue }
        if (opts.force) { skipped.push(`row ${label} no longer exists`); continue }
        conflicts.push(`row ${label} no longer exists`)
        continue
      }
      const changed = Object.keys(step.after).filter(c => c in current && !sameValue(current[c], step.after[c]))
      if (changed.length > 0 && !opts.force) {
        conflicts.push(`row ${label} was changed since (${changed.join(', ')})`)
        continue
      }
      if (step.kind === 'update') await run(sql.update(step.key, step.before))
      else await run(sql.delete(step.key))
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  if (conflicts.length > 0) return { ok: false, conflicts }
  return { ok: true, skipped }
}

// Recording ------------------------------------------------------------------------------------

export interface SavedRow {
  // Undefined for a new row
  before?: Row
  // The row as the database returned it after the save (may be empty: MySQL inserts)
  after: Row
  // The staged values: column -> text (null for NULL)
  edits: Row
}

// Turns the rows a save wrote into undo steps. Rows whose key can't be told are left out (MySQL
// inserts without RETURNING, with a key the user didn't type); `unrecorded` counts them.
export function stepsFromSave(primaryKeys: string[], rows: SavedRow[]): { steps: UndoStep[]; unrecorded: number } {
  const steps: UndoStep[] = []
  let unrecorded = 0
  for (const r of rows) {
    const hasAfter = Object.keys(r.after).length > 0
    const known: Row = hasAfter ? r.after : r.edits
    if (!primaryKeys.every(pk => known[pk] !== undefined && known[pk] !== null)) { unrecorded++; continue }
    const key = pickKey(known, primaryKeys)
    // Typed text doesn't compare with what the database returns (dates, numbers), so without the
    // saved row only the key is checked
    if (!r.before) { steps.push({ kind: 'insert', key, after: hasAfter ? r.after : key }); continue }
    const cols = Object.keys(r.edits)
    steps.push({
      kind: 'update',
      key,
      before: Object.fromEntries(cols.map(c => [c, r.before![c]])),
      after: hasAfter ? Object.fromEntries(cols.map(c => [c, r.after[c]])) : {},
    })
  }
  return { steps, unrecorded }
}

export function changeLabel(steps: UndoStep[]): string {
  const n = (kind: UndoStep['kind']) => steps.filter(s => s.kind === kind).length
  const part = (count: number, verb: string) => count ? `${verb} ${count} row${count === 1 ? '' : 's'}` : ''
  const text = [part(n('update'), 'edited'), part(n('insert'), 'inserted'), part(n('delete'), 'deleted')].filter(Boolean).join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}
