// SQL for whole-table operations offered in the table designer (PostgreSQL and MySQL).

export type TableDbType = 'postgres' | 'mysql'
export type TableActionKind = 'rename' | 'duplicate' | 'empty' | 'truncate' | 'drop' | 'analyze' | 'vacuum' | 'reindex' | 'optimize'

export interface TableActionOptions {
  newName?: string          // rename / duplicate
  withData?: boolean        // duplicate
  cascade?: boolean         // truncate / drop (PostgreSQL)
  restartIdentity?: boolean // truncate (PostgreSQL)
  full?: boolean            // vacuum FULL (PostgreSQL)
}

export interface TableColumnInfo { name: string; generated: boolean; identity: '' | 'a' | 'd' }

export const quoteIdentFor = (dbType: TableDbType) => dbType === 'mysql'
  ? (s: string) => '`' + s.replace(/`/g, '``') + '`'
  : (s: string) => '"' + s.replace(/"/g, '""') + '"'

const quoteLiteral = (s: string) => "'" + s.replace(/'/g, "''") + "'"

export function tableActionAvailable(dbType: TableDbType, kind: TableActionKind) {
  if (kind === 'vacuum' || kind === 'reindex') return dbType === 'postgres'
  if (kind === 'optimize') return dbType === 'mysql'
  return true
}

// Actions that can't run inside a transaction block
export const runsOutsideTransaction = (kind: TableActionKind) => kind === 'vacuum'

// MySQL commits these immediately (implicit commit), so a transaction can't undo them
export const mysqlAutoCommits = (kind: TableActionKind) => kind === 'truncate' || kind === 'drop' || kind === 'rename' || kind === 'duplicate'

// ── Cancellable transactional execution ───────────────────────────────────────

export interface TxSession {
  query(sql: string): Promise<void>
  close(commit: boolean): Promise<void>
  cancel(): Promise<void> // interrupts the statement currently running on the server
}

export class ActionCancelled extends Error {
  constructor() { super('Cancelled') }
}

export interface ActionRun {
  done: Promise<void>
  cancel: () => void
}

// Runs the statements in one transaction and commits only if all succeed. cancel() interrupts the
// running statement and rolls back; once the commit has started it is too late and is ignored.
export function runInTransaction(open: () => Promise<TxSession>, statements: string[], onCommitting?: () => void): ActionRun {
  let cancelled = false
  let committing = false
  let session: TxSession | undefined

  const done = (async () => {
    const opened = await open()
    session = opened
    try {
      for (const sql of statements) {
        if (cancelled) throw new ActionCancelled()
        try { await opened.query(sql) } catch (err) { throw cancelled ? new ActionCancelled() : err }
      }
      if (cancelled) throw new ActionCancelled()
      committing = true
      onCommitting?.()
      await opened.close(true)
      session = undefined
    } finally {
      if (session) await session.close(false).catch(() => {})
    }
  })()

  return {
    done,
    cancel: () => {
      if (committing || cancelled) return
      cancelled = true
      void session?.cancel().catch(() => {})
    },
  }
}

export function tableActionStatements(
  dbType: TableDbType,
  schema: string,
  table: string,
  kind: TableActionKind,
  opts: TableActionOptions = {},
  columns: TableColumnInfo[] = [],
): string[] {
  const q = quoteIdentFor(dbType)
  const ref = (name: string) => `${q(schema)}.${q(name)}`
  const target = ref(table)
  const newName = opts.newName?.trim() ?? ''
  if ((kind === 'rename' || kind === 'duplicate') && !newName) throw new Error('Enter a table name')

  switch (kind) {
    case 'rename':
      return dbType === 'mysql' ? [`RENAME TABLE ${target} TO ${ref(newName)}`] : [`ALTER TABLE ${target} RENAME TO ${q(newName)}`]

    case 'duplicate': {
      const copy = ref(newName)
      const statements = [dbType === 'mysql' ? `CREATE TABLE ${copy} LIKE ${target}` : `CREATE TABLE ${copy} (LIKE ${target} INCLUDING ALL)`]
      if (opts.withData) {
        // Generated columns are computed by the copy itself and can't be inserted
        const cols = columns.filter(c => !c.generated)
        if (cols.length === 0) throw new Error('Column list is not loaded yet')
        const list = cols.map(c => q(c.name)).join(', ')
        const overriding = cols.some(c => c.identity === 'a') ? ' OVERRIDING SYSTEM VALUE' : ''
        statements.push(`INSERT INTO ${copy} (${list})${overriding} SELECT ${list} FROM ${target}`)
        // LIKE ... INCLUDING ALL gives identity columns a fresh sequence; move it past the copied values
        for (const c of cols.filter(c => c.identity)) {
          statements.push(`SELECT setval(pg_get_serial_sequence(${quoteLiteral(copy)}, ${quoteLiteral(c.name)}), max(${q(c.name)})) FROM ${copy} HAVING max(${q(c.name)}) IS NOT NULL`)
        }
      }
      return statements
    }

    case 'empty':
      return [`DELETE FROM ${target}`]

    case 'truncate':
      return dbType === 'mysql'
        ? [`TRUNCATE TABLE ${target}`]
        : [`TRUNCATE TABLE ${target}${opts.restartIdentity ? ' RESTART IDENTITY' : ''}${opts.cascade ? ' CASCADE' : ''}`]

    case 'drop':
      return [`DROP TABLE ${target}${dbType === 'postgres' && opts.cascade ? ' CASCADE' : ''}`]

    case 'analyze':
      return [dbType === 'mysql' ? `ANALYZE TABLE ${target}` : `ANALYZE ${target}`]

    case 'vacuum':
      return [`VACUUM (${opts.full ? 'FULL, ' : ''}ANALYZE) ${target}`]

    case 'reindex':
      return [`REINDEX TABLE ${target}`]

    case 'optimize':
      return [`OPTIMIZE TABLE ${target}`]
  }
}

export const TABLE_COLUMNS_SQL: Record<TableDbType, string> = {
  postgres: `
    SELECT a.attname AS name, a.attgenerated <> '' AS generated, a.attidentity::text AS identity
    FROM pg_attribute a
    WHERE a.attrelid = (quote_ident($1) || '.' || quote_ident($2))::regclass AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum`,
  mysql: `
    SELECT COLUMN_NAME AS name, EXTRA LIKE '%GENERATED%' AS \`generated\`, '' AS identity
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
    ORDER BY ORDINAL_POSITION`,
}

export const TABLE_STATS_SQL: Record<TableDbType, string> = {
  postgres: `
    SELECT GREATEST(c.reltuples, 0)::bigint AS row_estimate, pg_total_relation_size(c.oid) AS total_bytes
    FROM pg_class c WHERE c.oid = (quote_ident($1) || '.' || quote_ident($2))::regclass`,
  mysql: `
    SELECT TABLE_ROWS AS row_estimate, DATA_LENGTH + INDEX_LENGTH AS total_bytes
    FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
}

export function formatBytes(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`
}
