'use client'

import React, { useState, useCallback, useEffect, useLayoutEffect, useRef, useImperativeHandle, useMemo } from 'react'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import {
  Database, Table2, FunctionSquare, ChevronRight, ChevronDown,
  Plus, Play, PlugZap, FileCode2, RefreshCw, X, FileText, Loader2, View, Pencil, Save, FileCode, Search, Plug,
  Circle, Wrench, Check, Workflow, Key, Minus, Download, Sparkles, Braces, Clock, AlignLeft, AlignCenter, AlignRight, Shield, Tag, Shapes, AlertTriangle,
  GitCompareArrows, DatabaseZap, Link2, Leaf, KeyRound, SquareTerminal, Copy, ClipboardPaste, Trash2, ArrowUp, ArrowDown, Undo2, CircleSlash, ExternalLink, Palette, CalendarDays,
  Blocks, FolderPlus, Eraser, Scissors, CopyPlus, Gauge, Brush, FileDown, FileOutput, FileInput, FileUp,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { StructureSyncView, initialSyncState, type StructureSyncConfig, type StructureSyncState } from '@/components/structure-sync'
import { DataSyncView, initialDataSyncState, type DataSyncConfig, type DataSyncState } from '@/components/data-sync'
import { quenceTheme } from '@/components/sql-highlight'
import { changesSchema, parseCreateRoutine } from '@/lib/sql-routine'
import { DATABASE_INFO_SQL, MAINTENANCE_LABELS, buildDropDatabase, maintenanceSql, parseDatabaseInfo, type DatabaseSettings, type MaintenanceKind } from '@/lib/database-admin'
import { DatabaseDialog, DropDatabaseDialog, ExtensionsDialog, SchemaDialog, type RunSql } from '@/components/database-admin-dialogs'
import { sqlEditorLanguage, sqlNavigation, type FunctionInfo, type SqlEditorLanguageConfig, type SqlTarget } from '@/lib/sql-completion'
import { mongoEditorLanguage } from '@/lib/mongo-completion'
import { FOREIGN_KEYS_SQL, parseForeignKeys, type FkRef } from '@/lib/fk-lookup'
import { queryLanguageMismatch } from '@/lib/query-language'
import { quoteMixedCaseIdentifiers } from '@/lib/pg-identifiers'
import { connectionColor, environmentInfo, parseConnectionOptions, safeRunEnabled, type ConnectionOptions } from '@/lib/connection-options'
import { cannotRollBack, classifyStatement, mongoScriptWrites, previewWrap, PREVIEW_ROWS, PREVIEW_TOTAL_COLUMN } from '@/lib/safe-run'
import { ConfirmHost, confirmAction } from '@/components/confirm-dialog'
import { RedisBrowser } from '@/components/redis-browser'
import { RedisConsole } from '@/components/redis-console'
import { ConnectionTagFields, EnvironmentBadge } from '@/components/connection-tag-fields'
import { buildInsertStatement, buildUpdateStatement, cellText as cellEditText, quoteIdent, rowsToTsv } from '@/lib/grid-copy'
import { BSON_TYPE_LABELS, MONGO_TYPE_OPTIONS, buildMongoCellScript, buildMongoSetScript, mongoIdFilter, type MongoCellEdit } from '@/lib/mongo-cell'
import { ContextMenuAt, type MenuEntry } from '@/components/context-menu'
import { McpBridge, type McpAppApi } from '@/components/mcp-bridge'
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { HIGHLIGHT_KINDS, HIGHLIGHT_LABELS, cellHighlightKind, highlightStore, serverSnapshot as highlightServerSnapshot } from '@/lib/type-highlight'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { FkLookupPopover, type FkLookupTarget } from '@/components/fk-lookup'
import { DatePickerPopover } from '@/components/date-picker'
import { cellDateKind, dateColumnKind, formatCellDate, parseCellDate, type DateColumnKind } from '@/lib/date-cell'
import { ActionDialog, TableActionsBar, createStatement, tableActionTitle, type TableChange, type TableRef } from '@/components/table-actions'
import { tableActionAvailable, type TableActionKind, type TableActionOptions } from '@/lib/table-actions'
import { ExportDialog, type ExportPreset } from '@/components/table-export'
import { DatabaseExportDialog, MongoExportDialog, MongoImportDialog, SqlFileImportDialog } from '@/components/database-transfer'
import { TableImportDialog } from '@/components/table-import'
import { generateId } from '@/lib/utils'
import { toast } from 'sonner'
import { EditorView, keymap, placeholder as cmPlaceholder, Decoration, DecorationSet, ViewPlugin, ViewUpdate } from '@codemirror/view'
import { EditorState, StateEffect, StateField, RangeSetBuilder, Compartment } from '@codemirror/state'
import { sql, PostgreSQL, SQLNamespace } from '@codemirror/lang-sql'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting } from '@codemirror/language'
import { classHighlighter } from '@lezer/highlight'
import { SearchCursor } from '@codemirror/search'
import { autocompletion, closeBrackets, completionKeymap, closeBracketsKeymap } from '@codemirror/autocomplete'

// ── Types ─────────────────────────────────────────────────────────────────────

// SQL builders written for PostgreSQL or MySQL: SQLite reads PostgreSQL's quoting, NULLS LAST,
// RETURNING and (translated by the driver) $1 placeholders
function sqlDialectOf(dbType: 'postgres' | 'mysql' | 'sqlite' | 'redis'): 'postgres' | 'mysql' {
  return dbType === 'mysql' ? 'mysql' : 'postgres'
}

// Redis databases are db0, db1, … (the sidebar lists them; a click opens the key browser)
export const redisDbIndex = (name: string | null | undefined) => Number(/^db(\d+)$/.exec(name ?? '')?.[1] ?? 0)

function redisIpc() {
  const r = window.electronAPI!.redis
  return {
    connect: (opts: Record<string, unknown>) => r.connect(opts as never),
    disconnect: (id: string) => r.disconnect(id),
    introspect: async (id: string) => {
      const res = await r.databases(id)
      if (!res.ok) return { ok: false as const, error: res.error, databases: undefined }
      // Databases with keys, and db0 even when empty
      return { ok: true as const, databases: (res.databases ?? []).filter(d => d.keys > 0 || d.index === 0).map(d => `db${d.index}`) }
    },
    introspectDb: async () => ({ ok: true as const, tables: [], columns: [], functions: [], enums: [], types: [] }),
    query: async (id: string, line: string, database?: string) => {
      const res = await r.command(id, redisDbIndex(database), line)
      return res.ok
        ? { ok: true as const, rows: [{ reply: res.reply }], fields: ['reply'], rowCount: 1, ms: res.ms ?? 0 }
        : { ok: false as const, error: res.error }
    },
  }
}

function getIpc(dbType: 'postgres' | 'mysql' | 'mongodb' | 'sqlite' | 'redis') {
  if (dbType === 'redis') return redisIpc() as unknown as NonNullable<Window['electronAPI']>['sqlite']
  if (dbType === 'sqlite') return window.electronAPI!.sqlite
  if (dbType === 'mongodb') return window.electronAPI!.mongodb
  if (dbType === 'mysql') return window.electronAPI!.mysql
  return window.electronAPI!.pg
}

export interface DbConnection {
  id: string
  dbType: 'postgres' | 'mysql' | 'mongodb' | 'sqlite' | 'redis'
  label: string   // user-defined display name
  name: string    // auto-generated "host:port / db"
  host: string
  port: number
  database: string
  user: string
  password: string
  ssl: boolean
  vpnConfigPath?: string
  vpnUsername?: string
  vpnPassword?: string
  // Environment, color, Safe Run and SSH (lib/connection-options); SSH secrets are kept apart
  options?: ConnectionOptions
  sshPassword?: string
  sshPassphrase?: string
  status: 'connected' | 'connecting' | 'disconnected' | 'error'
  errorMsg?: string
  databases: DbDatabase[]
}

interface DbDatabase {
  name: string
  open: boolean
  loading: boolean
  loaded?: boolean
  error?: string
  schemas: SchemaEntry[]
}

const SCHEMA_PRELOAD_CONCURRENCY = 3

interface ColumnInfo { name: string; type: string; nullable?: boolean }

interface SchemaEntry {
  name: string
  tables: { name: string; type: string }[]
  views: { name: string; type: string }[]
  materializedViews: { name: string; type: string }[]
  functions: { name: string; arguments: string }[]
  enums: { name: string; values: string[] }[]
  types: { name: string; definition: string }[]
  columns: Record<string, ColumnInfo[]>
  open: boolean
}

export function buildSchemaEntries(tables: any[] = [], functions: any[] = [], enums: any[] = [], types: any[] = [], columns: any[] = []): SchemaEntry[] {
  const schemaMap = new Map<string, SchemaEntry>()

  function getOrCreate(schema: string): SchemaEntry {
    if (!schemaMap.has(schema)) {
      schemaMap.set(schema, { name: schema, tables: [], views: [], materializedViews: [], functions: [], enums: [], types: [], columns: {}, open: true })
    }
    return schemaMap.get(schema)!
  }

  for (const t of tables) {
    const entry = getOrCreate(t.table_schema)
    if (t.table_type === 'BASE TABLE') entry.tables.push({ name: t.table_name, type: 'TABLE' })
    else if (t.table_type === 'VIEW') entry.views.push({ name: t.table_name, type: 'VIEW' })
    else if (t.table_type === 'MATERIALIZED VIEW') entry.materializedViews.push({ name: t.table_name, type: 'MATERIALIZED VIEW' })
  }
  for (const f of functions) {
    const entry = getOrCreate(f.routine_schema)
    if (!entry.functions.some(item => item.name === f.routine_name && item.arguments === (f.arguments ?? ''))) {
      entry.functions.push({ name: f.routine_name, arguments: f.arguments ?? '' })
    }
  }
  for (const e of enums) {
    const entry = getOrCreate(e.schema)
    const values = typeof e.values === 'string' ? e.values.split(',') : (e.values ?? [])
    entry.enums.push({ name: e.name, values })
  }
  for (const t of types) {
    const entry = getOrCreate(t.schema)
    entry.types.push({ name: t.name, definition: t.definition })
  }
  for (const c of columns) {
    const entry = getOrCreate(c.table_schema)
    if (!entry.columns[c.table_name]) entry.columns[c.table_name] = []
    entry.columns[c.table_name].push({ name: c.column_name, type: c.data_type })
  }
  return [...schemaMap.values()]
}

// Builds a CodeMirror SQL `schema` namespace (schema → table → columns) for autocomplete.
export function buildSqlNamespace(schemas: SchemaEntry[]): SQLNamespace {
  const namespace: Record<string, SQLNamespace> = {}
  for (const schema of schemas) {
    const tablesNs: Record<string, readonly string[]> = {}
    for (const t of [...schema.tables, ...schema.views, ...schema.materializedViews]) {
      tablesNs[t.name] = (schema.columns[t.name] ?? []).map(c => c.name)
    }
    namespace[schema.name] = tablesNs
  }
  return namespace
}

const POSTGRES_TYPES = [
  'varchar', 'text', 'integer', 'bigint', 'boolean', 'numeric', 'timestamp',
  'timestamptz', 'date', 'time', 'json', 'jsonb', 'uuid', 'bytea', 'xml',
  'double precision', 'real', 'smallint', 'serial', 'bigserial'
]

interface DesignColumn {
  id: string
  name: string
  type: string
  length: string
  decimal: string
  nullable: boolean
  isPrimaryKey: boolean
  isForeignKey: boolean
  defaultValue: string
  originalName?: string
}

interface DesignIndex {
  id: string
  name: string
  columns: string[]
  isUnique: boolean
  isPrimary: boolean
  definition?: string
  isNew?: boolean
}

interface DesignForeignKey {
  id: string
  constraintName: string
  columnName: string
  foreignTableSchema: string
  foreignTableName: string
  foreignColumnName: string
  updateRule: string
  deleteRule: string
  isNew?: boolean
}

interface DesignUnique {
  id: string
  constraintName: string
  columnName: string
  isNew?: boolean
}

interface DesignTrigger {
  id: string
  triggerName: string
  actionStatement: string
  eventManipulation: string
  actionTiming: string
  actionOrientation: string
  isNew?: boolean
}

interface ErdTableColumn {
  name: string
  type: string
  isPrimaryKey: boolean
  isForeignKey: boolean
  nullable: boolean
}

interface ErdTable {
  name: string
  columns: ErdTableColumn[]
  x: number
  y: number
}

interface ErdRelation {
  localTable: string
  localColumn: string
  foreignTable: string
  foreignColumn: string
}

export interface QueryTab {
  id: string
  kind: 'query' | 'table' | 'design' | 'erd' | 'create-table' | 'create-view' | 'structure-sync' | 'data-sync' | 'redis-browser' | 'redis-console'
  title: string
  sql: string
  results: QueryResult[]
  running: boolean
  connectionId: string | null
  databaseName: string | null
  schemaName?: string
  tableName?: string
  dbType?: 'postgres' | 'mysql' | 'mongodb' | 'sqlite' | 'redis'
  page?: number
  pageSize?: number
  totalRows?: number
  columnTypes?: ColumnInfo[]
  isFunction?: boolean
  functionArguments?: string
  originalSql?: string

  // Design Tab Properties
  designActiveTab?: 'fields' | 'indexes' | 'fkeys' | 'uniques' | 'triggers'
  originalColumns?: DesignColumn[]
  columns?: DesignColumn[]
  originalIndexes?: DesignIndex[]
  indexes?: DesignIndex[]
  originalForeignKeys?: DesignForeignKey[]
  foreignKeys?: DesignForeignKey[]
  originalUniques?: DesignUnique[]
  uniques?: DesignUnique[]
  originalTriggers?: DesignTrigger[]
  triggers?: DesignTrigger[]

  // ERD Properties
  erdTables?: ErdTable[]
  erdRelations?: ErdRelation[]

  // Table tab editing — keyed by cellEditKey(rowIndex, col); rowIndex indexes results[0].rows
  primaryKeys?: string[]
  pendingEdits?: Record<string, CellEdit>
  savingEdits?: boolean
  editError?: { rowIndex: number; message: string }
  // Set when inserting a new row failed; shown as a popup until dismissed
  insertError?: string

  // A cell to scroll to and highlight (MCP select_cell); nonce makes a repeat request count
  focusCell?: { row: number; col: string; nonce: number }

  // Safe Run: changes made in this open transaction, waiting for Commit or Roll back
  safeRun?: { sessionId: string; dialect: 'postgres' | 'mysql' | 'sqlite'; changes: { verb: string; table?: string; rows: number | null }[]; startedAt: number }
  tableSort?: TableSort

  sync?: StructureSyncState
  dataSync?: DataSyncState

  // Table tab: single-column foreign keys of the table, for the row-picker popup
  foreignKeyRefs?: FkRef[]
}

// value null means SQL NULL
interface CellEdit { rowIndex: number; col: string; value: string | null }

function cellEditKey(rowIndex: number, col: string) {
  return `${rowIndex}\u0000${col}`
}

export { cellEditText }

function hasPendingTableEdits(tab: QueryTab) {
  return tab.kind === 'table' && Object.keys(tab.pendingEdits ?? {}).length > 0
}

interface ParamQuery { sql: string; params: unknown[] }

// One plan per edited row. `update` returns the saved row on Postgres (RETURNING *);
// MySQL has no RETURNING, so `reselect` re-reads it by its (possibly edited) key.
// Edits on a row index past the loaded rows are a new row: `insert` plans only list the typed
// columns, so every other column gets its database default.
export interface RowSavePlan { rowIndex: number; update: ParamQuery; reselect?: ParamQuery; insert?: boolean }


export interface TableSort { column: string; dir: 'asc' | 'desc' }

// Sorts the whole table server-side. Primary key columns are appended as a tiebreaker (and are
// the default order) so LIMIT/OFFSET pages are stable; NULLs sort last in both directions.
export function buildTableOrderBy(dbType: 'postgres' | 'mysql', sort: TableSort | undefined, primaryKeys: string[]): string {
  const q = quoteIdent(dbType)
  const keys: TableSort[] = [
    ...(sort ? [sort] : []),
    ...primaryKeys.filter(pk => pk !== sort?.column).map(pk => ({ column: pk, dir: 'asc' as const })),
  ]
  if (keys.length === 0) return ''
  const terms = keys.map(({ column, dir }) => dbType === 'mysql'
    ? `${q(column)} IS NULL, ${q(column)} ${dir.toUpperCase()}`
    : `${q(column)} ${dir.toUpperCase()} NULLS LAST`)
  return `ORDER BY ${terms.join(', ')}`
}

export function buildMongoSort(sort: TableSort | undefined): Record<string, 1 | -1> {
  if (!sort) return { _id: 1 }
  return { [sort.column]: sort.dir === 'asc' ? 1 : -1, ...(sort.column !== '_id' ? { _id: 1 as const } : {}) }
}

export function buildRowSavePlans(
  dbType: 'postgres' | 'mysql',
  schema: string,
  table: string,
  primaryKeys: string[],
  rows: Record<string, unknown>[],
  edits: CellEdit[],
): RowSavePlan[] {
  const q = quoteIdent(dbType)
  const target = `${q(schema)}.${q(table)}`
  const byRow = new Map<number, CellEdit[]>()
  for (const e of edits) byRow.set(e.rowIndex, [...(byRow.get(e.rowIndex) ?? []), e])

  return [...byRow.entries()].sort(([a], [b]) => a - b).map(([rowIndex, rowEdits]) => {
    const row = rows[rowIndex]
    const params: unknown[] = []
    const placeholder = (v: unknown) => { params.push(v); return dbType === 'mysql' ? '?' : `$${params.length}` }
    if (!row) {
      const cols = rowEdits.map(e => q(e.col)).join(', ')
      const values = rowEdits.map(e => placeholder(e.value)).join(', ')
      const insertSql = `INSERT INTO ${target} (${cols}) VALUES (${values})`
      return { rowIndex, insert: true, update: { sql: dbType === 'postgres' ? `${insertSql} RETURNING *` : insertSql, params } }
    }
    const sets = rowEdits.map(e => `${q(e.col)} = ${placeholder(e.value)}`)
    const where = primaryKeys.map(pk => `${q(pk)} = ${placeholder(row[pk])}`)
    const updateSql = `UPDATE ${target} SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`

    if (dbType === 'postgres') return { rowIndex, update: { sql: `${updateSql} RETURNING *`, params } }
    return {
      rowIndex,
      update: { sql: updateSql, params },
      reselect: {
        sql: `SELECT * FROM ${target} WHERE ${primaryKeys.map(pk => `${q(pk)} = ?`).join(' AND ')}`,
        params: primaryKeys.map(pk => rowEdits.find(e => e.col === pk)?.value ?? row[pk]),
      },
    }
  })
}

// Deletes one row by its primary key; rowCount tells whether it was still there
export function buildRowDelete(dbType: 'postgres' | 'mysql', schema: string, table: string, primaryKeys: string[], row: Record<string, unknown>): ParamQuery {
  const q = quoteIdent(dbType)
  const params = primaryKeys.map(pk => row[pk])
  const where = primaryKeys.map((pk, i) => `${q(pk)} = ${dbType === 'mysql' ? '?' : `$${i + 1}`}`)
  return { sql: `DELETE FROM ${q(schema)}.${q(table)} WHERE ${where.join(' AND ')}`, params }
}

interface SavedQuery {
  id: string
  title: string
  sql: string
  connectionId: string
  databaseName: string
  schemaName: string
}

export interface QueryResult {
  fields: string[]
  rows: Record<string, unknown>[]
  rowCount: number | null
  ms: number
  error?: string
  statement?: string  // the SQL statement that produced this result
  types?: Record<string, string>[]  // MongoDB: each row's BSON field types, by dotted path
}

// ── Small reusable dialogs ────────────────────────────────────────────────────

function NameQueryDialog({ title, initial, placeholder, onConfirm, onClose }: {
  title: string
  initial: string
  placeholder?: string
  onConfirm: (name: string) => void
  onClose: () => void
}) {
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.select() }, [])
  function submit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = value.trim()
    if (!trimmed) return
    onConfirm(trimmed)
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-card border border-border rounded-lg shadow-xl w-80">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <span className="text-sm font-semibold">{title}</span>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors"><X className="h-4 w-4" /></button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-4">
          <input
            ref={inputRef}
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder={placeholder ?? 'Query name…'}
            className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
          />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20 transition-colors">Cancel</button>
            <button type="submit" disabled={!value.trim()} className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50">Confirm</button>
          </div>
        </form>
      </div>
    </div>
  )
}

function ConfirmDialog({ message, onConfirm, onClose }: {
  message: string
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-card border border-border rounded-lg shadow-xl w-80">
        <div className="px-5 py-4 border-b border-border">
          <span className="text-sm font-semibold">Confirm</span>
        </div>
        <div className="px-5 py-4 space-y-4">
          <p className="text-sm text-muted-foreground">{message}</p>
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-xs rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20 transition-colors">Cancel</button>
            <button onClick={onConfirm} className="px-3 py-1.5 text-xs rounded bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors">Delete</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── New Connection dialog ─────────────────────────────────────────────────────

type ConnectionDraft = Omit<DbConnection, 'id' | 'status' | 'databases' | 'errorMsg'>

// The database menu's actions that need DatabaseView (dialogs, IPC)
type DatabaseAction =
  | { kind: 'create' | 'edit' | 'drop' | 'schema' | 'extensions'; connId: string; dbName: string }
  | { kind: 'maintain'; connId: string; dbName: string; maintenance: MaintenanceKind }

// The database a PostgreSQL connection logs into; it can't be renamed or dropped over that connection
function connectionBaseDb(conn: DbConnection) {
  return conn.database || conn.user
}
type DbKind = DbConnection['dbType']

const DEFAULT_PORTS: Record<DbKind, number> = { postgres: 5432, mysql: 3306, mongodb: 27017, sqlite: 0, redis: 6379 }

interface NewConnectionDialogProps {
  onConnect: (conn: ConnectionDraft) => Promise<void>
  onClose: () => void
  // Prefilled settings: a chosen type (New Connection ▸) or a copy of a connection (Duplicate)
  initial?: Partial<ConnectionDraft>
  title?: string
}

function vpnFileName(p: string) {
  return p.split(/[\\/]/).pop() ?? p
}

export function parseConnectionString(str: string, dbType: 'postgres' | 'mysql' | 'mongodb' | 'sqlite' | 'redis'): Partial<{ host: string; port: string; database: string; user: string; password: string; ssl: boolean }> {
  try {
    const url = new URL(str)
    return {
      host: url.hostname || 'localhost',
      port: url.port || (dbType === 'mysql' ? '3306' : dbType === 'mongodb' ? '27017' : dbType === 'redis' ? '6379' : '5432'),
      database: url.pathname.replace(/^\//, '') || '',
      user: url.username ? decodeURIComponent(url.username) : '',
      password: url.password ? decodeURIComponent(url.password) : '',
      ssl: url.protocol === 'rediss:' || url.searchParams.get('sslmode') === 'require' || url.searchParams.get('ssl') === 'true',
    }
  } catch {
    return {}
  }
}

// The inverse of parseConnectionString: assembles a pastable URL from the dialog's fields.
// A saved connection as a URL (MongoDB connections already store theirs)
export function connectionStringOf(conn: Pick<DbConnection, 'dbType' | 'host' | 'port' | 'database' | 'user' | 'password' | 'ssl'>, withPassword: boolean): string {
  if (conn.dbType === 'sqlite') return conn.host
  if (conn.dbType === 'redis') {
    if (/^rediss?:\/\//i.test(conn.host)) return conn.host
    const auth = conn.user || (withPassword && conn.password)
      ? `${encodeURIComponent(conn.user)}${withPassword && conn.password ? `:${encodeURIComponent(conn.password)}` : ''}@`
      : ''
    return `${conn.ssl ? 'rediss' : 'redis'}://${auth}${conn.host}:${conn.port}${conn.database ? `/${conn.database}` : ''}`
  }
  if (conn.dbType === 'mongodb') {
    if (withPassword) return conn.host
    try {
      const url = new URL(conn.host)
      url.password = ''
      return url.toString()
    } catch {
      return conn.host
    }
  }
  return buildConnectionString(conn.dbType, {
    host: conn.host, port: String(conn.port), database: conn.database, user: conn.user,
    password: withPassword ? conn.password : '', ssl: conn.ssl,
  })
}

function copyConnectionString(conn: DbConnection, withPassword: boolean) {
  navigator.clipboard.writeText(connectionStringOf(conn, withPassword)).then(
    () => toast.success(withPassword ? 'Copied connection string (includes the password)' : 'Copied connection string'),
    () => toast.error('Could not copy to the clipboard'),
  )
}

export function buildConnectionString(dbType: 'postgres' | 'mysql', fields: {
  host: string; port: string; database: string; user: string; password: string; ssl: boolean
}): string {
  const scheme = dbType === 'mysql' ? 'mysql' : 'postgresql'
  const auth = fields.user ? `${encodeURIComponent(fields.user)}${fields.password ? `:${encodeURIComponent(fields.password)}` : ''}@` : ''
  const db = fields.database ? `/${encodeURIComponent(fields.database)}` : ''
  const query = fields.ssl ? (dbType === 'mysql' ? '?ssl=true' : '?sslmode=require') : ''
  return `${scheme}://${auth}${fields.host}:${fields.port}${db}${query}`
}

const fileBaseName = (p: string) => p.split(/[\\/]/).pop() || p

// SQLite: a connection is a database file. New… creates the empty file right away.
function SqliteFileField({ value, onChange }: { value: string; onChange: (path: string) => void }) {
  const sqlite = window.electronAPI?.sqlite
  const create = async () => {
    const path = await sqlite?.pickFile(true)
    if (!path) return
    const probe = `create-${Date.now()}`
    const res = await sqlite!.connect({ id: probe, host: path, create: true })
    await sqlite!.disconnect(probe)
    if (!res.ok) { toast.error(`Could not create the database: ${res.error}`); return }
    onChange(path)
  }
  return (
    <div className="space-y-1">
      <label className="text-xs text-muted-foreground">Database file</label>
      <div className="flex items-center gap-2">
        <div className="flex-1 bg-background border border-border rounded px-2 py-1.5 text-xs text-muted-foreground truncate font-mono" title={value}>
          {value || 'No file chosen'}
        </div>
        <button type="button" onClick={async () => { const path = await sqlite?.pickFile(false); if (path) onChange(path) }}
          className="px-2.5 py-1.5 rounded text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20 transition-colors shrink-0">
          Open…
        </button>
        <button type="button" onClick={() => void create()}
          className="px-2.5 py-1.5 rounded text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20 transition-colors shrink-0">
          New…
        </button>
      </div>
    </div>
  )
}

function NewConnectionDialog({ onConnect, onClose, initial, title = 'New Connection' }: NewConnectionDialogProps) {
  const initialType = initial?.dbType ?? 'postgres'
  const [dbType, setDbType] = useState<'postgres' | 'mysql' | 'mongodb' | 'sqlite' | 'redis'>(initialType)
  const [connString, setConnString] = useState('')
  const [label, setLabel] = useState(initial?.label ?? '')
  const [host, setHost] = useState(initial?.host ?? (initialType === 'mongodb' ? 'mongodb://localhost:27017' : 'localhost'))
  const [port, setPort] = useState(String(initial?.port ?? DEFAULT_PORTS[initialType]))
  const [database, setDatabase] = useState(initial?.database ?? '')
  const [user, setUser] = useState(initial?.user ?? '')
  const [password, setPassword] = useState(initial?.password ?? '')
  const [ssl, setSsl] = useState(initial?.ssl ?? false)
  const [vpnConfigPath, setVpnConfigPath] = useState(initial?.vpnConfigPath ?? '')
  const [vpnUsername, setVpnUsername] = useState(initial?.vpnUsername ?? '')
  const [vpnPassword, setVpnPassword] = useState(initial?.vpnPassword ?? '')
  const [options, setOptions] = useState<ConnectionOptions>(initial?.options ?? {})
  const [loading, setLoading] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [error, setError] = useState('')

  const defaultPort = dbType === 'mysql' ? '3306' : dbType === 'mongodb' ? '27017' : '5432'
  const name = dbType === 'sqlite' ? fileBaseName(host) : dbType === 'mongodb' ? (database ? `MongoDB / ${database}` : 'MongoDB') : `${host}:${port}${database ? ' / ' + database : ''}`

  function switchDbType(t: 'postgres' | 'mysql' | 'mongodb' | 'sqlite' | 'redis') {
    setDbType(t)
    setTestResult(null)
    // Only auto-update port if it's still the default for the current type
    setPort(prev => (prev === '5432' || prev === '3306' || prev === '27017' || prev === '6379' || prev === '0') ? String(DEFAULT_PORTS[t] || 5432) : prev)
    // host is a server name, a MongoDB URI or (SQLite) a file path
    const isFile = (h: string) => /[\\/]|\.(db|sqlite3?|db3)$/i.test(h) && !h.startsWith('mongodb')
    if (t === 'sqlite') {
      setHost(prev => isFile(prev) ? prev : '')
    } else if (t === 'mongodb') {
      setHost(prev => prev.startsWith('mongodb') ? prev : 'mongodb://localhost:27017')
    } else {
      setHost(prev => prev.startsWith('mongodb') || prev === '' || isFile(prev) ? 'localhost' : prev)
    }
  }

  function applyConnString(str: string) {
    if (dbType === 'mongodb') {
      setHost(str.trim())
      setTestResult(null)
      return
    }
    const parsed = parseConnectionString(str.trim(), dbType)
    if (parsed.host) setHost(parsed.host)
    if (parsed.port) setPort(parsed.port)
    if (parsed.database !== undefined) setDatabase(parsed.database)
    if (parsed.user !== undefined) setUser(parsed.user)
    if (parsed.password !== undefined) setPassword(parsed.password)
    if (parsed.ssl !== undefined) setSsl(parsed.ssl)
    setTestResult(null)
  }

  const ipc = getIpc(dbType)

  async function handleTest() {
    setTesting(true)
    setTestResult(null)
    const tempId = `test-${Date.now()}`
    const res = await ipc.connect({ id: tempId, host, port: parseInt(port) || (dbType === 'mysql' ? 3306 : dbType === 'mongodb' ? 27017 : 5432), database, user, password, ssl, vpnConfigPath: vpnConfigPath || undefined, vpnUsername: vpnUsername || undefined, vpnPassword: vpnPassword || undefined })
    await ipc.disconnect(tempId)
    setTestResult(res.ok ? { ok: true, msg: 'Connection successful' } : { ok: false, msg: res.error ?? 'Failed' })
    setTesting(false)
  }

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await onConnect({ dbType, label: label.trim(), name, host, port: parseInt(port) || (dbType === 'mysql' ? 3306 : dbType === 'mongodb' ? 27017 : 5432), database, user, password, ssl, vpnConfigPath: vpnConfigPath || undefined, vpnUsername: vpnUsername || undefined, vpnPassword: vpnPassword || undefined, options })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const inputCls = "w-full bg-background border border-border rounded px-2 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-card border border-border rounded-lg shadow-xl w-[440px] max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <span className="text-sm font-semibold">{title}</span>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleConnect} className="p-5 space-y-3">
          {/* DB type toggle */}
          <div className="flex items-center gap-1 p-0.5 bg-muted/40 rounded-md border border-border w-fit">
            {(['postgres', 'mysql', 'mongodb', 'sqlite', 'redis'] as const).map(t => (
              <button
                key={t} type="button" onClick={() => switchDbType(t)}
                className={cn(
                  'px-3 py-1 rounded text-xs font-medium transition-colors',
                  dbType === t ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t === 'postgres' ? 'PostgreSQL' : t === 'mysql' ? 'MySQL' : t === 'mongodb' ? 'MongoDB' : t === 'sqlite' ? 'SQLite' : 'Redis'}
              </button>
            ))}
          </div>

          {/* Connection string */}
          {dbType !== 'sqlite' && <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              {dbType === 'mongodb' ? 'Connection URI' : 'Connection String'} <span className="text-muted-foreground/50">{dbType === 'mongodb' ? '' : '(optional — paste to populate fields)'}</span>
            </label>
            <div className="flex gap-2">
              <input
                value={dbType === 'mongodb' ? host : connString}
                onChange={e => dbType === 'mongodb' ? setHost(e.target.value) : setConnString(e.target.value)}
                placeholder={dbType === 'mysql' ? 'mysql://user:pass@host:3306/db' : dbType === 'mongodb' ? 'mongodb://localhost:27017' : dbType === 'redis' ? 'redis://user:pass@host:6379/0' : 'postgresql://user:pass@host:5432/db'}
                className={cn(inputCls, 'flex-1 font-mono text-xs')}
              />
              {dbType !== 'mongodb' && (
                <button
                  type="button"
                  onClick={() => applyConnString(connString)}
                  disabled={!connString.trim()}
                  className="px-2.5 py-1.5 rounded text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20 transition-colors shrink-0 disabled:opacity-40"
                >
                  Apply
                </button>
              )}
            </div>
          </div>}

          <div className="border-t border-border/50" />

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Label <span className="text-muted-foreground/50">(optional)</span></label>
            <input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Production DB" className={inputCls} />
          </div>

          <ConnectionTagFields value={options} onChange={setOptions} />

          {dbType === 'sqlite' ? (
            <SqliteFileField value={host} onChange={setHost} />
          ) : dbType === 'mongodb' ? (
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Default Database <span className="text-muted-foreground/50">(optional)</span></label>
              <input value={database} onChange={e => setDatabase(e.target.value)} placeholder="e.g. admin" className={inputCls} />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2 space-y-1">
                  <label className="text-xs text-muted-foreground">Host</label>
                  <input value={host} onChange={e => setHost(e.target.value)} placeholder="localhost" className={inputCls} />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Port</label>
                  <input value={port} onChange={e => setPort(e.target.value)} placeholder={defaultPort} className={inputCls} />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">{dbType === 'redis' ? 'Default database number' : 'Database'} {dbType === 'redis' && <span className="text-muted-foreground/50">(optional)</span>}</label>
                <input value={database} onChange={e => setDatabase(e.target.value)} placeholder={dbType === 'mysql' ? 'my_database' : dbType === 'redis' ? '0' : 'postgres'} className={inputCls} />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">User</label>
                  <input value={user} onChange={e => setUser(e.target.value)} placeholder={dbType === 'mysql' ? 'root' : 'postgres'} className={inputCls} />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Password</label>
                  <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" className={inputCls} />
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button" onClick={() => setSsl(!ssl)}
                  className={cn("h-4 w-4 rounded flex items-center justify-center transition-all border shadow-sm", ssl ? "bg-primary border-primary text-primary-foreground" : "border-border/85 bg-background hover:border-border")}
                >
                  {ssl && <Check className="h-3 w-3 stroke-[3.5]" />}
                </button>
                <span className="text-xs text-muted-foreground select-none cursor-pointer" onClick={() => setSsl(!ssl)}>SSL Connection</span>
              </div>

              <div className="space-y-1">
                <label className="text-xs text-muted-foreground flex items-center gap-1">
                  <Shield className="h-3 w-3" /> OpenVPN Config <span className="text-muted-foreground/50">(optional)</span>
                </label>
                <div className="flex items-center gap-2">
                  <div className="flex-1 bg-background border border-border rounded px-2 py-1.5 text-xs text-muted-foreground truncate">
                    {vpnConfigPath ? vpnFileName(vpnConfigPath) : 'No .ovpn file selected'}
                  </div>
                  <button
                    type="button"
                    onClick={async () => { const p = await window.electronAPI!.pg.selectOvpnFile(); if (p) setVpnConfigPath(p) }}
                    className="px-2.5 py-1.5 rounded text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20 transition-colors shrink-0"
                  >
                    Browse
                  </button>
                  {vpnConfigPath && (
                    <button type="button" onClick={() => { setVpnConfigPath(''); setVpnUsername(''); setVpnPassword('') }} className="text-muted-foreground hover:text-foreground transition-colors">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                {vpnConfigPath && (
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">VPN Username <span className="text-muted-foreground/50">(if required)</span></label>
                      <input value={vpnUsername} onChange={e => setVpnUsername(e.target.value)} placeholder="username" className={inputCls} />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">VPN Password <span className="text-muted-foreground/50">(if required)</span></label>
                      <input type="password" value={vpnPassword} onChange={e => setVpnPassword(e.target.value)} placeholder="••••••••" className={inputCls} />
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-950/60 px-3 py-2">
              <X className="h-3.5 w-3.5 text-red-300 shrink-0 mt-0.5" />
              <p className="text-xs text-red-300 whitespace-pre-wrap break-words">{error}</p>
            </div>
          )}
          {testResult && (
            testResult.ok
              ? <div className="flex items-center gap-2 rounded-md border border-green-500/40 bg-green-500/10 px-3 py-2">
                  <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
                  <p className="text-xs text-green-500">{testResult.msg}</p>
                </div>
              : <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-950/60 px-3 py-2">
                  <X className="h-3.5 w-3.5 text-red-300 shrink-0 mt-0.5" />
                  <p className="text-xs text-red-300 whitespace-pre-wrap break-words">{testResult.msg}</p>
                </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button" onClick={handleTest} disabled={testing || loading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent/20 transition-colors border border-border disabled:opacity-50"
            >
              {testing && <Loader2 className="h-3 w-3 animate-spin" />}
              Test Connection
            </button>
            <div className="flex-1" />
            <button type="button" onClick={onClose} className="px-3 py-1.5 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent/20 transition-colors border border-border">
              Cancel
            </button>
            <button
              type="submit" disabled={loading || testing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {loading && <Loader2 className="h-3 w-3 animate-spin" />}
              Connect
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Edit Connection dialog ────────────────────────────────────────────────────

interface EditConnectionDialogProps {
  conn: DbConnection
  onSave: (id: string, data: Omit<DbConnection, 'id' | 'status' | 'databases'>) => Promise<void>
  onDisconnectAndEdit: (id: string) => Promise<void>
  onClose: () => void
}

function EditConnectionDialog({ conn, onSave, onDisconnectAndEdit, onClose }: EditConnectionDialogProps) {
  const [confirmDisconnect, setConfirmDisconnect] = useState(conn.status === 'connected')
  const [label, setLabel] = useState(conn.label)
  const [host, setHost] = useState(conn.host)
  const [port, setPort] = useState(String(conn.port))
  const [database, setDatabase] = useState(conn.database)
  const [user, setUser] = useState(conn.user)
  const [password, setPassword] = useState(conn.password)
  const [ssl, setSsl] = useState(conn.ssl)
  const [vpnConfigPath, setVpnConfigPath] = useState(conn.vpnConfigPath ?? '')
  const [vpnUsername, setVpnUsername] = useState(conn.vpnUsername ?? '')
  const [vpnPassword, setVpnPassword] = useState(conn.vpnPassword ?? '')
  const [options, setOptions] = useState<ConnectionOptions>(conn.options ?? {})
  const [loading, setLoading] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [error, setError] = useState('')

  async function handleTest() {
    setTesting(true)
    setTestResult(null)
    const tempId = `test-${Date.now()}`
    const ipc = getIpc(conn.dbType)
    const res = await ipc.connect({ id: tempId, host, port: parseInt(port) || (conn.dbType === 'mysql' ? 3306 : conn.dbType === 'mongodb' ? 27017 : 5432), database, user, password, ssl, vpnConfigPath: vpnConfigPath || undefined, vpnUsername: vpnUsername || undefined, vpnPassword: vpnPassword || undefined })
    await ipc.disconnect(tempId)
    setTestResult(res.ok ? { ok: true, msg: 'Connection successful' } : { ok: false, msg: res.error ?? 'Failed' })
    setTesting(false)
  }

  async function handleDisconnectAndEdit() {
    setLoading(true)
    await onDisconnectAndEdit(conn.id)
    setConfirmDisconnect(false)
    setLoading(false)
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const name = conn.dbType === 'sqlite' ? fileBaseName(host) : conn.dbType === 'mongodb' ? (database ? `MongoDB / ${database}` : 'MongoDB') : `${host}:${port}${database ? ' / ' + database : ''}`
    try {
      await onSave(conn.id, { dbType: conn.dbType, label: label.trim(), name, host, port: parseInt(port) || (conn.dbType === 'mysql' ? 3306 : conn.dbType === 'mongodb' ? 27017 : 5432), database, user, password, ssl, vpnConfigPath: vpnConfigPath || undefined, vpnUsername: vpnUsername || undefined, vpnPassword: vpnPassword || undefined, options })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-card border border-border rounded-lg shadow-xl w-[420px]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <span className="text-sm font-semibold">Edit Connection</span>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        {confirmDisconnect ? (
          <div className="p-5 space-y-4">
            <p className="text-sm text-muted-foreground">
              This connection is currently active. You need to disconnect before editing.
            </p>
            {error && (
              <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-950/60 px-3 py-2">
                <X className="h-3.5 w-3.5 text-red-300 shrink-0 mt-0.5" />
                <p className="text-xs text-red-300 whitespace-pre-wrap break-words">{error}</p>
              </div>
            )}
            <div className="flex items-center justify-end gap-2">
              <button onClick={onClose} className="px-3 py-1.5 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent/20 transition-colors border border-border">
                Cancel
              </button>
              <button
                onClick={handleDisconnectAndEdit} disabled={loading}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {loading && <Loader2 className="h-3 w-3 animate-spin" />}
                Disconnect & Edit
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSave} className="p-5 space-y-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Label <span className="text-muted-foreground/50">(optional)</span></label>
              <input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Production DB"
                className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary" />
            </div>

            <ConnectionTagFields value={options} onChange={setOptions} />

            {conn.dbType === 'sqlite' ? (
              <SqliteFileField value={host} onChange={setHost} />
            ) : conn.dbType === 'mongodb' ? (
              <>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Connection URI</label>
                  <input value={host} onChange={e => setHost(e.target.value)} placeholder="mongodb://localhost:27017"
                    className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Default Database <span className="text-muted-foreground/50">(optional)</span></label>
                  <input value={database} onChange={e => setDatabase(e.target.value)} placeholder="e.g. admin"
                    className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary" />
                </div>
              </>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2 space-y-1">
                    <label className="text-xs text-muted-foreground">Host</label>
                    <input value={host} onChange={e => setHost(e.target.value)} placeholder="localhost"
                      className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Port</label>
                    <input value={port} onChange={e => setPort(e.target.value)} placeholder="5432"
                      className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary" />
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Database</label>
                  <input value={database} onChange={e => setDatabase(e.target.value)} placeholder="postgres"
                    className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">User</label>
                    <input value={user} onChange={e => setUser(e.target.value)} placeholder="postgres"
                      className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Password</label>
                    <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••"
                      className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary" />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSsl(!ssl)}
                    className={cn(
                      "h-4 w-4 rounded flex items-center justify-center transition-all border shadow-sm",
                      ssl
                        ? "bg-primary border-primary text-primary-foreground"
                        : "border-border/85 bg-background hover:border-border"
                    )}
                  >
                    {ssl && <Check className="h-3 w-3 stroke-[3.5]" />}
                  </button>
                  <span className="text-xs text-muted-foreground select-none cursor-pointer" onClick={() => setSsl(!ssl)}>SSL Connection</span>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(buildConnectionString(conn.dbType as 'postgres' | 'mysql', { host, port, database, user, password, ssl }))
                        .then(() => toast.success('Connection string copied'), () => toast.error('Could not copy to the clipboard'))
                    }}
                    className="ml-auto flex items-center gap-1 text-[11px] text-primary hover:underline"
                  >
                    <Copy className="h-3 w-3" /> Copy connection string
                  </button>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground flex items-center gap-1">
                    <Shield className="h-3 w-3" /> OpenVPN Config <span className="text-muted-foreground/50">(optional)</span>
                  </label>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 bg-background border border-border rounded px-2 py-1.5 text-xs text-muted-foreground truncate">
                      {vpnConfigPath ? vpnFileName(vpnConfigPath) : 'No .ovpn file selected'}
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        const p = await window.electronAPI!.pg.selectOvpnFile()
                        if (p) setVpnConfigPath(p)
                      }}
                      className="px-2.5 py-1.5 rounded text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20 transition-colors shrink-0"
                    >
                      Browse
                    </button>
                    {vpnConfigPath && (
                      <button type="button" onClick={() => { setVpnConfigPath(''); setVpnUsername(''); setVpnPassword('') }} className="text-muted-foreground hover:text-foreground transition-colors">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  {vpnConfigPath && (
                    <div className="grid grid-cols-2 gap-2 pt-1">
                      <div className="space-y-1">
                        <label className="text-xs text-muted-foreground">VPN Username <span className="text-muted-foreground/50">(if required)</span></label>
                        <input
                          value={vpnUsername} onChange={e => setVpnUsername(e.target.value)}
                          placeholder="username"
                          className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-muted-foreground">VPN Password <span className="text-muted-foreground/50">(if required)</span></label>
                        <input
                          type="password"
                          value={vpnPassword} onChange={e => setVpnPassword(e.target.value)}
                          placeholder="••••••••"
                          className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
            {error && (
              <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-950/60 px-3 py-2">
                <X className="h-3.5 w-3.5 text-red-300 shrink-0 mt-0.5" />
                <p className="text-xs text-red-300 whitespace-pre-wrap break-words">{error}</p>
              </div>
            )}
            {testResult && (
              testResult.ok
                ? <div className="flex items-center gap-2 rounded-md border border-green-500/40 bg-green-500/10 px-3 py-2">
                    <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
                    <p className="text-xs text-green-500">{testResult.msg}</p>
                  </div>
                : <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-950/60 px-3 py-2">
                    <X className="h-3.5 w-3.5 text-red-300 shrink-0 mt-0.5" />
                    <p className="text-xs text-red-300 whitespace-pre-wrap break-words">{testResult.msg}</p>
                  </div>
            )}
            <div className="flex items-center gap-2 pt-1">
              <button
                type="button" onClick={handleTest} disabled={testing || loading}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent/20 transition-colors border border-border disabled:opacity-50"
              >
                {testing && <Loader2 className="h-3 w-3 animate-spin" />}
                Test Connection
              </button>
              <div className="flex-1" />
              <button type="button" onClick={onClose}
                className="px-3 py-1.5 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent/20 transition-colors border border-border">
                Cancel
              </button>
              <button type="submit" disabled={loading || testing}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50">
                {loading && <Loader2 className="h-3 w-3 animate-spin" />}
                Save
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

// ── Top toolbar ───────────────────────────────────────────────────────────────

function ToolbarBtn({ icon, label, onClick, disabled }: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex flex-col items-center justify-center gap-0.5 w-14 h-full px-1 text-muted-foreground hover:text-foreground hover:bg-accent/20 transition-colors disabled:opacity-40 disabled:pointer-events-none"
    >
      <div className="flex items-center justify-center h-7 w-7">{icon}</div>
      <span className="text-[10px] leading-none">{label}</span>
    </button>
  )
}

function DbToolbar({
  onNewConnection,
  onNewQuery,
  onNewTable,
  onNewView,
  onStructureSync,
  onDataSync,
  activeConn,
}: {
  onNewConnection: () => void
  onNewQuery: () => void
  onNewTable: () => void
  onNewView: () => void
  onStructureSync: () => void
  onDataSync: () => void
  activeConn: DbConnection | null
}) {
  return (
    <div className="flex items-stretch h-16 border-b border-border bg-card shrink-0 px-1">
      <ToolbarBtn
        icon={
          <div className="relative">
            <PlugZap className="h-6 w-6" />
            <Plus className="h-3 w-3 absolute -bottom-0.5 -right-0.5 text-green-400 stroke-[3]" />
          </div>
        }
        label="Connection"
        onClick={onNewConnection}
      />

      <div className="w-px bg-border my-3 mx-0.5" />

      <ToolbarBtn
        icon={<FileCode2 className="h-6 w-6" />}
        label="New Query"
        onClick={onNewQuery}
      />

      <div className="w-px bg-border my-3 mx-0.5" />

      <ToolbarBtn
        icon={<Table2 className="h-6 w-6 text-primary" />}
        label="Table"
        onClick={onNewTable}
        disabled={!activeConn || activeConn.dbType !== 'postgres' || activeConn.status !== 'connected'}
      />

      <ToolbarBtn
        icon={<View className="h-6 w-6 text-sky-300" />}
        label="View"
        onClick={onNewView}
        disabled={!activeConn || activeConn.dbType !== 'postgres' || activeConn.status !== 'connected'}
      />

      <ToolbarBtn
        icon={<FunctionSquare className="h-6 w-6 text-purple-300" />}
        label="Function"
        onClick={() => {}}
        disabled
      />

      <div className="w-px bg-border my-3 mx-0.5" />

      <ToolbarBtn
        icon={<GitCompareArrows className="h-6 w-6 text-primary" />}
        label="Structure Sync"
        onClick={onStructureSync}
      />

      <ToolbarBtn
        icon={<DatabaseZap className="h-6 w-6 text-primary" />}
        label="Data Sync"
        onClick={onDataSync}
      />

      <div className="flex-1" />

      {activeConn && (
        <div className="flex items-center gap-1.5 px-3 text-xs text-muted-foreground">
          <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', activeConn.status === 'connected' ? 'bg-green-500' : activeConn.status === 'connecting' ? 'bg-yellow-500' : 'bg-destructive')} />
          {activeConn.label || activeConn.name}
        </div>
      )}
    </div>
  )
}

// ── Connections tree ──────────────────────────────────────────────────────────

// A clickable "+ Add …" row shown in place of an empty group (no databases, no schemas,
// no tables, …) so creating the first item is one click from the empty state.
function AddRow({ label, indent, onClick }: { label: string; indent: number; onClick: () => void }) {
  return (
    <button
      onClick={e => { e.stopPropagation(); onClick() }}
      className="w-full flex items-center gap-1.5 py-0.5 text-[10px] rounded transition-colors text-left text-muted-foreground/60 hover:bg-accent/20 hover:text-foreground font-sans"
      style={{ paddingLeft: indent }}
    >
      <Plus className="h-3 w-3 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  )
}

function ConnectionsPanel({
  connections,
  activeConnId,
  onSelectConn,
  onToggleDb,
  onToggleSchema,
  onNewConnection,
  onDuplicateConnection,
  onNewQueryFor,
  onDatabaseAction,
  onNewTableIn,
  onNewViewIn,
  onNewCollectionIn,
  onTableChanged,
  onRefresh,
  onRefreshDb,
  onOpenErd,
  onOpenRedis,
  onDisconnect,
  onReconnect,
  onCancelConnect,
  onRemove,
  onEdit,
  onSelectDb,
  onSelectSchema,
  onOpenTable,
  onOpenTableDesign,
  onOpenFunction,
  onOpenType,
  activeDbPerConn,
  activeSchemaPerDb,
  openConns,
  setOpenConns,
  openGroups,
  setOpenGroups,
  savedQueries,
  onOpenSavedQuery,
  onDeleteSavedQuery,
  onRenameSavedQuery,
}: {
  connections: DbConnection[]
  activeConnId: string | null
  onSelectConn: (id: string) => void
  onToggleDb: (connId: string, dbName: string) => void
  onToggleSchema: (connId: string, dbName: string, schemaName: string) => void
  onNewConnection: (dbType?: DbKind) => void
  onDuplicateConnection: (connId: string) => void
  onNewQueryFor: (connId: string, dbName?: string) => void
  onDatabaseAction: (action: DatabaseAction) => void
  onNewTableIn: (connId: string, dbName: string, schema: string) => void
  onNewViewIn: (connId: string, dbName: string, schema: string) => void
  onNewCollectionIn: (connId: string, dbName: string) => void
  onTableChanged: (connId: string, dbName: string, schema: string, table: string, change: TableChange) => void
  onRefresh: (connId: string) => void
  onRefreshDb: (connId: string, dbName: string) => void
  onOpenErd: (connId: string, dbName: string) => void
  onOpenRedis: (connId: string, dbName: string, kind: 'redis-browser' | 'redis-console') => void
  onDisconnect: (connId: string) => void
  onReconnect: (connId: string) => void
  onCancelConnect: (connId: string) => void
  onRemove: (connId: string) => void
  onEdit: (connId: string) => void
  onSelectDb: (connId: string, dbName: string) => void
  onSelectSchema: (connId: string, dbName: string, schemaName: string) => void
  onOpenTable: (connId: string, dbName: string, schema: string, table: string) => void
  onOpenTableDesign: (connId: string, dbName: string, schema: string, table: string) => void
  onOpenFunction: (connId: string, dbName: string, schema: string, functionName: string, args: string) => void
  onOpenType: (connId: string, dbName: string, schema: string, typeName: string, definition: string) => void
  activeDbPerConn: Record<string, string>
  activeSchemaPerDb: Record<string, string>
  openConns: Set<string>
  setOpenConns: React.Dispatch<React.SetStateAction<Set<string>>>
  openGroups: Set<string>
  setOpenGroups: React.Dispatch<React.SetStateAction<Set<string>>>
  savedQueries: SavedQuery[]
  onOpenSavedQuery: (sq: SavedQuery) => void
  onDeleteSavedQuery: (id: string) => void
  onRenameSavedQuery: (id: string, currentTitle: string) => void
}) {
  const [activeItemKey, setActiveItemKey] = useState<string | null>(null)
  const [sidebarSearch, setSidebarSearch] = useState('')

  const dbIpc = (connId: string) => {
    const conn = connections.find(c => c.id === connId)
    return getIpc(conn?.dbType ?? 'postgres')
  }

  const selectConn = (id: string) => {
    onSelectConn(id)
  }

  const [connMenu, setConnMenu] = useState<{ x: number; y: number; connId: string } | null>(null)

  const connMenuEntries = (conn: DbConnection): MenuEntry[] => {
    const connected = conn.status === 'connected'
    const openConn = () => {
      onReconnect(conn.id)
      setOpenConns(prev => new Set(prev).add(conn.id))
    }
    return [
      connected || conn.status === 'connecting'
        ? { label: 'Close Connection', icon: <PlugZap className="h-3.5 w-3.5" />, onSelect: () => onDisconnect(conn.id) }
        : { label: 'Open Connection', icon: <PlugZap className="h-3.5 w-3.5" />, onSelect: openConn },
      { kind: 'separator' },
      { label: 'Edit Connection…', icon: <Pencil className="h-3.5 w-3.5" />, onSelect: () => onEdit(conn.id) },
      {
        label: 'New Connection', icon: <Plus className="h-3.5 w-3.5" />, submenu: [
          { label: 'PostgreSQL…', onSelect: () => onNewConnection('postgres') },
          { label: 'MySQL…', onSelect: () => onNewConnection('mysql') },
          { label: 'MongoDB…', onSelect: () => onNewConnection('mongodb') },
        ],
      },
      { label: 'Delete Connection', icon: <Trash2 className="h-3.5 w-3.5" />, destructive: true, onSelect: () => onRemove(conn.id) },
      { label: 'Duplicate Connection…', icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => onDuplicateConnection(conn.id) },
      {
        label: 'Copy Connection String', icon: <Link2 className="h-3.5 w-3.5" />, submenu: [
          { label: 'With Password', onSelect: () => copyConnectionString(conn, true) },
          { label: 'Without Password', onSelect: () => copyConnectionString(conn, false) },
        ],
      },
      { kind: 'separator' },
      { label: 'New Query', icon: <FileCode className="h-3.5 w-3.5" />, disabled: !connected, hint: connected ? undefined : 'not connected', onSelect: () => onNewQueryFor(conn.id) },
      { kind: 'separator' },
      { label: 'Refresh', icon: <RefreshCw className="h-3.5 w-3.5" />, disabled: !connected, onSelect: () => onRefresh(conn.id) },
    ]
  }

  const [dbMenu, setDbMenu] = useState<{ x: number; y: number; connId: string; dbName: string } | null>(null)
  // Database/collection export and import dialogs
  const [transfer, setTransfer] = useState<
    | { kind: 'dump' | 'execute'; dbType: 'postgres' | 'mysql'; connId: string; dbName: string }
    | { kind: 'mongo-export' | 'mongo-import'; connId: string; dbName: string; collection?: string }
    | { kind: 'table-import'; target: TableRef }
    | null
  >(null)

  const dbMenuEntries = (conn: DbConnection, db: DbDatabase): MenuEntry[] => {
    if (conn.dbType === 'redis') {
      return [
        { label: 'Key Browser', icon: <KeyRound className="h-3.5 w-3.5" />, onSelect: () => onOpenRedis(conn.id, db.name, 'redis-browser') },
        { label: 'Console', icon: <SquareTerminal className="h-3.5 w-3.5" />, onSelect: () => onOpenRedis(conn.id, db.name, 'redis-console') },
        { kind: 'separator' },
        { label: 'Refresh', icon: <RefreshCw className="h-3.5 w-3.5" />, onSelect: () => onRefresh(conn.id) },
      ]
    }
    const isPg = conn.dbType === 'postgres'
    const isBase = isPg && db.name === connectionBaseDb(conn)
    const act = (kind: 'create' | 'edit' | 'drop' | 'schema' | 'extensions') => () => onDatabaseAction({ kind, connId: conn.id, dbName: db.name })
    const sep: MenuEntry = { kind: 'separator' }
    const maintenance: MaintenanceKind[] = ['analyze', 'vacuum', 'vacuumAnalyze', 'vacuumFull', 'reindex']
    return [
      { label: db.open ? 'Close Database' : 'Open Database', icon: <Database className="h-3.5 w-3.5" />, onSelect: () => onToggleDb(conn.id, db.name) },
      sep,
      ...(isPg ? [
        { label: 'Edit Database…', icon: <Pencil className="h-3.5 w-3.5" />, onSelect: act('edit') },
        { label: 'New Database…', icon: <Plus className="h-3.5 w-3.5" />, onSelect: act('create') },
        {
          label: 'Delete Database', icon: <Trash2 className="h-3.5 w-3.5" />, destructive: true,
          disabled: isBase, hint: isBase ? "the connection's database" : undefined, onSelect: act('drop'),
        },
        sep,
        { label: 'Manage Extensions…', icon: <Blocks className="h-3.5 w-3.5" />, onSelect: act('extensions') },
        sep,
        { label: 'New Schema…', icon: <FolderPlus className="h-3.5 w-3.5" />, onSelect: act('schema') },
      ] satisfies MenuEntry[] : []),
      { label: 'New Query', icon: <FileCode className="h-3.5 w-3.5" />, onSelect: () => onNewQueryFor(conn.id, db.name) },
      sep,
      // Dumps and SQL file imports don't support SQLite yet
      ...(conn.dbType === 'sqlite' ? [] : conn.dbType === 'mongodb' ? [
        { label: 'Export Database…', icon: <FileOutput className="h-3.5 w-3.5" />, onSelect: () => setTransfer({ kind: 'mongo-export', connId: conn.id, dbName: db.name }) },
        { label: 'Import…', icon: <FileInput className="h-3.5 w-3.5" />, onSelect: () => setTransfer({ kind: 'mongo-import', connId: conn.id, dbName: db.name }) },
      ] satisfies MenuEntry[] : [
        { label: 'Dump SQL File…', icon: <FileDown className="h-3.5 w-3.5" />, onSelect: () => setTransfer({ kind: 'dump', dbType: conn.dbType as 'postgres' | 'mysql', connId: conn.id, dbName: db.name }) },
        { label: 'Execute SQL File…', icon: <FileUp className="h-3.5 w-3.5" />, onSelect: () => setTransfer({ kind: 'execute', dbType: conn.dbType as 'postgres' | 'mysql', connId: conn.id, dbName: db.name }) },
      ] satisfies MenuEntry[]),
      sep,
      ...(isPg ? [{
        label: 'Maintain', icon: <Wrench className="h-3.5 w-3.5" />, submenu: maintenance.map((kind): MenuEntry => ({
          label: MAINTENANCE_LABELS[kind],
          hint: kind === 'vacuumFull' || kind === 'reindex' ? 'locks tables' : undefined,
          onSelect: () => onDatabaseAction({ kind: 'maintain', connId: conn.id, dbName: db.name, maintenance: kind }),
        })),
      }] satisfies MenuEntry[] : []),
      ...(conn.dbType === 'sqlite' ? [] : [{ label: 'View ER Diagram', icon: <Workflow className="h-3.5 w-3.5" />, onSelect: () => onOpenErd(conn.id, db.name) }] satisfies MenuEntry[]),
      sep,
      { label: 'Refresh', icon: <RefreshCw className="h-3.5 w-3.5" />, onSelect: () => onRefreshDb(conn.id, db.name) },
    ]
  }

  const [tableMenu, setTableMenu] = useState<{ x: number; y: number; connId: string; dbName: string; schema: string; table: string; isView: boolean } | null>(null)
  const [tableDialog, setTableDialog] = useState<{ kind: TableActionKind; target: TableRef; initialOptions?: TableActionOptions } | null>(null)
  const [exportDialog, setExportDialog] = useState<{ target: TableRef; preset?: ExportPreset } | null>(null)

  const tableMenuEntries = (conn: DbConnection, m: NonNullable<typeof tableMenu>): MenuEntry[] => {
    const { dbName, schema, table } = m
    const sep: MenuEntry = { kind: 'separator' }
    const copy = (text: string | Promise<string>, what: string) => {
      Promise.resolve(text)
        .then(t => navigator.clipboard.writeText(t))
        .then(() => toast.success(`Copied ${what}`), err => toast.error(`Could not copy ${what}: ${err instanceof Error ? err.message : String(err)}`))
    }
    const refresh: MenuEntry = { label: 'Refresh', icon: <RefreshCw className="h-3.5 w-3.5" />, onSelect: () => onRefreshDb(conn.id, dbName) }
    const open: MenuEntry = { label: m.isView ? 'Open View' : conn.dbType === 'mongodb' ? 'Open Collection' : 'Open Table', icon: <Table2 className="h-3.5 w-3.5" />, onSelect: () => onOpenTable(conn.id, dbName, schema, table) }
    const copyName: MenuEntry = { label: 'Copy Name', icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => copy(table, 'name') }
    if (conn.dbType === 'mongodb' && !m.isView) {
      return [
        open, sep,
        { label: 'Export Collection…', icon: <FileOutput className="h-3.5 w-3.5" />, onSelect: () => setTransfer({ kind: 'mongo-export', connId: conn.id, dbName, collection: table }) },
        { label: 'Import Documents…', icon: <FileInput className="h-3.5 w-3.5" />, onSelect: () => setTransfer({ kind: 'mongo-import', connId: conn.id, dbName, collection: table }) },
        sep, copyName, sep, refresh,
      ]
    }
    if (conn.dbType === 'mongodb' || m.isView) return [open, sep, copyName, sep, refresh]
    if (conn.dbType === 'redis') return [refresh]
    if (conn.dbType === 'sqlite') {
      const sq = (s: string) => '"' + s.replace(/"/g, '""') + '"'
      return [
        open, sep,
        {
          label: 'Copy', icon: <Copy className="h-3.5 w-3.5" />, submenu: [
            { label: 'Name', onSelect: () => copy(table, 'name') },
            { label: 'SELECT Statement', onSelect: () => copy(`SELECT * FROM ${sq(table)};`, 'SELECT statement') },
          ],
        },
        sep, refresh,
      ]
    }

    const dbType = conn.dbType
    const q = quoteIdent(dbType)
    const target: TableRef = { dbType, connectionId: conn.id, database: dbName, schema, table }
    const action = (kind: TableActionKind, initialOptions?: TableActionOptions) => () => setTableDialog({ kind, target, initialOptions })
    const maintenance = ([
      ['analyze', 'Analyze Table', <Gauge key="a" className="h-3.5 w-3.5" />],
      ['vacuum', 'Vacuum Table', <Brush key="v" className="h-3.5 w-3.5" />],
      ['reindex', 'Reindex Table', <RefreshCw key="r" className="h-3.5 w-3.5" />],
      ['optimize', 'Optimize Table', <Brush key="o" className="h-3.5 w-3.5" />],
    ] as const).filter(([kind]) => tableActionAvailable(dbType, kind))
    return [
      open,
      { label: 'Design Table', icon: <Wrench className="h-3.5 w-3.5" />, onSelect: () => onOpenTableDesign(conn.id, dbName, schema, table) },
      { label: 'New Table', icon: <Plus className="h-3.5 w-3.5" />, onSelect: () => onNewTableIn(conn.id, dbName, schema) },
      { label: 'Delete Table', icon: <Trash2 className="h-3.5 w-3.5" />, destructive: true, onSelect: action('drop') },
      { label: 'Empty Table', icon: <Eraser className="h-3.5 w-3.5" />, onSelect: action('empty') },
      { label: 'Truncate Table', icon: <Scissors className="h-3.5 w-3.5" />, onSelect: action('truncate') },
      {
        label: 'Duplicate Table', icon: <CopyPlus className="h-3.5 w-3.5" />, submenu: [
          { label: 'Structure and Data…', onSelect: action('duplicate', { withData: true }) },
          { label: 'Structure Only…', onSelect: action('duplicate', { withData: false }) },
        ],
      },
      sep,
      { label: 'Import Wizard…', icon: <FileInput className="h-3.5 w-3.5" />, onSelect: () => setTransfer({ kind: 'table-import', target }) },
      { label: 'Export Wizard…', icon: <FileOutput className="h-3.5 w-3.5" />, onSelect: () => setExportDialog({ target }) },
      sep,
      {
        label: 'Dump SQL File', icon: <FileDown className="h-3.5 w-3.5" />, submenu: [
          { label: 'Structure and Data…', onSelect: () => setExportDialog({ target, preset: 'dump-data' }) },
          { label: 'Structure Only…', onSelect: () => setExportDialog({ target, preset: 'dump-structure' }) },
        ],
      },
      { label: 'Maintain', icon: <Wrench className="h-3.5 w-3.5" />, submenu: maintenance.map(([kind, label, icon]) => ({ label: `${label}…`, icon, onSelect: action(kind) })) },
      { label: 'View in ER Diagram', icon: <Workflow className="h-3.5 w-3.5" />, onSelect: () => onOpenErd(conn.id, dbName) },
      sep,
      {
        label: 'Copy', icon: <Copy className="h-3.5 w-3.5" />, submenu: [
          { label: 'Name', onSelect: () => copy(table, 'name') },
          { label: 'Qualified Name', onSelect: () => copy(`${q(schema)}.${q(table)}`, 'qualified name') },
          { label: 'SELECT Statement', onSelect: () => copy(`SELECT * FROM ${q(schema)}.${q(table)};`, 'SELECT statement') },
          { label: 'CREATE Statement', onSelect: () => copy(createStatement(target), 'CREATE statement') },
        ],
      },
      { label: 'Rename', icon: <Pencil className="h-3.5 w-3.5" />, onSelect: action('rename') },
      sep,
      refresh,
    ]
  }

  const doubleClickConn = (conn: DbConnection) => {
    if (conn.status === 'disconnected' || conn.status === 'error') {
      onReconnect(conn.id)
      setOpenConns(prev => { const next = new Set(prev); next.add(conn.id); return next })
      return
    }
    if (conn.status === 'connecting') return
    setOpenConns(prev => {
      const next = new Set(prev)
      if (next.has(conn.id)) next.delete(conn.id); else next.add(conn.id)
      return next
    })
  }

  const toggleGroup = (key: string) => {
    setOpenGroups(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  const handleRefreshMaterializedView = async (connId: string, dbName: string, schema: string, mvName: string) => {
    const query = `REFRESH MATERIALIZED VIEW "${schema.replace(/"/g, '""')}"."${mvName.replace(/"/g, '""')}";`
    const res = await dbIpc(connId).query(connId, query, dbName)
    if (res.ok) {
      toast.success(`Materialized view "${schema}.${mvName}" successfully refreshed!`)
    } else {
      toast.error(`Failed to refresh materialized view:\n\n${res.error}`)
    }
  }

  const needle = sidebarSearch.trim().toLowerCase()

  // When searching, pre-compute which items match so we can auto-expand and hide non-matches
  const matchingTables = new Set<string>()   // "connId::dbName::schemaName::tableName"
  const matchingViews  = new Set<string>()   // "connId::dbName::schemaName::viewName"
  const matchingMaterialized = new Set<string>() // "connId::dbName::schemaName::matViewName"
  const matchingFns    = new Set<string>()   // "connId::dbName::schemaName::fnName"
  const matchingSaved  = new Set<string>()   // sq.id
  const matchingSchemas = new Set<string>()  // "connId::dbName::schemaName"
  const matchingDbs    = new Set<string>()   // "connId::dbName"
  const matchingConns  = new Set<string>()   // connId

  if (needle) {
    for (const conn of connections) {
      const connMatches = (conn.label || conn.name).toLowerCase().includes(needle)
      for (const db of conn.databases) {
        const dbMatches = db.name.toLowerCase().includes(needle)
        for (const schema of db.schemas) {
          const schemaMatches = schema.name.toLowerCase().includes(needle)
          for (const t of schema.tables ?? []) {
            if (t.name.toLowerCase().includes(needle)) {
              matchingTables.add(`${conn.id}::${db.name}::${schema.name}::${t.name}`)
              matchingSchemas.add(`${conn.id}::${db.name}::${schema.name}`)
              matchingDbs.add(`${conn.id}::${db.name}`)
              matchingConns.add(conn.id)
            }
          }
          for (const v of schema.views ?? []) {
            if (v.name.toLowerCase().includes(needle)) {
              matchingViews.add(`${conn.id}::${db.name}::${schema.name}::${v.name}`)
              matchingSchemas.add(`${conn.id}::${db.name}::${schema.name}`)
              matchingDbs.add(`${conn.id}::${db.name}`)
              matchingConns.add(conn.id)
            }
          }
          for (const mv of schema.materializedViews ?? []) {
            if (mv.name.toLowerCase().includes(needle)) {
              matchingMaterialized.add(`${conn.id}::${db.name}::${schema.name}::${mv.name}`)
              matchingSchemas.add(`${conn.id}::${db.name}::${schema.name}`)
              matchingDbs.add(`${conn.id}::${db.name}`)
              matchingConns.add(conn.id)
            }
          }
          for (const fn of schema.functions ?? []) {
            if (fn.name.toLowerCase().includes(needle) || fn.arguments.toLowerCase().includes(needle)) {
              matchingFns.add(`${conn.id}::${db.name}::${schema.name}::${fn.name}::${fn.arguments}`)
              matchingSchemas.add(`${conn.id}::${db.name}::${schema.name}`)
              matchingDbs.add(`${conn.id}::${db.name}`)
              matchingConns.add(conn.id)
            }
          }
          if (schemaMatches) {
            matchingSchemas.add(`${conn.id}::${db.name}::${schema.name}`)
            matchingDbs.add(`${conn.id}::${db.name}`)
            matchingConns.add(conn.id)
          }
        }
        if (dbMatches) {
          matchingDbs.add(`${conn.id}::${db.name}`)
          matchingConns.add(conn.id)
        }
      }
      for (const sq of savedQueries) {
        if (sq.connectionId === conn.id && sq.title.toLowerCase().includes(needle)) {
          matchingSaved.add(sq.id)
          matchingConns.add(conn.id)
        }
      }
      if (connMatches) matchingConns.add(conn.id)
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 h-8 border-b border-border shrink-0">
        <span className="text-xs font-medium text-muted-foreground">Connections</span>
        <button
          onClick={() => onNewConnection()}
          title="New connection"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/20 rounded px-1.5 h-5 transition-colors"
        >
          <Plus className="h-3 w-3" />
        </button>
      </div>

      <div className="flex items-center gap-2 px-3 h-7 border-b border-border shrink-0">
        <Search className="h-3 w-3 text-muted-foreground/60 shrink-0" />
        <input
          value={sidebarSearch}
          onChange={e => setSidebarSearch(e.target.value)}
          placeholder="Search…"
          className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/40 outline-none"
        />
        {sidebarSearch && (
          <button onClick={() => setSidebarSearch('')} className="text-muted-foreground/50 hover:text-foreground transition-colors"><X className="h-3 w-3" /></button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto py-1 px-1">
        {connections.length === 0 && (
          <p className="text-xs text-muted-foreground/50 px-3 py-4 text-center">No connections yet</p>
        )}
        {connections.filter(conn => !needle || matchingConns.has(conn.id)).map(conn => {
          const isOpen = needle ? true : openConns.has(conn.id)
          const isActive = conn.id === activeConnId
          return (
            <div key={conn.id} className={cn('rounded', isActive && isOpen ? 'bg-accent/10' : '')}>
              {/* Connection row */}
              <div
                role="button" tabIndex={0}
                onClick={() => selectConn(conn.id)}
                onDoubleClick={() => doubleClickConn(conn)}
                onKeyDown={e => e.key === 'Enter' && doubleClickConn(conn)}
                onContextMenu={e => { e.preventDefault(); selectConn(conn.id); setConnMenu({ x: e.clientX, y: e.clientY, connId: conn.id }) }}
                className={cn(
                  'group w-full flex items-center gap-1.5 px-2 py-0.5 text-xs rounded transition-colors cursor-pointer select-none',
                  isActive ? 'bg-accent/20 text-foreground' : 'text-muted-foreground hover:bg-accent/20 hover:text-foreground'
                )}
              >
                <span
                  onClick={e => { e.stopPropagation(); doubleClickConn(conn) }}
                  className="shrink-0 flex items-center justify-center rounded hover:bg-accent/40 transition-colors p-0.5 -m-0.5"
                >
                  {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                </span>
                <Plug className={cn('h-3.5 w-3.5 shrink-0',
                  conn.status === 'connected' ? 'text-green-500' :
                  conn.status === 'connecting' ? 'text-yellow-500' :
                  conn.status === 'disconnected' ? 'text-muted-foreground/40' :
                  'text-destructive'
                )} />
                <span className="truncate flex-1">{conn.label || conn.name}</span>
                <EnvironmentBadge options={conn.options} />
                {conn.dbType === 'sqlite'
                  ? <span className="shrink-0 text-[9px] font-semibold px-1 rounded bg-sky-500/20 text-sky-300 leading-4">SQLite</span>
                  : conn.dbType === 'mysql'
                  ? <span className="shrink-0 text-[9px] font-semibold px-1 rounded bg-orange-500/20 text-orange-400 leading-4">MySQL</span>
                  : conn.dbType === 'mongodb'
                  ? <span className="shrink-0 text-[9px] font-semibold px-1 rounded bg-emerald-500/20 text-emerald-400 leading-4">Mongo</span>
                  : <span className="shrink-0 text-[9px] font-semibold px-1 rounded bg-blue-500/20 text-blue-400 leading-4">PgSQL</span>
                }
                {conn.status === 'connecting' && (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                    <button
                      onClick={e => { e.stopPropagation(); onCancelConnect(conn.id) }}
                      title="Cancel connecting"
                      className="shrink-0 px-1 rounded text-[10px] leading-4 border border-border text-muted-foreground hover:text-foreground hover:bg-accent/30"
                    >
                      Cancel
                    </button>
                  </>
                )}
                {conn.status === 'connected' && conn.databases.some(d => d.loading) && (
                  <span title="Loading tables in the background" className="shrink-0">
                    <Loader2 className="h-2.5 w-2.5 animate-spin text-muted-foreground/50" />
                  </span>
                )}
              </div>

              {isOpen && conn.status === 'error' && (
                <div className="flex items-start gap-1.5 mx-3 mb-1 px-2 py-1.5 rounded border border-red-500/30 bg-red-950/60">
                  <X className="h-3 w-3 text-red-300 shrink-0 mt-0.5" />
                  <p className="text-[11px] text-red-300 leading-snug">{conn.errorMsg}</p>
                </div>
              )}

              {/* Databases */}
              {isOpen && conn.status === 'connected' && conn.databases.filter(db => !needle || matchingDbs.has(`${conn.id}::${db.name}`)).map(db => {
                const dbKey = `${conn.id}::${db.name}`
                return (
                <div key={db.name}>
                  {/* Database row */}
                  <div
                    role="button" tabIndex={0}
                    onClick={() => { onSelectDb(conn.id, db.name); setActiveItemKey(dbKey); if (conn.dbType === 'redis') onOpenRedis(conn.id, db.name, 'redis-browser') }}
                    onDoubleClick={() => { if (conn.dbType !== 'redis') onToggleDb(conn.id, db.name) }}
                    onKeyDown={e => e.key === 'Enter' && (onSelectDb(conn.id, db.name), setActiveItemKey(dbKey))}
                    onContextMenu={e => {
                      e.preventDefault()
                      onSelectDb(conn.id, db.name)
                      setActiveItemKey(dbKey)
                      setDbMenu({ x: e.clientX, y: e.clientY, connId: conn.id, dbName: db.name })
                    }}
                    className={cn(
                      'group w-full flex items-center gap-1.5 py-0.5 text-xs rounded transition-colors cursor-pointer select-none',
                      activeItemKey === dbKey ? 'bg-primary/20 text-foreground' : 'text-muted-foreground hover:bg-accent/20 hover:text-foreground'
                    )}
                    style={{ paddingLeft: 16 }}
                  >
                    {conn.dbType === 'redis' ? (
                      <KeyRound className="h-3.5 w-3.5 text-red-300 shrink-0 ml-3" />
                    ) : (
                      <>
                        <span
                          onClick={e => { e.stopPropagation(); onToggleDb(conn.id, db.name) }}
                          onDoubleClick={e => e.stopPropagation()}
                          className="shrink-0 flex items-center justify-center rounded hover:bg-accent/40 transition-colors p-0.5 -m-0.5"
                        >
                          {db.open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                        </span>
                        <Database className="h-3.5 w-3.5 text-blue-300 shrink-0" />
                      </>
                    )}
                    <span className="truncate flex-1">{db.name}</span>
                    {db.loading && <Loader2 className="h-3 w-3 animate-spin shrink-0" />}
                    {!db.loading && db.error && (
                      <span title={db.error} className="shrink-0">
                        <AlertTriangle className="h-3 w-3 text-destructive" />
                      </span>
                    )}
                  </div>

                  {/* Introspection error */}
                  {db.open && db.error && !db.loading && (
                    <div className="mx-2 my-1 px-2 py-1.5 rounded border border-destructive/40 bg-destructive/10 text-[10px] text-destructive leading-snug">
                      {db.error}
                    </div>
                  )}

                  {/* Schemas */}
                  {(needle ? true : db.open) && db.schemas.filter(schema => !needle || matchingSchemas.has(`${conn.id}::${db.name}::${schema.name}`)).map(schema => {
                    const schemaKey = `${conn.id}::${db.name}::${schema.name}`
                    const isMysql = conn.dbType === 'mysql' || conn.dbType === 'mongodb'
                    const groupIndent = isMysql ? 32 : 48
                    const itemIndent = isMysql ? 48 : 64
                    const enumItemIndent = isMysql ? 56 : 72
                    return (
                    <div key={schema.name}>
                      {!isMysql && (
                      <button
                        onClick={() => { onSelectSchema(conn.id, db.name, schema.name); onToggleSchema(conn.id, db.name, schema.name); setActiveItemKey(schemaKey) }}
                        className={cn(
                          'w-full flex items-center gap-1.5 py-0.5 text-xs rounded transition-colors text-left',
                          activeItemKey === schemaKey ? 'bg-primary/20 text-foreground' : 'text-muted-foreground hover:bg-accent/20 hover:text-foreground',
                          activeSchemaPerDb[`${conn.id}::${db.name}`] === schema.name ? 'text-foreground' : ''
                        )}
                        style={{ paddingLeft: 32 }}
                      >
                        {schema.open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                        <span className="text-[10px] font-bold w-3.5 text-center shrink-0 text-amber-300">S</span>
                        <span className="truncate">{schema.name}</span>
                        {activeSchemaPerDb[`${conn.id}::${db.name}`] === schema.name && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-primary shrink-0" />}
                      </button>
                      )}

                      {(needle ? true : isMysql ? db.open : schema.open) && (
                        <>
                           {/* Tables group */}
                          {(() => {
                            const groupKey = `${conn.id}::${db.name}::${schema.name}::tables`
                            const open = needle ? true : openGroups.has(groupKey)
                            const visibleTables = needle ? schema.tables.filter(t => matchingTables.has(`${conn.id}::${db.name}::${schema.name}::${t.name}`)) : schema.tables
                            
                            // If searching and there are no search results, we hide the group
                            if (needle && visibleTables.length === 0) return null

                            return (
                              <>
                                <button
                                  onClick={() => { onSelectSchema(conn.id, db.name, schema.name); toggleGroup(groupKey); setActiveItemKey(groupKey) }}
                                  className={cn(
                                    'w-full flex items-center gap-1.5 py-0.5 text-xs rounded transition-colors text-left',
                                    activeItemKey === groupKey ? 'bg-primary/20 text-foreground' : 'text-muted-foreground hover:bg-accent/20 hover:text-foreground'
                                  )}
                                  style={{ paddingLeft: groupIndent }}
                                >
                                  {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                                  <Table2 className="h-3 w-3 text-primary shrink-0" />
                                  <span>{conn.dbType === 'mongodb' ? 'Collections' : 'Tables'}</span>
                                  <span className="ml-1 text-muted-foreground/50">({needle ? visibleTables.length : schema.tables.length})</span>
                                </button>
                                {open && (
                                  visibleTables.length > 0 ? (
                                    visibleTables.map(t => {
                                      const tableKey = `${conn.id}::${db.name}::${schema.name}::${t.name}`
                                      return (
                                        <div
                                          key={t.name}
                                          role="button" tabIndex={0}
                                          onClick={() => { onSelectSchema(conn.id, db.name, schema.name); setActiveItemKey(tableKey) }}
                                          onDoubleClick={() => onOpenTable(conn.id, db.name, schema.name, t.name)}
                                          onKeyDown={e => e.key === 'Enter' && (onSelectSchema(conn.id, db.name, schema.name), setActiveItemKey(tableKey), onOpenTable(conn.id, db.name, schema.name, t.name))}
                                          onContextMenu={e => {
                                            e.preventDefault()
                                            onSelectSchema(conn.id, db.name, schema.name)
                                            setActiveItemKey(tableKey)
                                            setTableMenu({ x: e.clientX, y: e.clientY, connId: conn.id, dbName: db.name, schema: schema.name, table: t.name, isView: t.type === 'VIEW' })
                                          }}
                                          className={cn(
                                            'flex items-center gap-1.5 py-0.5 text-xs rounded cursor-pointer select-none transition-colors group relative pr-8',
                                            activeItemKey === tableKey ? 'bg-primary/20 text-foreground' : 'text-muted-foreground hover:bg-accent/20 hover:text-foreground'
                                          )}
                                          style={{ paddingLeft: itemIndent }}
                                        >
                                          {t.type === 'VIEW'
                                            ? <View className="h-3.5 w-3.5 text-sky-300 shrink-0" />
                                            : <Table2 className="h-3.5 w-3.5 text-primary shrink-0" />
                                          }
                                          <span className="truncate flex-1">{t.name}</span>
                                        </div>
                                      )
                                    })
                                  ) : (
                                    <AddRow
                                      label={conn.dbType === 'mongodb' ? 'Add collection' : 'Add table'}
                                      indent={itemIndent}
                                      onClick={() => conn.dbType === 'mongodb'
                                        ? onNewCollectionIn(conn.id, db.name)
                                        : onNewTableIn(conn.id, db.name, schema.name)
                                      }
                                    />
                                  )
                                )}
                              </>
                            )
                          })()}

                          {/* Views group */}
                          {(() => {
                            const groupKey = `${conn.id}::${db.name}::${schema.name}::views`
                            const open = needle ? true : openGroups.has(groupKey)
                            const visibleViews = needle ? (schema.views ?? []).filter(v => matchingViews.has(`${conn.id}::${db.name}::${schema.name}::${v.name}`)) : (schema.views ?? [])

                            if (needle && visibleViews.length === 0) return null

                            return (
                              <>
                                <button
                                  onClick={() => { onSelectSchema(conn.id, db.name, schema.name); toggleGroup(groupKey); setActiveItemKey(groupKey) }}
                                  className={cn(
                                    'w-full flex items-center gap-1.5 py-0.5 text-xs rounded transition-colors text-left',
                                    activeItemKey === groupKey ? 'bg-primary/20 text-foreground' : 'text-muted-foreground hover:bg-accent/20 hover:text-foreground'
                                  )}
                                  style={{ paddingLeft: groupIndent }}
                                >
                                  {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                                  <View className="h-3 w-3 text-sky-300 shrink-0" />
                                  <span>Views</span>
                                  <span className="ml-1 text-muted-foreground/50">({needle ? visibleViews.length : (schema.views ?? []).length})</span>
                                </button>
                                {open && (
                                  visibleViews.length > 0 ? (
                                    visibleViews.map(v => {
                                      const viewKey = `${conn.id}::${db.name}::${schema.name}::${v.name}`
                                      return (
                                        <div
                                          key={v.name}
                                          role="button" tabIndex={0}
                                          onClick={() => { onSelectSchema(conn.id, db.name, schema.name); setActiveItemKey(viewKey) }}
                                          onDoubleClick={() => onOpenTable(conn.id, db.name, schema.name, v.name)}
                                          onKeyDown={e => e.key === 'Enter' && (onSelectSchema(conn.id, db.name, schema.name), setActiveItemKey(viewKey), onOpenTable(conn.id, db.name, schema.name, v.name))}
                                          onContextMenu={e => {
                                            e.preventDefault()
                                            onSelectSchema(conn.id, db.name, schema.name)
                                            setActiveItemKey(viewKey)
                                            setTableMenu({ x: e.clientX, y: e.clientY, connId: conn.id, dbName: db.name, schema: schema.name, table: v.name, isView: true })
                                          }}
                                          className={cn(
                                            'flex items-center gap-1.5 py-0.5 text-xs rounded cursor-pointer select-none transition-colors group relative pr-8',
                                            activeItemKey === viewKey ? 'bg-primary/20 text-foreground' : 'text-muted-foreground hover:bg-accent/20 hover:text-foreground'
                                          )}
                                          style={{ paddingLeft: itemIndent }}
                                        >
                                          <View className="h-3.5 w-3.5 text-sky-300 shrink-0" />
                                          <span className="truncate flex-1">{v.name}</span>
                                        </div>
                                      )
                                    })
                                  ) : conn.dbType === 'mongodb' ? (
                                    <div className="text-muted-foreground/45 text-[10px] py-0.5 select-none font-sans italic" style={{ paddingLeft: itemIndent }}>
                                      No views
                                    </div>
                                  ) : (
                                    <AddRow label="Add view" indent={itemIndent} onClick={() => onNewViewIn(conn.id, db.name, schema.name)} />
                                  )
                                )}
                              </>
                            )
                          })()}

                          {/* Materialized Views group — Postgres only */}
                          {!isMysql && (() => {
                            const groupKey = `${conn.id}::${db.name}::${schema.name}::matviews`
                            const open = needle ? true : openGroups.has(groupKey)
                            const visibleMatViews = needle ? (schema.materializedViews ?? []).filter(mv => matchingMaterialized.has(`${conn.id}::${db.name}::${schema.name}::${mv.name}`)) : (schema.materializedViews ?? [])

                            if (needle && visibleMatViews.length === 0) return null

                            return (
                              <>
                                <button
                                  onClick={() => { onSelectSchema(conn.id, db.name, schema.name); toggleGroup(groupKey); setActiveItemKey(groupKey) }}
                                  className={cn(
                                    'w-full flex items-center gap-1.5 py-0.5 text-xs rounded transition-colors text-left',
                                    activeItemKey === groupKey ? 'bg-primary/20 text-foreground' : 'text-muted-foreground hover:bg-accent/20 hover:text-foreground'
                                  )}
                                  style={{ paddingLeft: groupIndent }}
                                >
                                  {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                                  <View className="h-3 w-3 text-teal-300 shrink-0" />
                                  <span>Materialized Views</span>
                                  <span className="ml-1 text-muted-foreground/50">({needle ? visibleMatViews.length : (schema.materializedViews ?? []).length})</span>
                                </button>
                                {open && (
                                  visibleMatViews.length > 0 ? (
                                    visibleMatViews.map(mv => {
                                      const mvKey = `${conn.id}::${db.name}::${schema.name}::${mv.name}`
                                      return (
                                        <div
                                          key={mvKey}
                                          role="button" tabIndex={0}
                                          onClick={() => { onSelectSchema(conn.id, db.name, schema.name); setActiveItemKey(mvKey) }}
                                          onDoubleClick={() => onOpenTable(conn.id, db.name, schema.name, mv.name)}
                                          onKeyDown={e => e.key === 'Enter' && (onSelectSchema(conn.id, db.name, schema.name), setActiveItemKey(mvKey), onOpenTable(conn.id, db.name, schema.name, mv.name))}
                                          className={cn(
                                            'flex items-center gap-1.5 py-0.5 text-xs rounded cursor-pointer select-none transition-colors group relative pr-8',
                                            activeItemKey === mvKey ? 'bg-primary/20 text-foreground' : 'text-muted-foreground hover:bg-accent/20 hover:text-foreground'
                                          )}
                                          style={{ paddingLeft: itemIndent }}
                                        >
                                          <View className="h-3.5 w-3.5 text-teal-300 shrink-0" />
                                          <span className="truncate flex-1">{mv.name}</span>
                                          <button
                                            onClick={e => { e.stopPropagation(); handleRefreshMaterializedView(conn.id, db.name, schema.name, mv.name) }}
                                            title="Refresh materialized view data"
                                            className="absolute right-1 opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-accent/40 text-muted-foreground hover:text-foreground shrink-0"
                                          >
                                            <RefreshCw className="h-3 w-3" />
                                          </button>
                                        </div>
                                      )
                                    })
                                  ) : (
                                    <div className="text-muted-foreground/45 text-[10px] py-0.5 select-none font-sans italic" style={{ paddingLeft: itemIndent }}>
                                      No materialized views
                                    </div>
                                  )
                                )}
                              </>
                            )
                          })()}

                          {/* Functions group */}
                          {(() => {
                            const groupKey = `${conn.id}::${db.name}::${schema.name}::functions`
                            const open = needle ? true : openGroups.has(groupKey)
                            const visibleFns = needle ? schema.functions.filter(fn => matchingFns.has(`${conn.id}::${db.name}::${schema.name}::${fn.name}::${fn.arguments}`)) : schema.functions

                            if (needle && visibleFns.length === 0) return null

                            return (
                              <>
                                <button
                                  onClick={() => { onSelectSchema(conn.id, db.name, schema.name); toggleGroup(groupKey); setActiveItemKey(groupKey) }}
                                  className={cn(
                                    'w-full flex items-center gap-1.5 py-0.5 text-xs rounded transition-colors text-left',
                                    activeItemKey === groupKey ? 'bg-primary/20 text-foreground' : 'text-muted-foreground hover:bg-accent/20 hover:text-foreground'
                                  )}
                                  style={{ paddingLeft: groupIndent }}
                                >
                                  {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                                  <FunctionSquare className="h-3 w-3 text-purple-300 shrink-0" />
                                  <span>Functions</span>
                                  <span className="ml-1 text-muted-foreground/50">({needle ? visibleFns.length : schema.functions.length})</span>
                                </button>
                                {open && (
                                  visibleFns.length > 0 ? (
                                    visibleFns.map(fn => {
                                      const fnKey = `${conn.id}::${db.name}::${schema.name}::fn::${fn.name}::${fn.arguments}`
                                      return (
                                        <div
                                          key={fnKey}
                                          role="button" tabIndex={0}
                                          onClick={() => { onSelectSchema(conn.id, db.name, schema.name); setActiveItemKey(fnKey) }}
                                          onDoubleClick={() => onOpenFunction(conn.id, db.name, schema.name, fn.name, fn.arguments)}
                                          onKeyDown={e => e.key === 'Enter' && (onSelectSchema(conn.id, db.name, schema.name), setActiveItemKey(fnKey), onOpenFunction(conn.id, db.name, schema.name, fn.name, fn.arguments))}
                                          className={cn(
                                            'flex items-center gap-1.5 py-0.5 text-xs rounded cursor-pointer select-none transition-colors',
                                            activeItemKey === fnKey ? 'bg-primary/20 text-foreground' : 'text-muted-foreground hover:bg-accent/20 hover:text-foreground'
                                          )}
                                          style={{ paddingLeft: itemIndent }}
                                        >
                                          <FunctionSquare className="h-3.5 w-3.5 text-purple-300 shrink-0" />
                                          <span className="truncate flex-1">
                                            {fn.name}
                                            <span className="text-muted-foreground/60 ml-1">({fn.arguments})</span>
                                          </span>
                                        </div>
                                      )
                                    })
                                  ) : (
                                    <div className="text-muted-foreground/45 text-[10px] py-0.5 select-none font-sans italic" style={{ paddingLeft: itemIndent }}>
                                      No functions
                                    </div>
                                  )
                                )}
                              </>
                            )
                          })()}

                          {/* Enums group */}
                          {(() => {
                            const groupKey = `${conn.id}::${db.name}::${schema.name}::enums`
                            const open = openGroups.has(groupKey)
                            if (needle && schema.enums.length === 0) return null
                            return (
                              <>
                                <button
                                  onClick={() => { onSelectSchema(conn.id, db.name, schema.name); toggleGroup(groupKey); setActiveItemKey(groupKey) }}
                                  className={cn('w-full flex items-center gap-1.5 py-0.5 text-xs rounded transition-colors text-left', activeItemKey === groupKey ? 'bg-primary/20 text-foreground' : 'text-muted-foreground hover:bg-accent/20 hover:text-foreground')}
                                  style={{ paddingLeft: groupIndent }}
                                >
                                  {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                                  <Tag className="h-3 w-3 text-yellow-400 shrink-0" />
                                  <span>Enums</span>
                                  <span className="ml-1 text-muted-foreground/50">({schema.enums.length})</span>
                                </button>
                                {open && (
                                  schema.enums.length > 0 ? (
                                    schema.enums.map(en => {
                                      const enKey = `${conn.id}::${db.name}::${schema.name}::enum::${en.name}`
                                      const enOpen = openGroups.has(enKey)
                                      return (
                                        <div key={enKey}>
                                          <button
                                            onClick={() => { setActiveItemKey(enKey); toggleGroup(enKey) }}
                                            className={cn('w-full flex items-center gap-1.5 py-0.5 text-xs rounded transition-colors text-left', activeItemKey === enKey ? 'bg-primary/20 text-foreground' : 'text-muted-foreground hover:bg-accent/20 hover:text-foreground')}
                                            style={{ paddingLeft: itemIndent }}
                                          >
                                            {enOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                                            <Tag className="h-3 w-3 text-yellow-400 shrink-0" />
                                            <span className="truncate">{en.name}</span>
                                            <span className="ml-1 text-muted-foreground/50">({en.values.length})</span>
                                          </button>
                                          {enOpen && (
                                            <div className="flex flex-wrap gap-1 py-1" style={{ paddingLeft: enumItemIndent, paddingRight: 8 }}>
                                              {en.values.map(v => (
                                                <span key={v} className="px-1.5 py-0.5 rounded text-[10px] bg-yellow-400/10 text-yellow-300 border border-yellow-400/20 leading-none">{v}</span>
                                              ))}
                                            </div>
                                          )}
                                        </div>
                                      )
                                    })
                                  ) : (
                                    <div className="text-muted-foreground/45 text-[10px] py-0.5 select-none font-sans italic" style={{ paddingLeft: itemIndent }}>No enums</div>
                                  )
                                )}
                              </>
                            )
                          })()}

                          {/* Types group — Postgres only */}
                          {!isMysql && (() => {
                            const groupKey = `${conn.id}::${db.name}::${schema.name}::types`
                            const open = openGroups.has(groupKey)
                            if (needle && schema.types.length === 0) return null
                            return (
                              <>
                                <button
                                  onClick={() => { onSelectSchema(conn.id, db.name, schema.name); toggleGroup(groupKey); setActiveItemKey(groupKey) }}
                                  className={cn('w-full flex items-center gap-1.5 py-0.5 text-xs rounded transition-colors text-left', activeItemKey === groupKey ? 'bg-primary/20 text-foreground' : 'text-muted-foreground hover:bg-accent/20 hover:text-foreground')}
                                  style={{ paddingLeft: groupIndent }}
                                >
                                  {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                                  <Shapes className="h-3 w-3 text-orange-400 shrink-0" />
                                  <span>Types</span>
                                  <span className="ml-1 text-muted-foreground/50">({schema.types.length})</span>
                                </button>
                                {open && (
                                  schema.types.length > 0 ? (
                                    schema.types.map(tp => {
                                      const tpKey = `${conn.id}::${db.name}::${schema.name}::type::${tp.name}`
                                      return (
                                        <div
                                          key={tpKey}
                                          role="button" tabIndex={0}
                                          onClick={() => setActiveItemKey(tpKey)}
                                          onDoubleClick={() => onOpenType(conn.id, db.name, schema.name, tp.name, tp.definition)}
                                          onKeyDown={e => e.key === 'Enter' && onOpenType(conn.id, db.name, schema.name, tp.name, tp.definition)}
                                          className={cn('flex items-center gap-1.5 py-0.5 text-xs rounded cursor-pointer select-none transition-colors', activeItemKey === tpKey ? 'bg-primary/20 text-foreground' : 'text-muted-foreground hover:bg-accent/20 hover:text-foreground')}
                                          style={{ paddingLeft: itemIndent }}
                                        >
                                          <Shapes className="h-3 w-3 text-orange-400 shrink-0" />
                                          <span className="truncate flex-1">{tp.name}</span>
                                          <span className="text-muted-foreground/50 text-[10px] shrink-0">{tp.definition}</span>
                                        </div>
                                      )
                                    })
                                  ) : (
                                    <div className="text-muted-foreground/45 text-[10px] py-0.5 select-none font-sans italic" style={{ paddingLeft: itemIndent }}>No types</div>
                                  )
                                )}
                              </>
                            )
                          })()}

                          {/* Saved queries group */}
                          {(() => {
                            const allSchemaSaved = savedQueries.filter(q => q.connectionId === conn.id && q.databaseName === db.name && q.schemaName === schema.name)
                            const schemaSaved = needle ? allSchemaSaved.filter(sq => matchingSaved.has(sq.id)) : allSchemaSaved

                            if (needle && schemaSaved.length === 0) return null

                            const groupKey = `${conn.id}::${db.name}::${schema.name}::saved`
                            const open = needle ? true : openGroups.has(groupKey)
                            return (
                              <>
                                <button
                                  onClick={() => { onSelectSchema(conn.id, db.name, schema.name); toggleGroup(groupKey); setActiveItemKey(groupKey) }}
                                  className={cn('w-full flex items-center gap-1.5 py-0.5 text-xs rounded transition-colors text-left', activeItemKey === groupKey ? 'bg-primary/20 text-foreground' : 'text-muted-foreground hover:bg-accent/20 hover:text-foreground')}
                                  style={{ paddingLeft: groupIndent }}
                                >
                                  {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                                  <Save className="h-3 w-3 text-primary/70 shrink-0" />
                                  <span>Saved Queries</span>
                                  <span className="ml-1 text-muted-foreground/50">({schemaSaved.length})</span>
                                </button>
                                {open && (
                                  schemaSaved.length > 0 ? (
                                    schemaSaved.map(sq => {
                                      const sqKey = `saved::${sq.id}`
                                      return (
                                        <div
                                          key={sq.id}
                                          role="button" tabIndex={0}
                                          onClick={() => { onSelectSchema(conn.id, db.name, schema.name); setActiveItemKey(sqKey) }}
                                          onDoubleClick={() => onOpenSavedQuery(sq)}
                                          onKeyDown={e => e.key === 'Enter' && (onSelectSchema(conn.id, db.name, schema.name), onOpenSavedQuery(sq), setActiveItemKey(sqKey))}
                                          className={cn('group w-full flex items-center gap-1.5 py-0.5 text-xs rounded transition-colors cursor-pointer select-none', activeItemKey === sqKey ? 'bg-primary/20 text-foreground' : 'text-muted-foreground hover:bg-accent/20 hover:text-foreground')}
                                          style={{ paddingLeft: itemIndent }}
                                        >
                                          <FileCode className="h-3 w-3 shrink-0" />
                                          <span className="truncate flex-1">{sq.title}</span>
                                          <button
                                            onClick={e => { e.stopPropagation(); onRenameSavedQuery(sq.id, sq.title) }}
                                            className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-accent/30 hover:text-foreground shrink-0"
                                            title="Rename"
                                          >
                                            <Pencil className="h-2.5 w-2.5" />
                                          </button>
                                          <button
                                            onClick={e => { e.stopPropagation(); onDeleteSavedQuery(sq.id) }}
                                            className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-accent/30 hover:text-destructive shrink-0"
                                            title="Delete"
                                          >
                                            <X className="h-2.5 w-2.5" />
                                          </button>
                                        </div>
                                      )
                                    })
                                  ) : (
                                    <div className="text-muted-foreground/45 text-[10px] py-0.5 select-none font-sans italic" style={{ paddingLeft: itemIndent }}>
                                      No saved queries
                                    </div>
                                  )
                                )}
                              </>
                            )
                          })()}
                        </>
                      )}
                    </div>
                  )})}

                  {/* No schemas yet (Postgres only — MySQL/Mongo databases have no separate schema level) */}
                  {db.open && !db.error && conn.dbType === 'postgres' && db.schemas.length === 0 && (
                    <AddRow label="Add schema" indent={32} onClick={() => onDatabaseAction({ kind: 'schema', connId: conn.id, dbName: db.name })} />
                  )}
                </div>
              )
              })}

              {/* No databases yet (Postgres only — MySQL/Mongo connections list what the server already has) */}
              {isOpen && conn.status === 'connected' && conn.dbType === 'postgres' && conn.databases.length === 0 && (
                <AddRow label="Add database" indent={16} onClick={() => onDatabaseAction({ kind: 'create', connId: conn.id, dbName: connectionBaseDb(conn) })} />
              )}
            </div>
          )
        })}
      </div>
      {connMenu && (() => {
        const conn = connections.find(c => c.id === connMenu.connId)
        return conn ? <ContextMenuAt x={connMenu.x} y={connMenu.y} entries={connMenuEntries(conn)} onClose={() => setConnMenu(null)} /> : null
      })()}
      {tableMenu && (() => {
        const conn = connections.find(c => c.id === tableMenu.connId)
        return conn ? <ContextMenuAt x={tableMenu.x} y={tableMenu.y} entries={tableMenuEntries(conn, tableMenu)} onClose={() => setTableMenu(null)} /> : null
      })()}
      {exportDialog && (
        <ExportDialog target={exportDialog.target} preset={exportDialog.preset} onClose={() => setExportDialog(null)} />
      )}
      {transfer?.kind === 'dump' && (
        <DatabaseExportDialog target={{ dbType: transfer.dbType, connectionId: transfer.connId, database: transfer.dbName }} onClose={() => setTransfer(null)} />
      )}
      {transfer?.kind === 'execute' && (
        <SqlFileImportDialog target={{ dbType: transfer.dbType, connectionId: transfer.connId, database: transfer.dbName }}
          onClose={() => setTransfer(null)} onDone={() => onRefreshDb(transfer.connId, transfer.dbName)} />
      )}
      {transfer?.kind === 'mongo-export' && (
        <MongoExportDialog connectionId={transfer.connId} database={transfer.dbName} only={transfer.collection} onClose={() => setTransfer(null)} />
      )}
      {transfer?.kind === 'mongo-import' && (
        <MongoImportDialog connectionId={transfer.connId} database={transfer.dbName} collection={transfer.collection}
          onClose={() => setTransfer(null)} onDone={() => onRefreshDb(transfer.connId, transfer.dbName)} />
      )}
      {transfer?.kind === 'table-import' && (
        <TableImportDialog target={transfer.target} onClose={() => setTransfer(null)} />
      )}
      {tableDialog && (
        <ActionDialog
          kind={tableDialog.kind}
          target={tableDialog.target}
          initialOptions={tableDialog.initialOptions}
          onClose={() => setTableDialog(null)}
          onDone={change => {
            const { kind, target } = tableDialog
            setTableDialog(null)
            // Duplicates get their own toast (with an Open button) from onTableChanged
            if (change.kind !== 'created') toast.success(`${tableActionTitle(kind)} finished`)
            onTableChanged(target.connectionId, target.database, target.schema, target.table, change)
          }}
        />
      )}
      {dbMenu && (() => {
        const conn = connections.find(c => c.id === dbMenu.connId)
        const db = conn?.databases.find(d => d.name === dbMenu.dbName)
        return conn && db ? <ContextMenuAt x={dbMenu.x} y={dbMenu.y} entries={dbMenuEntries(conn, db)} onClose={() => setDbMenu(null)} /> : null
      })()}
    </div>
  )
}

// ── Query tab bar ─────────────────────────────────────────────────────────────

const DB_TYPE_COLORS = { postgres: 'text-blue-400', mysql: 'text-orange-400', mongodb: 'text-emerald-400', sqlite: 'text-sky-300', redis: 'text-red-400' } as const
const DB_TYPE_LABELS = { postgres: 'PostgreSQL', mysql: 'MySQL', mongodb: 'MongoDB', sqlite: 'SQLite', redis: 'Redis' } as const

function QueryTabBar({
  tabs, activeId, onSelect, onClose, dbTypeOf, colorOf,
}: {
  tabs: QueryTab[]
  activeId: string
  onSelect: (id: string) => void
  onClose: (id: string) => void
  dbTypeOf: (tab: QueryTab) => 'postgres' | 'mysql' | 'mongodb' | 'sqlite' | 'redis' | undefined
  colorOf?: (tab: QueryTab) => string | null
}) {
  // Scroll the active tab into view when it changes (e.g. opening something that already has a tab)
  const stripRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const strip = stripRef.current
    const el = strip?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeId)}"]`)
    if (!strip || !el) return
    const left = el.offsetLeft // the strip is the offset parent (relative)
    const right = left + el.offsetWidth
    if (left < strip.scrollLeft) strip.scrollTo({ left, behavior: 'smooth' })
    else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollTo({ left: right - strip.clientWidth, behavior: 'smooth' })
  }, [activeId, tabs.length])

  return (
    <div ref={stripRef} className="relative flex items-end border-b border-border bg-card shrink-0 overflow-x-auto">
      {tabs.map(tab => {
        const dbType = dbTypeOf(tab)
        const isMongo = dbType === 'mongodb'
        // Same colors as the connection badges in the sidebar
        const dbColor = dbType ? DB_TYPE_COLORS[dbType] : 'text-primary'
        const isChanged = (tab.isFunction && tab.sql !== tab.originalSql) || (tab.kind === 'design' && isTableDesignChanged(tab)) || (!tab.isFunction && tab.kind === 'query' && tab.originalSql !== undefined && tab.sql !== tab.originalSql && tab.sql.trim() !== '') || (tab.kind === 'create-table' && (tab.columns ?? []).length > 0) || (tab.kind === 'create-view' && tab.sql.trim() !== '') || hasPendingTableEdits(tab)
        return (
          <div
            key={tab.id}
            data-tab-id={tab.id}
            onClick={() => onSelect(tab.id)}
            onMouseDown={e => { if (e.button === 1) { e.preventDefault(); onClose(tab.id) } }}
            title={dbType ? `${tab.title} (${DB_TYPE_LABELS[dbType]})` : undefined}
            className={cn(
              'group flex items-center gap-1.5 px-3 h-8 text-xs cursor-pointer border-r border-border shrink-0 transition-colors select-none',
              tab.id === activeId
                ? 'bg-background text-foreground border-b-2 border-b-primary -mb-px'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/10'
            )}
            style={colorOf?.(tab) ? { boxShadow: `inset 0 2px 0 ${colorOf(tab)}` } : undefined}
          >
            {tab.kind === 'redis-browser' ? (
              <KeyRound className={cn('h-3 w-3 shrink-0', dbColor)} />
            ) : tab.kind === 'redis-console' ? (
              <SquareTerminal className={cn('h-3 w-3 shrink-0', dbColor)} />
            ) : tab.kind === 'table' ? (
              <Table2 className={cn('h-3 w-3 shrink-0', dbColor)} />
            ) : tab.kind === 'design' ? (
              <Wrench className="h-3 w-3 shrink-0 text-primary" />
            ) : tab.kind === 'erd' ? (
              <Workflow className="h-3 w-3 shrink-0 text-primary" />
            ) : tab.kind === 'create-table' ? (
              <Table2 className="h-3 w-3 shrink-0 text-primary" />
            ) : tab.kind === 'create-view' ? (
              <View className="h-3 w-3 shrink-0 text-sky-300" />
            ) : tab.kind === 'structure-sync' ? (
              <GitCompareArrows className="h-3 w-3 shrink-0 text-primary" />
            ) : tab.kind === 'data-sync' ? (
              <DatabaseZap className="h-3 w-3 shrink-0 text-primary" />
            ) : tab.isFunction ? (
              <FunctionSquare className="h-3 w-3 shrink-0 text-purple-300" />
            ) : tab.tableName?.startsWith('type:') ? (
              <Shapes className="h-3 w-3 shrink-0 text-orange-400" />
            ) : isMongo ? (
              <Leaf className={cn('h-3 w-3 shrink-0', dbColor)} />
            ) : dbType ? (
              <Database className={cn('h-3 w-3 shrink-0', dbColor)} />
            ) : (
              <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
            <span className="max-w-32 truncate">{tab.title}</span>
            {isChanged && (
              <Circle className="h-1.5 w-1.5 fill-primary text-primary shrink-0 ml-0.5" />
            )}
            <button
              onClick={e => { e.stopPropagation(); onClose(tab.id) }}
              className="opacity-0 group-hover:opacity-100 ml-0.5 rounded hover:bg-accent/30 p-0.5 transition-opacity"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

// ── Results grid (standalone to avoid inline-component remount lag) ────────────

// Spreadsheet Tab order: next cell to the right, wrapping to the next row (Shift+Tab: reverse).
// Stays put at the very first/last cell.
export function nextTabCell(ri: number, ci: number, columns: number, rows: number, backwards: boolean): { ri: number; ci: number } {
  if (columns === 0 || rows === 0) return { ri, ci }
  if (!backwards) {
    if (ci + 1 < columns) return { ri, ci: ci + 1 }
    return ri + 1 < rows ? { ri: ri + 1, ci: 0 } : { ri, ci }
  }
  if (ci > 0) return { ri, ci: ci - 1 }
  return ri > 0 ? { ri: ri - 1, ci: columns - 1 } : { ri, ci }
}

// MongoDB cells that can't be edited as text: _id, and whole sub-documents (they expand instead)
function isLockedMongoCell(col: string, raw: unknown) {
  if (col === '_id' || col.startsWith('_id.')) return true
  return !!raw && typeof raw === 'object' && !Array.isArray(raw) && !(raw as { _bsontype?: string })._bsontype && !(raw instanceof Date)
}

const CELL_EDIT_DEBOUNCE_MS = 250
const DEFAULT_COL_WIDTH = 160
const MIN_COL_WIDTH = 40

interface TableGridProps {
  editable?: boolean
  pendingEdits?: Record<string, CellEdit>
  onCellEdit?: (rowIndex: number, col: string, value: string | null | undefined) => void
  errorRowIndex?: number
  // When set, header clicks sort the whole table on the server instead of the rows on screen.
  // `dir` sets the order directly (null clears it); without it the column's sort cycles.
  serverSort?: { sort?: TableSort; onSort: (column: string, dir?: 'asc' | 'desc' | null) => void }
  // The table or collection the rows come from, for "Copy As" statements and cell actions
  table?: { schema: string; name: string; primaryKeys: string[] }
  onDeleteRow?: (rowIndex: number) => void
  // Why rows can't be deleted right now (e.g. unsaved edits), shown in the menu
  deleteBlockedReason?: string
  onMongoEdit?: (rowIndex: number, edit: MongoCellEdit) => void
  // Foreign keys of the table: their cells get a row-picker popup over the referenced table
  foreignKeys?: FkRef[]
  fkTarget?: FkLookupTarget
  onOpenReferencedTable?: (fk: FkRef) => void
  // An empty editable table shows one blank row; saving what is typed into it inserts a row
  allowNewRow?: boolean
  // Scroll to this cell and select it (row: index into the result's rows)
  focusCell?: { row: number; col: string; nonce: number }
}

// Grid interactions a row forwards to its grid. Rows read them through a ref, so a row that skips
// re-rendering still calls the grid's latest logic.
interface GridActions {
  select: (ri: number, col: string) => void
  activate: (ri: number, col: string, isDoc: boolean) => void
  openMenu: (x: number, y: number, ri: number, rowIndex: number, col: string, anchor: DOMRect) => void
  openDate: (ri: number, rowIndex: number, col: string, anchor: DOMRect) => void
  openFk: (ri: number, rowIndex: number, col: string, anchor: DOMRect) => void
  editStart: (pendingValue: string | null | undefined, before: string, typed: boolean, current: string) => void
  edit: (rowIndex: number, col: string, text: string, original: string) => void
  recordHistory: (text: string) => void
  stepHistory: (input: HTMLInputElement, redo: boolean) => string | undefined
  cancelEdit: (rowIndex: number, col: string) => void
  endEdit: () => void
  tab: (ri: number, col: string, backwards: boolean) => void
}

interface GridRowProps {
  row: Record<string, any>
  ri: number
  rowIndex: number
  isDraft: boolean
  fields: string[]
  colWidths: Record<string, number>
  selectedCol: string | null
  editing: { col: string; typed?: string } | null
  pendingEdits: Record<string, CellEdit> | undefined
  failed: boolean
  fkPopupCol: string | null
  datePopupCol: string | null
  dbType?: 'postgres' | 'mysql' | 'mongodb' | 'sqlite' | 'redis'
  editable: boolean
  highlightKinds: ReadonlySet<string>
  columnTypeByName: Map<string, string>
  fkByColumn: Map<string, FkRef>
  dateKindByColumn: Map<string, DateColumnKind>
  rowTypes: Record<string, string> | undefined   // MongoDB: each field's BSON type in this document
  actions: React.RefObject<GridActions>
}

// Re-render a row only when something it shows changed; for pending edits only its own cells count
function gridRowPropsEqual(prev: GridRowProps, next: GridRowProps) {
  for (const key of Object.keys(next) as (keyof GridRowProps)[]) {
    if (key === 'pendingEdits') continue
    if (prev[key] !== next[key]) return false
  }
  if (prev.pendingEdits === next.pendingEdits) return true
  return next.fields.every(col => {
    const k = cellEditKey(next.rowIndex, col)
    return prev.pendingEdits?.[k] === next.pendingEdits?.[k]
  })
}

const GridRow = React.memo(function GridRow({
  row, ri, rowIndex, isDraft, fields, colWidths, selectedCol, editing, pendingEdits, failed, fkPopupCol, datePopupCol,
  dbType, editable, highlightKinds, columnTypeByName, fkByColumn, dateKindByColumn, rowTypes, actions,
}: GridRowProps) {
  return (
    <tr className={cn('border-b border-border/50', selectedCol !== null ? 'bg-primary/10' : 'hover:bg-accent/10', isDraft && 'border-dashed')}>
      {fields.map(col => {
        const isSelected = selectedCol === col
        const isEditing = editing?.col === col
        const pending = pendingEdits?.[cellEditKey(rowIndex, col)]
        const isFailedEdit = !!pending && failed
        const raw = getNestedValue(row, col)
        const width = colWidths[col] ?? DEFAULT_COL_WIDTH
        let display = ''
        let isDoc = false
        if (raw === null || raw === undefined) {
          display = 'null'
        } else if (
          dbType === 'mongodb' &&
          typeof raw === 'object' &&
          !Array.isArray(raw) &&
          raw.constructor?.name !== 'ObjectID' &&
          raw.constructor?.name !== 'ObjectId' &&
          !(raw as any)._bsontype
        ) {
          isDoc = true
          display = `Document (${Object.keys(raw).length})`
        } else {
          display = typeof raw === 'object' ? JSON.stringify(raw) : String(raw)
        }
        const original = cellEditText(raw)
        const dateKind = editable ? cellDateKind(dateKindByColumn.get(col), rowTypes?.[col]) : undefined

        let tint: React.CSSProperties = {}
        if (highlightKinds.size > 0 && !isEditing && !pending && !isFailedEdit && !isSelected && !isDraft) {
          const kind = cellHighlightKind(columnTypeByName.get(col), raw)
          if (kind && highlightKinds.has(kind)) tint = { backgroundColor: `color-mix(in oklch, var(--hl-${kind}) 20%, transparent)` }
        }

        return (
          <td
            key={col}
            data-cell={`${ri}:${col}`}
            onClick={e => { e.stopPropagation(); actions.current.select(ri, col) }}
            onDoubleClick={e => { e.stopPropagation(); actions.current.activate(ri, col, isDoc) }}
            onContextMenu={e => {
              // Inside the cell editor the browser's own menu (cut/copy/paste) is more useful
              if (isEditing || rowIndex < 0) return
              e.preventDefault()
              e.stopPropagation()
              actions.current.openMenu(e.clientX, e.clientY, ri, rowIndex, col, e.currentTarget.getBoundingClientRect())
            }}
            className={cn(
              'border-r border-border/50 font-mono whitespace-nowrap',
              isEditing ? 'p-0' : 'px-2 py-0.5 truncate',
              (fkByColumn.has(col) || dateKind) && 'relative group/fk',
              isDoc ? 'cursor-pointer' : 'cursor-default',
              pending && !isEditing && !isFailedEdit ? 'bg-amber-500/20 ring-1 ring-inset ring-amber-500/60' : '',
              isFailedEdit && !isEditing ? 'bg-red-500/20 ring-1 ring-inset ring-red-500/70' : '',
              isSelected && !isEditing && !pending ? 'ring-1 ring-inset ring-primary bg-primary/5' : '',
            )}
            style={{ width, minWidth: width, maxWidth: width, ...tint }}
          >
            {isEditing ? (
              <input
                autoFocus
                readOnly={!editable}
                defaultValue={editing?.typed ?? (pending ? (pending.value ?? '') : original)}
                onFocus={e => {
                  const typed = editing?.typed !== undefined
                  const before = pending ? (pending.value ?? '') : original
                  // Undo from a typed start goes back to the value the cell had before
                  actions.current.editStart(pending?.value, before, typed, e.currentTarget.value)
                  if (!typed) { e.currentTarget.select(); return }
                  const end = e.currentTarget.value.length
                  e.currentTarget.setSelectionRange(end, end)
                  if (editable && rowIndex >= 0) actions.current.edit(rowIndex, col, e.currentTarget.value, original)
                }}
                onChange={e => {
                  const text = e.currentTarget.value
                  actions.current.recordHistory(text)
                  if (editable && rowIndex >= 0) actions.current.edit(rowIndex, col, text, original)
                }}
                onKeyDown={e => {
                  const key = e.key.toLowerCase()
                  if ((e.ctrlKey || e.metaKey) && (key === 'z' || key === 'y')) {
                    e.preventDefault()
                    const text = actions.current.stepHistory(e.currentTarget, key === 'y' || e.shiftKey)
                    if (text !== undefined && editable && rowIndex >= 0) actions.current.edit(rowIndex, col, text, original)
                  } else if (e.key === 'Escape') {
                    if (editable && rowIndex >= 0) actions.current.cancelEdit(rowIndex, col)
                    e.currentTarget.blur()
                  } else if (e.key === 'Enter') {
                    e.currentTarget.blur()
                  } else if (e.key === 'Tab') {
                    e.preventDefault()
                    e.currentTarget.blur()
                    actions.current.tab(ri, col, e.shiftKey)
                  } else if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
                    // Leave edit mode; the Ctrl+S listener on document still receives this event and saves
                    e.currentTarget.blur()
                  }
                }}
                onBlur={() => actions.current.endEdit()}
                className={cn('w-full h-full px-2 py-0.5 text-foreground text-xs font-mono outline-none border-none ring-1 ring-inset', editable ? 'bg-background ring-amber-500' : 'bg-primary/10 ring-primary')}
              />
            ) : pending ? (
              <span className={cn(isFailedEdit ? 'text-red-400' : 'text-amber-400', pending.value === null && 'italic')}>{pending.value ?? 'NULL'}</span>
            ) : isDraft ? (
              <span className="text-muted-foreground/40 italic" title="Filled in by the database unless you type a value">DEFAULT</span>
            ) : raw === null || raw === undefined ? (
              <span className="text-muted-foreground/50 italic">null</span>
            ) : isDoc ? (
              <span className="text-primary font-semibold">{display}</span>
            ) : typeof raw === 'object' ? (
              <span className="text-muted-foreground/80">{display}</span>
            ) : display}
            {!isEditing && rowIndex >= 0 && dateKind && (
              <button
                onClick={e => {
                  e.stopPropagation()
                  actions.current.openDate(ri, rowIndex, col, (e.currentTarget.closest('td') as HTMLElement).getBoundingClientRect())
                }}
                onDoubleClick={e => e.stopPropagation()}
                title="Pick a date"
                className={cn(
                  'absolute top-1/2 -translate-y-1/2 p-0.5 rounded bg-card border border-border text-primary hover:bg-primary/20 transition-opacity',
                  fkByColumn.has(col) ? 'right-6' : 'right-0.5',
                  datePopupCol === col ? 'opacity-100' : 'opacity-0 group-hover/fk:opacity-100',
                )}
              >
                <CalendarDays className="h-3 w-3" />
              </button>
            )}
            {!isEditing && rowIndex >= 0 && fkByColumn.has(col) && (
              <button
                onClick={e => {
                  e.stopPropagation()
                  actions.current.openFk(ri, rowIndex, col, (e.currentTarget.closest('td') as HTMLElement).getBoundingClientRect())
                }}
                onDoubleClick={e => e.stopPropagation()}
                title={`Pick a row from ${fkByColumn.get(col)!.refTable} (or right-click the cell)`}
                className={cn(
                  'absolute right-0.5 top-1/2 -translate-y-1/2 p-0.5 rounded bg-card border border-border text-primary hover:bg-primary/20 transition-opacity',
                  fkPopupCol === col ? 'opacity-100' : 'opacity-0 group-hover/fk:opacity-100',
                )}
              >
                <Link2 className="h-3 w-3" />
              </button>
            )}
          </td>
        )
      })}
    </tr>
  )
}, gridRowPropsEqual)

function SingleResultGrid({ result, columnTypes, dbType, editable = false, pendingEdits, onCellEdit, errorRowIndex, serverSort, foreignKeys, fkTarget, onOpenReferencedTable, table, onDeleteRow, deleteBlockedReason, onMongoEdit, allowNewRow, focusCell }: { result: QueryResult; columnTypes?: ColumnInfo[]; dbType?: 'postgres' | 'mysql' | 'mongodb' | 'sqlite' | 'redis' } & TableGridProps) {
  const [selectedCell, setSelectedCell] = useState<{ ri: number; col: string } | null>(null)
  const [cellMenu, setCellMenu] = useState<{ x: number; y: number; ri: number; rowIndex: number; col: string; anchor: DOMRect } | null>(null)
  // `typed`: editing was started by typing this character on the selected cell
  const [editingCell, setEditingCell] = useState<{ ri: number; col: string; typed?: string } | null>(null)
  const [colWidths, setColWidths] = useState<Record<string, number>>({})
  const [fkPopup, setFkPopup] = useState<{ rowIndex: number; col: string; fk: FkRef; anchor: DOMRect } | null>(null)
  const fkByColumn = useMemo(() => new Map((fkTarget ? foreignKeys ?? [] : []).map(fk => [fk.column, fk])), [foreignKeys, fkTarget])
  const highlightKinds = React.useSyncExternalStore(highlightStore.subscribe, highlightStore.get, highlightServerSnapshot)
  const columnTypeByName = useMemo(() => new Map((columnTypes ?? []).map(c => [c.name, c.type])), [columnTypes])
  // Editable date/timestamp columns get a calendar picker; MongoDB fields get one per document,
  // where the value is a Date (see dateKindAt)
  const dateKindByColumn = useMemo(() => new Map<string, DateColumnKind>(
    editable
      ? (columnTypes ?? []).flatMap(c => { const kind = dateColumnKind(c.type); return kind ? [[c.name, kind] as [string, DateColumnKind]] : [] })
      : [],
  ), [columnTypes, editable])
  const dateKindAt = (rowIndex: number, col: string) =>
    editable ? cellDateKind(dateKindByColumn.get(col), result.types?.[rowIndex]?.[col]) : undefined
  const [datePopup, setDatePopup] = useState<{ rowIndex: number; col: string; kind: DateColumnKind; anchor: DOMRect } | null>(null)
  const justResizedRef = useRef(false)
  // Rows in display order, for the keyboard handler (declared before the rows are computed)
  const shownRowsRef = useRef<Record<string, any>[]>([])
  // Pending value of the cell when editing started, so Escape can restore it
  const editStartRef = useRef<string | null | undefined>(undefined)
  const commitTimerRef = useRef<{ timer: ReturnType<typeof setTimeout>; commit: () => void } | null>(null)

  const cancelPendingCommit = () => {
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current.timer)
    commitTimerRef.current = null
  }
  const flushPendingCommit = () => {
    const pendingCommit = commitTimerRef.current
    cancelPendingCommit()
    pendingCommit?.commit()
  }
  const scheduleCommit = (commit: () => void) => {
    cancelPendingCommit()
    commitTimerRef.current = { timer: setTimeout(flushPendingCommit, CELL_EDIT_DEBOUNCE_MS), commit }
  }
  useEffect(() => cancelPendingCommit, [])

  // Chromium keeps one undo stack per page, so native Ctrl+Z in a cell would undo edits made in
  // other inputs (e.g. the row filter). The cell editor keeps its own history instead.
  const cellHistoryRef = useRef<{ past: string[]; future: string[]; current: string } | null>(null)

  const recordCellHistory = (value: string) => {
    const h = cellHistoryRef.current
    if (!h || h.current === value) return
    h.past.push(h.current)
    h.current = value
    h.future = []
  }

  const stepCellHistory = (input: HTMLInputElement, redo: boolean): string | undefined => {
    const h = cellHistoryRef.current
    if (!h) return undefined
    const value = (redo ? h.future : h.past).pop()
    if (value === undefined) return undefined
    ;(redo ? h.past : h.future).push(h.current)
    h.current = value
    input.value = value
    input.setSelectionRange(value.length, value.length)
    return value
  }
  // New rows, after the loaded ones: the blank row of an empty editable table, and rows that have
  // edits staged past the loaded rows (added through MCP insert_rows); row indexes continue on
  const lastDraftIndex = useMemo(() => {
    let last = allowNewRow && editable && result.rows.length === 0 ? 0 : -1
    if (editable) for (const e of Object.values(pendingEdits ?? {})) if (e.rowIndex >= result.rows.length) last = Math.max(last, e.rowIndex - result.rows.length)
    return last
  }, [allowNewRow, editable, result.rows.length, pendingEdits])
  const draftRows = useMemo<Record<string, unknown>[]>(
    () => Array.from({ length: lastDraftIndex + 1 }, () => ({})),
    [lastDraftIndex],
  )
  const rowIndexOf = useMemo(() => {
    const map = new Map<Record<string, unknown>, number>(result.rows.map((r, i) => [r, i]))
    draftRows.forEach((d, k) => map.set(d, result.rows.length + k))
    return map
  }, [result.rows, draftRows])
  const rowAt = (rowIndex: number): Record<string, unknown> => result.rows[rowIndex] ?? draftRows[rowIndex - result.rows.length] ?? {}

  const startColumnResize = (e: React.MouseEvent, col: string) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startWidth = colWidths[col] ?? DEFAULT_COL_WIDTH
    justResizedRef.current = true
    const onMove = (ev: MouseEvent) => {
      const width = Math.max(MIN_COL_WIDTH, startWidth + ev.clientX - startX)
      setColWidths(prev => ({ ...prev, [col]: width }))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      // The mouseup can land on the header and fire a click that would otherwise toggle sorting
      setTimeout(() => { justResizedRef.current = false }, 0)
    }
    document.body.style.cursor = 'col-resize'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }
  const [rowSearch, setRowSearch] = useState('')
  const [rowFilter, setRowFilter] = useState('')
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [sortCol, setSortCol] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [expandedColumns, setExpandedColumns] = useState<Set<string>>(new Set())
  const gridRef = React.useRef<HTMLDivElement>(null)
  const exportBtnRef = React.useRef<HTMLButtonElement>(null)

  const visibleFields = React.useMemo(() => {
    const rootFields = result.fields.filter(f => !f.includes('.') || !result.fields.includes(f.split('.')[0]))
    if (rootFields.length === 0) return result.fields

    const fieldsList: string[] = []
    const visited = new Set<string>()

    function addFieldAndChildren(field: string) {
      if (visited.has(field)) return
      visited.add(field)
      fieldsList.push(field)

      if (expandedColumns.has(field)) {
        const childKeys = new Set<string>()
        for (const row of result.rows) {
          const val = getNestedValue(row, field)
          if (
            val !== null &&
            typeof val === 'object' &&
            !Array.isArray(val) &&
            !(val instanceof Date) &&
            val.constructor?.name !== 'ObjectID' &&
            val.constructor?.name !== 'ObjectId' &&
            !(val as any)._bsontype
          ) {
            Object.keys(val).forEach(k => {
              childKeys.add(`${field}.${k}`)
            })
          }
        }
        Array.from(childKeys).sort().forEach(childField => {
          addFieldAndChildren(childField)
        })
      }
    }

    rootFields.forEach(f => addFieldAndChildren(f))
    return fieldsList
  }, [result.fields, result.rows, expandedColumns])

  // Reset grid UI state on each new query result. Intentionally not using a `key` remount here
  // (see comment above SingleResultGrid) since that reintroduces the remount lag this component avoids.
  // Keyed on `fields` (a fresh array per query) rather than `result`, so saving edited rows in
  // place keeps the user's sort, filter and selection.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setSelectedCell(null); setEditingCell(null); setCellMenu(null); setRowSearch(''); setRowFilter(''); setExportMenuOpen(false); setSortCol(null); setExpandedColumns(new Set()) }, [result.fields])

  const handleSortClick = (col: string) => {
    if (sortCol === col) {
      if (sortDir === 'asc') {
        setSortDir('desc')
      } else {
        setSortCol(null)
        setSortDir('asc')
      }
    } else {
      setSortCol(col)
      setSortDir('asc')
    }
  }

  useEffect(() => {
    if (!exportMenuOpen) return
    const handler = (e: MouseEvent) => {
      if (exportBtnRef.current && !exportBtnRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [exportMenuOpen])

  const downloadFile = (content: string, filename: string, contentType: string) => {
    const blob = new Blob([content], { type: contentType })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const handleExportCsv = () => {
    if (result.rows.length === 0) return
    const headers = visibleFields.join(',')
    const rows = result.rows.map(row => 
      visibleFields.map(field => {
        const val = getNestedValue(row, field)
        if (val === null) return ''
        const str = typeof val === 'object' ? JSON.stringify(val) : String(val)
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`
        }
        return str
      }).join(',')
    )
    const csvContent = [headers, ...rows].join('\n')
    downloadFile(csvContent, `export_${Date.now()}.csv`, 'text/csv;charset=utf-8;')
    setExportMenuOpen(false)
  }

  const handleExportJson = () => {
    if (result.rows.length === 0) return
    const jsonContent = JSON.stringify(result.rows, null, 2)
    downloadFile(jsonContent, `export_${Date.now()}.json`, 'application/json;charset=utf-8;')
    setExportMenuOpen(false)
  }

  const handleCopyJson = () => {
    if (result.rows.length === 0) return
    navigator.clipboard.writeText(JSON.stringify(result.rows, null, 2))
      .then(() => toast.success('Copied all rows to clipboard as JSON!'))
    setExportMenuOpen(false)
  }

  const handleCopyMarkdown = () => {
    if (result.rows.length === 0) return
    const headers = '| ' + visibleFields.join(' | ') + ' |'
    const separators = '| ' + visibleFields.map(() => '---').join(' | ') + ' |'
    const rows = result.rows.map(row => 
      '| ' + visibleFields.map(field => {
        const val = getNestedValue(row, field)
        if (val === null) return '*null*'
        const str = typeof val === 'object' ? JSON.stringify(val) : String(val)
        return str.replace(/\|/g, '\\|').replace(/\n/g, ' ')
      }).join(' | ') + ' |'
    )
    const mdContent = [headers, separators, ...rows].join('\n')
    navigator.clipboard.writeText(mdContent)
      .then(() => toast.success('Copied all rows to clipboard as a Markdown Table!'))
    setExportMenuOpen(false)
  }

  useEffect(() => {
    const t = setTimeout(() => setRowFilter(rowSearch), 200)
    return () => clearTimeout(t)
  }, [rowSearch])

  useEffect(() => {
    if (!selectedCell || editingCell) return
    const fields = visibleFields
    const rowCount = result.rows.length + draftRows.length
    const handler = (e: KeyboardEvent) => {
      // Type-to-edit: a printable key on the selected cell opens its editor with that character
      if (editable && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target as HTMLElement | null
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return
        if (dbType === 'mongodb' && isLockedMongoCell(selectedCell.col, getNestedValue(shownRowsRef.current[selectedCell.ri], selectedCell.col))) return
        e.preventDefault()
        setEditingCell({ ...selectedCell, typed: e.key })
        return
      }
      if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target as HTMLElement | null
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return
        e.preventDefault()
        setSelectedCell(prev => {
          if (!prev) return prev
          const next = nextTabCell(prev.ri, fields.indexOf(prev.col), fields.length, rowCount, e.shiftKey)
          return { ri: next.ri, col: fields[next.ci] }
        })
        return
      }
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return
      e.preventDefault()
      setSelectedCell(prev => {
        if (!prev) return prev
        const ci = fields.indexOf(prev.col)
        let ri = prev.ri, newCi = ci
        if (e.key === 'ArrowUp')    ri = Math.max(0, ri - 1)
        if (e.key === 'ArrowDown')  ri = Math.min(rowCount - 1, ri + 1)
        if (e.key === 'ArrowLeft')  newCi = Math.max(0, ci - 1)
        if (e.key === 'ArrowRight') newCi = Math.min(fields.length - 1, ci + 1)
        return { ri, col: fields[newCi] }
      })
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [selectedCell, editingCell, result, visibleFields, draftRows, editable, dbType])

  useEffect(() => {
    if (!selectedCell) return
    const el = gridRef.current?.querySelector(`[data-cell="${selectedCell.ri}:${CSS.escape(selectedCell.col)}"]`)
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selectedCell])

  const needle = rowFilter.toLowerCase()
  const visibleRows = needle
    ? result.rows.filter(row =>
        result.fields.some(col => {
          const v = row[col]
          if (v === null) return false
          return String(typeof v === 'object' ? JSON.stringify(v) : v).toLowerCase().includes(needle)
        })
      )
    : result.rows

  const sortedRows = React.useMemo(() => {
    if (!sortCol || serverSort) return visibleRows
    return [...visibleRows].sort((a, b) => {
      const aVal = a[sortCol]
      const bVal = b[sortCol]
      if (aVal === null && bVal === null) return 0
      if (aVal === null) return sortDir === 'asc' ? 1 : -1
      if (bVal === null) return sortDir === 'asc' ? -1 : 1
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return sortDir === 'asc' ? aVal - bVal : bVal - aVal
      }
      const aStr = typeof aVal === 'object' ? JSON.stringify(aVal) : String(aVal)
      const bStr = typeof bVal === 'object' ? JSON.stringify(bVal) : String(bVal)
      return sortDir === 'asc' ? aStr.localeCompare(bStr) : bStr.localeCompare(aStr)
    })
  }, [visibleRows, sortCol, sortDir, serverSort])
  useEffect(() => { shownRowsRef.current = sortedRows }, [sortedRows])

  // Point at a requested cell: select it and scroll it into view. A row hidden by the row filter
  // clears the filter first (the effect runs again with the rows shown).
  const focusHandledRef = useRef(0)
  useEffect(() => {
    if (!focusCell || focusHandledRef.current === focusCell.nonce) return
    const target = rowAt(focusCell.row)
    const ri = [...sortedRows, ...draftRows].indexOf(target)
    if (ri < 0 && rowFilter) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRowSearch(''); setRowFilter('')
      return
    }
    focusHandledRef.current = focusCell.nonce
    if (ri < 0) return
    setSelectedCell({ ri, col: focusCell.col })
    requestAnimationFrame(() => {
      gridRef.current?.querySelector(`[data-cell="${ri}:${CSS.escape(focusCell.col)}"]`)
        ?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' })
    })
  // rowAt reads result/draftRows, listed here
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusCell, sortedRows, draftRows, rowFilter])

  const gridActions: GridActions = {
    select: (ri, col) => {
      setSelectedCell({ ri, col })
      if (editingCell && !(editingCell.ri === ri && editingCell.col === col)) setEditingCell(null)
    },
    activate: (ri, col, isDoc) => {
      setSelectedCell({ ri, col })
      if (!isDoc) {
        if (dbType === 'mongodb' && (col === '_id' || col.startsWith('_id.'))) return
        setEditingCell({ ri, col })
        return
      }
      setExpandedColumns(prev => {
        const next = new Set(prev)
        if (next.has(col)) {
          next.delete(col)
          for (const key of Array.from(next)) if (key.startsWith(col + '.')) next.delete(key)
        } else {
          next.add(col)
        }
        return next
      })
    },
    openMenu: (x, y, ri, rowIndex, col, anchor) => {
      setSelectedCell({ ri, col })
      setCellMenu({ x, y, ri, rowIndex, col, anchor })
    },
    openDate: (ri, rowIndex, col, anchor) => {
      const kind = dateKindAt(rowIndex, col)
      setSelectedCell({ ri, col })
      if (kind) setDatePopup({ rowIndex, col, kind, anchor })
    },
    openFk: (ri, rowIndex, col, anchor) => {
      setSelectedCell({ ri, col })
      setFkPopup({ rowIndex, col, fk: fkByColumn.get(col)!, anchor })
    },
    editStart: (pendingValue, before, typed, current) => {
      editStartRef.current = pendingValue
      cellHistoryRef.current = { past: typed ? [before] : [], future: [], current }
    },
    edit: (rowIndex, col, text, original) => scheduleCommit(() => onCellEdit?.(rowIndex, col, text === original ? undefined : text)),
    recordHistory: recordCellHistory,
    stepHistory: stepCellHistory,
    cancelEdit: (rowIndex, col) => {
      cancelPendingCommit()
      onCellEdit?.(rowIndex, col, editStartRef.current)
    },
    endEdit: () => { flushPendingCommit(); setEditingCell(null) },
    tab: (ri, col, backwards) => {
      const rowCount = result.rows.length + draftRows.length
      const next = nextTabCell(ri, visibleFields.indexOf(col), visibleFields.length, rowCount, backwards)
      setSelectedCell({ ri: next.ri, col: visibleFields[next.ci] })
    },
  }
  const gridActionsRef = useRef(gridActions)
  useLayoutEffect(() => { gridActionsRef.current = gridActions })

  // Right-click menu of a cell, modeled on Navicat's grid menu
  const cellMenuEntries = (menu: NonNullable<typeof cellMenu>): MenuEntry[] => {
    const { rowIndex, ri, col } = menu
    const row = rowAt(rowIndex)
    const isDraftRow = rowIndex >= result.rows.length
    const raw = getNestedValue(row, col)
    const pending = pendingEdits?.[cellEditKey(rowIndex, col)]
    const isMongo = dbType === 'mongodb'
    const sep: MenuEntry = { kind: 'separator' }
    const entries: MenuEntry[] = []

    const copy = (text: string, what: string) => {
      navigator.clipboard.writeText(text)
        .then(() => toast.success(`Copied ${what}`), () => toast.error('Could not write to the clipboard'))
    }
    // What the grid shows: the row with its unsaved edits applied
    const shownRow: Record<string, unknown> = { ...row }
    for (const e of Object.values(pendingEdits ?? {})) if (e.rowIndex === rowIndex) shownRow[e.col] = e.value
    // Mongo rows also hold flattened "parent.child" copies of nested fields; the document is the rest
    const document = Object.fromEntries(Object.entries(row).filter(([k]) => !k.includes('.') || !(k.split('.')[0] in row)))

    const dateKind = dateKindAt(rowIndex, col)
    const fk = fkTarget ? fkByColumn.get(col) : undefined
    if (fk) {
      entries.push(
        { label: `Pick from ${fk.refTable}…`, icon: <Link2 className="h-3.5 w-3.5" />, onSelect: () => setFkPopup({ rowIndex, col, fk, anchor: menu.anchor }) },
        { label: `Open ${fk.refTable}`, icon: <ExternalLink className="h-3.5 w-3.5" />, disabled: !onOpenReferencedTable, onSelect: () => onOpenReferencedTable?.(fk) },
        sep,
      )
    }

    if (isMongo && onMongoEdit && table) {
      const types = result.types?.[rowIndex] ?? {}
      const type = types[col]
      const isId = col === '_id' || col.startsWith('_id.')
      const idOk = mongoIdFilter(row._id, types._id) !== null
      const blocked = isId ? "_id can't be changed" : !idOk ? '_id type not supported' : undefined
      entries.push(
        ...(editable && !isLockedMongoCell(col, raw)
          ? [{ label: 'Edit Cell', shortcut: 'Double-click', disabled: !!blocked, hint: blocked, onSelect: () => setEditingCell({ ri, col }) }]
          : []),
        ...(dateKind && !blocked
          ? [{ label: 'Pick Date…', icon: <CalendarDays className="h-3.5 w-3.5" />, onSelect: () => setDatePopup({ rowIndex, col, kind: dateKind, anchor: menu.anchor }) }]
          : []),
        { label: 'Set to Null', icon: <CircleSlash className="h-3.5 w-3.5" />, disabled: !!blocked || type === 'null', hint: blocked, onSelect: () => onMongoEdit(rowIndex, { kind: 'changeType', col, to: 'null' }) },
        { label: 'Set to Empty String', disabled: !!blocked || raw === '', onSelect: () => onMongoEdit(rowIndex, { kind: 'emptyString', col }) },
        {
          label: 'Change Type to', disabled: !!blocked, submenu: [
            { kind: 'label', label: `Current: ${type ? BSON_TYPE_LABELS[type] ?? type : 'missing'}` },
            ...MONGO_TYPE_OPTIONS.map(o => ({
              label: o.label, checked: type === o.type, disabled: type === o.type,
              onSelect: () => onMongoEdit(rowIndex, { kind: 'changeType', col, to: o.type }),
            })),
          ],
        },
        { label: 'Delete Field', icon: <Trash2 className="h-3.5 w-3.5" />, disabled: !!blocked || type === undefined, onSelect: () => onMongoEdit(rowIndex, { kind: 'unset', col }) },
        sep,
      )
    } else if (!isMongo && editable && onCellEdit) {
      const nullable = columnTypes?.find(c => c.name === col)?.nullable
      // A new row's untouched cell is DEFAULT, not NULL, so "Set to NULL" stays available there
      const isNull = !isDraftRow && (raw === null || raw === undefined)
      entries.push(
        {
          label: 'Set to NULL', icon: <CircleSlash className="h-3.5 w-3.5" />,
          disabled: nullable === false || (pending ? pending.value === null : isNull),
          hint: nullable === false ? 'NOT NULL' : undefined,
          onSelect: () => onCellEdit(rowIndex, col, isNull ? undefined : null),
        },
        {
          label: 'Set to Empty String',
          disabled: pending ? pending.value === '' : raw === '',
          onSelect: () => onCellEdit(rowIndex, col, raw === '' ? undefined : ''),
        },
        {
          label: 'Paste', icon: <ClipboardPaste className="h-3.5 w-3.5" />,
          onSelect: () => {
            navigator.clipboard.readText().then(
              text => onCellEdit(rowIndex, col, !isNull && text === cellEditText(raw) ? undefined : text),
              () => toast.error('Could not read the clipboard'),
            )
          },
        },
        { label: 'Edit Cell', shortcut: 'Double-click', onSelect: () => setEditingCell({ ri, col }) },
        ...(dateKind
          ? [{ label: 'Pick Date…', icon: <CalendarDays className="h-3.5 w-3.5" />, onSelect: () => setDatePopup({ rowIndex, col, kind: dateKind, anchor: menu.anchor }) }]
          : []),
        { label: 'Revert Cell', icon: <Undo2 className="h-3.5 w-3.5" />, disabled: !pending, onSelect: () => onCellEdit(rowIndex, col, undefined) },
        sep,
      )
    }

    const sqlDialect = dbType === 'mysql' ? 'mysql' : 'postgres'
    const shownValue = pending ? pending.value : raw
    entries.push(
      { label: 'Copy', icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => copy(cellEditText(shownValue), 'value') },
      {
        label: 'Copy As', submenu: [
          ...(!isMongo ? [
            { label: 'Insert Statement', disabled: !table, onSelect: () => copy(buildInsertStatement(sqlDialect, table!.schema, table!.name, result.fields, shownRow), 'INSERT statement') },
            { label: 'Update Statement', disabled: !table || table.primaryKeys.length === 0 || isDraftRow, onSelect: () => copy(buildUpdateStatement(sqlDialect, table!.schema, table!.name, table!.primaryKeys, result.fields, shownRow), 'UPDATE statement') },
            sep,
          ] : []),
          { label: 'Tab-Separated Values (Data Only)', onSelect: () => copy(rowsToTsv(visibleFields, [shownRow], false), 'row') },
          { label: 'Tab-Separated Values (Field Names Only)', onSelect: () => copy(rowsToTsv(visibleFields, [], true), 'field names') },
          { label: 'Tab-Separated Values (Field Names and Data)', onSelect: () => copy(rowsToTsv(visibleFields, [shownRow], true), 'row with field names') },
          sep,
          { label: isMongo ? 'JSON Document' : 'JSON', onSelect: () => copy(JSON.stringify(isMongo ? document : shownRow, null, 2), 'JSON') },
        ],
      },
      { label: 'Copy Field Name', onSelect: () => copy(col, 'field name') },
      sep,
    )

    const activeSort = serverSort
      ? (serverSort.sort?.column === col ? serverSort.sort.dir : undefined)
      : (sortCol === col ? sortDir : undefined)
    const sortBy = (dir: 'asc' | 'desc' | null) => {
      if (serverSort) { serverSort.onSort(col, dir); return }
      if (dir) { setSortCol(col); setSortDir(dir) } else setSortCol(null)
    }
    entries.push(
      { label: 'Sort Ascending', icon: <ArrowUp className="h-3.5 w-3.5" />, checked: activeSort === 'asc', onSelect: () => sortBy('asc') },
      { label: 'Sort Descending', icon: <ArrowDown className="h-3.5 w-3.5" />, checked: activeSort === 'desc', onSelect: () => sortBy('desc') },
      { label: 'Remove Sort', disabled: !activeSort, onSelect: () => sortBy(null) },
    )

    if (isMongo && onMongoEdit && table) {
      const idOk = mongoIdFilter(row._id, result.types?.[rowIndex]?._id) !== null
      entries.push(sep, { label: 'Delete Document', icon: <Trash2 className="h-3.5 w-3.5" />, destructive: true, disabled: !idOk, onSelect: () => onMongoEdit(rowIndex, { kind: 'deleteDocument' }) })
    } else if (!isMongo && editable && onDeleteRow) {
      entries.push(sep, {
        label: 'Delete Record', icon: <Trash2 className="h-3.5 w-3.5" />, destructive: true,
        disabled: isDraftRow || !!deleteBlockedReason, hint: isDraftRow ? 'not saved yet' : deleteBlockedReason,
        onSelect: () => onDeleteRow(rowIndex),
      })
    }
    return entries
  }

  if (result.error) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-950/60 px-4 py-3 max-w-lg">
          <X className="h-4 w-4 text-red-300 shrink-0 mt-0.5" />
          <p className="text-xs text-red-300 whitespace-pre-wrap break-words">{result.error}</p>
        </div>
      </div>
    )
  }
  if (result.fields.length === 0) {
    return <div className="flex-1 flex items-center justify-center"><p className="text-xs text-muted-foreground">Query executed successfully — no rows returned</p></div>
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-2 px-3 h-7 border-b border-border shrink-0 bg-card">
        <Search className="h-3 w-3 text-muted-foreground/60 shrink-0" />
        <input
          value={rowSearch}
          onChange={e => setRowSearch(e.target.value)}
          placeholder="Filter rows…"
          className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/40 outline-none"
        />
        {rowSearch && (
          <span className="text-xs text-muted-foreground/50 shrink-0">{visibleRows.length} / {result.rows.length}</span>
        )}
        {rowSearch && (
          <button onClick={() => { setRowSearch(''); setRowFilter('') }} className="text-muted-foreground/50 hover:text-foreground transition-colors shrink-0 mr-1"><X className="h-3 w-3" /></button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              title="Highlight cells by data type"
              className={cn('flex items-center gap-1 px-1.5 h-5 rounded text-xs border transition-colors font-medium shrink-0',
                highlightKinds.size > 0 ? 'border-primary/50 text-primary bg-primary/10' : 'border-border text-muted-foreground hover:text-foreground hover:bg-accent/40')}
            >
              <Palette className="h-3 w-3" />
              <span>Highlight{highlightKinds.size > 0 ? ` (${highlightKinds.size})` : ''}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel className="text-[11px] py-1 font-normal text-muted-foreground">Highlight by data type</DropdownMenuLabel>
            {HIGHLIGHT_KINDS.map(kind => (
              <DropdownMenuCheckboxItem
                key={kind}
                checked={highlightKinds.has(kind)}
                onCheckedChange={on => highlightStore.toggle(kind, on === true)}
                onSelect={e => e.preventDefault()}
                className="text-xs py-1 gap-2"
              >
                <span className="h-3 w-3 rounded-sm shrink-0 border border-border/60" style={{ background: `color-mix(in oklch, var(--hl-${kind}) 55%, transparent)` }} />
                {HIGHLIGHT_LABELS[kind]}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-xs py-1" onSelect={() => highlightStore.set(HIGHLIGHT_KINDS)}>Highlight all</DropdownMenuItem>
            <DropdownMenuItem className="text-xs py-1" disabled={highlightKinds.size === 0} onSelect={() => highlightStore.set([])}>Turn off</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="relative shrink-0">
          <button
            ref={exportBtnRef}
            onClick={() => setExportMenuOpen(prev => !prev)}
            title="Export results"
            className="flex items-center gap-1 px-1.5 h-5 rounded text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors font-medium"
          >
            <Download className="h-3 w-3" />
            <span>Export</span>
          </button>
          
          {exportMenuOpen && (
            <div className="absolute right-0 top-6 z-50 w-44 rounded-md border border-border bg-popover text-popover-foreground shadow-lg backdrop-blur-md bg-opacity-95 p-1 flex flex-col gap-0.5 animate-in fade-in duration-100">
              <button
                onClick={handleExportCsv}
                className="w-full text-left text-xs px-2 py-1.5 rounded hover:bg-accent hover:text-foreground transition-colors"
              >
                Export as CSV
              </button>
              <button
                onClick={handleExportJson}
                className="w-full text-left text-xs px-2 py-1.5 rounded hover:bg-accent hover:text-foreground transition-colors"
              >
                Export as JSON
              </button>
              <div className="h-[1px] bg-border my-0.5" />
              <button
                onClick={handleCopyJson}
                className="w-full text-left text-xs px-2 py-1.5 rounded hover:bg-accent hover:text-foreground transition-colors"
              >
                Copy as JSON
              </button>
              <button
                onClick={handleCopyMarkdown}
                className="w-full text-left text-xs px-2 py-1.5 rounded hover:bg-accent hover:text-foreground transition-colors"
              >
                Copy as Markdown Table
              </button>
            </div>
          )}
        </div>
      </div>
      <div ref={gridRef} className="flex-1 overflow-auto min-h-0" onClick={() => { if (!editingCell) setSelectedCell(null) }}>
        <table className="w-max text-xs border-collapse table-fixed">
          <thead>
            <tr className="bg-card border-b border-border sticky top-0 z-10">
              {visibleFields.map(col => {
                const colType = columnTypes?.find(c => c.name === col)?.type
                const activeSortDir = serverSort
                  ? (serverSort.sort?.column === col ? serverSort.sort.dir : undefined)
                  : (sortCol === col ? sortDir : undefined)
                const width = colWidths[col] ?? DEFAULT_COL_WIDTH
                return (
                  <th
                    key={col}
                    onClick={() => {
                      if (justResizedRef.current) return
                      if (serverSort) serverSort.onSort(col)
                      else handleSortClick(col)
                    }}
                    title={serverSort ? 'Sort the whole table by this column' : 'Sort these results'}
                    className="relative text-left px-2 py-0.5 font-medium text-muted-foreground border-r border-border whitespace-nowrap cursor-pointer select-none hover:bg-accent/10 transition-colors overflow-hidden"
                    style={{ width, minWidth: width, maxWidth: width }}
                  >
                    <div className="flex items-center gap-1 min-w-0">
                      <span className="truncate">{col}</span>
                      {activeSortDir && (
                        <span className="text-primary text-[10px] shrink-0">{activeSortDir === 'asc' ? '▲' : '▼'}</span>
                      )}
                    </div>
                    {colType && <div className="text-[10px] font-normal text-muted-foreground/50 leading-tight truncate">{colType}</div>}
                    {fkByColumn.has(col) && (
                      <div className="text-[10px] font-normal text-primary/70 leading-tight truncate" title={`Foreign key to ${fkByColumn.get(col)!.refTable}.${fkByColumn.get(col)!.refColumn}. Right-click a cell to pick a row.`}>
                        → {fkByColumn.get(col)!.refTable}.{fkByColumn.get(col)!.refColumn}
                      </div>
                    )}
                    <div
                      onMouseDown={e => startColumnResize(e, col)}
                      onClick={e => e.stopPropagation()}
                      className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-primary/40 active:bg-primary/60"
                      title="Drag to resize"
                    />
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {[...sortedRows, ...draftRows].map((row, ri) => {
              const rowIndex = rowIndexOf.get(row) ?? -1
              return (
                <GridRow
                  key={ri}
                  row={row}
                  ri={ri}
                  rowIndex={rowIndex}
                  isDraft={rowIndex >= result.rows.length}
                  fields={visibleFields}
                  colWidths={colWidths}
                  selectedCol={selectedCell?.ri === ri ? selectedCell.col : null}
                  editing={editingCell?.ri === ri ? editingCell : null}
                  pendingEdits={pendingEdits}
                  failed={errorRowIndex === rowIndex}
                  fkPopupCol={fkPopup?.rowIndex === rowIndex ? fkPopup.col : null}
                  datePopupCol={datePopup?.rowIndex === rowIndex ? datePopup.col : null}
                  dbType={dbType}
                  editable={editable}
                  highlightKinds={highlightKinds}
                  columnTypeByName={columnTypeByName}
                  fkByColumn={fkByColumn}
                  dateKindByColumn={dateKindByColumn}
                  rowTypes={result.types?.[rowIndex]}
                  actions={gridActionsRef}
                />
              )
            })}
          </tbody>
        </table>
      </div>
      {datePopup && (() => {
        const raw = getNestedValue(rowAt(datePopup.rowIndex), datePopup.col)
        const pendingEdit = pendingEdits?.[cellEditKey(datePopup.rowIndex, datePopup.col)]
        const rawDate = parseCellDate(raw)
        // Picking the date the cell already has is not an edit
        const originalText = rawDate ? formatCellDate(rawDate, datePopup.kind) : null
        return (
          <DatePickerPopover
            key={`${datePopup.rowIndex}:${datePopup.col}`}
            anchor={datePopup.anchor}
            kind={datePopup.kind}
            column={datePopup.col}
            value={pendingEdit ? parseCellDate(pendingEdit.value) : rawDate}
            onPick={date => {
              const text = formatCellDate(date, datePopup.kind)
              onCellEdit?.(datePopup.rowIndex, datePopup.col, text === originalText ? undefined : text)
              setDatePopup(null)
            }}
            onClose={() => setDatePopup(null)}
          />
        )
      })()}
      {fkPopup && fkTarget && (() => {
        const row = rowAt(fkPopup.rowIndex)
        const original = cellEditText(getNestedValue(row, fkPopup.col))
        const pendingEdit = pendingEdits?.[cellEditKey(fkPopup.rowIndex, fkPopup.col)]
        const rawValue = getNestedValue(row, fkPopup.col)
        return (
          <FkLookupPopover
            key={`${fkPopup.rowIndex}:${fkPopup.col}`}
            anchor={fkPopup.anchor}
            fk={fkPopup.fk}
            target={fkTarget}
            currentValue={pendingEdit ? pendingEdit.value : (rawValue === null || rawValue === undefined ? null : original)}
            editable={editable}
            onPick={value => {
              onCellEdit?.(fkPopup.rowIndex, fkPopup.col, value === original ? undefined : value)
              setFkPopup(null)
            }}
            onGoTo={() => { onOpenReferencedTable?.(fkPopup.fk); setFkPopup(null) }}
            onClose={() => setFkPopup(null)}
          />
        )
      })()}
      {cellMenu && (
        <ContextMenuAt
          key={`${cellMenu.rowIndex}:${cellMenu.col}:${cellMenu.x}:${cellMenu.y}`}
          x={cellMenu.x}
          y={cellMenu.y}
          entries={cellMenuEntries(cellMenu)}
          onClose={() => setCellMenu(null)}
        />
      )}
    </div>
  )
}

function ResultsGrid({ results, running, statusBorder, columnTypes, dbType, editable, pendingEdits, onCellEdit, errorRowIndex, serverSort, foreignKeys, fkTarget, onOpenReferencedTable, table, onDeleteRow, deleteBlockedReason, onMongoEdit, allowNewRow, focusCell }: {
  results: QueryResult[]
  running: boolean
  statusBorder: 'top' | 'bottom'
  columnTypes?: ColumnInfo[]
  dbType?: 'postgres' | 'mysql' | 'mongodb' | 'sqlite' | 'redis'
} & TableGridProps) {
  const [prevResults, setPrevResults] = useState(results)
  const [activeIdx, setActiveIdx] = useState(() => results.length > 0 ? results.length - 1 : 0)

  if (results !== prevResults) {
    setPrevResults(results)
    setActiveIdx(results.length > 0 ? results.length - 1 : 0)
  }

  const result = results[activeIdx] ?? null
  const totalMs = results.reduce((s, r) => s + r.ms, 0)

  const statusBar = (
    <div className={cn('flex items-center gap-0 bg-card shrink-0 border-border', statusBorder === 'top' ? 'border-b' : 'border-t')}>
      {/* Result tabs — only shown when multiple results */}
      {results.length > 1 && (
        <div className="flex items-center border-r border-border">
          {results.map((r, i) => (
            <button
              key={i}
              onClick={() => setActiveIdx(i)}
              className={cn(
                'px-3 h-7 text-xs border-r border-border last:border-r-0 transition-colors whitespace-nowrap',
                i === activeIdx ? 'bg-background text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-accent/20',
                r.error ? 'bg-red-950/60 text-red-300' : ''
              )}
            >
              Result {i + 1}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-3 px-3 h-7 flex-1">
        {!running && result && !result.error && (
          <>
            <span className="text-xs text-muted-foreground">{result.rowCount ?? result.rows.length} rows</span>
            <span className="text-xs text-muted-foreground/60">{result.ms}ms</span>
            {results.length > 1 && <span className="text-xs text-muted-foreground/40">{results.length} statements · {totalMs}ms total</span>}
          </>
        )}
        {!running && result?.error && (
          <span className="text-xs bg-red-950/60 text-red-300 px-2 py-0.5 rounded truncate">{result.error}</span>
        )}
      </div>
    </div>
  )

  let grid: React.ReactNode
  if (running) {
    grid = (
      <div className="flex-1 flex flex-col items-center justify-center gap-3">
        <Loader2 className="h-6 w-6 animate-spin text-primary/60" />
        <span className="text-xs text-muted-foreground">Running…</span>
      </div>
    )
  } else if (result) {
    grid = <SingleResultGrid result={result} columnTypes={columnTypes} dbType={dbType} editable={editable} pendingEdits={pendingEdits} onCellEdit={onCellEdit} errorRowIndex={errorRowIndex} serverSort={serverSort} foreignKeys={foreignKeys} fkTarget={fkTarget} onOpenReferencedTable={onOpenReferencedTable} table={table} onDeleteRow={onDeleteRow} deleteBlockedReason={deleteBlockedReason} onMongoEdit={onMongoEdit} allowNewRow={allowNewRow} focusCell={focusCell} />
  } else {
    grid = <div className="flex-1 flex items-center justify-center"><p className="text-xs text-muted-foreground">No results yet</p></div>
  }

  return statusBorder === 'bottom' ? (
    <div className="flex flex-col h-full">{grid}{statusBar}</div>
  ) : (
    <div className="flex flex-col h-full">{statusBar}{grid}</div>
  )
}

// ── SQL Editor (CodeMirror 6) ─────────────────────────────────────────────────

// Search highlight extension — driven by a StateEffect so SqlEditor can update it externally
interface SearchHighlightSpec { query: string; caseSensitive: boolean }
const setSearchHighlight = StateEffect.define<SearchHighlightSpec>()

const searchHighlightMark = Decoration.mark({ class: 'cm-search-match' })

const searchHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decos, tr) {
    decos = decos.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(setSearchHighlight)) {
        const { query, caseSensitive } = effect.value
        const builder = new RangeSetBuilder<Decoration>()
        if (query.length > 0) {
          const normalize = caseSensitive ? undefined : (s: string) => s.toLowerCase()
          const cursor = new SearchCursor(tr.state.doc, query, 0, undefined, normalize)
          let lastTo = -1
          while (true) {
            cursor.next()
            const { from, to } = cursor.value
            if (from === to || from <= lastTo) break  // end or stuck
            builder.add(from, to, searchHighlightMark)
            lastTo = to
          }
        }
        decos = builder.finish()
      }
    }
    return decos
  },
  provide: f => EditorView.decorations.from(f),
})

const searchHighlightTheme = EditorView.theme({
  '.cm-search-match': { background: 'oklch(0.9 0.11 98 / 0.25)', borderRadius: '2px' },
})

interface SqlEditorHandle {
  getSelection: () => string
  setHighlight: (query: string, caseSensitive: boolean) => void
  findNext: (query: string, caseSensitive: boolean) => { found: boolean; total: number }
  findPrev: (query: string, caseSensitive: boolean) => { found: boolean; total: number }
  replaceCurrent: (query: string, replacement: string, caseSensitive: boolean) => void
  replaceAll: (query: string, replacement: string, caseSensitive: boolean) => void
  clearHighlights: () => void
  countMatches: (query: string, caseSensitive: boolean) => number
}

function editorLanguage({ dialect, collections, ...sqlConfig }: Omit<SqlEditorLanguageConfig, 'dialect'> & { dialect: 'postgres' | 'mysql' | 'mongodb' | 'sqlite' | 'redis'; collections?: string[] }) {
  return dialect === 'mongodb' ? mongoEditorLanguage(collections ?? []) : sqlEditorLanguage({ ...sqlConfig, dialect: dialect === 'redis' ? 'postgres' : dialect })
}

function editorPlaceholder(dialect: 'postgres' | 'mysql' | 'mongodb' | 'sqlite' | 'redis') {
  return dialect === 'mongodb' ? 'Write your MongoDB query here… e.g. db.users.find({})' : 'Write your SQL query here…'
}

function SqlEditor({ value, onChange, onRun, onOpenFind, onNavigate, editorRef, schema, defaultTable, defaultSchema, dialect = 'postgres', functions, collections }: {
  value: string
  onChange: (v: string) => void
  onRun: () => void
  onOpenFind?: () => void
  onNavigate?: (target: SqlTarget) => void   // Ctrl+click on a table or function name
  editorRef?: React.RefObject<SqlEditorHandle | null>
  schema?: SQLNamespace
  defaultTable?: string
  defaultSchema?: string
  dialect?: 'postgres' | 'mysql' | 'mongodb' | 'sqlite' | 'redis'
  functions?: FunctionInfo[]
  collections?: string[]   // MongoDB only: suggested after `db.`
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const sqlCompartmentRef = useRef(new Compartment())
  const placeholderCompartmentRef = useRef(new Compartment())
  const onRunRef = useRef(onRun)
  const onChangeRef = useRef(onChange)
  const onOpenFindRef = useRef(onOpenFind)
  useEffect(() => { onRunRef.current = onRun }, [onRun])
  useEffect(() => { onChangeRef.current = onChange }, [onChange])
  useEffect(() => { onOpenFindRef.current = onOpenFind }, [onOpenFind])
  const onNavigateRef = useRef(onNavigate)
  useEffect(() => { onNavigateRef.current = onNavigate }, [onNavigate])

  useImperativeHandle(editorRef, () => {
    const handle: SqlEditorHandle = {
      setHighlight: (query, caseSensitive) => {
        viewRef.current?.dispatch({ effects: setSearchHighlight.of({ query, caseSensitive }) })
      },
      getSelection: () => {
        const view = viewRef.current
        if (!view) return ''
        const { from, to } = view.state.selection.main
        if (from === to) return ''
        return view.state.sliceDoc(from, to)
      },
      countMatches: (query, caseSensitive) => {
        const view = viewRef.current
        if (!view || !query) return 0
        const doc = view.state.doc.toString()
        const needle = caseSensitive ? query : query.toLowerCase()
        const haystack = caseSensitive ? doc : doc.toLowerCase()
        let count = 0, pos = 0
        while ((pos = haystack.indexOf(needle, pos)) !== -1) { count++; pos += needle.length }
        return count
      },
      findNext: (query, caseSensitive) => {
        const view = viewRef.current
        if (!view || !query) return { found: false, total: 0 }
        const doc = view.state.doc
        const norm = caseSensitive ? undefined : (s: string) => s.toLowerCase()
        const selTo = view.state.selection.main.to
        // Collect all matches, then pick first after cursor (or wrap)
        const allMatches: { from: number; to: number }[] = []
        const scan = new SearchCursor(doc, query, 0, undefined, norm)
        let lastTo = -1
        while (true) { scan.next(); const {from, to} = scan.value; if (from === to || from <= lastTo) break; allMatches.push({from, to}); lastTo = to }
        if (!allMatches.length) return { found: false, total: 0 }
        const after = allMatches.find(m => m.from >= selTo) ?? allMatches[0]
        view.dispatch({ selection: { anchor: after.from, head: after.to }, scrollIntoView: true })
        return { found: true, total: allMatches.length }
      },
      findPrev: (query, caseSensitive) => {
        const view = viewRef.current
        if (!view || !query) return { found: false, total: 0 }
        const doc = view.state.doc
        const norm = caseSensitive ? undefined : (s: string) => s.toLowerCase()
        const selFrom = view.state.selection.main.from
        const allMatches: { from: number; to: number }[] = []
        const scan = new SearchCursor(doc, query, 0, undefined, norm)
        let lastTo = -1
        while (true) { scan.next(); const {from, to} = scan.value; if (from === to || from <= lastTo) break; allMatches.push({from, to}); lastTo = to }
        const before = allMatches.filter(m => m.to <= selFrom)
        const match = before.length > 0 ? before[before.length - 1] : allMatches[allMatches.length - 1]
        if (!match) return { found: false, total: 0 }
        view.dispatch({ selection: { anchor: match.from, head: match.to }, scrollIntoView: true })
        return { found: true, total: allMatches.length }
      },
      replaceCurrent: (query, replacement, caseSensitive) => {
        const view = viewRef.current
        if (!view || !query) return
        const sel = view.state.selection.main
        const selected = view.state.sliceDoc(sel.from, sel.to)
        const matches = caseSensitive ? selected === query : selected.toLowerCase() === query.toLowerCase()
        if (matches) {
          view.dispatch({ changes: { from: sel.from, to: sel.to, insert: replacement } })
        }
        handle.findNext(query, caseSensitive)
      },
      replaceAll: (query, replacement, caseSensitive) => {
        const view = viewRef.current
        if (!view || !query) return
        const norm = caseSensitive ? undefined : (s: string) => s.toLowerCase()
        const cursor = new SearchCursor(view.state.doc, query, 0, undefined, norm)
        const changes: { from: number; to: number; insert: string }[] = []
        let lastTo = -1
        while (true) { cursor.next(); const {from, to} = cursor.value; if (from === to || from <= lastTo) break; changes.push({ from, to, insert: replacement }); lastTo = to }
        if (changes.length) view.dispatch({ changes })
      },
      clearHighlights: () => {
        const view = viewRef.current
        if (!view) return
        view.dispatch({
          selection: { anchor: view.state.selection.main.anchor },
          effects: setSearchHighlight.of({ query: '', caseSensitive: false }),
        })
      },
    }
    return handle
  }, [])

  // Create editor once on mount
  useEffect(() => {
    if (!containerRef.current) return
    const startState = EditorState.create({
      doc: value,
      extensions: [
        history(),
        closeBrackets(),
        keymap.of([
          { key: 'Ctrl-Enter', run: () => { onRunRef.current(); return true } },
          { key: 'Mod-Enter', run: () => { onRunRef.current(); return true } },
          { key: 'Ctrl-f', run: () => { onOpenFindRef.current?.(); return true } },
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        sqlCompartmentRef.current.of(editorLanguage({ dialect, schema, defaultSchema, defaultTable, functions, collections })),
        autocompletion({ activateOnTyping: true }),
        sqlNavigation(target => onNavigateRef.current?.(target)),
        syntaxHighlighting(classHighlighter),
        searchHighlightField,
        searchHighlightTheme,
        quenceTheme,
        placeholderCompartmentRef.current.of(cmPlaceholder(editorPlaceholder(dialect))),
        EditorView.updateListener.of(update => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString())
        }),
        EditorView.lineWrapping,
      ],
    })
    const view = new EditorView({ state: startState, parent: containerRef.current })
    viewRef.current = view
    return () => { view.destroy(); viewRef.current = null }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reconfigure language/schema live when connection/database/table selection changes
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: [
        sqlCompartmentRef.current.reconfigure(
          editorLanguage({ dialect, schema, defaultSchema, defaultTable, functions, collections })
        ),
        placeholderCompartmentRef.current.reconfigure(cmPlaceholder(editorPlaceholder(dialect))),
      ],
    })
  }, [schema, defaultTable, defaultSchema, dialect, functions, collections])

  // Sync external value changes (e.g. tab switch) without re-creating editor
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    }
  }, [value])

  // Clicking empty space below the last line (inside the editor's own box, but past .cm-content's
  // bottom edge when the doc is short) should still focus the editor and put the cursor at the end,
  // the way clicking anywhere in a plain <textarea> does. CodeMirror only owns clicks on .cm-content
  // itself, so without this the surrounding empty area silently drops focus instead.
  const handleContainerMouseDown = (e: React.MouseEvent) => {
    const view = viewRef.current
    if (!view) return
    if ((e.target as HTMLElement).closest('.cm-content')) return   // let CodeMirror handle its own area
    e.preventDefault()
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    view.focus()
  }

  return <div ref={containerRef} className="h-full overflow-hidden" onMouseDown={handleContainerMouseDown} />
}

// ── SQL Search/Replace bar ────────────────────────────────────────────────────

function SqlSearchBar({ editorRef, onClose }: {
  editorRef: React.RefObject<SqlEditorHandle | null>
  onClose: () => void
}) {
  const [find, setFind] = useState('')
  const [replace, setReplace] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [matchCount, setMatchCount] = useState(0)
  const findInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { findInputRef.current?.focus() }, [])

  // Synchronizes with the external CodeMirror view (highlight + match count); not derived component state.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!find) {
      setMatchCount(0)
      editorRef.current?.setHighlight('', false)
      return
    }
    editorRef.current?.setHighlight(find, caseSensitive)
    setMatchCount(editorRef.current?.countMatches(find, caseSensitive) ?? 0)
  }, [find, caseSensitive, editorRef])
  /* eslint-enable react-hooks/set-state-in-effect */

  const next = () => editorRef.current?.findNext(find, caseSensitive)
  const prev = () => editorRef.current?.findPrev(find, caseSensitive)

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); editorRef.current?.clearHighlights() }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); next() }
    if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); prev() }
  }

  return (
    <div className="flex items-center gap-2 px-3 h-8 border-b border-border bg-card shrink-0">
      <Search className="h-3 w-3 text-muted-foreground/60 shrink-0" />
      <input
        ref={findInputRef}
        value={find}
        onChange={e => setFind(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find…"
        className="w-36 bg-background border border-border rounded px-1.5 h-5 text-xs text-foreground placeholder:text-muted-foreground/40 outline-none focus:ring-1 focus:ring-primary"
      />
      <input
        value={replace}
        onChange={e => setReplace(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Replace…"
        className="w-36 bg-background border border-border rounded px-1.5 h-5 text-xs text-foreground placeholder:text-muted-foreground/40 outline-none focus:ring-1 focus:ring-primary"
      />
      <button
        onClick={() => setCaseSensitive(v => !v)}
        title="Case sensitive"
        className={cn('px-1.5 h-5 rounded text-xs border transition-colors', caseSensitive ? 'border-primary text-primary' : 'border-border text-muted-foreground hover:text-foreground')}
      >Aa</button>
      {find && <span className="text-xs text-muted-foreground/60 tabular-nums">{matchCount} match{matchCount !== 1 ? 'es' : ''}</span>}
      <div className="flex items-center gap-1">
        <button onClick={prev} disabled={!find} title="Previous (Shift+Enter)" className="px-1.5 h-5 rounded text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20 disabled:opacity-40 transition-colors">↑</button>
        <button onClick={next} disabled={!find} title="Next (Enter)" className="px-1.5 h-5 rounded text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20 disabled:opacity-40 transition-colors">↓</button>
        <button onClick={() => editorRef.current?.replaceCurrent(find, replace, caseSensitive)} disabled={!find} className="px-1.5 h-5 rounded text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20 disabled:opacity-40 transition-colors">Replace</button>
        <button onClick={() => { editorRef.current?.replaceAll(find, replace, caseSensitive); setMatchCount(0) }} disabled={!find} className="px-1.5 h-5 rounded text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20 disabled:opacity-40 transition-colors">All</button>
      </div>
      <button onClick={() => { onClose(); editorRef.current?.clearHighlights() }} className="ml-auto text-muted-foreground/50 hover:text-foreground transition-colors"><X className="h-3 w-3" /></button>
    </div>
  )
}

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let currentStatement = ''
  let i = 0
  const len = sql.length

  while (i < len) {
    const char = sql[i]
    const nextChar = sql[i + 1]

    // 1. Handle block comments /* ... */
    if (char === '/' && nextChar === '*') {
      currentStatement += '/*'
      i += 2
      while (i < len) {
        if (sql[i] === '*' && sql[i + 1] === '/') {
          currentStatement += '*/'
          i += 2
          break
        }
        currentStatement += sql[i]
        i++
      }
      continue
    }

    // 2. Handle line comments -- ...
    if (char === '-' && nextChar === '-') {
      currentStatement += '--'
      i += 2
      while (i < len && sql[i] !== '\n' && sql[i] !== '\r') {
        currentStatement += sql[i]
        i++
      }
      continue
    }

    // 3. Handle single-quoted strings '...'
    if (char === "'") {
      currentStatement += "'"
      i++
      while (i < len) {
        if (sql[i] === "\\") {
          currentStatement += sql[i]
          if (i + 1 < len) {
            currentStatement += sql[i + 1]
            i += 2
          } else {
            i++
          }
        } else if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            currentStatement += "''"
            i += 2
          } else {
            currentStatement += "'"
            i++
            break
          }
        } else {
          currentStatement += sql[i]
          i++
        }
      }
      continue
    }

    // 4. Handle double-quoted identifiers "..."
    if (char === '"') {
      currentStatement += '"'
      i++
      while (i < len) {
        if (sql[i] === "\\") {
          currentStatement += sql[i]
          if (i + 1 < len) {
            currentStatement += sql[i + 1]
            i += 2
          } else {
            i++
          }
        } else if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            currentStatement += '""'
            i += 2
          } else {
            currentStatement += '"'
            i++
            break
          }
        } else {
          currentStatement += sql[i]
          i++
        }
      }
      continue
    }

    // 5. Handle dollar-quoted strings $$ ... $$ or $tag$ ... $tag$
    if (char === '$') {
      let tagEnd = i + 1
      while (tagEnd < len && sql[tagEnd] !== '$' && /[a-zA-Z0-9_]/.test(sql[tagEnd])) {
        tagEnd++
      }
      if (tagEnd < len && sql[tagEnd] === '$') {
        const tag = sql.slice(i, tagEnd + 1)
        currentStatement += tag
        i = tagEnd + 1
        const tagLen = tag.length
        let foundEnd = false
        while (i < len) {
          if (sql.slice(i, i + tagLen) === tag) {
            currentStatement += tag
            i += tagLen
            foundEnd = true
            break
          } else {
            currentStatement += sql[i]
            i++
          }
        }
        if (foundEnd) {
          continue
        }
      }
    }

    // 6. Handle statement terminator ;
    if (char === ';') {
      const trimmed = currentStatement.trim()
      if (trimmed) {
        statements.push(trimmed)
      }
      currentStatement = ''
      i++
      continue
    }

    currentStatement += char
    i++
  }

  const trimmed = currentStatement.trim()
  if (trimmed) {
    statements.push(trimmed)
  }

  return statements
}

function parseArguments(argsStr: string) {
  if (!argsStr || argsStr.trim() === '') return []
  let current = ''
  let depth = 0
  const parts: string[] = []
  for (let i = 0; i < argsStr.length; i++) {
    const char = argsStr[i]
    if (char === '(') depth++
    else if (char === ')') depth--
    
    if (char === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  if (current.trim()) {
    parts.push(current.trim())
  }

  return parts.map((part, index) => {
    const lower = part.toLowerCase()
    const isOut = lower.startsWith('out ') || lower === 'out'
    if (isOut) {
      return null
    }
    
    let cleaned = part
    if (lower.startsWith('in ')) cleaned = cleaned.substring(3).trim()
    else if (lower.startsWith('inout ')) cleaned = cleaned.substring(6).trim()
    else if (lower.startsWith('variadic ')) cleaned = cleaned.substring(9).trim()
    
    const defaultIdx = cleaned.toLowerCase().indexOf(' default ')
    let defaultValue = ''
    if (defaultIdx !== -1) {
      defaultValue = cleaned.substring(defaultIdx + 9).trim()
      cleaned = cleaned.substring(0, defaultIdx).trim()
    }
    
    const words = cleaned.split(/\s+/)
    let name = ''
    let type = ''
    if (words.length > 1) {
      name = words[0]
      type = words.slice(1).join(' ')
    } else {
      name = `Param ${index + 1}`
      type = words[0]
    }
    
    return { name, type, defaultValue }
  }).filter(Boolean) as { name: string; type: string; defaultValue: string }[]
}

function isTableDesignChanged(tab: QueryTab): boolean {
  if (tab.kind !== 'design') return false
  const getColSig = (c: DesignColumn) => `${c.name}::${c.type}::${c.length}::${c.decimal}::${c.nullable}::${c.isPrimaryKey}::${c.defaultValue}`
  const origColSigs = (tab.originalColumns ?? []).map(getColSig).sort().join('|')
  const curColSigs = (tab.columns ?? []).map(getColSig).sort().join('|')
  if (origColSigs !== curColSigs) return true

  const getIdxSig = (i: DesignIndex) => `${i.name}::${i.columns.join(',')}::${i.isUnique}`
  const origIdxSigs = (tab.originalIndexes ?? []).filter(i => !i.isPrimary).map(getIdxSig).sort().join('|')
  const curIdxSigs = (tab.indexes ?? []).filter(i => !i.isPrimary).map(getIdxSig).sort().join('|')
  if (origIdxSigs !== curIdxSigs) return true

  const getFkSig = (f: DesignForeignKey) => `${f.constraintName}::${f.columnName}::${f.foreignTableSchema}::${f.foreignTableName}::${f.foreignColumnName}::${f.updateRule}::${f.deleteRule}`
  const origFkSigs = (tab.originalForeignKeys ?? []).map(getFkSig).sort().join('|')
  const curFkSigs = (tab.foreignKeys ?? []).map(getFkSig).sort().join('|')
  if (origFkSigs !== curFkSigs) return true

  const getUniqSig = (u: DesignUnique) => `${u.constraintName}::${u.columnName}`
  const origUniqSigs = (tab.originalUniques ?? []).map(getUniqSig).sort().join('|')
  const curUniqSigs = (tab.uniques ?? []).map(getUniqSig).sort().join('|')
  if (origUniqSigs !== curUniqSigs) return true

  const getTrigSig = (t: DesignTrigger) => `${t.triggerName}::${t.actionStatement}::${t.eventManipulation}::${t.actionTiming}::${t.actionOrientation}`
  const origTrigSigs = (tab.originalTriggers ?? []).map(getTrigSig).sort().join('|')
  const curTrigSigs = (tab.triggers ?? []).map(getTrigSig).sort().join('|')
  if (origTrigSigs !== curTrigSigs) return true

  return false
}

function generateTableAlterSql(tab: QueryTab): string {
  const schema = tab.schemaName!
  const table = tab.tableName!
  const fullTable = `"${schema}"."${table}"`
  
  const origCols = tab.originalColumns ?? []
  const currentCols = tab.columns ?? []
  
  const origIdxs = tab.originalIndexes ?? []
  const currentIdxs = tab.indexes ?? []
  
  const origFkeys = tab.originalForeignKeys ?? []
  const currentFkeys = tab.foreignKeys ?? []
  
  const origUniqs = tab.originalUniques ?? []
  const currentUniqs = tab.uniques ?? []
  
  const origTrigs = tab.originalTriggers ?? []
  const currentTrigs = tab.triggers ?? []

  const ddl: string[] = []

  // 1. Column Drops
  origCols.forEach(orig => {
    if (!currentCols.some(c => c.originalName === orig.name)) {
      ddl.push(`ALTER TABLE ${fullTable} DROP COLUMN "${orig.name}";`)
    }
  })

  // 2. Column Additions, Renames, and Modifications
  currentCols.forEach(col => {
    if (!col.originalName) {
      let typeStr = col.type
      if (col.length) {
        if (col.decimal && ['numeric', 'decimal'].includes(col.type.toLowerCase())) {
          typeStr += `(${col.length}, ${col.decimal})`
        } else {
          typeStr += `(${col.length})`
        }
      }
      const nullStr = col.nullable ? 'NULL' : 'NOT NULL'
      const defStr = col.defaultValue ? ` DEFAULT ${col.defaultValue}` : ''
      ddl.push(`ALTER TABLE ${fullTable} ADD COLUMN "${col.name}" ${typeStr} ${nullStr}${defStr};`)
    } else {
      const orig = origCols.find(o => o.name === col.originalName)
      if (orig) {
        if (col.name !== orig.name) {
          ddl.push(`ALTER TABLE ${fullTable} RENAME COLUMN "${orig.name}" TO "${col.name}";`)
          col.originalName = col.name
        }
        
        const origTypeLower = orig.type.toLowerCase()
        const colTypeLower = col.type.toLowerCase()
        let origFullType = origTypeLower
        if (orig.length) {
          origFullType += orig.decimal && ['numeric', 'decimal'].includes(origTypeLower) ? `(${orig.length}, ${orig.decimal})` : `(${orig.length})`
        }
        let colFullType = colTypeLower
        if (col.length) {
          colFullType += col.decimal && ['numeric', 'decimal'].includes(colTypeLower) ? `(${col.length}, ${col.decimal})` : `(${col.length})`
        }

        if (colFullType !== origFullType) {
          ddl.push(`ALTER TABLE ${fullTable} ALTER COLUMN "${col.name}" TYPE ${colFullType} USING "${col.name}"::${col.type};`)
        }

        if (col.nullable !== orig.nullable) {
          if (col.nullable) {
            ddl.push(`ALTER TABLE ${fullTable} ALTER COLUMN "${col.name}" DROP NOT NULL;`)
          } else {
            ddl.push(`ALTER TABLE ${fullTable} ALTER COLUMN "${col.name}" SET NOT NULL;`)
          }
        }

        if (col.defaultValue !== orig.defaultValue) {
          if (!col.defaultValue) {
            ddl.push(`ALTER TABLE ${fullTable} ALTER COLUMN "${col.name}" DROP DEFAULT;`)
          } else {
            ddl.push(`ALTER TABLE ${fullTable} ALTER COLUMN "${col.name}" SET DEFAULT ${col.defaultValue};`)
          }
        }
      }
    }
  })

  // 3. Primary Key Constraint Update
  const origPks = origCols.filter(c => c.isPrimaryKey).map(c => c.name).sort()
  const currentPks = currentCols.filter(c => c.isPrimaryKey).map(c => c.name).sort()
  if (JSON.stringify(origPks) !== JSON.stringify(currentPks)) {
    ddl.push(`ALTER TABLE ${fullTable} DROP CONSTRAINT IF EXISTS "${table}_pkey";`)
    if (currentPks.length > 0) {
      ddl.push(`ALTER TABLE ${fullTable} ADD PRIMARY KEY (${currentPks.map(c => `"${c}"`).join(', ')});`)
    }
  }

  // 4. Foreign Key Constraints Update
  origFkeys.forEach(orig => {
    if (!currentFkeys.some(fk => fk.id === orig.id)) {
      ddl.push(`ALTER TABLE ${fullTable} DROP CONSTRAINT IF EXISTS "${orig.constraintName}";`)
    }
  })
  currentFkeys.forEach(fk => {
    const isNew = fk.isNew || !origFkeys.some(o => o.id === fk.id)
    const orig = origFkeys.find(o => o.id === fk.id)
    const isChanged = orig && (
      orig.constraintName !== fk.constraintName ||
      orig.columnName !== fk.columnName ||
      orig.foreignTableSchema !== fk.foreignTableSchema ||
      orig.foreignTableName !== fk.foreignTableName ||
      orig.foreignColumnName !== fk.foreignColumnName ||
      orig.updateRule !== fk.updateRule ||
      orig.deleteRule !== fk.deleteRule
    )

    if (isNew || isChanged) {
      if (orig) {
        ddl.push(`ALTER TABLE ${fullTable} DROP CONSTRAINT IF EXISTS "${orig.constraintName}";`)
      }
      ddl.push(`ALTER TABLE ${fullTable} ADD CONSTRAINT "${fk.constraintName}" FOREIGN KEY ("${fk.columnName}") REFERENCES "${fk.foreignTableSchema}"."${fk.foreignTableName}" ("${fk.foreignColumnName}") ON UPDATE ${fk.updateRule} ON DELETE ${fk.deleteRule};`)
    }
  })

  // 5. Unique Constraints Update
  origUniqs.forEach(orig => {
    if (!currentUniqs.some(u => u.id === orig.id)) {
      ddl.push(`ALTER TABLE ${fullTable} DROP CONSTRAINT IF EXISTS "${orig.constraintName}";`)
    }
  })
  currentUniqs.forEach(u => {
    const isNew = u.isNew || !origUniqs.some(o => o.id === u.id)
    const orig = origUniqs.find(o => o.id === u.id)
    const isChanged = orig && (orig.constraintName !== u.constraintName || orig.columnName !== u.columnName)

    if (isNew || isChanged) {
      if (orig) {
        ddl.push(`ALTER TABLE ${fullTable} DROP CONSTRAINT IF EXISTS "${orig.constraintName}";`)
      }
      ddl.push(`ALTER TABLE ${fullTable} ADD CONSTRAINT "${u.constraintName}" UNIQUE ("${u.columnName}");`)
    }
  })

  // 6. Indexes Update
  origIdxs.forEach(orig => {
    if (orig.isPrimary) return
    if (!currentIdxs.some(idx => idx.id === orig.id)) {
      ddl.push(`DROP INDEX IF EXISTS "${schema}"."${orig.name}";`)
    }
  })
  currentIdxs.forEach(idx => {
    if (idx.isPrimary) return
    const isNew = idx.isNew || !origIdxs.some(o => o.id === idx.id)
    const orig = origIdxs.find(o => o.id === idx.id)
    const isChanged = orig && (
      orig.name !== idx.name ||
      JSON.stringify(orig.columns) !== JSON.stringify(idx.columns) ||
      orig.isUnique !== idx.isUnique
    )

    if (isNew || isChanged) {
      if (orig) {
        ddl.push(`DROP INDEX IF EXISTS "${schema}"."${orig.name}";`)
      }
      const uniqueStr = idx.isUnique ? 'UNIQUE ' : ''
      ddl.push(`CREATE ${uniqueStr}INDEX "${idx.name}" ON ${fullTable} (${idx.columns.map(c => `"${c}"`).join(', ')});`)
    }
  })

  // 7. Triggers Update
  origTrigs.forEach(orig => {
    if (!currentTrigs.some(t => t.id === orig.id)) {
      ddl.push(`DROP TRIGGER IF EXISTS "${orig.triggerName}" ON ${fullTable};`)
    }
  })
  currentTrigs.forEach(trig => {
    const isNew = trig.isNew || !origTrigs.some(o => o.id === trig.id)
    const orig = origTrigs.find(o => o.id === trig.id)
    const isChanged = orig && (
      orig.triggerName !== trig.triggerName ||
      orig.actionStatement !== trig.actionStatement ||
      orig.eventManipulation !== trig.eventManipulation ||
      orig.actionTiming !== trig.actionTiming ||
      orig.actionOrientation !== trig.actionOrientation
    )

    if (isNew || isChanged) {
      if (orig) {
        ddl.push(`DROP TRIGGER IF EXISTS "${orig.triggerName}" ON ${fullTable};`)
      }
      ddl.push(`CREATE TRIGGER "${trig.triggerName}" ${trig.actionTiming} ${trig.eventManipulation} ON ${fullTable} FOR EACH ${trig.actionOrientation} ${trig.actionStatement};`)
    }
  })

  return ddl.join('\n')
}

function generateCreateTableSql(schema: string, table: string, columns: DesignColumn[]): string {
  const fullTable = `"${schema}"."${table}"`

  const colDefs = columns.map(col => {
    let typeStr = col.type
    if (col.length) {
      if (col.decimal && ['numeric', 'decimal'].includes(col.type.toLowerCase())) {
        typeStr += `(${col.length}, ${col.decimal})`
      } else {
        typeStr += `(${col.length})`
      }
    }
    const nullStr = col.nullable ? 'NULL' : 'NOT NULL'
    const defStr = col.defaultValue ? ` DEFAULT ${col.defaultValue}` : ''
    return `  "${col.name}" ${typeStr} ${nullStr}${defStr}`
  })

  const pkCols = columns.filter(c => c.isPrimaryKey).map(c => c.name)
  if (pkCols.length > 0) {
    colDefs.push(`  PRIMARY KEY (${pkCols.map(c => `"${c}"`).join(', ')})`)
  }

  return `CREATE TABLE ${fullTable} (\n${colDefs.join(',\n')}\n);`
}

function generateCreateViewSql(schema: string, view: string, query: string): string {
  return `CREATE VIEW "${schema}"."${view}" AS\n${query.trim().replace(/;\s*$/, '')};`
}

// ── ER Diagram Component ──────────────────────────────────────────────────────

function ErdDiagramView({
  tab,
  erdTables,
  erdRelations,
  onChange,
  onOpenTable,
  onOpenTableDesign,
}: {
  tab: QueryTab
  erdTables: ErdTable[]
  erdRelations: ErdRelation[]
  onChange: (id: string, patch: Partial<QueryTab>) => void
  onOpenTable: (connId: string, dbName: string, schema: string, table: string) => void
  onOpenTableDesign: (connId: string, dbName: string, schema: string, table: string) => void
}) {
  const [draggingTable, setDraggingTable] = useState<{
    tableName: string
    startX: number
    startY: number
    initialX: number
    initialY: number
  } | null>(null)

  const [zoom, setZoom] = useState(1.0)
  const [isHovered, setIsHovered] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Handle Ctrl+Wheel zoom inside container
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const zoomStep = 0.05
        setZoom(prev => {
          const next = e.deltaY < 0 ? prev + zoomStep : prev - zoomStep
          return Math.min(2.0, Math.max(0.2, next))
        })
      }
    }

    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      container.removeEventListener('wheel', handleWheel)
    }
  }, [])

  // Handle Ctrl+ / Ctrl- / Ctrl= zoom inside window when hovered
  useEffect(() => {
    if (!isHovered) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+' || e.key === '-')) {
        e.preventDefault()
        const zoomStep = 0.1
        setZoom(prev => {
          const next = (e.key === '=' || e.key === '+') ? prev + zoomStep : prev - zoomStep
          return Math.min(2.0, Math.max(0.2, next))
        })
      }
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true })
    }
  }, [isHovered])

  const [isPanning, setIsPanning] = useState(false)
  const [panOffset, setPanOffset] = useState({ x: 100, y: 100 })

  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    // Only pan if clicking directly on the canvas background
    const target = e.target as HTMLElement
    if (
      target === e.currentTarget || 
      target.tagName === 'svg' || 
      target.classList.contains('bg-background') || 
      target.style.backgroundImage || 
      target.style.transform ||
      target.id === 'diagram-canvas-inner'
    ) {
      setIsPanning(true)
      e.preventDefault()
    }
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (draggingTable) {
      const dx = (e.clientX - draggingTable.startX) / zoom
      const dy = (e.clientY - draggingTable.startY) / zoom
      const nextTables = erdTables.map(t =>
        t.name === draggingTable.tableName
          ? { ...t, x: Math.max(0, draggingTable.initialX + dx), y: Math.max(0, draggingTable.initialY + dy) }
          : t
      )
      onChange(tab.id, { erdTables: nextTables })
      return
    }

    if (isPanning) {
      setPanOffset(prev => ({
        x: prev.x + e.movementX,
        y: prev.y + e.movementY
      }))
    }
  }

  const handleMouseUpOrLeave = () => {
    setDraggingTable(null)
    setIsPanning(false)
  }

  // Generate connection paths for SVGs
  const getRelationPath = (rel: ErdRelation) => {
    const source = erdTables.find(t => t.name === rel.localTable)
    const target = erdTables.find(t => t.name === rel.foreignTable)
    if (!source || !target) return ''

    // Find indices of columns in respective tables to locate vertical centers
    const localColIdx = source.columns ? source.columns.findIndex(c => c.name === rel.localColumn) : -1
    const foreignColIdx = target.columns ? target.columns.findIndex(c => c.name === rel.foreignColumn) : -1

    // Calculate Y coordinates: if col is found, target its row center (colRowHeight = 24px); if not, target table header middle (18px)
    const y1 = localColIdx !== -1 
      ? source.y + 36 + 4 + localColIdx * 24 + 12 
      : source.y + 18
    const y2 = foreignColIdx !== -1 
      ? target.y + 36 + 4 + foreignColIdx * 24 + 12 
      : target.y + 18

    // Side-to-side connection paths based on relative card positions (width = 220px)
    const leftToRight = target.x > source.x
    const x1 = leftToRight ? source.x + 220 : source.x
    const x2 = leftToRight ? target.x : target.x + 220

    // Draw beautiful cubic bezier path
    const dx = Math.abs(x2 - x1)
    const controlOffset = Math.max(dx * 0.4, 50)
    
    return `M ${x1} ${y1} C ${x1 + (leftToRight ? controlOffset : -controlOffset)} ${y1}, ${x2 + (leftToRight ? -controlOffset : controlOffset)} ${y2}, ${x2} ${y2}`
  }

  return (
    <div className="flex flex-col h-full bg-background select-none relative overflow-hidden">
      {/* ERD Header */}
      <div className="flex items-center justify-between px-4 h-12 border-b border-border bg-muted/20 shrink-0">
        <div className="flex items-center gap-2">
          <Workflow className="h-4 w-4 text-primary shrink-0" />
          <span className="text-xs font-semibold text-foreground font-mono">
            {tab.databaseName}
          </span>
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold border border-border px-1.5 py-0.5 rounded bg-muted/40 font-sans">
            ER Diagram
          </span>
        </div>

        <div className="text-[10px] text-muted-foreground flex items-center gap-2">
          {/* Zoom controls */}
          <div className="flex items-center gap-1 border border-border/80 bg-card rounded px-1 py-0.5 shrink-0 mr-4">
            <button
              onClick={() => setZoom(prev => Math.min(2.0, Math.max(0.2, prev - 0.1)))}
              className="p-1 hover:bg-accent/40 rounded transition-all text-foreground hover:text-primary"
              title="Zoom Out (Ctrl -)"
            >
              <Minus className="h-3 w-3" />
            </button>
            <span className="text-[10px] font-semibold text-foreground font-mono min-w-10 text-center select-none">
              {Math.round(zoom * 100)}%
            </span>
            <button
              onClick={() => setZoom(prev => Math.min(2.0, Math.max(0.2, prev + 0.1)))}
              className="p-1 hover:bg-accent/40 rounded transition-all text-foreground hover:text-primary"
              title="Zoom In (Ctrl +)"
            >
              <Plus className="h-3 w-3" />
            </button>
            <button
              onClick={() => setZoom(1.0)}
              className="p-1 hover:bg-accent/40 rounded transition-all text-muted-foreground hover:text-foreground text-[9px] font-medium ml-1"
              title="Reset Zoom"
            >
              Reset
            </button>
          </div>

          <span className="flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded bg-amber-400 border border-amber-600 block shadow-sm" /> PK
          </span>
          <span className="flex items-center gap-1 ml-2">
            <span className="h-2.5 w-2.5 rounded bg-blue-400 border border-blue-600 block shadow-sm" /> FK
          </span>
          <button
            onClick={() => onChange(tab.id, { erdTables: undefined })}
            className="flex items-center gap-1.5 ml-4 px-2.5 py-1 bg-card hover:bg-accent/40 border border-border text-[11px] font-medium rounded transition-all text-foreground"
          >
            <RefreshCw className="h-3 w-3 text-primary" />
            Reload Relations
          </button>
        </div>
      </div>

      {/* Grid Canvas */}
      <div
        ref={containerRef}
        onMouseEnter={() => setIsHovered(true)}
        onMouseDown={handleCanvasMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUpOrLeave}
        onMouseLeave={() => { setIsHovered(false); handleMouseUpOrLeave(); }}
        className="flex-1 overflow-hidden relative min-h-0 bg-background select-none"
        style={{
          cursor: draggingTable ? 'grabbing' : isPanning ? 'grabbing' : 'grab'
        }}
      >
        <div
          id="diagram-canvas-inner"
          style={{
            transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom})`,
            transformOrigin: '0 0',
            width: 20000,
            height: 20000,
            position: 'absolute',
            left: 0,
            top: 0,
            padding: 32,
            backgroundImage: 'radial-gradient(var(--border) 1px, transparent 1px)',
            backgroundSize: '20px 20px',
          }}
        >
        {/* SVG Relations Overlay */}
        <svg 
          className="absolute inset-0 pointer-events-none z-0"
          style={{ width: 20000, height: 20000 }}
        >
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="6"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1.5 L 8 5 L 0 8.5 z" style={{ fill: 'var(--primary)' }} />
            </marker>
          </defs>
          {erdRelations.map((rel, idx) => {
            const path = getRelationPath(rel)
            if (!path) return null
            return (
              <g key={idx} className="opacity-60 hover:opacity-100 transition-opacity">
                <path
                  d={path}
                  fill="none"
                  strokeWidth="2"
                  style={{ stroke: 'var(--primary)', transition: 'stroke 0.2s' }}
                  markerEnd="url(#arrow)"
                />
              </g>
            )
          })}
        </svg>

        {/* Draggable Tables */}
        {erdTables.map(t => (
          <div
            key={t.name}
            style={{ left: t.x, top: t.y, width: 220, position: 'absolute' }}
            className="bg-card border border-border rounded-lg shadow-md z-10 select-none overflow-hidden transition-shadow duration-150 hover:shadow-lg"
            onDoubleClick={() => {
              onOpenTable(tab.connectionId!, tab.databaseName!, tab.schemaName || 'public', t.name)
            }}
          >
            {/* Header / Drag Bar */}
            <div
              onMouseDown={e => {
                e.preventDefault()
                e.stopPropagation() // Block background panning!
                setDraggingTable({
                  tableName: t.name,
                  startX: e.clientX,
                  startY: e.clientY,
                  initialX: t.x,
                  initialY: t.y
                })
              }}
              className="flex items-center justify-between px-3 h-9 bg-muted/40 border-b border-border cursor-grab active:cursor-grabbing hover:bg-muted/60 transition-colors"
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <Table2 className="h-3.5 w-3.5 text-blue-300 shrink-0" />
                <span className="text-[11px] font-bold text-foreground font-mono truncate select-none">
                  {t.name}
                </span>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={e => {
                    e.stopPropagation()
                    onOpenTable(tab.connectionId!, tab.databaseName!, tab.schemaName || 'public', t.name)
                  }}
                  onMouseDown={e => e.stopPropagation()}
                  className="p-1 hover:bg-accent/40 rounded transition-all text-muted-foreground hover:text-foreground"
                  title="Open Table Data"
                >
                  <FileText className="h-3 w-3" />
                </button>
                <button
                  onClick={e => {
                    e.stopPropagation()
                    onOpenTableDesign(tab.connectionId!, tab.databaseName!, tab.schemaName || 'public', t.name)
                  }}
                  onMouseDown={e => e.stopPropagation()}
                  className="p-1 hover:bg-accent/40 rounded transition-all text-muted-foreground hover:text-foreground"
                  title="Open Table Design"
                >
                  <Pencil className="h-3 w-3" />
                </button>
              </div>
            </div>

            {/* Columns List */}
            <div className="py-1 bg-card divide-y divide-border/20">
              {t.columns.map(col => (
                <div
                  key={col.name}
                  className="flex items-center justify-between px-3 py-1.5 hover:bg-muted/15 transition-colors text-[10px] font-mono leading-none"
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    {col.isPrimaryKey ? (
                      <div title="Primary Key"><Key className="h-3 w-3 text-amber-500 shrink-0 fill-amber-500/20" /></div>
                    ) : col.isForeignKey ? (
                      <div title="Foreign Key"><Workflow className="h-3 w-3 text-blue-400 shrink-0" /></div>
                    ) : (
                      <div className="w-3" />
                    )}
                    <span className={cn(
                      "truncate font-semibold",
                      col.isPrimaryKey ? "text-amber-300 font-bold" : "text-foreground"
                    )}>
                      {col.name}
                    </span>
                  </div>
                  <span className="text-muted-foreground/60 text-[9px] shrink-0 font-sans ml-2 bg-muted/30 px-1 py-0.5 rounded border border-border/40 uppercase">
                    {col.type}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}

        {erdTables.length === 0 && (
          <div className="absolute top-20 left-20 bg-card border border-border p-6 rounded-xl flex flex-col gap-2 max-w-sm">
            <span className="text-xs font-semibold text-foreground">Empty Database Diagram</span>
            <span className="text-[11px] text-muted-foreground leading-normal">
              No tables found in schema &apos;public&apos;. Add tables or import structures to visualize.
            </span>
          </div>
        )}
        </div>
      </div>
    </div>
  )
}

// ── Query pane ────────────────────────────────────────────────────────────────

function QueryPane({
  tab,
  connections,
  onChange,
  onSave,
  onPageChange,
  onOpenTable,
  onOpenTableDesign,
  onOpenFunction,
  onSavedAsFunction,
  onRefreshDb,
  onAfterRun,
  onClose,
  isSaved,
  isActive,
  runTrigger,
  onSaveTableEdits,
  onTableSort,
  onUpdateSync,
  onUpdateDataSync,
  onTableChanged,
}: {
  tab: QueryTab
  connections: DbConnection[]
  onChange: (id: string, patch: Partial<QueryTab>) => void
  onSave: (tab: QueryTab) => void
  onSaveTableEdits: (tab: QueryTab) => Promise<boolean>
  onTableSort: (tab: QueryTab, column: string, dir?: 'asc' | 'desc' | null) => void
  onUpdateSync: (tabId: string, fn: (s: StructureSyncState) => StructureSyncState) => void
  onUpdateDataSync: (tabId: string, fn: (s: DataSyncState) => DataSyncState) => void
  onTableChanged: (connId: string, dbName: string, schema: string, table: string, change: TableChange) => void
  onPageChange: (tab: QueryTab, page: number) => void
  onOpenTable: (connId: string, dbName: string, schema: string, table: string) => void
  onOpenTableDesign: (connId: string, dbName: string, schema: string, table: string) => void
  onOpenFunction: (connId: string, dbName: string, schema: string, functionName: string, args: string) => void
  onSavedAsFunction: (tab: QueryTab, fn: FunctionInfo, isSavedQuery: boolean) => void
  onRefreshDb: (connId: string, dbName: string) => void
  onAfterRun?: (tab: QueryTab, ok: boolean) => void
  onClose: (id: string) => void
  isSaved: boolean
  isActive: boolean
  runTrigger: number
}) {
  const dbIpc = useCallback((connId: string) => {
    const conn = connections.find(c => c.id === connId)
    return getIpc(conn?.dbType ?? 'postgres')
  }, [connections])

  const editorRef = useRef<SqlEditorHandle>(null)
  const [showFind, setShowFind] = useState(false)
  const [fnRunDialog, setFnRunDialog] = useState<{ functionName: string; schemaName: string; args: { name: string; type: string; defaultValue: string }[] } | null>(null)
  const [paramValues, setParamValues] = useState<Record<string, string>>({})
  const [ddlPreviewSql, setDdlPreviewSql] = useState<string | null>(null)
  const [designSaving, setDesignSaving] = useState(false)
  const [designError, setDesignError] = useState<string | null>(null)
  const [queryHistory, setQueryHistory] = useState<{ sql: string; ts: number; ms: number; error?: string }[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [sqlAlign, setSqlAlign] = useState<'left' | 'center' | 'right'>('left')

  // Load Table Designer Metadata
  useEffect(() => {
    if (tab.kind !== 'design' || tab.columns !== undefined || tab.running) return
    const connId = tab.connectionId ?? connections.find(c => c.status === 'connected')?.id
    if (!connId || !tab.databaseName || !tab.schemaName || !tab.tableName) return

    onChange(tab.id, { running: true })

    const schema = tab.schemaName
    const table = tab.tableName

    const colsQuery = `SELECT 
  c.column_name AS name,
  c.udt_name AS type,
  COALESCE(c.character_maximum_length::text, '') AS length,
  COALESCE(c.numeric_scale::text, '') AS decimal,
  c.is_nullable = 'YES' AS nullable,
  COALESCE(c.column_default, '') AS default_value,
  EXISTS(
    SELECT 1 FROM pg_constraint con
    JOIN pg_attribute a ON a.attnum = ANY(con.conkey)
    WHERE con.contype = 'p' AND con.conrelid = pg_class.oid AND a.attname = c.column_name
  ) AS is_primary,
  EXISTS(
    SELECT 1 FROM pg_constraint con
    JOIN pg_attribute a ON a.attnum = ANY(con.conkey)
    WHERE con.contype = 'f' AND con.conrelid = pg_class.oid AND a.attname = c.column_name
  ) AS is_foreign
FROM information_schema.columns c
JOIN pg_class ON pg_class.relname = c.table_name
JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace AND pg_namespace.nspname = c.table_schema
WHERE c.table_schema = '${schema.replace(/'/g, "''")}' AND c.table_name = '${table.replace(/'/g, "''")}'
ORDER BY c.ordinal_position;`

    const indexesQuery = `SELECT 
  i.relname AS index_name,
  a.attname AS column_name,
  ix.indisunique AS is_unique,
  ix.indisprimary AS is_primary,
  pg_get_indexdef(ix.indexrelid) AS definition
FROM pg_index ix
JOIN pg_class t ON t.oid = ix.indrelid
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
WHERE n.nspname = '${schema.replace(/'/g, "''")}' AND t.relname = '${table.replace(/'/g, "''")}'
ORDER BY i.relname;`

    const fkeysQuery = `SELECT 
  tc.constraint_name,
  kcu.column_name,
  ccu.table_schema AS foreign_table_schema,
  ccu.table_name AS foreign_table_name,
  ccu.column_name AS foreign_column_name,
  rc.update_rule,
  rc.delete_rule
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
JOIN information_schema.referential_constraints rc ON tc.constraint_name = rc.constraint_name AND tc.table_schema = rc.constraint_name_schema
JOIN information_schema.constraint_column_usage ccu ON rc.unique_constraint_name = ccu.constraint_name AND rc.unique_constraint_schema = ccu.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = '${schema.replace(/'/g, "''")}' AND tc.table_name = '${table.replace(/'/g, "''")}';`

    const uniquesQuery = `SELECT 
  tc.constraint_name,
  kcu.column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
WHERE tc.constraint_type = 'UNIQUE' AND tc.table_schema = '${schema.replace(/'/g, "''")}' AND tc.table_name = '${table.replace(/'/g, "''")}';`

    const triggersQuery = `SELECT 
  trigger_name,
  action_statement,
  event_manipulation,
  action_timing,
  action_orientation
FROM information_schema.triggers
WHERE event_object_schema = '${schema.replace(/'/g, "''")}' AND event_object_table = '${table.replace(/'/g, "''")}';`

    Promise.all([
      dbIpc(connId).query(connId, colsQuery, tab.databaseName ?? undefined),
      dbIpc(connId).query(connId, indexesQuery, tab.databaseName ?? undefined),
      dbIpc(connId).query(connId, fkeysQuery, tab.databaseName ?? undefined),
      dbIpc(connId).query(connId, uniquesQuery, tab.databaseName ?? undefined),
      dbIpc(connId).query(connId, triggersQuery, tab.databaseName ?? undefined)
    ]).then(([colsRes, idxsRes, fkeysRes, uniqsRes, trigsRes]) => {
      const columnsList: DesignColumn[] = (colsRes.rows ?? []).map((r: any) => ({
        id: generateId(),
        name: r.name,
        type: r.type,
        length: r.length ?? '',
        decimal: r.decimal ?? '',
        nullable: !!r.nullable,
        isPrimaryKey: !!r.is_primary,
        isForeignKey: !!r.is_foreign,
        defaultValue: r.default_value ?? '',
        originalName: r.name
      }))

      const indexMap: Record<string, DesignIndex> = {}
      ;(idxsRes.rows ?? []).forEach((r: any) => {
        if (!indexMap[r.index_name]) {
          indexMap[r.index_name] = {
            id: generateId(),
            name: r.index_name,
            columns: [],
            isUnique: !!r.is_unique,
            isPrimary: !!r.is_primary,
            definition: r.definition
          }
        }
        indexMap[r.index_name].columns.push(r.column_name)
      })
      const indexesList = Object.values(indexMap)

      const fkeysList: DesignForeignKey[] = (fkeysRes.rows ?? []).map((r: any) => ({
        id: generateId(),
        constraintName: r.constraint_name,
        columnName: r.column_name,
        foreignTableSchema: r.foreign_table_schema,
        foreignTableName: r.foreign_table_name,
        foreignColumnName: r.foreign_column_name,
        updateRule: r.update_rule,
        deleteRule: r.delete_rule
      }))

      const uniquesList: DesignUnique[] = (uniqsRes.rows ?? []).map((r: any) => ({
        id: generateId(),
        constraintName: r.constraint_name,
        columnName: r.column_name
      }))

      const triggersList: DesignTrigger[] = (trigsRes.rows ?? []).map((r: any) => ({
        id: generateId(),
        triggerName: r.trigger_name,
        actionStatement: r.action_statement,
        eventManipulation: r.event_manipulation,
        actionTiming: r.action_timing,
        actionOrientation: r.action_orientation
      }))

      onChange(tab.id, {
        running: false,
        originalColumns: columnsList,
        columns: JSON.parse(JSON.stringify(columnsList)),
        originalIndexes: indexesList,
        indexes: JSON.parse(JSON.stringify(indexesList)),
        originalForeignKeys: fkeysList,
        foreignKeys: JSON.parse(JSON.stringify(fkeysList)),
        originalUniques: uniquesList,
        uniques: JSON.parse(JSON.stringify(uniquesList)),
        originalTriggers: triggersList,
        triggers: JSON.parse(JSON.stringify(triggersList))
      })
    }).catch(err => {
      console.error(err)
      onChange(tab.id, { running: false })
    })
  // Intentionally narrow deps: only reload when the tab identity or load-state changes, not on every connections/onChange identity change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, tab.kind, tab.columns, tab.running])

  // Close the find bar whenever the active tab changes.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setShowFind(false) }, [tab.id])

  // Load ERD Metadata
  useEffect(() => {
    if (tab.kind !== 'erd' || tab.erdTables !== undefined || tab.running) return
    const connId = tab.connectionId ?? connections.find(c => c.status === 'connected')?.id
    if (!connId || !tab.databaseName) return

    onChange(tab.id, { running: true })

    const colsQuery = `
      SELECT 
        c.table_name AS table_name,
        c.column_name AS name,
        c.udt_name AS type,
        c.is_nullable = 'YES' AS nullable,
        EXISTS(
          SELECT 1 FROM pg_constraint con
          JOIN pg_class pc ON pc.oid = con.conrelid
          JOIN pg_namespace pn ON pn.oid = pc.relnamespace
          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
          WHERE con.contype = 'p' 
            AND pc.relname = c.table_name 
            AND pn.nspname = c.table_schema 
            AND a.attname = c.column_name
        ) AS is_primary,
        EXISTS(
          SELECT 1 FROM pg_constraint con
          JOIN pg_class pc ON pc.oid = con.conrelid
          JOIN pg_namespace pn ON pn.oid = pc.relnamespace
          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
          WHERE con.contype = 'f' 
            AND pc.relname = c.table_name 
            AND pn.nspname = c.table_schema 
            AND a.attname = c.column_name
        ) AS is_foreign
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
      ORDER BY c.table_name, c.ordinal_position;
    `

    const fkeysQuery = `
      SELECT
        x.relname AS local_table,
        a.attname AS local_column,
        y.relname AS foreign_table,
        af.attname AS foreign_column
      FROM pg_constraint con
      JOIN pg_class x ON x.oid = con.conrelid
      JOIN pg_class y ON y.oid = con.confrelid
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
      JOIN pg_attribute af ON af.attrelid = con.confrelid AND af.attnum = ANY(con.confkey)
      JOIN pg_namespace n ON n.oid = x.relnamespace
      WHERE con.contype = 'f' AND n.nspname = 'public';
    `

    Promise.all([
      dbIpc(connId).query(connId, colsQuery, tab.databaseName),
      dbIpc(connId).query(connId, fkeysQuery, tab.databaseName)
    ]).then(([colsRes, fkeysRes]) => {
      if (!colsRes.ok) {
        onChange(tab.id, { running: false, erdTables: [] })
        return
      }

      // Group columns by table_name
      const tableMap: Record<string, ErdTableColumn[]> = {}
      for (const row of (colsRes.rows ?? [])) {
        const tName = row.table_name as string
        if (!tableMap[tName]) tableMap[tName] = []
        tableMap[tName].push({
          name: row.name as string,
          type: row.type as string,
          isPrimaryKey: !!row.is_primary,
          isForeignKey: !!row.is_foreign,
          nullable: !!row.nullable
        })
      }

      const relations: ErdRelation[] = (fkeysRes.rows ?? []).map((r: any) => ({
        localTable: r.local_table,
        localColumn: r.local_column,
        foreignTable: r.foreign_table,
        foreignColumn: r.foreign_column
      }))

      // Calculate dependency depth for topological sorting
      const getDepth = (tableName: string, visited: Set<string> = new Set()): number => {
        if (visited.has(tableName)) return 0
        visited.add(tableName)
        const localRels = relations.filter(r => r.localTable === tableName)
        if (localRels.length === 0) return 0
        let maxDepth = 0
        for (const rel of localRels) {
          const depthVal = getDepth(rel.foreignTable, new Set(visited))
          if (depthVal > maxDepth) maxDepth = depthVal
        }
        return maxDepth + 1
      }

      // Group tables by depth
      const names = Object.keys(tableMap)
      const depthGroups: Record<number, string[]> = {}
      names.forEach(name => {
        const d = getDepth(name)
        if (!depthGroups[d]) depthGroups[d] = []
        depthGroups[d].push(name)
      })

      // Layout tables based on depth groups with wrapping to keep rows compact and completely overlap-free
      const tableList: ErdTable[] = []
      const depths = Object.keys(depthGroups).map(Number).sort((a, b) => a - b)
      
      let currentColOffset = 0
      depths.forEach((depth) => {
        const tableNames = depthGroups[depth]
        const maxPerCol = 4 // Limit to 4 tables vertically per visual column
        const numColsNeeded = Math.ceil(tableNames.length / maxPerCol)

        for (let c = 0; c < numColsNeeded; c++) {
          const colNames = tableNames.slice(c * maxPerCol, (c + 1) * maxPerCol)
          let currentY = 60 // Start stacking from Y=60 for each visual column
          
          colNames.forEach((name) => {
            const cols = tableMap[name] || []
            // Calculate exact visual height: Header (36px) + vertical margins (8px) + Row Count * Height (24px)
            const cardHeight = 36 + 8 + cols.length * 24
            
            tableList.push({
              name,
              columns: cols,
              x: 60 + (currentColOffset + c) * 320,
              y: currentY
            })
            
            // Advance Y position dynamically by the card's height plus a comfortable 40px visual gutter
            currentY += cardHeight + 40
          })
        }
        currentColOffset += numColsNeeded
      })

      onChange(tab.id, {
        running: false,
        erdTables: tableList,
        erdRelations: relations
      })
    }).catch(() => {
      onChange(tab.id, { running: false, erdTables: [] })
    })
  // Intentionally narrow deps: only reload when the tab identity or load-state changes, not on every connections/onChange identity change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, tab.kind, tab.erdTables, tab.running])

  const executeFunction = useCallback(async () => {
    if (!fnRunDialog) return
    const connId = tab.connectionId ?? connections.find(c => c.status === 'connected')?.id
    if (!connId) return

    const valuesList = fnRunDialog.args.map(arg => {
      const val = paramValues[arg.name]
      if (val === undefined || val === '') {
        return 'NULL'
      }
      const isNumeric = ['int', 'integer', 'float', 'real', 'double', 'numeric', 'decimal', 'serial'].some(t => arg.type.toLowerCase().includes(t))
      const isBool = arg.type.toLowerCase() === 'boolean' || arg.type.toLowerCase() === 'bool'
      if (isNumeric || isBool) {
        return val
      }
      return `'${val.replace(/'/g, "''")}'`
    })
    const stmt = `SELECT * FROM "${fnRunDialog.schemaName}"."${fnRunDialog.functionName}"(${valuesList.join(', ')});`

    // Save parameters to localStorage before closing the dialog
    const conn = connections.find(c => c.id === connId)
    const hostDbKey = conn ? `${conn.host}:${conn.port}/${conn.database}` : 'default'
    const storageKey = `fn-params:${hostDbKey}:${fnRunDialog.schemaName}:${fnRunDialog.functionName}`
    try {
      localStorage.setItem(storageKey, JSON.stringify(paramValues))
    } catch (e) {
      console.error('Failed to save function parameters', e)
    }

    setFnRunDialog(null)
    onChange(tab.id, { running: true, results: [], connectionId: connId })

    const res = await dbIpc(connId).query(connId, stmt, tab.databaseName ?? undefined)
    const collected: QueryResult[] = []
    if (res.ok) {
      collected.push({ fields: res.fields ?? [], rows: res.rows ?? [], rowCount: res.rowCount ?? null, ms: res.ms ?? 0, statement: stmt })
    } else {
      collected.push({ fields: [], rows: [], rowCount: null, ms: 0, error: res.error, statement: stmt })
    }

    onChange(tab.id, { running: false, results: collected })
  }, [fnRunDialog, paramValues, tab, connections, onChange, dbIpc])

  const run = useCallback(async () => {
    if (tab.running) return

    if (tab.isFunction) {
      let schemaName = tab.schemaName
      let tableName = tab.tableName
      let functionArguments = tab.functionArguments

      if (!schemaName || !tableName || functionArguments === undefined) {
        const connId = tab.connectionId ?? connections.find(c => c.status === 'connected')?.id
        if (!connId) return

        const fnNameFromTitle = tab.title.endsWith('()') ? tab.title.slice(0, -2) : tab.title
        const escapedName = fnNameFromTitle.replace(/'/g, "''")
        const query = `
          SELECT n.nspname AS schema_name, p.proname AS function_name, pg_get_function_arguments(p.oid) AS arguments
          FROM pg_proc p
          JOIN pg_namespace n ON p.pronamespace = n.oid
          WHERE p.proname = '${escapedName}'
          LIMIT 1;
        `
        try {
          onChange(tab.id, { running: true })
          const res = await dbIpc(connId).query(connId, query, tab.databaseName ?? undefined)
          onChange(tab.id, { running: false })
          if (res.ok && res.rows && res.rows.length > 0) {
            const row = res.rows[0] as any
            schemaName = row.schema_name
            tableName = row.function_name
            functionArguments = row.arguments

            onChange(tab.id, {
              schemaName,
              tableName,
              functionArguments
            })
          }
        } catch (e) {
          onChange(tab.id, { running: false })
          console.error(e)
        }
      }

      if (schemaName && tableName) {
        const parsedArgs = parseArguments(functionArguments ?? '')
        if (parsedArgs.length > 0) {
          const connId = tab.connectionId ?? connections.find(c => c.status === 'connected')?.id
          const conn = connections.find(c => c.id === connId)
          const hostDbKey = conn ? `${conn.host}:${conn.port}/${conn.database}` : 'default'
          const storageKey = `fn-params:${hostDbKey}:${schemaName}:${tableName}`
          
          let savedVals: Record<string, string> = {}
          try {
            const saved = localStorage.getItem(storageKey)
            if (saved) {
              savedVals = JSON.parse(saved)
            }
          } catch (e) {
            console.error('Failed to load function parameters', e)
          }

          const initialVals: Record<string, string> = {}
          parsedArgs.forEach(arg => {
            if (savedVals[arg.name] !== undefined) {
              initialVals[arg.name] = savedVals[arg.name]
            } else {
              initialVals[arg.name] = arg.defaultValue || ''
            }
          })
          setParamValues(initialVals)
          setFnRunDialog({
            functionName: tableName,
            schemaName: schemaName,
            args: parsedArgs
          })
          return
        } else {
          const connId = tab.connectionId ?? connections.find(c => c.status === 'connected')?.id
          if (!connId) return
          const conn = connections.find(c => c.id === connId)
          const stmt = `SELECT * FROM "${schemaName}"."${tableName}"();`
          onChange(tab.id, { running: true, results: [], connectionId: connId, dbType: conn?.dbType })
          const res = await dbIpc(connId).query(connId, stmt, tab.databaseName ?? undefined)
          const collected: QueryResult[] = []
          if (res.ok) {
            collected.push({ fields: res.fields ?? [], rows: res.rows ?? [], rowCount: res.rowCount ?? null, ms: res.ms ?? 0, statement: stmt })
          } else {
            collected.push({ fields: [], rows: [], rowCount: null, ms: 0, error: res.error, statement: stmt })
          }
          onChange(tab.id, { running: false, results: collected })
          return
        }
      }
    }

    const selection = editorRef.current?.getSelection() ?? ''
    let sqlToRun = selection.trim() || tab.sql.trim()
    if (!sqlToRun) return
    const connId = tab.connectionId ?? connections.find(c => c.status === 'connected')?.id
    if (!connId) return

    const connForRun = connections.find(c => c.id === connId)
    const isMongoRun = connForRun?.dbType === 'mongodb'

    // Names typed with capitals get their quotes; the editor shows the query that ran
    const quotedSql = quotePgNames(selection.trim() ? sqlToRun : tab.sql, connForRun, tab.databaseName)
    if (quotedSql !== (selection.trim() ? sqlToRun : tab.sql)) {
      if (!selection.trim()) onChange(tab.id, { sql: quotedSql })
      sqlToRun = quotedSql.trim()
    }

    const mismatch = queryLanguageMismatch(connForRun?.dbType, sqlToRun)
    if (mismatch) {
      onChange(tab.id, { results: [{ fields: [], rows: [], rowCount: null, ms: 0, error: mismatch, statement: sqlToRun }], connectionId: connId, dbType: connForRun?.dbType })
      return
    }

    // For MongoDB, send the whole text as one shell script (no SQL splitting)
    const statements = isMongoRun ? [sqlToRun] : splitSqlStatements(sqlToRun)

    if (tab.safeRun) { toast.error('Commit or roll back the Safe Run first'); return }
    const place = `${connForRun?.label || connForRun?.name || ''}${tab.databaseName ? ` · ${tab.databaseName}` : ''}`
    const safe = safeRunEnabled(connForRun?.options)

    if (isMongoRun) {
      if (safe && mongoScriptWrites(sqlToRun) && !await confirmAction({
        title: 'Run this MongoDB code?', subtitle: place, danger: true, confirmLabel: 'Run',
        message: 'This connection uses Safe Run. MongoDB changes can’t be held for review like a SQL transaction, so they are saved as soon as this runs.',
        details: sqlToRun,
      })) return
    } else {
      const infos = statements.map(classifyStatement)
      // Before anything runs: statements that would change every row
      const everyRow = infos.filter(i => i.missingWhere)
      if (everyRow.length && !await confirmAction({
        title: 'Change every row?', subtitle: place, danger: true, confirmLabel: 'Run anyway',
        message: `${everyRow.length === 1 ? 'This statement has' : 'These statements have'} no WHERE clause, so ${everyRow.length === 1 ? 'it changes' : 'they change'} every row of the table:`,
        details: everyRow.map(i => `${i.verb} ${i.table ?? ''}`.trim()).join('\n'),
      })) return

      if (safe && infos.some(i => i.kind !== 'read') && connForRun && connForRun.dbType !== 'mongodb' && connForRun.dbType !== 'redis') {
        const dialect = connForRun.dbType
        const irreversible = infos.filter(i => cannotRollBack(dialect, i))
        if (irreversible.length && !await confirmAction({
          title: 'Run statements that can’t be rolled back?', subtitle: place, danger: true, confirmLabel: 'Run',
          message: 'MySQL saves CREATE, ALTER, DROP and TRUNCATE immediately, even inside a transaction, so Safe Run can’t hold them for review.',
          details: irreversible.map(i => `${i.verb} ${i.table ?? ''}`.trim()).join('\n'),
        })) return

        // Safe Run: everything in one transaction that waits for Commit or Roll back
        const api = dialect === 'mysql' ? window.electronAPI!.mysql : dialect === 'sqlite' ? window.electronAPI!.sqlite : window.electronAPI!.pg
        onChange(tab.id, { running: true, results: [], connectionId: connId, dbType: dialect })
        const opened = dialect === 'mysql'
          ? await window.electronAPI!.mysql.sessionOpen(connId, tab.databaseName ?? undefined)
          : dialect === 'sqlite'
            ? await window.electronAPI!.sqlite.sessionOpen(connId)
            : await window.electronAPI!.pg.sessionOpen(connId, tab.databaseName ?? undefined)
        if (!opened.ok || !opened.sessionId) {
          onChange(tab.id, { running: false, results: [{ fields: [], rows: [], rowCount: null, ms: 0, error: opened.error ?? 'Could not start a transaction', statement: sqlToRun }] })
          return
        }
        const sessionId = opened.sessionId
        const collected: QueryResult[] = []
        const changes: { verb: string; table?: string; rows: number | null }[] = []
        for (const [k, stmt] of statements.entries()) {
          const info = infos[k]
          const sql = dialect === 'postgres' ? previewWrap(stmt, info) : stmt
          const started = Date.now()
          const res = await api.sessionQuery(sessionId, sql)
          if (!res.ok) {
            await api.sessionClose(sessionId, false).catch(() => {})
            collected.push({ fields: [], rows: [], rowCount: null, ms: Date.now() - started, statement: stmt, error: `${res.error}\n\nSafe Run rolled back: nothing was changed.` })
            onChange(tab.id, { running: false, results: collected })
            setQueryHistory(prev => [{ sql: sqlToRun, ts: Date.now(), ms: 0, error: res.error }, ...prev].slice(0, 50))
            return
          }
          let rows = res.rows ?? []
          let rowCount = res.rowCount ?? null
          if (sql !== stmt) {
            // The preview wrap: at most PREVIEW_ROWS rows, and the real total in its own column
            rowCount = rows.length ? Number(rows[0][PREVIEW_TOTAL_COLUMN]) : 0
            rows = rows.map(({ [PREVIEW_TOTAL_COLUMN]: _total, ...rest }) => rest)
          }
          const fields = rows.length ? Object.keys(rows[0]) : []
          collected.push({ fields, rows, rowCount, ms: Date.now() - started, statement: stmt })
          if (info.kind !== 'read') changes.push({ verb: info.verb, table: info.table, rows: info.kind === 'dml' ? rowCount : null })
        }
        onChange(tab.id, { running: false, results: collected, safeRun: { sessionId, dialect, changes, startedAt: Date.now() } })
        setQueryHistory(prev => [{ sql: sqlToRun, ts: Date.now(), ms: collected.reduce((n, r) => n + r.ms, 0) }, ...prev].slice(0, 50))
        return
      }
    }

    onChange(tab.id, { running: true, results: [], connectionId: connId, dbType: connForRun?.dbType })

    const collected: QueryResult[] = []
    for (const stmt of statements) {
      const res = await dbIpc(connId).query(connId, stmt, tab.databaseName ?? undefined)
      if (res.ok) {
        // MongoDB: derive fields and flatten nested documents if it is a Mongo run
        const rawRows = res.rows ?? []
        const { rows, fields } = (isMongoRun && rawRows.length > 0)
          ? processMongoRows(rawRows)
          : { rows: rawRows, fields: (res.fields && res.fields.length > 0) ? res.fields : [] }
        collected.push({ fields, rows, rowCount: res.rowCount ?? null, ms: res.ms ?? 0, statement: stmt })
      } else {
        collected.push({ fields: [], rows: [], rowCount: null, ms: 0, error: res.error, statement: stmt })
        break
      }
    }

    const lastError = collected.find(r => r.error)?.error
    onChange(tab.id, { running: false, results: collected })
    const totalMs = collected.reduce((s, r) => s + r.ms, 0)
    setQueryHistory(prev => [{ sql: sqlToRun, ts: Date.now(), ms: totalMs, error: lastError }, ...prev].slice(0, 50))
    if (tab.databaseName && (tab.isFunction || tab.tableName?.startsWith('type:'))) {
      onAfterRun?.(tab, !lastError)
    } else if (tab.databaseName && !isMongoRun && changesSchema(statements)) {
      // CREATE/ALTER/DROP: refresh so the sidebar and the editor's names show the change right away.
      // Statements before a failing one did run, so refresh if any succeeded.
      onAfterRun?.(tab, collected.some(r => !r.error))
    }
  }, [tab, connections, onChange, onAfterRun, dbIpc])

  const finishSafeRun = useCallback(async (commit: boolean) => {
    const pending = tab.safeRun
    if (!pending) return
    const api = pending.dialect === 'mysql' ? window.electronAPI!.mysql : pending.dialect === 'sqlite' ? window.electronAPI!.sqlite : window.electronAPI!.pg
    const res = await api.sessionClose(pending.sessionId, commit)
    onChange(tab.id, { safeRun: undefined })
    if (!res.ok) {
      toast.error(commit
        ? `Commit failed, nothing was saved: ${res.error}`
        : `The transaction had already ended: ${res.error}`)
      return
    }
    toast.success(commit ? 'Committed' : 'Rolled back: nothing was changed')
    if (commit && tab.databaseName && pending.changes.some(c => c.rows === null)) onAfterRun?.(tab, true)
  }, [tab, onChange, onAfterRun])

  const explainQuery = useCallback(async () => {
    if (tab.running) return

    const selection = editorRef.current?.getSelection() ?? ''
    const sqlToRun = selection.trim() || tab.sql.trim()
    if (!sqlToRun) return
    const connId = tab.connectionId ?? connections.find(c => c.status === 'connected')?.id
    if (!connId) return

    const dbType = connections.find(c => c.id === connId)?.dbType
    const mismatch = queryLanguageMismatch(dbType, sqlToRun)
    if (mismatch) {
      onChange(tab.id, { results: [{ fields: [], rows: [], rowCount: null, ms: 0, error: mismatch, statement: sqlToRun }], connectionId: connId })
      return
    }

    const isMongo = dbType === 'mongodb'
    const explained = quotePgNames(sqlToRun, connections.find(c => c.id === connId), tab.databaseName)
    // EXPLAIN ANALYZE really runs the statement: for one that changes data, show the plan only
    const writes = !isMongo && classifyStatement(sqlToRun).kind !== 'read'
    if (writes) toast.info('Showing the plan without running it', { description: 'EXPLAIN ANALYZE would execute this statement and change data.' })
    const explainStmt = isMongo
      ? `${sqlToRun.replace(/;\s*$/, '')}.explain("executionStats")`
      : writes ? `EXPLAIN ${explained};` : `EXPLAIN (ANALYZE, COSTS, VERBOSE, BUFFERS) ${explained};`
    onChange(tab.id, { running: true, results: [], connectionId: connId })

    let res = await dbIpc(connId).query(connId, explainStmt, tab.databaseName ?? undefined)
    if (!res.ok && !isMongo) {
      const fallbackStmt = `EXPLAIN ${explained};`
      res = await dbIpc(connId).query(connId, fallbackStmt, tab.databaseName ?? undefined)
    }

    const collected: QueryResult[] = []
    if (res.ok) {
      collected.push({ fields: res.fields ?? [], rows: res.rows ?? [], rowCount: res.rowCount ?? null, ms: res.ms ?? 0, statement: sqlToRun })
    } else {
      collected.push({ fields: [], rows: [], rowCount: null, ms: 0, error: res.error, statement: sqlToRun })
    }

    onChange(tab.id, { running: false, results: collected })
  }, [tab, connections, onChange, dbIpc])

  const beautifyQuery = useCallback(() => {
    const original = tab.sql
    if (!original) return

    const keywords = [
      'select', 'from', 'where', 'join', 'left join', 'right join', 'inner join', 'outer join',
      'on', 'group by', 'order by', 'having', 'limit', 'offset', 'and', 'or', 'in', 'exists',
      'not', 'null', 'as', 'insert into', 'values', 'update', 'set', 'delete from', 'union',
      'create table', 'create index', 'drop table', 'drop index', 'alter table', 'returning'
    ]

    const literals: string[] = []
    let formatted = original.replace(/(--.*)/g, (match) => {
      literals.push(match)
      return `__SQL_LITERAL_${literals.length - 1}__`
    })

    formatted = formatted.replace(/('([^'\\]|\\.)*')/g, (match) => {
      literals.push(match)
      return `__SQL_LITERAL_${literals.length - 1}__`
    })

    formatted = formatted.replace(/\s+/g, ' ').trim()

    for (const keyword of keywords) {
      const regex = new RegExp(`\\b${keyword.split(' ').join('\\s+')}\\b`, 'gi')
      formatted = formatted.replace(regex, keyword.toUpperCase())
    }

    const blockKeywords = [
      'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'OUTER JOIN',
      'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'INSERT INTO', 'VALUES',
      'UPDATE', 'SET', 'DELETE FROM', 'RETURNING'
    ]

    for (const blockKw of blockKeywords) {
      const regex = new RegExp(`\\s+(?=${blockKw}\\b)`, 'g')
      formatted = formatted.replace(regex, '\n')
    }

    for (let i = literals.length - 1; i >= 0; i--) {
      formatted = formatted.replace(`__SQL_LITERAL_${i}__`, literals[i])
    }

    onChange(tab.id, { sql: formatted })
  }, [tab, onChange])

  const saveFunction = useCallback(async () => {
    if (tab.running) return
    const connId = tab.connectionId ?? connections.find(c => c.status === 'connected')?.id
    if (!connId) return

    onChange(tab.id, { running: true, results: [] })

    const res = await dbIpc(connId).query(connId, tab.sql, tab.databaseName ?? undefined)
    const collected: QueryResult[] = []
    if (res.ok) {
      collected.push({ fields: res.fields ?? [], rows: res.rows ?? [], rowCount: res.rowCount ?? null, ms: res.ms ?? 0, statement: tab.sql })
      onChange(tab.id, { running: false, results: collected, originalSql: tab.sql })
      if (tab.databaseName) onAfterRun?.(tab, true)
    } else {
      collected.push({ fields: [], rows: [], rowCount: null, ms: 0, error: res.error, statement: tab.sql })
      onChange(tab.id, { running: false, results: collected })
      onAfterRun?.(tab, false)
    }
  }, [tab, connections, onChange, onAfterRun, dbIpc])

  // A query tab whose SQL is one CREATE [OR REPLACE] FUNCTION/PROCEDURE (Postgres) is saved by
  // running it; the tab then becomes that function's tab
  const createdRoutine = useMemo(() => {
    if (tab.kind !== 'query' || tab.isFunction || getTabDbType(tab, connections) !== 'postgres') return null
    const statements = splitSqlStatements(tab.sql)
    return statements.length === 1 ? parseCreateRoutine(statements[0]) : null
  }, [tab, connections])

  const saveAsFunction = useCallback(async () => {
    if (tab.running || !createdRoutine) return
    const connId = tab.connectionId ?? connections.find(c => c.status === 'connected' && c.dbType === 'postgres')?.id
    if (!connId || !tab.databaseName) { toast.error('Pick a connection and database to save the function to'); return }
    const sql = tab.sql
    onChange(tab.id, { running: true, results: [], connectionId: connId })
    const res = await dbIpc(connId).query(connId, sql, tab.databaseName)
    if (!res.ok) {
      onChange(tab.id, { running: false, results: [{ fields: [], rows: [], rowCount: null, ms: 0, error: res.error, statement: sql }] })
      return
    }
    const results: QueryResult[] = [{ fields: res.fields ?? [], rows: res.rows ?? [], rowCount: res.rowCount ?? null, ms: res.ms ?? 0, statement: sql }]
    // Find what was created: an unqualified name lands in the first schema of the search path;
    // with overloads, the newest one
    const lookup = await dbIpc(connId).query(connId, `SELECT n.nspname AS schema_name, p.proname AS name, pg_get_function_arguments(p.oid) AS arguments
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.proname = $1 AND n.nspname = COALESCE($2, current_schema())
ORDER BY p.oid DESC LIMIT 1`, tab.databaseName, [createdRoutine.name, createdRoutine.schema ?? null]).catch(() => null)
    const row = lookup?.ok ? lookup.rows?.[0] as { schema_name: string; name: string; arguments: string } | undefined : undefined
    if (!row) {
      onChange(tab.id, { running: false, results })
      toast.success(`Created ${createdRoutine.kind} ${createdRoutine.name}`)
      onAfterRun?.(tab, true)
      return
    }
    onSavedAsFunction({ ...tab, connectionId: connId, running: false, results }, { schema: row.schema_name, name: row.name, arguments: row.arguments }, isSaved)
    toast.success(`Saved ${createdRoutine.kind} ${row.schema_name}.${row.name}`)
  }, [tab, createdRoutine, connections, onChange, onAfterRun, onSavedAsFunction, isSaved, dbIpc])

  // Mirrors tab.pendingEdits but is updated synchronously, so Ctrl+S pressed while a cell
  // input is focused sees the edit its blur just committed (before React re-renders).
  const pendingEditsRef = useRef(tab.pendingEdits)
  useEffect(() => { pendingEditsRef.current = tab.pendingEdits }, [tab.pendingEdits])

  const handleCellEdit = useCallback((rowIndex: number, col: string, value: string | null | undefined) => {
    const next = { ...pendingEditsRef.current }
    const key = cellEditKey(rowIndex, col)
    if (value === undefined) delete next[key]
    else next[key] = { rowIndex, col, value }
    pendingEditsRef.current = next
    onChange(tab.id, { pendingEdits: next })
  }, [tab.id, onChange])

  const saveTableEdits = useCallback(() => {
    if (tab.savingEdits || Object.keys(pendingEditsRef.current ?? {}).length === 0) return
    onSaveTableEdits({ ...tab, pendingEdits: pendingEditsRef.current })
  }, [tab, onSaveTableEdits])

  const [rowToDelete, setRowToDelete] = useState<{ rowIndex: number } | null>(null)

  // Deletes a row (SQL, by primary key) or document (MongoDB, by _id), then reloads the page
  const deleteTableRow = useCallback(async (rowIndex: number) => {
    setRowToDelete(null)
    const connId = tab.connectionId
    const row = tab.results[0]?.rows[rowIndex]
    if (!connId || !tab.schemaName || !tab.tableName || !row) return
    const dbType = getTabDbType(tab, connections)
    let res
    try {
      if (dbType === 'mongodb') {
        const script = buildMongoCellScript(tab.tableName, row._id, tab.results[0]?.types?.[rowIndex]?._id, { kind: 'deleteDocument' })
        res = await dbIpc(connId).query(connId, script, tab.databaseName ?? undefined)
      } else {
        const del = buildRowDelete(sqlDialectOf(dbType), tab.schemaName, tab.tableName, tab.primaryKeys ?? [], row)
        res = await dbIpc(connId).query(connId, del.sql, tab.databaseName ?? undefined, del.params)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      return
    }
    if (!res.ok) { toast.error(`Delete failed: ${res.error}`); return }
    const deleted = dbType === 'mongodb' ? Number(res.rows?.[0]?.deletedCount ?? 0) : (res.rowCount ?? 0)
    if (deleted === 0) toast.error('Nothing was deleted: the row may have already been changed or deleted')
    else toast.success(dbType === 'mongodb' ? 'Document deleted' : 'Record deleted')
    onPageChange({ ...tab, totalRows: undefined }, tab.page ?? 0)
  }, [tab, connections, dbIpc, onPageChange])

  // MongoDB cell actions apply right away (collections have no pending-edit mode), then reload
  const applyMongoEdit = useCallback(async (rowIndex: number, edit: MongoCellEdit) => {
    const connId = tab.connectionId
    const result = tab.results[0]
    const row = result?.rows[rowIndex]
    if (!connId || !tab.tableName || !row || edit.kind === 'deleteDocument') return
    const types = result.types?.[rowIndex] ?? {}
    let script: string
    try {
      script = buildMongoCellScript(tab.tableName, row._id, types._id, edit, getNestedValue(row, edit.col), types[edit.col])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      return
    }
    const res = await dbIpc(connId).query(connId, script, tab.databaseName ?? undefined)
    if (!res.ok) { toast.error(`Update failed: ${res.error}`); return }
    if (Number(res.rows?.[0]?.matchedCount ?? 0) === 0) {
      toast.error('Document not found: it may have been changed or deleted')
      return
    }
    try {
      const patched = await refreshMongoDocuments(connId, tab.databaseName ?? undefined, tab.tableName, result, [rowIndex])
      onChange(tab.id, { results: [patched, ...tab.results.slice(1)] })
    } catch {
      onPageChange(tab, tab.page ?? 0) // couldn't re-read just this document; reload the page instead
    }
  }, [tab, dbIpc, onPageChange, onChange])

  const discardTableEdits = useCallback(() => {
    pendingEditsRef.current = undefined
    onChange(tab.id, { pendingEdits: undefined, editError: undefined })
  }, [tab.id, onChange])

  const handleSave = useCallback(() => {
    if (tab.kind === 'table') {
      saveTableEdits()
    } else if (tab.kind === 'design') {
      const ddl = generateTableAlterSql(tab)
      if (ddl.trim() === '') return
      setDdlPreviewSql(ddl)
    } else if (tab.isFunction) {
      saveFunction()
    } else if (createdRoutine) {
      saveAsFunction()
    } else {
      onSave(tab)
    }
  }, [tab, onSave, saveFunction, saveAsFunction, createdRoutine, saveTableEdits])

  const runRef = useRef(run)
  useEffect(() => { runRef.current = run }, [run])
  const handleSaveRef = useRef(handleSave)
  useEffect(() => { handleSaveRef.current = handleSave }, [handleSave])
  const tabRef = useRef(tab)
  useEffect(() => { tabRef.current = tab }, [tab])

  // Ctrl+R from Electron main process (fires run-query IPC, not a keydown event)
  useEffect(() => {
    if (runTrigger === 0) return
    runRef.current()
  }, [runTrigger])

  useEffect(() => {
    if (!isActive) return
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        handleSaveRef.current()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isActive])

  useEffect(() => {
    if (!fnRunDialog) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setFnRunDialog(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [fnRunDialog])

  const connectedConns = connections.filter(c => c.status === 'connected')
  const boundConn = connections.find(c => c.id === tab.connectionId && c.status === 'connected')
  const availableDbs = boundConn?.databases ?? []
  const boundDb = boundConn?.databases.find(d => d.name === tab.databaseName)
  const availableSchemas = boundDb?.schemas ?? []
  const editorDialect: 'postgres' | 'mysql' | 'mongodb' | 'sqlite' | 'redis' = boundConn?.dbType ?? 'postgres'
  // Memoized on the underlying state so the editor only reconfigures when the collections really change
  const mongoCollections = useMemo(() => {
    const conn = connections.find(c => c.id === tab.connectionId && c.status === 'connected' && c.dbType === 'mongodb')
    return conn?.databases.find(d => d.name === tab.databaseName)?.schemas.flatMap(s => [...s.tables, ...s.views].map(t => t.name))
  }, [connections, tab.connectionId, tab.databaseName])
  // Memoized on the underlying state so the editor only reconfigures when the schemas really change
  const completionSchemas = useMemo(() => {
    const conn = connections.find(c => c.id === tab.connectionId && c.status === 'connected' && c.dbType !== 'mongodb')
    return conn?.databases.find(d => d.name === tab.databaseName)?.schemas
  }, [connections, tab.connectionId, tab.databaseName])
  const sqlNamespace = useMemo(() => completionSchemas ? buildSqlNamespace(completionSchemas) : undefined, [completionSchemas])
  const tabDbType = getTabDbType(tab, connections)
  useEffect(() => {
    if (tab.kind !== 'table' || tab.foreignKeyRefs !== undefined || tabDbType === 'mongodb' || tabDbType === 'sqlite' || tabDbType === 'redis') return
    if (!tab.connectionId || !tab.databaseName || !tab.schemaName || !tab.tableName) return
    if (!connections.some(c => c.id === tab.connectionId && c.status === 'connected')) return
    let cancelled = false
    const connId = tab.connectionId
    dbIpc(connId).query(connId, FOREIGN_KEYS_SQL[tabDbType], tab.databaseName, [tab.schemaName, tab.tableName])
      .then(r => { if (!cancelled && r.ok) onChange(tab.id, { foreignKeyRefs: parseForeignKeys(r.rows ?? []) }) })
      .catch(() => { /* the FK picker is optional */ })
    return () => { cancelled = true }
  }, [tab.kind, tab.id, tab.foreignKeyRefs, tab.connectionId, tab.databaseName, tab.schemaName, tab.tableName, tabDbType, connections, dbIpc, onChange])
  // Stable identity: the FK popup refetches when its target changes
  const fkTarget = useMemo<FkLookupTarget | undefined>(
    () => tab.kind === 'table' && tab.connectionId && tab.databaseName && tabDbType !== 'mongodb' && tabDbType !== 'sqlite' && tabDbType !== 'redis'
      ? { dbType: tabDbType, connectionId: tab.connectionId, database: tab.databaseName }
      : undefined,
    [tab.kind, tab.connectionId, tab.databaseName, tabDbType],
  )
  const editorFunctions = useMemo(
    () => (completionSchemas ?? []).flatMap(s => s.functions.map(f => ({ schema: s.name, name: f.name, arguments: f.arguments }))),
    [completionSchemas]
  )
  // Tables of this schema are suggested without a prefix; MySQL lists a database's tables under the database name
  // MySQL and SQLite list tables under the database name; PostgreSQL under a schema
  const editorDefaultSchema = editorDialect === 'mysql' || editorDialect === 'sqlite' ? (tab.databaseName ?? undefined) : (tab.schemaName ?? 'public')
  // Ctrl+click on a name: switch to its tab, or open one
  const handleEditorNavigate = useCallback((target: SqlTarget) => {
    if (!tab.connectionId || !tab.databaseName) return
    if (target.kind === 'table') onOpenTable(tab.connectionId, tab.databaseName, target.schema, target.name)
    else onOpenFunction(tab.connectionId, tab.databaseName, target.schema, target.name, target.arguments)
  }, [tab.connectionId, tab.databaseName, onOpenTable, onOpenFunction])
  const isFunctionChanged = tab.isFunction && tab.sql !== tab.originalSql
  const isQueryChanged = !tab.isFunction && tab.kind === 'query' && tab.originalSql !== undefined && tab.sql !== tab.originalSql && tab.sql.trim() !== ''
  const canRun = !tab.running && !!boundConn && !!tab.databaseName && (!tab.isFunction || !isFunctionChanged)
  const canSave = tab.isFunction
    ? (isFunctionChanged && !!boundConn && !!tab.databaseName)
    : createdRoutine
      ? (!!boundConn && !!tab.databaseName && !tab.running)
      : (!!tab.connectionId && !!tab.databaseName && !!tab.schemaName && !!tab.sql.trim())

  if (tab.kind === 'redis-browser' || tab.kind === 'redis-console') {
    const conn = connections.find(c => c.id === tab.connectionId)
    if (!conn || conn.status !== 'connected') {
      return <div className="h-full flex items-center justify-center text-xs text-muted-foreground">Connect {conn ? (conn.label || conn.name) : 'the connection'} to use this tab.</div>
    }
    const label = conn.label || conn.name
    const db = redisDbIndex(tab.databaseName)
    return tab.kind === 'redis-browser'
      ? <RedisBrowser key={`${conn.id}:${db}`} connectionId={conn.id} db={db} label={label} />
      : <RedisConsole key={`${conn.id}:${db}`} connectionId={conn.id} db={db} label={label} safe={safeRunEnabled(conn.options)} />
  }

  if (tab.kind === 'structure-sync') {
    return (
      <StructureSyncView
        state={tab.sync ?? initialSyncState()}
        update={fn => onUpdateSync(tab.id, fn)}
        connections={connections.flatMap(c => c.dbType === 'sqlite' || c.dbType === 'redis' ? [] : [{
          id: c.id, label: c.label || c.name, dbType: c.dbType, status: c.status, databases: c.databases.map(d => d.name),
        }])}
        onDeployed={(connId, database) => onRefreshDb(connId, database)}
      />
    )
  }

  if (tab.kind === 'data-sync') {
    return (
      <DataSyncView
        state={tab.dataSync ?? initialDataSyncState()}
        update={fn => onUpdateDataSync(tab.id, fn)}
        connections={connections.flatMap(c => c.dbType === 'sqlite' || c.dbType === 'redis' ? [] : [{
          id: c.id, label: c.label || c.name, dbType: c.dbType, status: c.status, databases: c.databases.map(d => d.name),
        }])}
        onDeployed={(connId, database) => onRefreshDb(connId, database)}
      />
    )
  }

  if (tab.kind === 'table') {
    const page = tab.page ?? 0
    const pageSize = tab.pageSize ?? TABLE_PAGE_SIZE
    const totalRows = tab.totalRows
    const totalPages = totalRows !== undefined ? Math.max(1, Math.ceil(totalRows / pageSize)) : undefined
    const currentRowsCount = tab.results?.[0]?.rows?.length ?? 0
    const from = page * pageSize + 1
    const to = totalRows !== undefined ? Math.min((page + 1) * pageSize, totalRows) : (page + 1) * pageSize
    const tableDbType = getTabDbType(tab, connections)
    const editCount = Object.keys(tab.pendingEdits ?? {}).length
    const hasEdits = editCount > 0
    const readOnlyReason = tableDbType !== 'mongodb' && tab.primaryKeys !== undefined && tab.primaryKeys.length === 0
      ? 'Read-only: table has no primary key'
      : null
    // MongoDB documents are matched by _id; SQL rows need a primary key
    const editable = readOnlyReason === null && (tableDbType === 'mongodb' || (tab.primaryKeys?.length ?? 0) > 0)
    const navBlockedTitle = hasEdits ? 'Save or discard your changes first' : undefined
    const busy = tab.running || !!tab.savingEdits

    return (
      <div className="flex flex-col h-full">
        {/* Table tab header */}
        <div className="flex items-center justify-between px-3 h-9 border-b border-border bg-muted/10 shrink-0">
          <div className="flex items-center gap-2">
            <Table2 className="h-3.5 w-3.5 text-primary shrink-0" />
            <span className="text-xs font-semibold text-foreground font-mono">
              {tab.schemaName}.{tab.tableName}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => onPageChange(tab, tab.page ?? 0)}
              disabled={busy || hasEdits}
              title={navBlockedTitle ?? 'Refresh table data'}
              className="flex items-center gap-1 px-2 h-6 rounded text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-all font-medium disabled:opacity-40"
            >
              <RefreshCw className={cn("h-3 w-3", tab.running && "animate-spin")} />
              Refresh
            </button>
            <button
              onClick={() => onOpenTableDesign(tab.connectionId!, tab.databaseName!, tab.schemaName!, tab.tableName!)}
              className="flex items-center gap-1 px-2 h-6 rounded text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-all font-medium"
            >
              <Wrench className="h-3 w-3 text-primary" />
              Design
            </button>
          </div>
        </div>

        {tab.insertError && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => onChange(tab.id, { insertError: undefined })}>
            <div className="bg-card border border-border rounded-lg shadow-2xl w-[min(480px,92vw)] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
              <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
                <AlertTriangle className="h-4 w-4 text-red-400 shrink-0" />
                <span className="text-sm font-semibold text-foreground">Row not inserted</span>
              </div>
              <div className="px-4 py-3 flex flex-col gap-2">
                <p className="text-xs text-red-300 whitespace-pre-wrap break-words">{tab.insertError}</p>
                <p className="text-[11px] text-muted-foreground">Nothing was inserted. Your values are still in the new row, so you can fix them and save again.</p>
              </div>
              <div className="flex justify-end px-4 py-3 border-t border-border">
                <button
                  autoFocus
                  onClick={() => onChange(tab.id, { insertError: undefined })}
                  className="px-3 h-7 rounded text-xs bg-primary text-primary-foreground font-medium hover:bg-primary/90"
                >
                  OK
                </button>
              </div>
            </div>
          </div>
        )}

        {tab.editError ? (
          <div className="flex items-center gap-2 px-3 min-h-7 py-1 border-b border-red-500/30 bg-red-500/10 shrink-0">
            <AlertTriangle className="h-3.5 w-3.5 text-red-400 shrink-0" />
            <span className="text-xs text-red-400 font-medium shrink-0">Save stopped at the highlighted row:</span>
            <span className="text-xs text-red-300 truncate" title={tab.editError.message}>{tab.editError.message}</span>
          </div>
        ) : hasEdits && (
          <div className="flex items-center gap-2 px-3 h-7 border-b border-amber-500/30 bg-amber-500/10 shrink-0">
            <span className="text-xs text-amber-400 font-medium">
              {editCount} unsaved change{editCount === 1 ? '' : 's'}
            </span>
            <span className="text-xs text-muted-foreground/70">Ctrl+S to save · Esc while editing reverts the cell</span>
          </div>
        )}

        <div className="flex-1 min-h-0">
          <ResultsGrid
            results={tab.results}
            running={tab.running}
            statusBorder="top"
            columnTypes={tab.columnTypes}
            dbType={tableDbType}
            editable={editable}
            pendingEdits={tab.pendingEdits}
            onCellEdit={handleCellEdit}
            errorRowIndex={tab.editError?.rowIndex}
            allowNewRow={tableDbType !== 'mongodb'}
            focusCell={tab.focusCell}
            foreignKeys={tab.foreignKeyRefs}
            fkTarget={fkTarget}
            onOpenReferencedTable={fk => onOpenTable(tab.connectionId!, tableDbType === 'mysql' ? fk.refSchema : tab.databaseName!, fk.refSchema, fk.refTable)}
            serverSort={{
              sort: tab.tableSort,
              onSort: (column, dir) => {
                if (busy) return
                // Re-sorting reloads the rows, which would drop pending edits
                if (hasEdits) { toast.error('Save or discard your changes before sorting'); return }
                onTableSort(tab, column, dir)
              },
            }}
            table={tab.schemaName && tab.tableName ? { schema: tab.schemaName, name: tab.tableName, primaryKeys: tab.primaryKeys ?? [] } : undefined}
            onDeleteRow={rowIndex => setRowToDelete({ rowIndex })}
            deleteBlockedReason={busy ? 'busy' : hasEdits ? 'save changes first' : undefined}
            onMongoEdit={tableDbType === 'mongodb' ? (rowIndex, edit) => {
              if (busy) return
              if (edit.kind === 'deleteDocument') setRowToDelete({ rowIndex })
              else applyMongoEdit(rowIndex, edit)
            } : undefined}
          />
        </div>
        <AlertDialog open={!!rowToDelete} onOpenChange={open => { if (!open) setRowToDelete(null) }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{tableDbType === 'mongodb' ? 'Delete document?' : 'Delete record?'}</AlertDialogTitle>
              <AlertDialogDescription>
                {rowToDelete && describeRowForDelete(tab, tableDbType, rowToDelete.rowIndex)} This can&apos;t be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={() => { if (rowToDelete) deleteTableRow(rowToDelete.rowIndex) }}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <div className="flex items-center gap-2 px-3 h-8 border-t border-border bg-card shrink-0">
          <button
            onClick={discardTableEdits}
            disabled={busy || !hasEdits}
            className="flex items-center gap-1 px-2 h-5 rounded border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-accent/20 disabled:opacity-40 transition-colors"
            title="Discard all changes"
          >
            <X className="h-3 w-3" />
            Discard
          </button>
          <button
            onClick={saveTableEdits}
            disabled={busy || !hasEdits}
            className="flex items-center gap-1 px-2 h-5 rounded bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-40 transition-colors"
            title="Save all changes (Ctrl+S)"
          >
            {tab.savingEdits ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
            {tab.savingEdits ? 'Saving…' : `Save${hasEdits ? ` (${editCount})` : ''}`}
          </button>
          {readOnlyReason && (
            <span className="text-[11px] text-muted-foreground/60">{readOnlyReason}</span>
          )}
          <div className="w-px h-4 bg-border mx-1" />
          <button
            onClick={() => onPageChange(tab, 0)}
            disabled={tab.running || hasEdits || page === 0}
            className="px-1.5 h-5 rounded text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20 disabled:opacity-40 transition-colors"
            title={navBlockedTitle ?? 'First page'}
          >«</button>
          <button
            onClick={() => onPageChange(tab, page - 1)}
            disabled={tab.running || hasEdits || page === 0}
            className="px-1.5 h-5 rounded text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20 disabled:opacity-40 transition-colors"
            title={navBlockedTitle ?? 'Previous page'}
          >‹</button>
          <span className="text-xs text-muted-foreground tabular-nums">
            {totalRows !== undefined
              ? `${from}–${to} of ${totalRows.toLocaleString()}`
              : `Page ${page + 1}`}
          </span>
          <button
            onClick={() => onPageChange(tab, page + 1)}
            disabled={tab.running || hasEdits || (totalPages !== undefined ? page >= totalPages - 1 : currentRowsCount < pageSize)}
            className="px-1.5 h-5 rounded text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20 disabled:opacity-40 transition-colors"
            title={navBlockedTitle ?? 'Next page'}
          >›</button>
          {totalPages !== undefined && (
            <button
              onClick={() => onPageChange(tab, totalPages - 1)}
              disabled={tab.running || hasEdits || page >= totalPages - 1}
              className="px-1.5 h-5 rounded text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20 disabled:opacity-40 transition-colors"
              title={navBlockedTitle ?? 'Last page'}
            >»</button>
          )}
          {totalPages !== undefined && (
            <span className="text-xs text-muted-foreground/50">Page {page + 1} of {totalPages}</span>
          )}
        </div>
      </div>
    )
  }

  if (tab.kind === 'erd') {
    const erdTables = tab.erdTables ?? []
    const erdRelations = tab.erdRelations ?? []

    if (tab.erdTables === undefined && tab.running) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-3 bg-muted/10">
          <Loader2 className="h-8 w-8 text-primary animate-spin" />
          <span className="text-xs text-muted-foreground font-medium">Introspecting database relationships...</span>
        </div>
      )
    }

    return (
      <ErdDiagramView
        tab={tab}
        erdTables={erdTables}
        erdRelations={erdRelations}
        onChange={onChange}
        onOpenTable={onOpenTable}
        onOpenTableDesign={onOpenTableDesign}
      />
    )
  }

  if (tab.kind === 'create-table') {
    const columns = tab.columns ?? []
    const tableName = tab.tableName ?? ''
    const schemaName = tab.schemaName ?? 'public'
    const canCreate = !!tableName.trim() && columns.length > 0 && columns.every(c => c.name.trim()) && !tab.running

    const handleAddColumn = () => {
      const next = [...columns, {
        id: generateId(),
        name: `column_${columns.length + 1}`,
        type: 'varchar',
        length: '255',
        decimal: '',
        nullable: true,
        isPrimaryKey: false,
        isForeignKey: false,
        defaultValue: ''
      }]
      onChange(tab.id, { columns: next })
    }

    const handleDeleteColumn = (colId: string) => {
      onChange(tab.id, { columns: columns.filter(c => c.id !== colId) })
    }

    const handleUpdateColumn = (colId: string, patch: Partial<DesignColumn>) => {
      onChange(tab.id, { columns: columns.map(c => c.id === colId ? { ...c, ...patch } : c) })
    }

    const handleCreate = async () => {
      const connId = tab.connectionId ?? connections.find(c => c.status === 'connected')?.id
      if (!connId || !tab.databaseName || !canCreate) return

      setDesignSaving(true)
      setDesignError(null)

      const ddl = generateCreateTableSql(schemaName, tableName.trim(), columns)
      const res = await dbIpc(connId).query(connId, ddl, tab.databaseName)

      if (res.ok) {
        setDesignSaving(false)
        toast.success(`Table "${schemaName}.${tableName.trim()}" created successfully!`)
        onRefreshDb(connId, tab.databaseName)
        onOpenTableDesign(connId, tab.databaseName, schemaName, tableName.trim())
        onClose(tab.id)
      } else {
        setDesignSaving(false)
        setDesignError(res.error || 'Failed to create table.')
      }
    }

    return (
      <div className="flex flex-col h-full bg-background select-none relative">
        <div className="flex items-center justify-between px-4 h-12 border-b border-border bg-muted/20 shrink-0">
          <div className="flex items-center gap-2">
            <Table2 className="h-4 w-4 text-primary shrink-0" />
            <input
              type="text"
              value={tableName}
              onChange={e => onChange(tab.id, { tableName: e.target.value })}
              placeholder="table_name"
              className="bg-background border border-border/80 hover:border-border focus:border-primary focus:ring-1 focus:ring-primary rounded px-2 py-1 text-xs font-mono transition-all shadow-sm w-56"
            />
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold border border-border px-1.5 py-0.5 rounded bg-muted/40 font-sans">
              New Table &middot; {schemaName}
            </span>
          </div>
          <button
            onClick={handleCreate}
            disabled={!canCreate}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-all shadow-sm border border-transparent',
              canCreate
                ? 'bg-primary text-primary-foreground hover:bg-primary/95 hover:shadow'
                : 'bg-muted/30 text-muted-foreground cursor-not-allowed border-border/40'
            )}
          >
            <Save className="h-3.5 w-3.5" />
            {tab.running ? 'Creating…' : 'Create Table'}
          </button>
        </div>

        {designError && (
          <div className="px-4 py-2 bg-red-950/60 border-b border-red-500/30 text-xs text-red-300 whitespace-pre-wrap break-words shrink-0">
            {designError}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4 min-h-0 bg-background">
          <div className="flex flex-col gap-3 h-full">
            <div className="flex items-center justify-between shrink-0">
              <span className="text-xs font-medium text-muted-foreground">Define table columns &amp; types</span>
              <button
                onClick={handleAddColumn}
                className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium border border-border bg-card text-foreground hover:bg-accent/30 transition-colors"
              >
                <Plus className="h-3 w-3 text-primary" />
                Add Field
              </button>
            </div>

            <div className="border border-border rounded-lg bg-card overflow-hidden flex flex-col flex-1 min-h-0">
              <div className="overflow-x-auto overflow-y-auto flex-1">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-muted/40 border-b border-border text-muted-foreground font-medium">
                      <th className="p-2.5 w-14 text-center">PK</th>
                      <th className="p-2.5 w-52">Name</th>
                      <th className="p-2.5 w-48">Type</th>
                      <th className="p-2.5 w-24">Length</th>
                      <th className="p-2.5 w-24">Decimal</th>
                      <th className="p-2.5 w-16 text-center">Null</th>
                      <th className="p-2.5 w-52">Default Value</th>
                      <th className="p-2.5 w-16 text-center">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {columns.length === 0 && (
                      <tr>
                        <td colSpan={8} className="p-8 text-center text-muted-foreground">
                          No columns defined. Click &quot;Add Field&quot; to add columns to this table.
                        </td>
                      </tr>
                    )}
                    {columns.map(col => (
                      <tr key={col.id} className="border-b border-border/40 hover:bg-muted/20 transition-colors">
                        <td className="p-2 text-center">
                          <div className="flex items-center justify-center h-full">
                            <button
                              onClick={() => handleUpdateColumn(col.id, { isPrimaryKey: !col.isPrimaryKey })}
                              className={cn(
                                "h-4 w-4 rounded flex items-center justify-center transition-all border shadow-sm",
                                col.isPrimaryKey
                                  ? "bg-primary border-primary text-primary-foreground"
                                  : "border-border/85 bg-background hover:border-border"
                              )}
                            >
                              {col.isPrimaryKey && <Check className="h-3 w-3 stroke-[3.5]" />}
                            </button>
                          </div>
                        </td>
                        <td className="p-2">
                          <input
                            type="text"
                            value={col.name}
                            onChange={e => handleUpdateColumn(col.id, { name: e.target.value })}
                            placeholder="column_name"
                            className="w-full bg-background border border-border/80 hover:border-border focus:border-primary focus:ring-1 focus:ring-primary rounded px-2 py-1 text-xs font-mono transition-all shadow-sm"
                          />
                        </td>
                        <td className="p-2">
                          <select
                            value={col.type}
                            onChange={e => handleUpdateColumn(col.id, { type: e.target.value })}
                            className="w-full bg-background border border-border/80 hover:border-border focus:border-primary focus:ring-1 focus:ring-primary rounded px-2 py-1 text-xs font-mono text-foreground transition-all shadow-sm"
                          >
                            {POSTGRES_TYPES.map(t => (
                              <option key={t} value={t}>{t}</option>
                            ))}
                            {!POSTGRES_TYPES.includes(col.type) && (
                              <option value={col.type}>{col.type}</option>
                            )}
                          </select>
                        </td>
                        <td className="p-2">
                          <input
                            type="text"
                            value={col.length}
                            onChange={e => handleUpdateColumn(col.id, { length: e.target.value })}
                            placeholder="length"
                            className="w-full bg-background border border-border/80 hover:border-border focus:border-primary focus:ring-1 focus:ring-primary rounded px-2 py-1 text-xs font-mono text-center transition-all shadow-sm"
                          />
                        </td>
                        <td className="p-2">
                          <input
                            type="text"
                            value={col.decimal}
                            onChange={e => handleUpdateColumn(col.id, { decimal: e.target.value })}
                            placeholder="decimal"
                            disabled={!['numeric', 'decimal'].includes(col.type.toLowerCase())}
                            className="w-full bg-background border border-border/80 hover:border-border focus:border-primary focus:ring-1 focus:ring-primary rounded px-2 py-1 text-xs font-mono text-center disabled:opacity-30 transition-all shadow-sm"
                          />
                        </td>
                        <td className="p-2 text-center">
                          <div className="flex items-center justify-center h-full">
                            <button
                              onClick={() => handleUpdateColumn(col.id, { nullable: !col.nullable })}
                              className={cn(
                                "h-4 w-4 rounded flex items-center justify-center transition-all border shadow-sm",
                                col.nullable
                                  ? "bg-primary border-primary text-primary-foreground"
                                  : "border-border/85 bg-background hover:border-border"
                              )}
                            >
                              {col.nullable && <Check className="h-3 w-3 stroke-[3.5]" />}
                            </button>
                          </div>
                        </td>
                        <td className="p-2">
                          <input
                            type="text"
                            value={col.defaultValue}
                            onChange={e => handleUpdateColumn(col.id, { defaultValue: e.target.value })}
                            placeholder="NULL or 'value'"
                            className="w-full bg-background border border-border/80 hover:border-border focus:border-primary focus:ring-1 focus:ring-primary rounded px-2 py-1 text-xs font-mono transition-all shadow-sm"
                          />
                        </td>
                        <td className="p-2 text-center">
                          <button
                            onClick={() => handleDeleteColumn(col.id)}
                            className="p-1 text-muted-foreground hover:text-destructive rounded transition-colors"
                            title="Delete column"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (tab.kind === 'create-view') {
    const viewName = tab.tableName ?? ''
    const schemaName = tab.schemaName ?? 'public'
    const canCreate = !!viewName.trim() && !!tab.sql.trim() && !tab.running

    const handleCreate = async () => {
      const connId = tab.connectionId ?? connections.find(c => c.status === 'connected')?.id
      if (!connId || !tab.databaseName || !canCreate) return

      setDesignSaving(true)
      setDesignError(null)

      const ddl = generateCreateViewSql(schemaName, viewName.trim(), tab.sql)
      const res = await dbIpc(connId).query(connId, ddl, tab.databaseName)

      if (res.ok) {
        setDesignSaving(false)
        toast.success(`View "${schemaName}.${viewName.trim()}" created successfully!`)
        onRefreshDb(connId, tab.databaseName)
        onClose(tab.id)
      } else {
        setDesignSaving(false)
        setDesignError(res.error || 'Failed to create view.')
      }
    }

    return (
      <div className="flex flex-col h-full bg-background select-none relative">
        <div className="flex items-center justify-between px-4 h-12 border-b border-border bg-muted/20 shrink-0">
          <div className="flex items-center gap-2">
            <View className="h-4 w-4 text-sky-300 shrink-0" />
            <input
              type="text"
              value={viewName}
              onChange={e => onChange(tab.id, { tableName: e.target.value })}
              placeholder="view_name"
              className="bg-background border border-border/80 hover:border-border focus:border-primary focus:ring-1 focus:ring-primary rounded px-2 py-1 text-xs font-mono transition-all shadow-sm w-56"
            />
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold border border-border px-1.5 py-0.5 rounded bg-muted/40 font-sans">
              New View &middot; {schemaName}
            </span>
          </div>
          <button
            onClick={handleCreate}
            disabled={!canCreate}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-all shadow-sm border border-transparent',
              canCreate
                ? 'bg-primary text-primary-foreground hover:bg-primary/95 hover:shadow'
                : 'bg-muted/30 text-muted-foreground cursor-not-allowed border-border/40'
            )}
          >
            <Save className="h-3.5 w-3.5" />
            {tab.running ? 'Creating…' : 'Create View'}
          </button>
        </div>

        {designError && (
          <div className="px-4 py-2 bg-red-950/60 border-b border-red-500/30 text-xs text-red-300 whitespace-pre-wrap break-words shrink-0">
            {designError}
          </div>
        )}

        <div className="flex-1 min-h-0">
          <SqlEditor
            value={tab.sql}
            onChange={v => onChange(tab.id, { sql: v })}
            onRun={() => {}}
          />
        </div>
      </div>
    )
  }

  if (tab.kind === 'design') {
    const isChanged = isTableDesignChanged(tab)
    const activeSubTab = tab.designActiveTab ?? 'fields'
    const columns = tab.columns ?? []
    const indexes = tab.indexes ?? []
    const foreignKeys = tab.foreignKeys ?? []
    const uniques = tab.uniques ?? []
    const triggers = tab.triggers ?? []

    const handleAddColumn = () => {
      const next = [...columns, {
        id: generateId(),
        name: `new_column_${columns.length + 1}`,
        type: 'varchar',
        length: '255',
        decimal: '',
        nullable: true,
        isPrimaryKey: false,
        isForeignKey: false,
        defaultValue: ''
      }]
      onChange(tab.id, { columns: next })
    }

    const handleDeleteColumn = (colId: string) => {
      const next = columns.filter(c => c.id !== colId)
      onChange(tab.id, { columns: next })
    }

    const handleUpdateColumn = (colId: string, patch: Partial<DesignColumn>) => {
      const next = columns.map(c => c.id === colId ? { ...c, ...patch } : c)
      onChange(tab.id, { columns: next })
    }

    const handleAddIndex = () => {
      const next = [...indexes, {
        id: generateId(),
        name: `idx_${tab.tableName}_${indexes.length + 1}`,
        columns: [columns[0]?.name ?? ''],
        isUnique: false,
        isPrimary: false,
        isNew: true
      }]
      onChange(tab.id, { indexes: next })
    }

    const handleDeleteIndex = (idxId: string) => {
      const next = indexes.filter(i => i.id !== idxId)
      onChange(tab.id, { indexes: next })
    }

    const handleUpdateIndex = (idxId: string, patch: Partial<DesignIndex>) => {
      const next = indexes.map(i => i.id === idxId ? { ...i, ...patch } : i)
      onChange(tab.id, { indexes: next })
    }

    const handleAddForeignKey = () => {
      const next = [...foreignKeys, {
        id: generateId(),
        constraintName: `fk_${tab.tableName}_${foreignKeys.length + 1}`,
        columnName: columns[0]?.name ?? '',
        foreignTableSchema: tab.schemaName ?? 'public',
        foreignTableName: '',
        foreignColumnName: '',
        updateRule: 'NO ACTION',
        deleteRule: 'NO ACTION',
        isNew: true
      }]
      onChange(tab.id, { foreignKeys: next })
    }

    const handleDeleteForeignKey = (fkId: string) => {
      const next = foreignKeys.filter(f => f.id !== fkId)
      onChange(tab.id, { foreignKeys: next })
    }

    const handleUpdateForeignKey = (fkId: string, patch: Partial<DesignForeignKey>) => {
      const next = foreignKeys.map(f => f.id === fkId ? { ...f, ...patch } : f)
      onChange(tab.id, { foreignKeys: next })
    }

    const handleAddUnique = () => {
      const next = [...uniques, {
        id: generateId(),
        constraintName: `uq_${tab.tableName}_${uniques.length + 1}`,
        columnName: columns[0]?.name ?? '',
        isNew: true
      }]
      onChange(tab.id, { uniques: next })
    }

    const handleDeleteUnique = (uqId: string) => {
      const next = uniques.filter(u => u.id !== uqId)
      onChange(tab.id, { uniques: next })
    }

    const handleUpdateUnique = (uqId: string, patch: Partial<DesignUnique>) => {
      const next = uniques.map(u => u.id === uqId ? { ...u, ...patch } : u)
      onChange(tab.id, { uniques: next })
    }

    const handleAddTrigger = () => {
      const next = [...triggers, {
        id: generateId(),
        triggerName: `trg_${tab.tableName}_${triggers.length + 1}`,
        actionStatement: 'EXECUTE FUNCTION log_changes()',
        eventManipulation: 'INSERT',
        actionTiming: 'AFTER',
        actionOrientation: 'ROW',
        isNew: true
      }]
      onChange(tab.id, { triggers: next })
    }

    const handleDeleteTrigger = (trigId: string) => {
      const next = triggers.filter(t => t.id !== trigId)
      onChange(tab.id, { triggers: next })
    }

    const handleUpdateTrigger = (trigId: string, patch: Partial<DesignTrigger>) => {
      const next = triggers.map(t => t.id === trigId ? { ...t, ...patch } : t)
      onChange(tab.id, { triggers: next })
    }

    const runDdlChanges = async () => {
      if (!ddlPreviewSql) return
      const connId = tab.connectionId ?? connections.find(c => c.status === 'connected')?.id
      if (!connId || !tab.databaseName) return

      setDesignSaving(true)
      setDesignError(null)

      const statements = splitSqlStatements(ddlPreviewSql)
      let ok = true
      let errMsg = ''

      for (const stmt of statements) {
        if (!stmt.trim()) continue
        const res = await dbIpc(connId).query(connId, stmt, tab.databaseName)
        if (!res.ok) {
          ok = false
          errMsg = res.error || 'Failed to execute schema changes.'
          break
        }
      }

      if (ok) {
        setDdlPreviewSql(null)
        setDesignSaving(false)
        onChange(tab.id, { columns: undefined }) // triggers metadata reload useEffect
        onRefreshDb(connId, tab.databaseName) // refreshes ConnectionsPanel Tables list tree
      } else {
        setDesignSaving(false)
        setDesignError(errMsg)
      }
    }

    if (tab.columns === undefined && tab.running) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-3 bg-muted/10">
          <Loader2 className="h-8 w-8 text-primary animate-spin" />
          <span className="text-xs text-muted-foreground font-medium">Introspecting table schema...</span>
        </div>
      )
    }

    return (
      <div className="flex flex-col h-full bg-background select-none relative">
        {/* Designer Header */}
        <div className="flex items-center justify-between px-4 h-12 border-b border-border bg-muted/20 shrink-0">
          <div className="flex items-center gap-2">
            <Wrench className="h-4 w-4 text-primary shrink-0" />
            <span className="text-xs font-semibold text-foreground font-mono">
              {tab.schemaName}.{tab.tableName}
            </span>
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold border border-border px-1.5 py-0.5 rounded bg-muted/40 font-sans">
              Table Designer
            </span>
          </div>

          <div className="flex items-center gap-2">
            {tab.connectionId && tab.databaseName && tab.schemaName && tab.tableName && (
              <TableActionsBar
                target={{
                  dbType: getTabDbType(tab, connections) === 'mysql' ? 'mysql' : 'postgres',
                  connectionId: tab.connectionId, database: tab.databaseName, schema: tab.schemaName, table: tab.tableName,
                }}
                onOpenData={() => onOpenTable(tab.connectionId!, tab.databaseName!, tab.schemaName!, tab.tableName!)}
                onChanged={change => onTableChanged(tab.connectionId!, tab.databaseName!, tab.schemaName!, tab.tableName!, change)}
              />
            )}
            <button
              onClick={handleSave}
              disabled={!isChanged || tab.running}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-all shadow-sm border border-transparent',
                isChanged
                  ? 'bg-primary text-primary-foreground hover:bg-primary/95 hover:shadow'
                  : 'bg-muted/30 text-muted-foreground cursor-not-allowed border-border/40'
              )}
            >
              <Save className="h-3.5 w-3.5" />
              Save Structure
            </button>
          </div>
        </div>

        {/* Designer Sub Tabs */}
        <div className="flex items-center gap-1 px-4 h-10 border-b border-border bg-muted/10 shrink-0 overflow-x-auto">
          {[
            { id: 'fields', label: 'Fields', count: columns.length },
            { id: 'indexes', label: 'Indexes', count: indexes.filter(i => !i.isPrimary).length },
            { id: 'fkeys', label: 'Foreign Keys', count: foreignKeys.length },
            { id: 'uniques', label: 'Uniques', count: uniques.length },
            { id: 'triggers', label: 'Triggers', count: triggers.length },
          ].map(t => (
            <button
              key={t.id}
              onClick={() => onChange(tab.id, { designActiveTab: t.id as any })}
              className={cn(
                'flex items-center gap-1.5 px-3 h-8 text-xs font-medium rounded transition-all',
                activeSubTab === t.id
                  ? 'bg-background border border-border text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/20'
              )}
            >
              {t.label}
              <span className="text-[10px] bg-muted px-1.5 py-0.2 rounded-full text-muted-foreground font-mono ml-1">
                {t.count}
              </span>
            </button>
          ))}
        </div>

        {/* Tab Content Panels */}
        <div className="flex-1 overflow-y-auto p-4 min-h-0 bg-background">
          {activeSubTab === 'fields' && (
            <div className="flex flex-col gap-3 h-full">
              <div className="flex items-center justify-between shrink-0">
                <span className="text-xs font-medium text-muted-foreground">Manage table columns & types</span>
                <button
                  onClick={handleAddColumn}
                  className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium border border-border bg-card text-foreground hover:bg-accent/30 transition-colors"
                >
                  <Plus className="h-3 w-3 text-primary" />
                  Add Field
                </button>
              </div>

              <div className="border border-border rounded-lg bg-card overflow-hidden flex flex-col flex-1 min-h-0">
                <div className="overflow-x-auto overflow-y-auto flex-1">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-muted/40 border-b border-border text-muted-foreground font-medium">
                        <th className="p-2.5 w-14 text-center">PK</th>
                        <th className="p-2.5 w-52">Name</th>
                        <th className="p-2.5 w-48">Type</th>
                        <th className="p-2.5 w-24">Length</th>
                        <th className="p-2.5 w-24">Decimal</th>
                        <th className="p-2.5 w-16 text-center">Null</th>
                        <th className="p-2.5 w-52">Default Value</th>
                        <th className="p-2.5 w-16 text-center">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {columns.map(col => (
                        <tr key={col.id} className="border-b border-border/40 hover:bg-muted/20 transition-colors">
                          <td className="p-2 text-center">
                            <div className="flex items-center justify-center h-full">
                              <button
                                onClick={() => handleUpdateColumn(col.id, { isPrimaryKey: !col.isPrimaryKey })}
                                className={cn(
                                  "h-4 w-4 rounded flex items-center justify-center transition-all border shadow-sm",
                                  col.isPrimaryKey
                                    ? "bg-primary border-primary text-primary-foreground"
                                    : "border-border/85 bg-background hover:border-border"
                                )}
                              >
                                {col.isPrimaryKey && <Check className="h-3 w-3 stroke-[3.5]" />}
                              </button>
                            </div>
                          </td>
                          <td className="p-2">
                            <input
                              type="text"
                              value={col.name}
                              onChange={e => handleUpdateColumn(col.id, { name: e.target.value })}
                              placeholder="column_name"
                              className="w-full bg-background border border-border/80 hover:border-border focus:border-primary focus:ring-1 focus:ring-primary rounded px-2 py-1 text-xs font-mono transition-all shadow-sm"
                            />
                          </td>
                          <td className="p-2">
                            <select
                              value={col.type}
                              onChange={e => handleUpdateColumn(col.id, { type: e.target.value })}
                              className="w-full bg-background border border-border/80 hover:border-border focus:border-primary focus:ring-1 focus:ring-primary rounded px-2 py-1 text-xs font-mono text-foreground transition-all shadow-sm"
                            >
                              {POSTGRES_TYPES.map(t => (
                                <option key={t} value={t}>{t}</option>
                              ))}
                              {!POSTGRES_TYPES.includes(col.type) && (
                                <option value={col.type}>{col.type}</option>
                              )}
                            </select>
                          </td>
                          <td className="p-2">
                            <input
                              type="text"
                              value={col.length}
                              onChange={e => handleUpdateColumn(col.id, { length: e.target.value })}
                              placeholder="length"
                              className="w-full bg-background border border-border/80 hover:border-border focus:border-primary focus:ring-1 focus:ring-primary rounded px-2 py-1 text-xs font-mono text-center transition-all shadow-sm"
                            />
                          </td>
                          <td className="p-2">
                            <input
                              type="text"
                              value={col.decimal}
                              onChange={e => handleUpdateColumn(col.id, { decimal: e.target.value })}
                              placeholder="decimal"
                              disabled={!['numeric', 'decimal'].includes(col.type.toLowerCase())}
                              className="w-full bg-background border border-border/80 hover:border-border focus:border-primary focus:ring-1 focus:ring-primary rounded px-2 py-1 text-xs font-mono text-center disabled:opacity-30 transition-all shadow-sm"
                            />
                          </td>
                          <td className="p-2 text-center">
                            <div className="flex items-center justify-center h-full">
                              <button
                                onClick={() => handleUpdateColumn(col.id, { nullable: !col.nullable })}
                                className={cn(
                                  "h-4 w-4 rounded flex items-center justify-center transition-all border shadow-sm",
                                  col.nullable
                                    ? "bg-primary border-primary text-primary-foreground"
                                    : "border-border/85 bg-background hover:border-border"
                                )}
                              >
                                {col.nullable && <Check className="h-3 w-3 stroke-[3.5]" />}
                              </button>
                            </div>
                          </td>
                          <td className="p-2">
                            <input
                              type="text"
                              value={col.defaultValue}
                              onChange={e => handleUpdateColumn(col.id, { defaultValue: e.target.value })}
                              placeholder="NULL or 'value'"
                              className="w-full bg-background border border-border/80 hover:border-border focus:border-primary focus:ring-1 focus:ring-primary rounded px-2 py-1 text-xs font-mono transition-all shadow-sm"
                            />
                          </td>
                          <td className="p-2 text-center">
                            <button
                              onClick={() => handleDeleteColumn(col.id)}
                              className="p-1 text-muted-foreground hover:text-destructive rounded transition-colors"
                              title="Delete column"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                      {columns.length === 0 && (
                        <tr>
                          <td colSpan={8} className="p-8 text-center text-muted-foreground">
                            No columns defined. Click &quot;Add Field&quot; to add columns to this table.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {activeSubTab === 'indexes' && (
            <div className="flex flex-col gap-3 h-full">
              <div className="flex items-center justify-between shrink-0">
                <span className="text-xs font-medium text-muted-foreground">Speed up table queries with indexes</span>
                <button
                  onClick={handleAddIndex}
                  className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium border border-border bg-card text-foreground hover:bg-accent/30 transition-colors"
                >
                  <Plus className="h-3 w-3 text-primary" />
                  Add Index
                </button>
              </div>

              <div className="border border-border rounded-lg bg-card overflow-hidden flex flex-col flex-1 min-h-0">
                <div className="overflow-x-auto overflow-y-auto flex-1">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-muted/40 border-b border-border text-muted-foreground font-medium">
                        <th className="p-2.5 w-64">Index Name</th>
                        <th className="p-2.5 w-64">Indexed Columns</th>
                        <th className="p-2.5 w-28 text-center">Unique</th>
                        <th className="p-2.5 text-center w-16">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {indexes.filter(idx => !idx.isPrimary).map(idx => (
                        <tr key={idx.id} className="border-b border-border/40 hover:bg-muted/20 transition-colors">
                          <td className="p-2">
                            <input
                              type="text"
                              value={idx.name}
                              onChange={e => handleUpdateIndex(idx.id, { name: e.target.value })}
                              className="w-full bg-background border border-border/80 hover:border-border focus:border-primary focus:ring-1 focus:ring-primary rounded px-2 py-1 text-xs font-mono transition-all shadow-sm"
                            />
                          </td>
                          <td className="p-2">
                            <select
                              multiple
                              value={idx.columns}
                              onChange={e => {
                                const selected = Array.from(e.target.selectedOptions, option => option.value)
                                handleUpdateIndex(idx.id, { columns: selected })
                              }}
                              className="w-full bg-background border border-border/80 hover:border-border focus:border-primary focus:ring-1 focus:ring-primary rounded px-2 py-1 text-xs font-mono text-foreground h-20 transition-all shadow-sm"
                            >
                              {columns.map(c => (
                                <option key={c.id} value={c.name}>{c.name}</option>
                              ))}
                            </select>
                            <span className="text-[10px] text-muted-foreground mt-1 block">Hold Ctrl to select multiple columns</span>
                          </td>
                          <td className="p-2 text-center">
                            <div className="flex items-center justify-center h-full">
                              <button
                                onClick={() => handleUpdateIndex(idx.id, { isUnique: !idx.isUnique })}
                                className={cn(
                                  "h-4 w-4 rounded flex items-center justify-center transition-all border shadow-sm",
                                  idx.isUnique
                                    ? "bg-primary border-primary text-primary-foreground"
                                    : "border-border/85 bg-background hover:border-border"
                                )}
                              >
                                {idx.isUnique && <Check className="h-3 w-3 stroke-[3.5]" />}
                              </button>
                            </div>
                          </td>
                          <td className="p-2 text-center">
                            <button
                              onClick={() => handleDeleteIndex(idx.id)}
                              className="p-1 text-muted-foreground hover:text-destructive rounded transition-colors"
                              title="Delete index"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                      {indexes.filter(i => !i.isPrimary).length === 0 && (
                        <tr>
                          <td colSpan={4} className="p-8 text-center text-muted-foreground">
                            No indexes defined. Click &quot;Add Index&quot; to speed up your queries.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {activeSubTab === 'fkeys' && (
            <div className="flex flex-col gap-3 h-full">
              <div className="flex items-center justify-between shrink-0">
                <span className="text-xs font-medium text-muted-foreground">Define relational foreign key constraints</span>
                <button
                  onClick={handleAddForeignKey}
                  className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium border border-border bg-card text-foreground hover:bg-accent/30 transition-colors"
                >
                  <Plus className="h-3 w-3 text-primary" />
                  Add FK
                </button>
              </div>

              <div className="border border-border rounded-lg bg-card overflow-hidden flex flex-col flex-1 min-h-0">
                <div className="overflow-x-auto overflow-y-auto flex-1">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-muted/40 border-b border-border text-muted-foreground font-medium">
                        <th className="p-2.5 w-48">Constraint Name</th>
                        <th className="p-2.5 w-32">Local Column</th>
                        <th className="p-2.5 w-32">Foreign Schema</th>
                        <th className="p-2.5 w-32">Foreign Table</th>
                        <th className="p-2.5 w-32">Foreign Column</th>
                        <th className="p-2.5 w-28">On Update</th>
                        <th className="p-2.5 w-28">On Delete</th>
                        <th className="p-2.5 text-center w-16">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {foreignKeys.map(fk => (
                        <tr key={fk.id} className="border-b border-border/40 hover:bg-muted/20 transition-colors">
                          <td className="p-2">
                            <input
                              type="text"
                              value={fk.constraintName}
                              onChange={e => handleUpdateForeignKey(fk.id, { constraintName: e.target.value })}
                              className="w-full bg-background border border-border/80 hover:border-border focus:border-primary focus:ring-1 focus:ring-primary rounded px-2 py-1 text-xs font-mono transition-all shadow-sm"
                            />
                          </td>
                          <td className="p-2">
                            <select
                              value={fk.columnName}
                              onChange={e => handleUpdateForeignKey(fk.id, { columnName: e.target.value })}
                              className="w-full bg-background border border-border/80 hover:border-border focus:border-primary focus:ring-1 focus:ring-primary rounded px-2 py-1 text-xs font-mono text-foreground transition-all shadow-sm"
                            >
                              {columns.map(c => (
                                <option key={c.id} value={c.name}>{c.name}</option>
                              ))}
                            </select>
                          </td>
                          <td className="p-2">
                            <input
                              type="text"
                              value={fk.foreignTableSchema}
                              onChange={e => handleUpdateForeignKey(fk.id, { foreignTableSchema: e.target.value })}
                              className="w-full bg-background border border-border/80 hover:border-border focus:border-primary focus:ring-1 focus:ring-primary rounded px-2 py-1 text-xs font-mono transition-all shadow-sm"
                            />
                          </td>
                          <td className="p-2">
                            <input
                              type="text"
                              value={fk.foreignTableName}
                              onChange={e => handleUpdateForeignKey(fk.id, { foreignTableName: e.target.value })}
                              placeholder="foreign_table"
                              className="w-full bg-background border border-border/80 hover:border-border focus:border-primary focus:ring-1 focus:ring-primary rounded px-2 py-1 text-xs font-mono transition-all shadow-sm"
                            />
                          </td>
                          <td className="p-2">
                            <input
                              type="text"
                              value={fk.foreignColumnName}
                              onChange={e => handleUpdateForeignKey(fk.id, { foreignColumnName: e.target.value })}
                              placeholder="id"
                              className="w-full bg-background border border-border/80 hover:border-border focus:border-primary focus:ring-1 focus:ring-primary rounded px-2 py-1 text-xs font-mono transition-all shadow-sm"
                            />
                          </td>
                          <td className="p-2">
                            <select
                              value={fk.updateRule}
                              onChange={e => handleUpdateForeignKey(fk.id, { updateRule: e.target.value })}
                              className="w-full bg-background border border-border/80 hover:border-border focus:border-primary focus:ring-1 focus:ring-primary rounded px-2 py-1 text-xs font-semibold text-foreground transition-all shadow-sm"
                            >
                              {['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'].map(r => (
                                <option key={r} value={r}>{r}</option>
                              ))}
                            </select>
                          </td>
                          <td className="p-2">
                            <select
                              value={fk.deleteRule}
                              onChange={e => handleUpdateForeignKey(fk.id, { deleteRule: e.target.value })}
                              className="w-full bg-background border border-border/80 hover:border-border focus:border-primary focus:ring-1 focus:ring-primary rounded px-2 py-1 text-xs font-semibold text-foreground transition-all shadow-sm"
                            >
                              {['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'].map(r => (
                                <option key={r} value={r}>{r}</option>
                              ))}
                            </select>
                          </td>
                          <td className="p-2 text-center">
                            <button
                              onClick={() => handleDeleteForeignKey(fk.id)}
                              className="p-1 text-muted-foreground hover:text-destructive rounded transition-colors"
                              title="Delete foreign key"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                      {foreignKeys.length === 0 && (
                        <tr>
                          <td colSpan={8} className="p-8 text-center text-muted-foreground">
                            No foreign keys defined. Click &quot;Add FK&quot; to link relational tables.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {activeSubTab === 'uniques' && (
            <div className="flex flex-col gap-3 h-full">
              <div className="flex items-center justify-between shrink-0">
                <span className="text-xs font-medium text-muted-foreground">Add unique constraints to column values</span>
                <button
                  onClick={handleAddUnique}
                  className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium border border-border bg-card text-foreground hover:bg-accent/30 transition-colors"
                >
                  <Plus className="h-3 w-3 text-primary" />
                  Add Unique
                </button>
              </div>

              <div className="border border-border rounded-lg bg-card overflow-hidden flex flex-col flex-1 min-h-0">
                <div className="overflow-x-auto overflow-y-auto flex-1">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-muted/40 border-b border-border text-muted-foreground font-medium">
                        <th className="p-2.5 w-64">Constraint Name</th>
                        <th className="p-2.5 w-64">Unique Column</th>
                        <th className="p-2.5 text-center w-16">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {uniques.map(uq => (
                        <tr key={uq.id} className="border-b border-border/40 hover:bg-muted/20 transition-colors">
                          <td className="p-2">
                            <input
                              type="text"
                              value={uq.constraintName}
                              onChange={e => handleUpdateUnique(uq.id, { constraintName: e.target.value })}
                              className="w-full bg-background border border-border/80 hover:border-border focus:border-primary focus:ring-1 focus:ring-primary rounded px-2 py-1 text-xs font-mono transition-all shadow-sm"
                            />
                          </td>
                          <td className="p-2">
                            <select
                              value={uq.columnName}
                              onChange={e => handleUpdateUnique(uq.id, { columnName: e.target.value })}
                              className="w-full bg-background border border-border/80 hover:border-border focus:border-primary focus:ring-1 focus:ring-primary rounded px-2 py-1 text-xs font-mono text-foreground transition-all shadow-sm"
                            >
                              {columns.map(c => (
                                <option key={c.id} value={c.name}>{c.name}</option>
                              ))}
                            </select>
                          </td>
                          <td className="p-2 text-center">
                            <button
                              onClick={() => handleDeleteUnique(uq.id)}
                              className="p-1 text-muted-foreground hover:text-destructive rounded transition-colors"
                              title="Delete unique constraint"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                      {uniques.length === 0 && (
                        <tr>
                          <td colSpan={3} className="p-8 text-center text-muted-foreground">
                            No unique constraints defined. Click &quot;Add Unique&quot; to prevent duplicate row values.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {activeSubTab === 'triggers' && (
            <div className="flex flex-col gap-3 h-full">
              <div className="flex items-center justify-between shrink-0">
                <span className="text-xs font-medium text-muted-foreground">Automate events with schema triggers</span>
                <button
                  onClick={handleAddTrigger}
                  className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium border border-border bg-card text-foreground hover:bg-accent/30 transition-colors"
                >
                  <Plus className="h-3 w-3 text-primary" />
                  Add Trigger
                </button>
              </div>

              <div className="border border-border rounded-lg bg-card overflow-hidden flex flex-col flex-1 min-h-0">
                <div className="overflow-x-auto overflow-y-auto flex-1">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-muted/40 border-b border-border text-muted-foreground font-medium">
                        <th className="p-2.5 w-48">Trigger Name</th>
                        <th className="p-2.5 w-28">Timing</th>
                        <th className="p-2.5 w-28">Event</th>
                        <th className="p-2.5 w-28">Orientation</th>
                        <th className="p-2.5 w-64">Action statement</th>
                        <th className="p-2.5 text-center w-16">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {triggers.map(trig => (
                        <tr key={trig.id} className="border-b border-border/40 hover:bg-muted/20 transition-colors">
                          <td className="p-2">
                            <input
                              type="text"
                              value={trig.triggerName}
                              onChange={e => handleUpdateTrigger(trig.id, { triggerName: e.target.value })}
                              className="w-full bg-background border border-border/80 hover:border-border focus:border-primary focus:ring-1 focus:ring-primary rounded px-2 py-1 text-xs font-mono transition-all shadow-sm"
                            />
                          </td>
                          <td className="p-2">
                            <select
                              value={trig.actionTiming}
                              onChange={e => handleUpdateTrigger(trig.id, { actionTiming: e.target.value })}
                              className="w-full bg-background border border-border/80 hover:border-border focus:border-primary focus:ring-1 focus:ring-primary rounded px-2 py-1 text-xs text-foreground font-semibold transition-all shadow-sm"
                            >
                              {['BEFORE', 'AFTER', 'INSTEAD OF'].map(t => (
                                <option key={t} value={t}>{t}</option>
                              ))}
                            </select>
                          </td>
                          <td className="p-2">
                            <select
                              value={trig.eventManipulation}
                              onChange={e => handleUpdateTrigger(trig.id, { eventManipulation: e.target.value })}
                              className="w-full bg-background border border-border/80 hover:border-border focus:border-primary focus:ring-1 focus:ring-primary rounded px-2 py-1 text-xs text-foreground font-semibold transition-all shadow-sm"
                            >
                              {['INSERT', 'UPDATE', 'DELETE'].map(e => (
                                <option key={e} value={e}>{e}</option>
                              ))}
                            </select>
                          </td>
                          <td className="p-2">
                            <select
                              value={trig.actionOrientation}
                              onChange={e => handleUpdateTrigger(trig.id, { actionOrientation: e.target.value })}
                              className="w-full bg-background border border-border/80 hover:border-border focus:border-primary focus:ring-1 focus:ring-primary rounded px-2 py-1 text-xs text-foreground font-semibold transition-all shadow-sm"
                            >
                              {['ROW', 'STATEMENT'].map(o => (
                                <option key={o} value={o}>{o}</option>
                              ))}
                            </select>
                          </td>
                          <td className="p-2">
                            <input
                              type="text"
                              value={trig.actionStatement}
                              onChange={e => handleUpdateTrigger(trig.id, { actionStatement: e.target.value })}
                              placeholder="EXECUTE FUNCTION my_func()"
                              className="w-full bg-background border border-border/80 hover:border-border focus:border-primary focus:ring-1 focus:ring-primary rounded px-2 py-1 text-xs font-mono transition-all shadow-sm"
                            />
                          </td>
                          <td className="p-2 text-center">
                            <button
                              onClick={() => handleDeleteTrigger(trig.id)}
                              className="p-1 text-muted-foreground hover:text-destructive rounded transition-colors"
                              title="Delete trigger"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                      {triggers.length === 0 && (
                        <tr>
                          <td colSpan={6} className="p-8 text-center text-muted-foreground">
                            No triggers defined. Click &quot;Add Trigger&quot; to automate action triggers.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Backdrop Blurred DDL SQL Review Modal */}
        {ddlPreviewSql && (
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-6">
            <div className="w-[600px] max-w-full bg-card border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh] animate-in fade-in zoom-in-95 duration-150">
              <div className="flex items-center justify-between px-4 h-12 border-b border-border bg-muted/40 shrink-0">
                <span className="text-xs font-semibold text-foreground uppercase tracking-wider">Review Schema Alterations (DDL)</span>
                <button
                  onClick={() => { setDdlPreviewSql(null); setDesignError(null) }}
                  disabled={designSaving}
                  className="p-1 hover:bg-accent/40 rounded transition-colors text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="p-4 flex-1 overflow-y-auto min-h-0 flex flex-col gap-3">
                <span className="text-[11px] text-muted-foreground leading-normal">
                  The following DDL statements will be executed sequentially on database <strong className="font-mono text-foreground">{tab.databaseName}</strong> to update table <strong className="font-mono text-foreground">{tab.schemaName}.{tab.tableName}</strong>.
                </span>

                <pre className="flex-1 min-h-[120px] bg-black/45 border border-border rounded-lg p-3 font-mono text-[11px] text-green-300 overflow-y-auto whitespace-pre-wrap leading-relaxed select-text">
                  {ddlPreviewSql}
                </pre>

                {designError && (
                  <div className="flex items-start gap-2 p-3 rounded-lg border border-red-500/30 bg-red-950/60 text-xs text-red-300 leading-normal">
                    <X className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span><strong>Execution Error:</strong> {designError}</span>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-2 px-4 h-14 border-t border-border bg-muted/40 shrink-0">
                <button
                  onClick={() => { setDdlPreviewSql(null); setDesignError(null) }}
                  disabled={designSaving}
                  className="px-3 h-8 text-xs font-medium border border-border text-foreground hover:bg-accent/30 rounded transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={runDdlChanges}
                  disabled={designSaving}
                  className="flex items-center gap-1.5 px-4 h-8 bg-primary hover:bg-primary/95 text-primary-foreground text-xs font-medium rounded shadow transition-all"
                >
                  {designSaving && <Loader2 className="h-3 w-3 animate-spin" />}
                  Execute Changes
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 h-8 border-b border-border bg-card shrink-0">
        <button
          onClick={run}
          disabled={!canRun}
          className="flex items-center gap-1.5 px-2.5 h-5 rounded bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {tab.running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
          Run
        </button>
        <button
          onClick={handleSave}
          disabled={!canSave}
          className={cn(
            "flex items-center gap-1.5 px-2.5 h-5 rounded border text-xs font-medium transition-colors",
            tab.isFunction
              ? isFunctionChanged
                ? "border-primary text-primary hover:bg-primary/10"
                : "border-border text-muted-foreground/60 cursor-default"
              : "border-border text-muted-foreground hover:text-foreground hover:bg-accent/20 disabled:opacity-40"
          )}
        >
          <Save className="h-3 w-3" />
          {tab.isFunction
            ? (isFunctionChanged ? 'Save' : 'Saved')
            : createdRoutine ? `Save ${createdRoutine.kind === 'procedure' ? 'Procedure' : 'Function'}` : (isSaved ? 'Saved' : 'Save')}
        </button>
        {!tab.isFunction && (
          <>
            <button
              onClick={explainQuery}
              disabled={tab.running || !tab.sql.trim()}
              title={boundConn?.dbType === 'mongodb' ? 'Explain the current query (executionStats)' : 'Run EXPLAIN ANALYZE on the current query'}
              className="flex items-center gap-1 px-2 h-5 rounded border border-border text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent/20 transition-colors disabled:opacity-40"
            >
              <Sparkles className="h-3 w-3 text-amber-400" />
              Explain
            </button>
            {boundConn?.dbType !== 'mongodb' && (
              <button
                onClick={beautifyQuery}
                disabled={!tab.sql.trim()}
                title="Format and beautify the SQL query"
                className="flex items-center gap-1 px-2 h-5 rounded border border-border text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent/20 transition-colors disabled:opacity-40"
              >
                <Braces className="h-3 w-3 text-violet-400" />
                Beautify
              </button>
            )}
          </>
        )}
        <div className="flex items-center rounded border border-border overflow-hidden">
          <button
            onClick={() => setSqlAlign('left')}
            title="Align SQL left (normal)"
            className={cn('px-1.5 h-5 transition-colors', sqlAlign === 'left' ? 'bg-primary/20 text-primary' : 'text-muted-foreground/60 hover:text-foreground hover:bg-accent/20')}
          >
            <AlignLeft className="h-3 w-3" />
          </button>
          <button
            onClick={() => setSqlAlign('center')}
            title="Align SQL center (chaotic)"
            className={cn('px-1.5 h-5 border-x border-border transition-colors', sqlAlign === 'center' ? 'bg-primary/20 text-primary' : 'text-muted-foreground/60 hover:text-foreground hover:bg-accent/20')}
          >
            <AlignCenter className="h-3 w-3" />
          </button>
          <button
            onClick={() => setSqlAlign('right')}
            title="Align SQL right (unhinged)"
            className={cn('px-1.5 h-5 transition-colors', sqlAlign === 'right' ? 'bg-primary/20 text-primary' : 'text-muted-foreground/60 hover:text-foreground hover:bg-accent/20')}
          >
            <AlignRight className="h-3 w-3" />
          </button>
        </div>
        <span className="text-xs text-muted-foreground">Ctrl+R to run · Ctrl+S to save</span>
        <button
          onClick={() => setShowHistory(prev => !prev)}
          title="Toggle query history"
          className={cn(
            'flex items-center gap-1 px-2 h-5 rounded border text-xs font-medium transition-colors',
            showHistory
              ? 'border-primary/50 text-primary bg-primary/10'
              : 'border-border text-muted-foreground hover:text-foreground hover:bg-accent/20'
          )}
        >
          <Clock className="h-3 w-3" />
          History{queryHistory.length > 0 ? ` (${queryHistory.length})` : ''}
        </button>

        <div className="flex-1" />

        {connectedConns.length === 0 ? (
          <span className="text-xs text-muted-foreground/50">No active connection</span>
        ) : (
          <div className="flex items-center gap-1.5">
            <Plug className={cn("h-3 w-3 shrink-0", tab.connectionId ? "text-green-400" : "text-muted-foreground/50")} />
            <select
              value={tab.connectionId ?? ''}
              onChange={e => onChange(tab.id, { connectionId: e.target.value || null, databaseName: null, schemaName: undefined, dbType: connections.find(c => c.id === e.target.value)?.dbType })}
              className="text-xs bg-background border border-border rounded px-1.5 h-5 text-muted-foreground outline-none"
            >
              <option value="">Connection…</option>
              {connectedConns.map(c => (
                <option key={c.id} value={c.id}>{c.label || c.name}</option>
              ))}
            </select>
            {boundConn && (
              <>
                <Database className="h-3 w-3 text-blue-300 shrink-0 ml-1" />
                <select
                  value={tab.databaseName ?? ''}
                  onChange={e => onChange(tab.id, { databaseName: e.target.value || null, schemaName: undefined })}
                  className="text-xs bg-background border border-border rounded px-1.5 h-5 text-muted-foreground outline-none"
                >
                  <option value="">Database…</option>
                  {availableDbs.map(db => (
                    <option key={db.name} value={db.name}>{db.name}</option>
                  ))}
                </select>
              </>
            )}
            {boundDb && availableSchemas.length > 0 && (
              <>
                <span className="text-[10px] font-bold w-3 text-center shrink-0 text-amber-300 ml-1 select-none">S</span>
                <select
                  value={tab.schemaName ?? ''}
                  onChange={e => onChange(tab.id, { schemaName: e.target.value || undefined })}
                  className="text-xs bg-background border border-border rounded px-1.5 h-5 text-muted-foreground outline-none"
                >
                  <option value="">Schema…</option>
                  {availableSchemas.map(s => (
                    <option key={s.name} value={s.name}>{s.name}</option>
                  ))}
                </select>
              </>
            )}
          </div>
        )}
      </div>

      {showHistory && queryHistory.length > 0 && (
        <div className="border-b border-border bg-card max-h-40 overflow-y-auto shrink-0">
          <div className="flex items-center justify-between px-3 h-6 border-b border-border/50 bg-muted/20 shrink-0">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Recent Queries</span>
            <button
              onClick={() => setQueryHistory([])}
              className="text-[10px] text-muted-foreground/50 hover:text-foreground transition-colors"
            >Clear</button>
          </div>
          {queryHistory.map((h, i) => (
            <button
              key={i}
              onClick={() => onChange(tab.id, { sql: h.sql })}
              title={h.sql}
              className="w-full text-left flex items-center gap-2 px-3 py-1 hover:bg-accent/10 transition-colors border-b border-border/30 last:border-b-0 group"
            >
              <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', h.error ? 'bg-destructive' : 'bg-green-400')} />
              <span className="text-[11px] font-mono text-foreground truncate flex-1">{h.sql.slice(0, 120)}{h.sql.length > 120 ? '…' : ''}</span>
              <span className="text-[10px] text-muted-foreground/50 shrink-0 tabular-nums">{h.ms}ms</span>
              <span className="text-[10px] text-muted-foreground/40 shrink-0">
                {new Date(h.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            </button>
          ))}
        </div>
      )}

      {isQueryChanged && (
        <div className="flex items-center justify-between px-3 h-8 border-b border-amber-500/30 bg-amber-500/10 shrink-0">
          <span className="text-xs text-amber-400 font-medium">Unsaved changes</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onChange(tab.id, { sql: tab.originalSql ?? '' })}
              className="px-2.5 h-5 rounded border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-accent/20 transition-colors"
            >
              Discard
            </button>
            <button
              onClick={handleSave}
              disabled={!canSave}
              className="flex items-center gap-1.5 px-2.5 h-5 rounded bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              <Save className="h-3 w-3" />
              {createdRoutine ? `Save ${createdRoutine.kind === 'procedure' ? 'Procedure' : 'Function'}` : 'Save'}
            </button>
          </div>
        </div>
      )}

      <ResizablePanelGroup direction="vertical" className="flex-1">
        <ResizablePanel defaultSize={50} minSize={20}>
          <div className="flex flex-col h-full" style={{ textAlign: sqlAlign }}>
            {showFind && <SqlSearchBar editorRef={editorRef} onClose={() => setShowFind(false)} />}
            <SqlEditor
              value={tab.sql}
              onChange={v => onChange(tab.id, { sql: v })}
              onRun={run}
              onOpenFind={() => setShowFind(true)}
              onNavigate={handleEditorNavigate}
              editorRef={editorRef}
              schema={sqlNamespace}
              defaultSchema={editorDefaultSchema}
              dialect={editorDialect}
              functions={editorFunctions}
              collections={mongoCollections}
            />
          </div>
        </ResizablePanel>
        <ResizableHandle className="h-px bg-border" />
        <ResizablePanel defaultSize={50} minSize={20}>
          <div className="flex flex-col h-full">
            {tab.safeRun && (
              <div className="flex items-start gap-3 px-3 py-2 border-b border-amber-500/40 bg-amber-500/10 shrink-0">
                <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0 space-y-0.5">
                  <div className="text-xs font-semibold text-amber-300">Safe Run: nothing is saved yet</div>
                  <div className="text-[11px] text-muted-foreground">
                    {tab.safeRun.changes.map((c, i) => (
                      <span key={i} className="mr-3 font-mono">
                        {c.verb}{c.table ? ` ${c.table}` : ''}{c.rows !== null ? `: ${c.rows.toLocaleString()} row${c.rows === 1 ? '' : 's'}` : ''}
                      </span>
                    ))}
                  </div>
                  <div className="text-[10px] text-muted-foreground/70">
                    The changed rows are in the results below (up to {PREVIEW_ROWS} per statement). Rows are locked until you decide; an idle transaction rolls back after 15 minutes.
                  </div>
                </div>
                <button onClick={() => void finishSafeRun(false)}
                  className="px-2.5 h-6 rounded border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-accent/20 shrink-0">Roll back</button>
                <button onClick={() => void finishSafeRun(true)}
                  className="px-2.5 h-6 rounded bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 shrink-0">Commit</button>
              </div>
            )}
            <ResultsGrid
              results={tab.results}
              running={tab.running}
              statusBorder="top"
              dbType={getTabDbType(tab, connections)}
              focusCell={tab.focusCell}
            />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>

      {fnRunDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setFnRunDialog(null)}
        >
          <div
            className="bg-card border border-border rounded-lg shadow-2xl w-[400px] overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150 text-card-foreground"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-muted/20">
              <div className="flex flex-col text-left">
                <span className="text-sm font-semibold text-foreground">Execute Function</span>
                <span className="text-xs text-muted-foreground mt-0.5 font-mono truncate max-w-[320px]">
                  {fnRunDialog.schemaName}.{fnRunDialog.functionName}()
                </span>
              </div>
              <button
                onClick={() => setFnRunDialog(null)}
                className="text-muted-foreground hover:text-foreground transition-colors p-1 hover:bg-accent/40 rounded"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            
            <div className="p-5 space-y-4 max-h-[300px] overflow-y-auto">
              {fnRunDialog.args.map(arg => (
                <div key={arg.name} className="space-y-1.5 text-left">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-foreground">{arg.name}</label>
                    <span className="text-[10px] font-mono text-purple-300 bg-purple-500/10 px-1.5 py-0.5 rounded">
                      {arg.type}
                    </span>
                  </div>
                  <input
                    type="text"
                    value={paramValues[arg.name] ?? ''}
                    onChange={e => setParamValues(prev => ({ ...prev, [arg.name]: e.target.value }))}
                    placeholder={arg.defaultValue ? `Default: ${arg.defaultValue}` : `Enter ${arg.type} value...`}
                    className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-all font-mono"
                    autoFocus={fnRunDialog.args[0].name === arg.name}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        executeFunction()
                      } else if (e.key === 'Escape') {
                        setFnRunDialog(null)
                      }
                    }}
                  />
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-2 px-5 py-3 border-t border-border bg-muted/10">
              <button
                onClick={() => setFnRunDialog(null)}
                className="px-3 py-1.5 text-xs rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={executeFunction}
                className="px-4 py-1.5 text-xs rounded bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors shadow-sm flex items-center gap-1.5"
              >
                <Play className="h-3 w-3" />
                Run Function
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

// ── Persistence ───────────────────────────────────────────────────────────────

const TABS_STORAGE_KEY = 'quence-db-tabs'
const TABS_META_KEY = 'quence-db-tabs-meta'

function loadSavedQueries(): SavedQuery[] { return [] }
async function loadSavedQueriesFromDb(): Promise<SavedQuery[]> {
  try {
    const rows = await window.electronAPI?.db.savedQueries.get()
    return (rows ?? []).map((r: any) => ({
      id: r.id,
      connectionId: r.connectionId || r.connection_id || '',
      databaseName: r.databaseName || r.database_name || '',
      title: r.name || r.title || '',
      sql: r.sql || '',
      schemaName: r.schemaName || r.schema_name || ''
    }))
  } catch { return [] }
}
async function persistSavedQueries(qs: SavedQuery[], prev: SavedQuery[]) {
  if (!window.electronAPI?.db) return
  const prevIds = new Set(prev.map(q => q.id))
  const nextIds = new Set(qs.map(q => q.id))
  // Delete removed
  for (const id of prevIds) {
    if (!nextIds.has(id)) await window.electronAPI.db.savedQueries.delete(id).catch(() => {})
  }
  // Create/update
  for (const q of qs) {
    if (!prevIds.has(q.id)) {
      await window.electronAPI.db.savedQueries.create({
        id: q.id,
        connectionId: q.connectionId,
        databaseName: q.databaseName,
        name: q.title,
        sql: q.sql,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }).catch(() => {})
    } else {
      const old = prev.find(p => p.id === q.id)
      if (old && (old.title !== q.title || old.sql !== q.sql)) {
        await window.electronAPI.db.savedQueries.update(q.id, {
          name: q.title,
          sql: q.sql,
          databaseName: q.databaseName
        }).catch(() => {})
      }
    }
  }
}

interface PersistedConnection {
  id: string
  dbType: 'postgres' | 'mysql' | 'mongodb' | 'sqlite' | 'redis'
  label: string
  name: string
  host: string
  port: number
  database: string
  user: string
  password: string
  ssl: boolean
  vpnConfigPath?: string
  vpnUsername?: string
  vpnPassword?: string
}

interface PersistedTab {
  id: string
  kind: 'query' | 'table' | 'design' | 'erd' | 'create-table' | 'create-view' | 'structure-sync' | 'data-sync' | 'redis-browser' | 'redis-console'
  title: string
  sql: string
  connectionId: string | null
  databaseName: string | null
  schemaName?: string
  tableName?: string
  isFunction?: boolean
  functionArguments?: string
  originalSql?: string

  // Results & Paging properties
  results?: QueryResult[]
  page?: number
  pageSize?: number
  totalRows?: number
  columnTypes?: ColumnInfo[]
  dbType?: 'postgres' | 'mysql' | 'mongodb' | 'sqlite' | 'redis'

  // Design properties
  designActiveTab?: 'fields' | 'indexes' | 'fkeys' | 'uniques' | 'triggers'
  originalColumns?: DesignColumn[]
  columns?: DesignColumn[]
  originalIndexes?: DesignIndex[]
  indexes?: DesignIndex[]
  originalForeignKeys?: DesignForeignKey[]
  foreignKeys?: DesignForeignKey[]
  originalUniques?: DesignUnique[]
  uniques?: DesignUnique[]
  originalTriggers?: DesignTrigger[]
  triggers?: DesignTrigger[]

  // ERD properties
  erdTables?: ErdTable[]
  erdRelations?: ErdRelation[]

  // Structure/data sync: only the source/target/options are kept; results are recomputed
  syncConfig?: StructureSyncConfig
  dataSyncConfig?: DataSyncConfig
}

interface PersistedTabsMeta {
  activeTabId: string
  tabCounter: number
  activeConnId: string | null
  activeDbPerConn: Record<string, string>
  activeSchemaPerDb: Record<string, string>  // "connId::dbName" -> schemaName
  openConns: string[]
  openGroups: string[]
  openDbs: Record<string, string[]>
}

async function loadPersistedConnectionsFromDb(): Promise<PersistedConnection[]> {
  try {
    const rows = await window.electronAPI?.db.connections.get()
    return (rows ?? []).map((r: any) => ({
      id: r.id, dbType: r.dbType === 'pg' ? 'postgres' : r.dbType as 'postgres' | 'mysql' | 'mongodb' | 'sqlite' | 'redis',
      label: r.name, name: r.dbType === 'sqlite' ? fileBaseName(r.host) : r.dbType === 'mongodb' ? (r.database ? `MongoDB / ${r.database}` : 'MongoDB') : `${r.host}:${r.port}/${r.database}`,
      host: r.host, port: r.port, database: r.database,
      user: r.username, password: r.password, ssl: r.ssl,
      vpnConfigPath: r.vpnConfigPath, vpnUsername: r.vpnUsername, vpnPassword: r.vpnPassword,
      options: parseConnectionOptions(r.options), sshPassword: r.sshPassword, sshPassphrase: r.sshPassphrase,
    }))
  } catch (err) {
    toast.error(`Could not load saved connections: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

function reportConnectionSaveError(err: unknown) {
  toast.error(`Could not save connection: ${err instanceof Error ? err.message : String(err)}`, { id: 'connection-save-error' })
}

async function savePersistedConnections(conns: DbConnection[], prev: DbConnection[]) {
  if (!window.electronAPI?.db) return
  const prevIds = new Set(prev.map(c => c.id))
  const nextIds = new Set(conns.map(c => c.id))
  // Delete removed
  for (const id of prevIds) {
    if (!nextIds.has(id)) await window.electronAPI.db.connections.delete(id).catch(reportConnectionSaveError)
  }
  // Create/update
  for (const c of conns) {
    const dbType = c.dbType === 'postgres' ? 'pg' : c.dbType
    if (!prevIds.has(c.id)) {
      await window.electronAPI.db.connections.create({
        id: c.id, name: c.label || c.name, dbType, host: c.host, port: c.port,
        database: c.database, username: c.user, password: c.password, ssl: c.ssl,
        vpnConfigPath: c.vpnConfigPath ?? null, vpnUsername: c.vpnUsername ?? null, vpnPassword: c.vpnPassword ?? null,
        options: c.options ?? {}, sshPassword: c.sshPassword ?? null, sshPassphrase: c.sshPassphrase ?? null,
        createdAt: Date.now(), updatedAt: Date.now(),
      }).catch(reportConnectionSaveError)
    } else {
      await window.electronAPI.db.connections.update(c.id, {
        name: c.label || c.name, dbType, host: c.host, port: c.port,
        database: c.database, username: c.user, password: c.password, ssl: c.ssl,
        vpnConfigPath: c.vpnConfigPath ?? null, vpnUsername: c.vpnUsername ?? null, vpnPassword: c.vpnPassword ?? null,
        options: c.options ?? {}, sshPassword: c.sshPassword ?? null, sshPassphrase: c.sshPassphrase ?? null,
      }).catch(reportConnectionSaveError)
    }
  }
}

// Exact names of what a PostgreSQL query in this database can refer to, as loaded in the sidebar
function pgKnownNames(conn: DbConnection | undefined, database: string | null | undefined): Set<string> {
  const names = new Set<string>()
  const db = conn?.databases.find(d => d.name === database)
  for (const s of db?.schemas ?? []) {
    names.add(s.name)
    for (const list of [s.tables, s.views, s.materializedViews, s.functions, s.enums, s.types]) for (const o of list) names.add(o.name)
    for (const cols of Object.values(s.columns)) for (const c of cols) names.add(c.name)
  }
  return names
}

// PostgreSQL reads unquoted names as lowercase; quotes the typed names that only exist with their
// capitals (see lib/pg-identifiers) and says so
function quotePgNames(sql: string, conn: DbConnection | undefined, database: string | null | undefined): string {
  if (conn?.dbType !== 'postgres') return sql
  const fix = quoteMixedCaseIdentifiers(sql, pgKnownNames(conn, database))
  if (fix.quoted.length === 0) return sql
  toast.info(`Quoted ${fix.quoted.map(n => `"${n}"`).join(', ')}`, {
    description: 'PostgreSQL reads unquoted names as lowercase, so names with capitals need quotes.',
  })
  return fix.sql
}

function getTabDbType(tab: QueryTab, connections: DbConnection[]): 'postgres' | 'mysql' | 'mongodb' | 'sqlite' | 'redis' {
  if (tab.dbType) return tab.dbType
  if (tab.connectionId) {
    const conn = connections.find(c => c.id === tab.connectionId)
    if (conn) return conn.dbType
  }
  if (tab.sql && tab.sql.trim().startsWith('db.')) return 'mongodb'
  return 'postgres'
}

function loadPersistedTabs(): { tabs: QueryTab[]; meta: PersistedTabsMeta } | null {
  try {
    const rawTabs = localStorage.getItem(TABS_STORAGE_KEY)
    const rawMeta = localStorage.getItem(TABS_META_KEY)
    if (!rawTabs || !rawMeta) return null
    const persisted: PersistedTab[] = JSON.parse(rawTabs)
    const meta: PersistedTabsMeta = JSON.parse(rawMeta)
    const tabs: QueryTab[] = persisted.map(t => ({
      ...t,
      results: t.results ?? [],
      running: false,
      originalSql: t.originalSql ?? t.sql,
      page: t.page ?? 0,
      pageSize: t.pageSize ?? TABLE_PAGE_SIZE,
      totalRows: t.totalRows,
      columnTypes: t.columnTypes,
      dbType: t.dbType,
      sync: t.kind === 'structure-sync' ? initialSyncState(t.syncConfig) : undefined,
      dataSync: t.kind === 'data-sync' ? initialDataSyncState(t.dataSyncConfig) : undefined,
    }))
    return { tabs, meta }
  } catch { return null }
}

function savePersistedTabs(
  tabs: QueryTab[], activeTabId: string, tabCounter: number,
  activeConnId: string | null, activeDbPerConn: Record<string, string>,
  activeSchemaPerDb: Record<string, string>,
  openConns: Set<string>, openGroups: Set<string>, openDbs: Record<string, string[]>,
) {
  try {
    const data: PersistedTab[] = tabs.map(t => ({
      id: t.id, kind: t.kind, title: t.title, sql: t.sql,
      connectionId: t.connectionId, databaseName: t.databaseName,
      schemaName: t.schemaName, tableName: t.tableName,
      isFunction: t.isFunction,
      functionArguments: t.functionArguments,
      originalSql: t.originalSql,

      // Results & Paging properties
      results: t.results,
      page: t.page,
      pageSize: t.pageSize,
      totalRows: t.totalRows,
      columnTypes: t.columnTypes,
      dbType: t.dbType,

      // Design properties
      designActiveTab: t.designActiveTab,
      originalColumns: t.originalColumns,
      columns: t.columns,
      originalIndexes: t.originalIndexes,
      indexes: t.indexes,
      originalForeignKeys: t.originalForeignKeys,
      foreignKeys: t.foreignKeys,
      originalUniques: t.originalUniques,
      uniques: t.uniques,
      originalTriggers: t.originalTriggers,
      triggers: t.triggers,

      // ERD properties
      erdTables: t.erdTables,
      erdRelations: t.erdRelations,

      syncConfig: t.sync?.config,
      dataSyncConfig: t.dataSync?.config,
    }))
    localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(data))
    const meta: PersistedTabsMeta = {
      activeTabId, tabCounter, activeConnId, activeDbPerConn, activeSchemaPerDb,
      openConns: [...openConns], openGroups: [...openGroups], openDbs,
    }
    localStorage.setItem(TABS_META_KEY, JSON.stringify(meta))
  } catch {}
}

// ── Root ──────────────────────────────────────────────────────────────────────

export function getNestedValue(obj: any, path: string): any {
  if (obj === null || obj === undefined) return undefined
  if (typeof obj === 'object' && path in obj) {
    return obj[path]
  }
  const parts = path.split('.')
  let current = obj
  for (const part of parts) {
    if (current === null || current === undefined) return undefined
    current = current[part]
  }
  return current
}

export function flattenObject(obj: any, prefix = ''): Record<string, any> {
  const result: Record<string, any> = {}
  if (obj === null || typeof obj !== 'object') return result

  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const value = obj[key]
      const newKey = prefix ? `${prefix}.${key}` : key

      if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        !(value instanceof Date) &&
        value.constructor?.name !== 'ObjectID' &&
        value.constructor?.name !== 'ObjectId' &&
        !value._bsontype
      ) {
        const flatChild = flattenObject(value, newKey)
        Object.assign(result, flatChild)
      } else {
        result[newKey] = value
      }
    }
  }
  return result
}

export function processMongoRows(rows: any[]) {
  const processedRows = rows.map(row => {
    const flat = flattenObject(row)
    return { ...row, ...flat }
  })

  const keys = new Set<string>()
  if (rows.length > 0) {
    Object.keys(rows[0]).forEach(k => keys.add(k))
  }
  for (const r of processedRows) {
    for (const k in r) {
      keys.add(k)
    }
  }

  return {
    rows: processedRows,
    fields: Array.from(keys)
  }
}

// Re-reads the given rows' documents by _id (keeping BSON types) and swaps them into the result, so an
// edit shows without reloading the page. Fields that are new are appended as columns; when there are
// none the column list keeps its identity, which keeps the grid's selection, sort and filter.
export async function refreshMongoDocuments(connId: string, database: string | undefined, collection: string, result: QueryResult, rowIndexes: number[]): Promise<QueryResult> {
  const types = result.types ?? []
  const idKey = (id: unknown) => JSON.stringify(id)
  const filters = [...new Set(rowIndexes)].flatMap(i => {
    const filter = mongoIdFilter(result.rows[i]?._id, types[i]?._id)
    return filter ? [filter] : []
  })
  if (filters.length === 0) return result
  const script = `db.getCollection(${JSON.stringify(collection)}).find({ $or: [${filters.join(', ')}] })`
  const res = await window.electronAPI!.mongodb.query(connId, script, database, undefined, { typed: true })
  if (!res.ok) throw new Error(res.error ?? 'Could not re-read the document')
  const fresh = processMongoRows(res.rows ?? [])
  const byId = new Map(fresh.rows.map((row, i) => [idKey(row._id), { row, types: res.types?.[i] }]))

  const wanted = new Set(rowIndexes)
  const rows = result.rows.map((row, i) => (wanted.has(i) ? byId.get(idKey(row._id))?.row ?? row : row))
  const nextTypes = result.types
    ? result.types.map((t, i) => (wanted.has(i) ? byId.get(idKey(result.rows[i]?._id))?.types ?? t : t))
    : undefined
  const known = new Set(result.fields)
  const added = fresh.fields.filter(f => !known.has(f))
  return { ...result, rows, types: nextTypes, fields: added.length > 0 ? [...result.fields, ...added] : result.fields }
}

// "The row with id = 5" / "The document with _id 64b…" for delete confirmations
function describeRowForDelete(tab: QueryTab, dbType: 'postgres' | 'mysql' | 'mongodb' | 'sqlite' | 'redis', rowIndex: number): string {
  const row = tab.results[0]?.rows[rowIndex]
  if (!row) return ''
  const short = (v: unknown) => { const t = cellEditText(v); return t.length > 60 ? `${t.slice(0, 60)}…` : t }
  if (dbType === 'mongodb') return `The document with _id ${short(row._id)} will be deleted from ${tab.tableName}.`
  const keys = (tab.primaryKeys ?? []).map(pk => `${pk} = ${short(row[pk])}`).join(', ')
  return `The row with ${keys} will be deleted from ${tab.schemaName}.${tab.tableName}.`
}

function makeTab(n: number, connectionId: string | null, databaseName: string | null = null): QueryTab {
  return { id: generateId(), kind: 'query', title: `Query ${n}`, sql: '', results: [], running: false, connectionId, databaseName, originalSql: '' }
}

const TABLE_PAGE_SIZE = 200

function tablePageSql(schema: string, table: string, page: number, orderBy = '') {
  const offset = page * TABLE_PAGE_SIZE
  return `SELECT *\nFROM ${schema}.${table}\n${orderBy ? `${orderBy}\n` : ''}LIMIT ${TABLE_PAGE_SIZE} OFFSET ${offset};`
}

function makeTableTab(connId: string, dbName: string, schema: string, table: string, dbType?: 'postgres' | 'mysql' | 'mongodb' | 'sqlite' | 'redis'): QueryTab {
  return { id: generateId(), kind: 'table', title: table, sql: tablePageSql(schema, table, 0), results: [], running: false, connectionId: connId, databaseName: dbName, schemaName: schema, tableName: table, page: 0, pageSize: TABLE_PAGE_SIZE, totalRows: undefined, dbType }
}

function makeTableDesignTab(connId: string, dbName: string, schema: string, table: string): QueryTab {
  return {
    id: generateId(),
    kind: 'design',
    title: `${table} [Design]`,
    sql: '',
    results: [],
    running: false,
    connectionId: connId,
    databaseName: dbName,
    schemaName: schema,
    tableName: table,
    designActiveTab: 'fields'
  }
}

function makeCreateTableTab(connId: string, dbName: string, schema: string): QueryTab {
  return {
    id: generateId(),
    kind: 'create-table',
    title: 'New Table',
    sql: '',
    results: [],
    running: false,
    connectionId: connId,
    databaseName: dbName,
    schemaName: schema,
    tableName: '',
    columns: [],
  }
}

function makeCreateViewTab(connId: string, dbName: string, schema: string): QueryTab {
  return {
    id: generateId(),
    kind: 'create-view',
    title: 'New View',
    sql: '',
    results: [],
    running: false,
    connectionId: connId,
    databaseName: dbName,
    schemaName: schema,
    tableName: '',
  }
}

// loaded once at module level so all useState initializers share the same snapshot
const _initialPersistedTabs = loadPersistedTabs()
const _initialTab = makeTab(1, null)

export function DatabaseView({ isActive = true }: { isActive?: boolean }) {
  const [isMounted, setIsMounted] = useState(false)
  // Mount-detection flag for hydration-safe rendering; must start false on first render.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsMounted(true)
  }, [])

  const [connections, setConnections] = useState<DbConnection[]>([])
  const [activeConnId, setActiveConnId] = useState<string | null>(
    _initialPersistedTabs ? _initialPersistedTabs.meta.activeConnId : null
  )
  const [activeDbPerConn, setActiveDbPerConn] = useState<Record<string, string>>(
    _initialPersistedTabs ? _initialPersistedTabs.meta.activeDbPerConn : {}
  )
  const [activeSchemaPerDb, setActiveSchemaPerDb] = useState<Record<string, string>>(
    _initialPersistedTabs ? (_initialPersistedTabs.meta.activeSchemaPerDb ?? {}) : {}
  )
  const [openConns, setOpenConns] = useState<Set<string>>(
    new Set(_initialPersistedTabs?.meta.openConns ?? [])
  )
  const [openGroups, setOpenGroups] = useState<Set<string>>(
    new Set(_initialPersistedTabs?.meta.openGroups ?? [])
  )
  const [openDbs] = useState<Record<string, string[]>>(
    _initialPersistedTabs?.meta.openDbs ?? {}
  )
  const [showNewConn, setShowNewConn] = useState(false)
  // Prefill for the New Connection dialog (a type from New Connection ▸, or a duplicated connection)
  const [newConnPreset, setNewConnPreset] = useState<{ initial?: Partial<ConnectionDraft>; title?: string; key: number }>({ key: 0 })
  const [removeConnId, setRemoveConnId] = useState<string | null>(null)
  const [editConnId, setEditConnId] = useState<string | null>(null)
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([])
  const prevSavedQueriesRef = useRef<SavedQuery[]>([])
  useEffect(() => {
    loadSavedQueriesFromDb().then(qs => { setSavedQueries(qs); prevSavedQueriesRef.current = qs })
  }, [])
  const [saveNameDialog, setSaveNameDialog] = useState<QueryTab | null>(null)
  const [renameDialog, setRenameDialog] = useState<{ id: string; title: string } | null>(null)
  const [newCollectionDialog, setNewCollectionDialog] = useState<{ connId: string; dbName: string } | null>(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [tabs, setTabs] = useState<QueryTab[]>(
    _initialPersistedTabs && _initialPersistedTabs.tabs.length > 0
      ? _initialPersistedTabs.tabs
      : [_initialTab]
  )
  const [activeTabId, setActiveTabId] = useState<string>(
    _initialPersistedTabs ? _initialPersistedTabs.meta.activeTabId : _initialTab.id
  )
  const [tabCounter, setTabCounter] = useState<number>(
    _initialPersistedTabs ? _initialPersistedTabs.meta.tabCounter : 2
  )
  const [runTrigger, setRunTrigger] = useState(0)

  const [unsavedCloseTab, setUnsavedCloseTab] = useState<QueryTab | null>(null)

  // A query tab on the connection, in its selected database (else the one it connects to, else its first)
  const openRedisTab = useCallback((connId: string, dbName: string, kind: 'redis-browser' | 'redis-console') => {
    const tab: QueryTab = {
      id: generateId(), kind, title: kind === 'redis-browser' ? dbName : `${dbName} console`,
      sql: '', results: [], running: false, connectionId: connId, databaseName: dbName, dbType: 'redis', originalSql: '',
    }
    // One tab per database and kind: switch to it when it's already open
    setTabs(prev => {
      const existing = prev.find(t => t.kind === kind && t.connectionId === connId && t.databaseName === dbName)
      setActiveTabId(existing ? existing.id : tab.id)
      return existing ? prev : [...prev, tab]
    })
  }, [])

  const newQueryFor = useCallback((connId: string | null, database?: string) => {
    const conn = connections.find(c => c.id === connId)
    // A Redis "query" is its console
    if (conn?.dbType === 'redis' && connId) {
      openRedisTab(connId, database ?? activeDbPerConn[connId] ?? conn.databases[0]?.name ?? 'db0', 'redis-console')
      return
    }
    const dbName = connId
      ? (database ?? activeDbPerConn[connId] ?? (conn?.databases.some(d => d.name === conn.database) ? conn.database : conn?.databases[0]?.name) ?? null)
      : null
    const schemaName = connId && dbName ? (activeSchemaPerDb[`${connId}::${dbName}`] ?? undefined) : undefined
    const tab: QueryTab = { ...makeTab(tabCounter, connId, dbName), schemaName, dbType: conn?.dbType }
    setTabs(prev => [...prev, tab])
    setActiveTabId(tab.id)
    setTabCounter(n => n + 1)
  }, [tabCounter, activeDbPerConn, activeSchemaPerDb, connections, openRedisTab])
  const newQuery = useCallback(() => newQueryFor(activeConnId), [newQueryFor, activeConnId])

  const openNewConnection = useCallback((preset?: { initial?: Partial<ConnectionDraft>; title?: string }) => {
    setNewConnPreset(prev => ({ ...preset, key: prev.key + 1 }))
    setShowNewConn(true)
  }, [])

  const newTableIn = useCallback((connId: string, dbName: string, schema: string) => {
    const tab = makeCreateTableTab(connId, dbName, schema)
    setTabs(prev => [...prev, tab])
    setActiveTabId(tab.id)
  }, [])

  const newViewIn = useCallback((connId: string, dbName: string, schema: string) => {
    const tab = makeCreateViewTab(connId, dbName, schema)
    setTabs(prev => [...prev, tab])
    setActiveTabId(tab.id)
  }, [])

  // The table and view designers write PostgreSQL/MySQL DDL
  const designerUnsupported = useCallback((connId: string) => {
    if (connections.find(c => c.id === connId)?.dbType !== 'sqlite') return false
    toast.info('The designer doesn’t support SQLite yet', { description: 'Use CREATE TABLE / CREATE VIEW in a query tab.' })
    return true
  }, [connections])

  const newTable = useCallback(() => {
    if (!activeConnId || designerUnsupported(activeConnId)) return
    const dbName = activeDbPerConn[activeConnId]
    if (!dbName) return
    const schemaName = activeSchemaPerDb[`${activeConnId}::${dbName}`] ?? 'public'
    const tab = makeCreateTableTab(activeConnId, dbName, schemaName)
    setTabs(prev => [...prev, tab])
    setActiveTabId(tab.id)
  }, [activeConnId, activeDbPerConn, activeSchemaPerDb, designerUnsupported])

  const newView = useCallback(() => {
    if (!activeConnId || designerUnsupported(activeConnId)) return
    const dbName = activeDbPerConn[activeConnId]
    if (!dbName) return
    const schemaName = activeSchemaPerDb[`${activeConnId}::${dbName}`] ?? 'public'
    const tab = makeCreateViewTab(activeConnId, dbName, schemaName)
    setTabs(prev => [...prev, tab])
    setActiveTabId(tab.id)
  }, [activeConnId, activeDbPerConn, activeSchemaPerDb, designerUnsupported])

  const newStructureSync = useCallback(() => {
    // Pre-fill the source with the PostgreSQL database/schema selected in the sidebar
    const conn = connections.find(c => c.id === activeConnId && c.dbType === 'postgres')
    const database = conn ? (activeDbPerConn[conn.id] ?? null) : null
    const schema = conn && database ? (activeSchemaPerDb[`${conn.id}::${database}`] ?? null) : null
    const sync = initialSyncState()
    sync.config.source = { connectionId: conn?.id ?? null, database, schema }
    const tab: QueryTab = {
      id: generateId(), kind: 'structure-sync', title: 'Structure Sync', sql: '', results: [], running: false,
      connectionId: null, databaseName: null, sync,
    }
    setTabs(prev => [...prev, tab])
    setActiveTabId(tab.id)
  }, [connections, activeConnId, activeDbPerConn, activeSchemaPerDb])

  const updateSync = useCallback((tabId: string, fn: (s: StructureSyncState) => StructureSyncState) => {
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, sync: fn(t.sync ?? initialSyncState()) } : t))
  }, [])

  const newDataSync = useCallback(() => {
    const conn = connections.find(c => c.id === activeConnId && c.dbType === 'postgres')
    const database = conn ? (activeDbPerConn[conn.id] ?? null) : null
    const schema = conn && database ? (activeSchemaPerDb[`${conn.id}::${database}`] ?? null) : null
    const dataSync = initialDataSyncState()
    dataSync.config.source = { connectionId: conn?.id ?? null, database, schema }
    const tab: QueryTab = {
      id: generateId(), kind: 'data-sync', title: 'Data Sync', sql: '', results: [], running: false,
      connectionId: null, databaseName: null, dataSync,
    }
    setTabs(prev => [...prev, tab])
    setActiveTabId(tab.id)
  }, [connections, activeConnId, activeDbPerConn, activeSchemaPerDb])

  const updateDataSync = useCallback((tabId: string, fn: (s: DataSyncState) => DataSyncState) => {
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, dataSync: fn(t.dataSync ?? initialDataSyncState()) } : t))
  }, [])

  // Pick the right IPC channel based on connection type
  const dbIpc = useCallback((connId: string) => {
    const conn = connections.find(c => c.id === connId)
    return getIpc(conn?.dbType ?? 'postgres')
  }, [connections])

  const handleSaveFunction = useCallback(async (tab: QueryTab) => {
    const connId = tab.connectionId ?? connections.find(c => c.status === 'connected')?.id
    if (!connId) return false

    setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, running: true, results: [] } : t))

    const res = await dbIpc(connId).query(connId, tab.sql, tab.databaseName ?? undefined)
    const collected: QueryResult[] = []
    if (res.ok) {
      collected.push({ fields: res.fields ?? [], rows: res.rows ?? [], rowCount: res.rowCount ?? null, ms: res.ms ?? 0, statement: tab.sql })
      setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, running: false, results: collected, originalSql: tab.sql } : t))
      return true
    } else {
      collected.push({ fields: [], rows: [], rowCount: null, ms: 0, error: res.error, statement: tab.sql })
      setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, running: false, results: collected } : t))
      return false
    }
  }, [connections, dbIpc])

  const removeTab = useCallback((id: string) => {
    setTabs(prev => {
      const next = prev.filter(t => t.id !== id)
      if (next.length === 0) {
        setActiveTabId('')
        return []
      }
      setActiveTabId(curr => curr === id ? next[next.length - 1].id : curr)
      return next
    })
  }, [])

  const closeTab = useCallback((id: string) => {
    setTabs(prev => {
      const tab = prev.find(t => t.id === id)
      if (tab) {
        const isFuncChanged = tab.isFunction && tab.sql !== tab.originalSql
        const isDesignChanged = tab.kind === 'design' && isTableDesignChanged(tab)
        const isQueryChanged = !tab.isFunction && tab.kind === 'query' && tab.originalSql !== undefined && tab.sql !== tab.originalSql && tab.sql.trim() !== ''
        const isCreateTableChanged = tab.kind === 'create-table' && (tab.columns ?? []).length > 0
        const isCreateViewChanged = tab.kind === 'create-view' && tab.sql.trim() !== ''
        if (isFuncChanged || isDesignChanged || isQueryChanged || isCreateTableChanged || isCreateViewChanged || hasPendingTableEdits(tab)) {
          setUnsavedCloseTab(tab)
          // Show the tab behind the prompt, so dismissing it leaves you on that tab
          setActiveTabId(id)
          return prev
        }
      }
      const next = prev.filter(t => t.id !== id)
      if (next.length === 0) {
        setActiveTabId('')
        return []
      }
      setActiveTabId(curr => curr === id ? next[next.length - 1].id : curr)
      return next
    })
  }, [])

  const tabsRef = useRef(tabs)
  useEffect(() => { tabsRef.current = tabs }, [tabs])

  // A tab closed while its Safe Run was still open: roll the transaction back now, instead of
  // holding its locks until the idle timeout
  const safeRunsRef = useRef(new Map<string, NonNullable<QueryTab['safeRun']>>())
  useEffect(() => {
    const open = new Map(tabs.filter(t => t.safeRun).map(t => [t.id, t.safeRun!]))
    for (const [tabId, pending] of safeRunsRef.current) {
      if (tabs.some(t => t.id === tabId)) continue
      const api = pending.dialect === 'mysql' ? window.electronAPI?.mysql : pending.dialect === 'sqlite' ? window.electronAPI?.sqlite : window.electronAPI?.pg
      void api?.sessionClose(pending.sessionId, false).catch(() => {})
      toast.info('Safe Run rolled back', { description: 'Its tab was closed before the changes were committed.' })
    }
    safeRunsRef.current = open
  }, [tabs])
  const newQueryRef = useRef(newQuery)
  useEffect(() => { newQueryRef.current = newQuery }, [newQuery])
  const closeTabRef = useRef(closeTab)
  useEffect(() => { closeTabRef.current = closeTab }, [closeTab])
  const activeTabIdRef = useRef(activeTabId)
  useEffect(() => { activeTabIdRef.current = activeTabId }, [activeTabId])

  const runTableTabRef = useRef<((tab: QueryTab, newPage?: number) => Promise<void>) | undefined>(undefined)

  // Listen for Ctrl+R from Electron main (before-input-event blocks native keydown)
  useEffect(() => {
    if (!isActive) return
    const cb = () => {
      const activeTab = tabsRef.current.find(t => t.id === activeTabIdRef.current)
      if (!activeTab) return
      if (activeTab.kind === 'table') {
        runTableTabRef.current?.(activeTab)
      } else if (activeTab.kind === 'query') {
        setRunTrigger(n => n + 1)
      }
    }
    window.electronAPI?.onRunQuery?.(cb)
    return () => window.electronAPI?.offRunQuery?.(cb)
  }, [isActive])

  // Global Ctrl+R refresh/run shortcut handler for web browser mode
  useEffect(() => {
    if (!isActive) return
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault()
        e.stopPropagation()
        const activeTab = tabsRef.current.find(t => t.id === activeTabIdRef.current)
        if (!activeTab) return
        if (activeTab.kind === 'table') {
          runTableTabRef.current?.(activeTab)
        } else if (activeTab.kind === 'query') {
          setRunTrigger(n => n + 1)
        }
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [isActive])

  // Listen for close-active-tab and new-query-tab from Electron main process
  useEffect(() => {
    if (!isActive) return
    const handleClose = () => {
      if (activeTabIdRef.current) closeTabRef.current(activeTabIdRef.current)
    }
    const handleNewQuery = () => {
      newQueryRef.current()
    }
    window.electronAPI?.onCloseActiveTab?.(handleClose)
    window.electronAPI?.onNewQueryTab?.(handleNewQuery)
    return () => {
      window.electronAPI?.offCloseActiveTab?.(handleClose)
      window.electronAPI?.offNewQueryTab?.(handleNewQuery)
    }
  }, [isActive])

  // Global keydown listeners for Ctrl+W and Ctrl+T (for browser/web mode)
  useEffect(() => {
    if (!isActive) return
    const handler = (e: KeyboardEvent) => {
      // In Electron mode, the main process intercepts and forwards these via IPC.
      // We only execute here in standalone web/browser mode to avoid double-firing.
      if (window.electronAPI) return

      if ((e.ctrlKey || e.metaKey) && (e.key === 'w' || e.key === 'W')) {
        e.preventDefault()
        e.stopPropagation()
        if (activeTabId) {
          closeTab(activeTabId)
        }
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 't' || e.key === 'T')) {
        e.preventDefault()
        e.stopPropagation()
        newQuery()
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [isActive, activeTabId, closeTab, newQuery])

  // Dismiss unsaved changes close confirmation on ESC key press
  useEffect(() => {
    if (!unsavedCloseTab) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setUnsavedCloseTab(null)
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [unsavedCloseTab])

  const prevConnectionsRef = useRef<DbConnection[]>([])
  useEffect(() => {
    savePersistedConnections(connections, prevConnectionsRef.current)
    prevConnectionsRef.current = connections
  }, [connections])

  // Persist tabs/UI state whenever anything changes
  useEffect(() => {
    const openDbsSnapshot: Record<string, string[]> = {}
    for (const conn of connections) {
      const opened = conn.databases.filter(d => d.open).map(d => d.name)
      if (opened.length > 0) openDbsSnapshot[conn.id] = opened
    }
    savePersistedTabs(tabs, activeTabId, tabCounter, activeConnId, activeDbPerConn, activeSchemaPerDb, openConns, openGroups, openDbsSnapshot)
  }, [tabs, activeTabId, tabCounter, activeConnId, activeDbPerConn, activeSchemaPerDb, openConns, openGroups, connections])

  const connectionsRef = useRef(connections)
  useEffect(() => { connectionsRef.current = connections }, [connections])

  // Per-connection attempt counter: results from a superseded, cancelled or disconnected
  // attempt are dropped instead of overwriting newer state.
  const connectAttemptRef = useRef(new Map<string, number>())
  const beginAttempt = useCallback((connId: string) => {
    const n = (connectAttemptRef.current.get(connId) ?? 0) + 1
    connectAttemptRef.current.set(connId, n)
    return () => connectAttemptRef.current.get(connId) === n
  }, [])

  const patchDb = useCallback((connId: string, dbName: string, patch: Partial<DbDatabase>) => {
    setConnections(prev => prev.map(c => c.id !== connId ? c : {
      ...c,
      databases: c.databases.map(d => d.name === dbName ? { ...d, ...patch } : d),
    }))
  }, [])

  const loadDbSchemas = useCallback(async (connId: string, dbType: DbConnection['dbType'], dbName: string, isCurrent: () => boolean) => {
    patchDb(connId, dbName, { loading: true, error: undefined })
    const res = await getIpc(dbType).introspectDb(connId, dbName).catch(err => ({ ok: false as const, error: String(err) }))
    if (!isCurrent()) return
    if (!res.ok) {
      patchDb(connId, dbName, { loading: false, error: res.error })
      return
    }
    const schemas = buildSchemaEntries(res.tables, res.functions, res.enums, res.types, res.columns)
    patchDb(connId, dbName, { loading: false, loaded: true, schemas })
  }, [patchDb])

  // Lists the databases, then loads every database's schemas in the background so expanding
  // one (or searching the sidebar) doesn't wait on the server.
  const loadDatabases = useCallback(async (connId: string, dbType: DbConnection['dbType'], defaultDb: string, reopenDbs: string[], isCurrent: () => boolean) => {
    const res = await getIpc(dbType).introspect(connId).catch(err => ({ ok: false as const, error: String(err), databases: undefined }))
    if (!isCurrent()) return { ok: false }
    if (!res.ok) {
      setConnections(prev => prev.map(c => c.id === connId ? { ...c, status: 'error', errorMsg: res.error } : c))
      return { ok: false, error: res.error }
    }
    const names = res.databases ?? []
    const databases: DbDatabase[] = names.map(name => ({ name, open: reopenDbs.includes(name), loading: false, schemas: [] }))
    setConnections(prev => prev.map(c => c.id === connId ? { ...c, status: 'connected', errorMsg: undefined, databases } : c))

    const queue = [...new Set([...reopenDbs, defaultDb, ...names])].filter(n => names.includes(n))
    const worker = async () => {
      for (let dbName = queue.shift(); dbName !== undefined && isCurrent(); dbName = queue.shift()) {
        await loadDbSchemas(connId, dbType, dbName, isCurrent)
      }
    }
    void Promise.all(Array.from({ length: SCHEMA_PRELOAD_CONCURRENCY }, worker))
    return { ok: true }
  }, [loadDbSchemas])

  type ConnData = Pick<DbConnection, 'dbType' | 'host' | 'port' | 'database' | 'user' | 'password' | 'ssl' | 'vpnConfigPath' | 'vpnUsername' | 'vpnPassword'>

  const connectAndLoad = useCallback(async (connId: string, data: ConnData, reopenDbs: string[] = []): Promise<{ ok: boolean; cancelled?: boolean; error?: string }> => {
    const isCurrent = beginAttempt(connId)
    setConnections(prev => prev.map(c => c.id === connId ? { ...c, status: 'connecting', errorMsg: undefined, databases: [] } : c))
    const res = await getIpc(data.dbType).connect({ id: connId, ...data }).catch(err => ({ ok: false, cancelled: false, error: String(err) }))
    if (!isCurrent() || res.cancelled) return { ok: false, cancelled: true }
    if (!res.ok) {
      setConnections(prev => prev.map(c => c.id === connId ? { ...c, status: 'error', errorMsg: res.error } : c))
      return { ok: false, error: res.error }
    }
    return loadDatabases(connId, data.dbType, data.database, reopenDbs, isCurrent)
  }, [beginAttempt, loadDatabases])

  // On mount: restore saved connections and reconnect each one
  useEffect(() => {
    loadPersistedConnectionsFromDb().then(saved => {
      if (!saved.length) return
      const restored: DbConnection[] = saved.map(s => ({ ...s, dbType: s.dbType ?? 'postgres', label: s.label ?? '', status: 'connecting' as const, databases: [] }))
      prevConnectionsRef.current = restored
      setConnections(restored)
      setActiveConnId(prev => prev ?? restored[0].id)
      // In dev, StrictMode runs this effect twice; the second connectAndLoad supersedes the first
      for (const s of restored) void connectAndLoad(s.id, s, openDbs[s.id] ?? [])
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleToggleDb = useCallback((connId: string, dbName: string) => {
    const conn = connectionsRef.current.find(c => c.id === connId)
    const db = conn?.databases.find(d => d.name === dbName)
    if (!conn || !db) return
    setConnections(prev => prev.map(c => c.id !== connId ? c : {
      ...c,
      databases: c.databases.map(d => d.name === dbName ? { ...d, open: !d.open } : d),
    }))
    // Normally already loaded (or loading) in the background; only failed loads are retried here
    if (!db.open && !db.loaded && !db.loading) {
      const attempt = connectAttemptRef.current.get(connId)
      void loadDbSchemas(connId, conn.dbType, dbName, () => connectAttemptRef.current.get(connId) === attempt)
    }
  }, [loadDbSchemas])

  const handleConnect = useCallback(async (opts: Omit<DbConnection, 'id' | 'status' | 'databases'>) => {
    const id = generateId()
    const newConn: DbConnection = { ...opts, label: opts.label ?? '', id, status: 'connecting', databases: [] }
    setConnections(prev => [...prev, newConn])
    setActiveConnId(id)

    const res = await connectAndLoad(id, opts)
    if (res.cancelled) return
    if (!res.ok) throw new Error(res.error)
    setTabs(prev => prev.map(t => t.connectionId ? t : { ...t, connectionId: id }))
  }, [connectAndLoad])

  const handleRefresh = useCallback(async (connId: string) => {
    const conn = connectionsRef.current.find(c => c.id === connId)
    if (!conn) return
    const reopenDbs = conn.databases.filter(d => d.open).map(d => d.name)
    const isCurrent = beginAttempt(connId)
    setConnections(prev => prev.map(c => c.id === connId ? { ...c, status: 'connecting', databases: [] } : c))
    await loadDatabases(connId, conn.dbType, conn.database, reopenDbs, isCurrent)
  }, [beginAttempt, loadDatabases])

  const handleCancelConnect = useCallback((connId: string) => {
    beginAttempt(connId)
    window.electronAPI?.cancelConnect(connId)
    setConnections(prev => prev.map(c => c.id === connId ? { ...c, status: 'disconnected', errorMsg: undefined, databases: [] } : c))
  }, [beginAttempt])

  const handleRefreshDb = useCallback(async (connId: string, dbName: string) => {
    setConnections(prev => prev.map(c => c.id !== connId ? c : {
      ...c,
      databases: c.databases.map(d => d.name === dbName ? { ...d, loading: true } : d),
    }))

    const res = await dbIpc(connId).introspectDb(connId, dbName)
    if (!res.ok) {
      setConnections(prev => prev.map(c => c.id !== connId ? c : {
        ...c,
        databases: c.databases.map(d => d.name === dbName ? { ...d, loading: false, error: res.error } : d),
      }))
      return
    }

    const schemas = buildSchemaEntries(res.tables, res.functions, res.enums, res.types, res.columns)
    setConnections(prev => prev.map(c => c.id !== connId ? c : {
      ...c,
      databases: c.databases.map(d => d.name === dbName ? { ...d, open: true, loading: false, loaded: true, error: undefined, schemas } : d),
    }))
  }, [dbIpc])

  const createCollection = useCallback(async (connId: string, dbName: string, name: string) => {
    const script = `db.createCollection(${JSON.stringify(name)})`
    const res = await window.electronAPI!.mongodb.query(connId, script, dbName)
    if (res.ok) {
      toast.success(`Collection "${name}" created`)
      handleRefreshDb(connId, dbName)
    } else {
      toast.error(res.error || 'Failed to create collection.')
    }
  }, [handleRefreshDb])

  const handleSaveDesign = useCallback(async (tab: QueryTab): Promise<boolean> => {
    const ddl = generateTableAlterSql(tab)
    if (ddl.trim() === '') return true

    const connId = tab.connectionId ?? connections.find(c => c.status === 'connected')?.id
    if (!connId || !tab.databaseName) return false

    const statements = splitSqlStatements(ddl)
    let ok = true
    let errMsg = ''

    for (const stmt of statements) {
      if (!stmt.trim()) continue
      const res = await dbIpc(connId).query(connId, stmt, tab.databaseName)
      if (!res.ok) {
        ok = false
        errMsg = res.error || 'Failed to execute schema changes.'
        break
      }
    }

    if (ok) {
      await handleRefreshDb(connId, tab.databaseName)
      return true
    } else {
      toast.error(`Failed to save table designer changes:\n\n${errMsg}`)
      return false
    }
  }, [connections, dbIpc, handleRefreshDb])

  const toggleSchema = useCallback((connId: string, dbName: string, schemaName: string) => {
    setConnections(prev => prev.map(c => c.id !== connId ? c : {
      ...c,
      databases: c.databases.map(d => d.name !== dbName ? d : {
        ...d,
        schemas: d.schemas.map(s => s.name === schemaName ? { ...s, open: !s.open } : s),
      }),
    }))
  }, [])

  const handleDisconnect = useCallback(async (connId: string) => {
    beginAttempt(connId)
    window.electronAPI?.cancelConnect(connId)
    await dbIpc(connId).disconnect(connId)
    setConnections(prev => prev.map(c => c.id === connId ? { ...c, status: 'disconnected', databases: [] } : c))
  }, [dbIpc, beginAttempt])

  const handleReconnect = useCallback(async (connId: string) => {
    const conn = connectionsRef.current.find(c => c.id === connId)
    if (!conn) return
    await connectAndLoad(connId, conn)
  }, [connectAndLoad])

  const handleRemove = useCallback(async (connId: string) => {
    await handleDisconnect(connId)
    setConnections(prev => prev.filter(c => c.id !== connId))
    if (activeConnId === connId) setActiveConnId(null)
  }, [activeConnId, handleDisconnect])

  // ── Database administration (PostgreSQL, from the database menu) ──
  const [dbAdmin, setDbAdmin] = useState<{ kind: 'create' | 'drop' | 'schema' | 'extensions'; connId: string; dbName: string } | { kind: 'edit'; connId: string; dbName: string; initial: DatabaseSettings } | null>(null)
  const extensionsChangedRef = useRef(false)

  // On the connection's own database unless `database` is given
  const pgRun = useCallback(async (connId: string, sql: string, database?: string, params?: unknown[]) => {
    const res = await window.electronAPI!.pg.query(connId, sql, database, params)
    if (!res.ok) throw new Error(res.error ?? 'Query failed')
    return res
  }, [])

  // Stable per dialog: the dialogs load their lookups (roles, extensions) when it changes
  const dbAdminConnId = dbAdmin?.connId
  const dbAdminDb = dbAdmin && (dbAdmin.kind === 'schema' || dbAdmin.kind === 'extensions') ? dbAdmin.dbName : undefined
  const dbAdminRun = useMemo<RunSql | null>(() => dbAdminConnId
    ? sql => window.electronAPI!.pg.query(dbAdminConnId, sql, dbAdminDb)
    : null, [dbAdminConnId, dbAdminDb])

  const handleDatabaseAction = useCallback(async (action: DatabaseAction) => {
    const { connId, dbName } = action
    if (action.kind === 'edit') {
      try {
        const res = await pgRun(connId, DATABASE_INFO_SQL, undefined, [dbName])
        const row = res.rows?.[0]
        if (!row) { toast.error(`Database ${dbName} not found`); return }
        setDbAdmin({ kind: 'edit', connId, dbName, initial: parseDatabaseInfo(row) })
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    } else if (action.kind === 'maintain') {
      const label = MAINTENANCE_LABELS[action.maintenance]
      toast.promise(pgRun(connId, maintenanceSql(action.maintenance, dbName), dbName), {
        loading: `${label}: ${dbName}…`,
        success: res => `${label} finished in ${((res.ms ?? 0) / 1000).toFixed(1)}s`,
        error: err => `${label} failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    } else {
      extensionsChangedRef.current = false
      setDbAdmin({ kind: action.kind, connId, dbName })
    }
  }, [pgRun])

  const closeDbAdmin = useCallback(() => {
    if (dbAdmin?.kind === 'extensions' && extensionsChangedRef.current) handleRefreshDb(dbAdmin.connId, dbAdmin.dbName)
    setDbAdmin(null)
  }, [dbAdmin, handleRefreshDb])

  const createDatabase = useCallback(async (statements: string[]) => {
    if (!dbAdmin) return
    for (const sql of statements) await pgRun(dbAdmin.connId, sql)
    setDbAdmin(null)
    toast.success('Database created')
    void handleRefresh(dbAdmin.connId)
  }, [dbAdmin, pgRun, handleRefresh])

  const editDatabase = useCallback(async (statements: string[], settings: DatabaseSettings) => {
    if (dbAdmin?.kind !== 'edit') return
    const { connId, dbName: oldName } = dbAdmin
    const renamed = settings.name !== oldName
    // Our own connections to the database would block the rename
    if (renamed) await window.electronAPI!.pg.closeDbPool(connId, oldName)
    let done = 0
    try {
      for (const sql of statements) { await pgRun(connId, sql); done++ }
    } catch (err) {
      // Nothing applied: the dialog shows the error and can retry. Partly applied: retrying would
      // redo the done part, so close and say what happened.
      if (done === 0) throw err
      setDbAdmin(null)
      toast.error(`${done} of ${statements.length} changes applied, then: ${err instanceof Error ? err.message : String(err)}`)
      return
    } finally {
      // The rename runs first: once it succeeded, point everything at the new name
      if (renamed && done > 0) {
        const newName = settings.name
        const moveDb = <T extends { connectionId?: string | null; databaseName?: string | null }>(x: T): T =>
          x.connectionId === connId && x.databaseName === oldName ? { ...x, databaseName: newName } : x
        setTabs(prev => prev.map(moveDb))
        setSavedQueries(prev => prev.map(moveDb))
        setActiveDbPerConn(prev => prev[connId] === oldName ? { ...prev, [connId]: newName } : prev)
      }
      if (done > 0) void handleRefresh(connId)
    }
    setDbAdmin(null)
    toast.success(renamed ? `Renamed to ${settings.name}` : 'Database updated')
  }, [dbAdmin, pgRun, handleRefresh])

  const dropDatabase = useCallback(async (force: boolean) => {
    if (dbAdmin?.kind !== 'drop') return
    const { connId, dbName } = dbAdmin
    await window.electronAPI!.pg.closeDbPool(connId, dbName)
    await pgRun(connId, buildDropDatabase(dbName, force))
    // Tabs showing the database's objects go; query tabs keep their SQL
    const gone = (t: QueryTab) => t.connectionId === connId && t.databaseName === dbName && (t.kind !== 'query' || !!t.isFunction)
    const remaining = tabsRef.current.filter(t => !gone(t))
    setTabs(remaining)
    setActiveTabId(curr => remaining.some(t => t.id === curr) ? curr : (remaining[remaining.length - 1]?.id ?? ''))
    setActiveDbPerConn(prev => {
      if (prev[connId] !== dbName) return prev
      const next = { ...prev }
      delete next[connId]
      return next
    })
    setDbAdmin(null)
    toast.success(`Deleted database ${dbName}`)
    void handleRefresh(connId)
  }, [dbAdmin, pgRun, handleRefresh])

  const createSchema = useCallback(async (sql: string) => {
    if (!dbAdmin) return
    await pgRun(dbAdmin.connId, sql, dbAdmin.dbName)
    setDbAdmin(null)
    toast.success('Schema created')
    handleRefreshDb(dbAdmin.connId, dbAdmin.dbName)
  }, [dbAdmin, pgRun, handleRefreshDb])

  const confirmRemoveConn = useCallback(() => {
    if (!removeConnId) return
    setRemoveConnId(null)
    void handleRemove(removeConnId)
  }, [removeConnId, handleRemove])

  const handleDisconnectAndEdit = handleDisconnect

  const handleEditSave = useCallback(async (connId: string, data: Omit<DbConnection, 'id' | 'status' | 'databases'>) => {
    setConnections(prev => prev.map(c => c.id === connId ? { ...c, ...data } : c))
  }, [])

  const handleSelectConn = useCallback((connId: string) => {
    setActiveConnId(connId)
    setActiveDbPerConn(prev => {
      const dbName = prev[connId] ?? null
      // Only update the active tab if it has no connection assigned yet
      setTabs(ts => ts.map(t =>
        t.kind === 'query' && t.id === activeTabId && !t.connectionId
          ? { ...t, connectionId: connId, databaseName: dbName }
          : t
      ))
      return prev
    })
  }, [activeTabId])

  const handleSelectDb = useCallback((connId: string, dbName: string) => {
    setActiveConnId(connId)
    setActiveDbPerConn(prev => ({ ...prev, [connId]: dbName }))
    setTabs(ts => ts.map(t =>
      t.kind === 'query' && t.id === activeTabId && !t.connectionId
        ? { ...t, connectionId: connId, databaseName: dbName }
        : t
    ))
  }, [activeTabId])

  const handleSelectSchema = useCallback((connId: string, dbName: string, schemaName: string) => {
    setActiveConnId(connId)
    setActiveDbPerConn(prev => ({ ...prev, [connId]: dbName }))
    setActiveSchemaPerDb(prev => ({ ...prev, [`${connId}::${dbName}`]: schemaName }))
    setTabs(ts => ts.map(t =>
      t.kind === 'query' && t.id === activeTabId && !t.connectionId
        ? { ...t, connectionId: connId, databaseName: dbName, schemaName }
        : t.kind === 'query' && t.id === activeTabId && !t.schemaName && t.connectionId === connId && t.databaseName === dbName
        ? { ...t, schemaName }
        : t
    ))
  }, [activeTabId])

  const runTableTab = useCallback(async (tab: QueryTab, newPage?: number) => {
    if (!tab.connectionId || !tab.databaseName || !tab.schemaName || !tab.tableName) return
    const page = newPage ?? tab.page ?? 0
    const isMongo = getTabDbType(tab, connections) === 'mongodb'

    if (isMongo) {
      const skip = page * TABLE_PAGE_SIZE
      const collection = `db.getCollection(${JSON.stringify(tab.tableName)})`
      const findQuery = `${collection}.find({}).sort(${JSON.stringify(buildMongoSort(tab.tableSort))}).skip(${skip}).limit(${TABLE_PAGE_SIZE})`
      const countQuery = `${collection}.countDocuments({})`
      // Pending edits are keyed by row position, so they can't survive a reload
      setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, running: true, page, sql: findQuery, pendingEdits: undefined, editError: undefined } : t))

      const [res, countRes] = await Promise.all([
        window.electronAPI!.mongodb.query(tab.connectionId, findQuery, tab.databaseName, undefined, { typed: true }),
        tab.totalRows === undefined
          ? dbIpc(tab.connectionId).query(tab.connectionId, countQuery, tab.databaseName)
          : Promise.resolve(null),
      ])

      // MongoDB returns rows as documents — derive fields and flatten nested documents
      const rawRows = res.ok ? (res.rows ?? []) : []
      const { rows, fields } = res.ok && rawRows.length > 0
        ? processMongoRows(rawRows)
        : { rows: rawRows, fields: res.fields ?? [] }

      setTabs(prev => prev.map(t => t.id !== tab.id ? t : {
        ...t,
        running: false,
        results: res.ok
          ? [{ fields, rows, rowCount: res.rowCount ?? rows.length, ms: res.ms ?? 0, types: res.types }]
          : [{ fields: [], rows: [], rowCount: null, ms: 0, error: res.error }],
        totalRows: countRes?.ok
          ? Number((countRes.rows?.[0] as any)?.result ?? t.totalRows)
          : t.totalRows,
        columnTypes: undefined,
      }))
    } else {
      // Pending edits are keyed by row position, so they can't survive a reload
      setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, running: true, page, pendingEdits: undefined, editError: undefined, insertError: undefined } : t))

      const tabType = getTabDbType(tab, connections)
      const isMysql = tabType === 'mysql'
      const isSqlite = tabType === 'sqlite'
      const pkSql = isMysql
        ? `SELECT COLUMN_NAME AS column_name FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION`
        : isSqlite
          ? `SELECT name AS column_name FROM pragma_table_info($2, $1) WHERE pk > 0 ORDER BY pk`
          : `SELECT a.attname AS column_name FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indisprimary AND i.indrelid = (quote_ident($1) || '.' || quote_ident($2))::regclass`

      // The primary key is needed before the page query: it orders pages deterministically
      let primaryKeys = tab.primaryKeys
      if (primaryKeys === undefined) {
        const pkRes = await dbIpc(tab.connectionId).query(tab.connectionId, pkSql, tab.databaseName, [tab.schemaName, tab.tableName])
        if (pkRes.ok) primaryKeys = (pkRes.rows ?? []).map((r: any) => r.column_name as string)
      }
      const sql = tablePageSql(tab.schemaName, tab.tableName, page, buildTableOrderBy(isMysql ? 'mysql' : 'postgres', tab.tableSort, primaryKeys ?? []))

      const [res, countRes, colRes, fkRes] = await Promise.all([
        dbIpc(tab.connectionId).query(tab.connectionId, sql, tab.databaseName),
        tab.totalRows === undefined
          ? dbIpc(tab.connectionId).query(tab.connectionId, `SELECT COUNT(*) AS __count FROM ${tab.schemaName}.${tab.tableName};`, tab.databaseName)
          : Promise.resolve(null),
        // Refetched when missing nullability (tabs saved by older versions)
        tab.columnTypes === undefined || tab.columnTypes.some(c => c.nullable === undefined)
          ? dbIpc(tab.connectionId).query(tab.connectionId, isMysql
              ? `SELECT COLUMN_NAME AS column_name, COLUMN_TYPE AS udt_name, IS_NULLABLE AS is_nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`
              : isSqlite
                ? `SELECT name AS column_name, type AS udt_name, CASE WHEN "notnull" THEN 'NO' ELSE 'YES' END AS is_nullable FROM pragma_table_xinfo($2, $1) WHERE hidden = 0 ORDER BY cid`
                : `SELECT column_name, udt_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
              tab.databaseName, [tab.schemaName, tab.tableName])
          : Promise.resolve(null),
        // The foreign key row picker has no SQLite lookups yet
        tab.foreignKeyRefs === undefined && !isSqlite
          ? dbIpc(tab.connectionId).query(tab.connectionId, FOREIGN_KEYS_SQL[isMysql ? 'mysql' : 'postgres'], tab.databaseName, [tab.schemaName, tab.tableName])
          : Promise.resolve(null),
      ])

      setTabs(prev => prev.map(t => t.id !== tab.id ? t : {
        ...t,
        running: false,
        sql,
        results: res.ok
          ? [{ fields: res.fields ?? [], rows: res.rows ?? [], rowCount: res.rowCount ?? null, ms: res.ms ?? 0 }]
          : [{ fields: [], rows: [], rowCount: null, ms: 0, error: res.error }],
        totalRows: countRes?.ok
          ? Number((countRes.rows?.[0] as any)?.__count ?? t.totalRows)
          : t.totalRows,
        columnTypes: colRes?.ok
          ? (colRes.rows ?? []).map((r: any) => ({ name: r.column_name as string, type: r.udt_name as string, nullable: r.is_nullable === 'YES' }))
          : t.columnTypes,
        primaryKeys: primaryKeys ?? t.primaryKeys,
        foreignKeyRefs: isSqlite ? [] : fkRes?.ok ? parseForeignKeys(fkRes.rows ?? []) : t.foreignKeyRefs,
      }))
    }
  }, [dbIpc, connections])

  const handleTableSort = useCallback((tab: QueryTab, column: string, dir?: 'asc' | 'desc' | null) => {
    const current = tab.tableSort
    // An explicit direction (from the cell menu) wins; otherwise the same cycle as the local grid
    // sort: ascending → descending → unsorted
    const tableSort: TableSort | undefined = dir !== undefined
      ? (dir ? { column, dir } : undefined)
      : current?.column !== column
        ? { column, dir: 'asc' }
        : current.dir === 'asc' ? { column, dir: 'desc' } : undefined
    setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, tableSort } : t))
    runTableTab({ ...tab, tableSort }, 0)
  }, [runTableTab])

  // Documents are saved one at a time in row order; the first failure stops the rest, which stay pending
  const saveMongoEdits = useCallback(async (tab: QueryTab, edits: CellEdit[]): Promise<boolean> => {
    const result = tab.results[0]
    if (!tab.connectionId || !tab.tableName || !result) return false
    const connId = tab.connectionId
    const byRow = new Map<number, CellEdit[]>()
    for (const e of edits) byRow.set(e.rowIndex, [...(byRow.get(e.rowIndex) ?? []), e])
    setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, savingEdits: true, editError: undefined } : t))

    const savedRows: number[] = []
    let failure: { rowIndex: number; message: string } | undefined
    for (const [rowIndex, rowEdits] of [...byRow.entries()].sort(([a], [b]) => a - b)) {
      const row = result.rows[rowIndex]
      const types = result.types?.[rowIndex] ?? {}
      try {
        const script = buildMongoSetScript(tab.tableName, row?._id, types._id, rowEdits.map(e => ({ col: e.col, text: e.value, type: types[e.col] })))
        const res = await getIpc('mongodb').query(connId, script, tab.databaseName ?? undefined)
        if (!res.ok) throw new Error(res.error ?? 'Unknown error')
        if (Number(res.rows?.[0]?.matchedCount ?? 0) === 0) throw new Error('Document not found. It may have been changed or deleted; refresh and try again.')
        savedRows.push(rowIndex)
      } catch (err) {
        failure = { rowIndex, message: err instanceof Error ? err.message : String(err) }
        break
      }
    }

    // Saved documents are re-read and patched in place; their edits stop being pending. Edits of the
    // failed document and the ones after it stay pending.
    let patched: QueryResult | undefined
    if (savedRows.length > 0) {
      try {
        patched = await refreshMongoDocuments(connId, tab.databaseName ?? undefined, tab.tableName, result, savedRows)
      } catch {
        if (!failure) { await runTableTab({ ...tab, pendingEdits: undefined }); toast.success(`Saved ${savedRows.length} document${savedRows.length === 1 ? '' : 's'}`); return true }
      }
    }
    const savedSet = new Set(savedRows)
    const savedKeys = new Set(edits.filter(e => savedSet.has(e.rowIndex)).map(e => cellEditKey(e.rowIndex, e.col)))
    setTabs(prev => prev.map(t => {
      if (t.id !== tab.id) return t
      // Keep an edit that was retyped while saving
      const remaining = Object.fromEntries(Object.entries(t.pendingEdits ?? {}).filter(([key, e]) =>
        !(savedKeys.has(key) && tab.pendingEdits?.[key]?.value === e.value)))
      return {
        ...t,
        savingEdits: false,
        editError: failure,
        results: patched ? [patched, ...t.results.slice(1)] : t.results,
        pendingEdits: Object.keys(remaining).length > 0 ? remaining : undefined,
      }
    }))

    const saved = savedRows.length
    if (failure) {
      toast.error(saved > 0 ? `Saved ${saved} document${saved === 1 ? '' : 's'}, then one failed: ${failure.message}` : `Save failed: ${failure.message}`)
      return false
    }
    toast.success(`Saved ${saved} document${saved === 1 ? '' : 's'}`)
    return true
  }, [runTableTab])

  // confirmed: the save was already approved (an MCP client's request the user allowed)
  const handleSaveTableEdits = useCallback(async (tab: QueryTab, opts: { confirmed?: boolean } = {}): Promise<boolean> => {
    const edits = Object.values(tab.pendingEdits ?? {})
    if (edits.length === 0) return true
    const conn = connections.find(c => c.id === tab.connectionId)
    if (!opts.confirmed && safeRunEnabled(conn?.options)) {
      const rows = tab.results[0]?.rows ?? []
      const lines = edits.slice().sort((a, b) => a.rowIndex - b.rowIndex).slice(0, 200).map(e => rows[e.rowIndex]
        ? `row ${e.rowIndex + 1}  ${e.col}: ${JSON.stringify(cellEditText(rows[e.rowIndex][e.col]))} → ${e.value === null ? 'NULL' : JSON.stringify(e.value)}`
        : `new row  ${e.col} = ${e.value === null ? 'NULL' : JSON.stringify(e.value)}`)
      const ok = await confirmAction({
        title: `Save ${edits.length} change${edits.length === 1 ? '' : 's'}?`,
        subtitle: `${conn?.label || conn?.name} · ${tab.schemaName}.${tab.tableName}`,
        message: 'This connection uses Safe Run. Check the changes before they are saved.',
        details: lines.join('\n') + (edits.length > 200 ? `\n… and ${edits.length - 200} more` : ''),
        confirmLabel: 'Save',
      })
      if (!ok) return false
    }
    const dbType = getTabDbType(tab, connections)
    if (dbType === 'mongodb') return saveMongoEdits(tab, edits)
    const primaryKeys = tab.primaryKeys ?? []
    if (!tab.connectionId || !tab.schemaName || !tab.tableName || primaryKeys.length === 0) {
      toast.error('This table cannot be edited')
      return false
    }

    const connId = tab.connectionId
    const database = tab.databaseName ?? undefined
    const plans = buildRowSavePlans(sqlDialectOf(dbType), tab.schemaName, tab.tableName, primaryKeys, tab.results[0]?.rows ?? [], edits)
    const api = getIpc(dbType)
    setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, savingEdits: true, editError: undefined, insertError: undefined } : t))

    // Rows are saved in order (new rows last); the first failure stops the rest so they stay pending.
    const savedRows = new Map<number, Record<string, unknown>>()
    let failure: { rowIndex: number; message: string } | undefined
    let insertFailed = false
    let inserted = 0
    for (const plan of plans) {
      let res = await api.query(connId, plan.update.sql, database, plan.update.params)
      if (res.ok && plan.reselect) res = await api.query(connId, plan.reselect.sql, database, plan.reselect.params)
      if (!res.ok) {
        failure = { rowIndex: plan.rowIndex, message: res.error ?? 'Unknown error' }
        insertFailed = !!plan.insert
        break
      }
      if (plan.insert) {
        inserted++
        savedRows.set(plan.rowIndex, res.rows?.[0] ?? {})
        continue
      }
      if (res.rows?.length !== 1) {
        failure = { rowIndex: plan.rowIndex, message: 'Row not found. It may have been changed or deleted; refresh the table and try again.' }
        break
      }
      savedRows.set(plan.rowIndex, res.rows[0])
    }

    const savedEditKeys = new Set(edits.filter(e => savedRows.has(e.rowIndex)).map(e => cellEditKey(e.rowIndex, e.col)))
    setTabs(prev => prev.map(t => {
      if (t.id !== tab.id) return t
      const current = t.results[0]
      // Only drop edits that were actually saved; a cell retyped during the save stays pending
      const remaining = Object.fromEntries(Object.entries(t.pendingEdits ?? {}).filter(([key, e]) =>
        !(savedEditKeys.has(key) && tab.pendingEdits?.[key]?.value === e.value)))
      return {
        ...t,
        savingEdits: false,
        editError: failure,
        insertError: insertFailed ? failure?.message : undefined,
        results: current ? [{ ...current, rows: current.rows.map((r, i) => savedRows.get(i) ?? r) }, ...t.results.slice(1)] : t.results,
        pendingEdits: Object.keys(remaining).length > 0 ? remaining : undefined,
      }
    }))

    const savedCount = savedRows.size
    // New rows get their defaults and generated values from the database; reload to show them.
    // Inserts are saved last, so everything before them succeeded and nothing pending is lost.
    if (inserted > 0) void runTableTab({ ...tab, totalRows: undefined })
    if (failure && insertFailed && savedCount === 0) return false // the popup explains it
    if (failure) {
      toast.error(savedCount > 0
        ? `Saved ${savedCount} of ${plans.length} rows, then a row failed: ${failure.message}`
        : `Save failed: ${failure.message}`)
      return false
    }
    toast.success(inserted > 0 && inserted === savedCount
      ? `Inserted ${inserted} row${inserted === 1 ? '' : 's'}`
      : `Saved ${savedCount} row${savedCount === 1 ? '' : 's'}`)
    return true
  }, [connections, runTableTab, saveMongoEdits])

  useEffect(() => {
    runTableTabRef.current = runTableTab
  }, [runTableTab])

  const handlePageChange = useCallback((tab: QueryTab, page: number) => {
    runTableTab(tab, page)
  }, [runTableTab])

  const handleOpenTable = useCallback((connId: string, dbName: string, schema: string, table: string) => {
    const existing = tabs.find(t => t.kind === 'table' && t.connectionId === connId && t.databaseName === dbName && t.schemaName === schema && t.tableName === table)
    if (existing) {
      setActiveTabId(existing.id)
      return
    }
    const conn = connections.find(c => c.id === connId)
    const newTab = makeTableTab(connId, dbName, schema, table, conn?.dbType)
    setTabs(prev => [...prev, newTab])
    setActiveTabId(newTab.id)
    setTimeout(() => runTableTab(newTab), 0)
  }, [tabs, runTableTab, connections])

  // Keeps open tabs in step with a table action run from the designer
  const handleTableChanged = useCallback((connId: string, dbName: string, schema: string, table: string, change: TableChange) => {
    const isTableTab = (t: QueryTab) => (t.kind === 'table' || t.kind === 'design')
      && t.connectionId === connId && t.databaseName === dbName && t.schemaName === schema && t.tableName === table

    if (change.kind === 'renamed') {
      const name = change.newName
      setTabs(prev => prev.map(t => !isTableTab(t) ? t : {
        ...t,
        tableName: name,
        title: t.kind === 'design' ? `${name} [Design]` : name,
        sql: t.kind === 'table' ? tablePageSql(schema, name, t.page ?? 0) : t.sql,
      }))
    } else if (change.kind === 'dropped') {
      setTabs(prev => {
        const next = prev.filter(t => !isTableTab(t))
        setActiveTabId(curr => next.some(t => t.id === curr) ? curr : (next[next.length - 1]?.id ?? ''))
        return next
      })
    } else if (change.kind === 'data') {
      for (const t of tabsRef.current.filter(t => isTableTab(t) && t.kind === 'table')) void runTableTab({ ...t, totalRows: undefined })
    } else if (change.kind === 'created') {
      toast.success(`Created ${change.name}`, { action: { label: 'Open', onClick: () => handleOpenTable(connId, dbName, schema, change.name) } })
    }
    if (change.kind === 'renamed' || change.kind === 'dropped' || change.kind === 'created') handleRefreshDb(connId, dbName)
  }, [runTableTab, handleOpenTable, handleRefreshDb])

  const handleOpenTableDesign = useCallback((connId: string, dbName: string, schema: string, table: string) => {
    const existing = tabs.find(t => t.kind === 'design' && t.connectionId === connId && t.databaseName === dbName && t.schemaName === schema && t.tableName === table)
    if (existing) {
      setActiveTabId(existing.id)
      return
    }
    const newTab = makeTableDesignTab(connId, dbName, schema, table)
    setTabs(prev => [...prev, newTab])
    setActiveTabId(newTab.id)
  }, [tabs])

  const handleOpenErd = useCallback((connId: string, dbName: string) => {
    const existing = tabs.find(t => t.kind === 'erd' && t.connectionId === connId && t.databaseName === dbName)
    if (existing) {
      setActiveTabId(existing.id)
      return
    }
    const newTab: QueryTab = {
      id: generateId(),
      kind: 'erd',
      title: `ERD: ${dbName}`,
      sql: '',
      results: [],
      running: false,
      connectionId: connId,
      databaseName: dbName,
    }
    setTabs(prev => [...prev, newTab])
    setActiveTabId(newTab.id)
  }, [tabs])

  const handleOpenFunction = useCallback(async (connId: string, dbName: string, schema: string, functionName: string, args: string) => {
    const tabTitle = args ? `${functionName}(${args})` : `${functionName}()`
    // Read from the ref: a setTabs updater may run too late to decide this
    const existing = tabsRef.current.find(t => t.kind === 'query' && t.isFunction && t.connectionId === connId && t.databaseName === dbName
      && t.schemaName === schema && t.tableName === functionName && t.functionArguments === args)
    if (existing) {
      setActiveTabId(existing.id)
      return
    }

    const escapedSchema = schema.replace(/'/g, "''")
    const escapedFn = functionName.replace(/'/g, "''")
    const query = `SELECT pg_get_functiondef(p.oid) AS definition
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = '${escapedSchema}' AND p.proname = '${escapedFn}';`

    let definition = `-- Definition for function ${schema}.${functionName}\n`
    try {
      const res = await dbIpc(connId).query(connId, query, dbName)
      if (res.ok && res.rows && res.rows.length > 0) {
        definition = res.rows.map((row: any) => row.definition).join('\n\n')
      } else {
        definition += `-- (Could not retrieve SQL definition: ${res.error || 'No function definition found'})\n`
      }
    } catch (err: any) {
      definition += `-- (Error fetching definition: ${err.message || String(err)})\n`
    }

    const tabId = generateId()
    const newTab: QueryTab = {
      id: tabId,
      kind: 'query',
      title: tabTitle,
      sql: definition,
      results: [],
      running: false,
      connectionId: connId,
      databaseName: dbName,
      schemaName: schema,
      tableName: functionName,
      isFunction: true,
      functionArguments: args,
      originalSql: definition,
    }
    setTabs(prev => [...prev, newTab])
    setActiveTabId(tabId)
  }, [dbIpc])

  // A query tab saved as CREATE FUNCTION becomes that function's tab. A saved query keeps its tab id,
  // so the converted tab gets a new one and the saved query stays as it was.
  const handleSavedAsFunction = useCallback((tab: QueryTab, fn: FunctionInfo, isSavedQuery: boolean) => {
    const isSame = (t: QueryTab) => t.isFunction && t.connectionId === tab.connectionId && t.databaseName === tab.databaseName
      && t.schemaName === fn.schema && t.tableName === fn.name && t.functionArguments === fn.arguments
    const id = isSavedQuery ? generateId() : tab.id
    const converted: QueryTab = {
      ...tab,
      id,
      title: `${fn.name}(${fn.arguments})`,
      schemaName: fn.schema,
      tableName: fn.name,
      isFunction: true,
      functionArguments: fn.arguments,
      originalSql: tab.sql,
    }
    setTabs(prev => prev
      // Another tab of the same function now shows an old definition; drop it unless it has edits
      .filter(t => t.id === tab.id || !isSame(t) || t.sql !== t.originalSql)
      .map(t => t.id === tab.id ? converted : t))
    setActiveTabId(id)
    if (tab.connectionId && tab.databaseName) handleRefreshDb(tab.connectionId, tab.databaseName)
  }, [handleRefreshDb])

  const handleOpenType = useCallback(async (connId: string, dbName: string, schema: string, typeName: string, typeKind: string) => {
    const tabTitle = `${schema}.${typeName}`
    const existing = tabs.find(t => t.kind === 'query' && t.connectionId === connId && t.databaseName === dbName && t.schemaName === schema && t.tableName === `type:${typeName}`)
    if (existing) { setActiveTabId(existing.id); return }

    const esc = (s: string) => s.replace(/'/g, "''")
    let definition = `-- Type: ${schema}.${typeName} (${typeKind})\n`

    try {
      let query = ''
      if (typeKind === 'composite') {
        query = `SELECT a.attname AS column_name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type
FROM pg_type t
JOIN pg_namespace n ON t.typnamespace = n.oid
JOIN pg_class c ON c.oid = t.typrelid
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
WHERE n.nspname = '${esc(schema)}' AND t.typname = '${esc(typeName)}'
ORDER BY a.attnum;`
        const res = await dbIpc(connId).query(connId, query, dbName)
        if (res.ok && res.rows?.length) {
          const cols = res.rows.map((r: any) => `    ${r.column_name} ${r.data_type}`).join(',\n')
          definition = `CREATE TYPE ${schema}.${typeName} AS (\n${cols}\n);`
        } else {
          definition += `-- (Could not retrieve definition${res.error ? ': ' + res.error : ''})\n`
        }
      } else if (typeKind === 'domain') {
        query = `SELECT pg_catalog.format_type(t.typbasetype, t.typtypmod) AS base_type,
       t.typnotnull AS not_null,
       t.typdefault AS default_val,
       pg_catalog.array_to_string(ARRAY(
         SELECT pg_catalog.pg_get_constraintdef(con.oid)
         FROM pg_catalog.pg_constraint con
         WHERE con.contypid = t.oid
       ), ', ') AS check_constraints
FROM pg_type t
JOIN pg_namespace n ON t.typnamespace = n.oid
WHERE n.nspname = '${esc(schema)}' AND t.typname = '${esc(typeName)}';`
        const res = await dbIpc(connId).query(connId, query, dbName)
        if (res.ok && res.rows?.length) {
          const r = res.rows[0]
          let def = `CREATE DOMAIN ${schema}.${typeName} AS ${r.base_type}`
          if (r.default_val) def += `\n    DEFAULT ${r.default_val}`
          if (r.not_null) def += `\n    NOT NULL`
          if (r.check_constraints) def += `\n    ${r.check_constraints}`
          definition = def + ';'
        } else {
          definition += `-- (Could not retrieve definition${res.error ? ': ' + res.error : ''})\n`
        }
      } else if (typeKind === 'range') {
        query = `SELECT pg_catalog.format_type(r.rngsubtype, NULL) AS subtype,
       opc.opcname AS subtype_opclass,
       col.collname AS collation,
       COALESCE(cf.proname, '') AS canonical,
       COALESCE(df.proname, '') AS subtype_diff
FROM pg_range r
JOIN pg_type t ON t.oid = r.rngtypid
JOIN pg_namespace n ON t.typnamespace = n.oid
LEFT JOIN pg_opclass opc ON opc.oid = r.rngsubopc
LEFT JOIN pg_collation col ON col.oid = r.rngcollation
LEFT JOIN pg_proc cf ON cf.oid = r.rngcanonical
LEFT JOIN pg_proc df ON df.oid = r.rngsubdiff
WHERE n.nspname = '${esc(schema)}' AND t.typname = '${esc(typeName)}';`
        const res = await dbIpc(connId).query(connId, query, dbName)
        if (res.ok && res.rows?.length) {
          const r = res.rows[0]
          const opts: string[] = [`SUBTYPE = ${r.subtype}`]
          if (r.subtype_opclass) opts.push(`SUBTYPE_OPCLASS = ${r.subtype_opclass}`)
          if (r.collation) opts.push(`COLLATION = ${r.collation}`)
          if (r.canonical) opts.push(`CANONICAL = ${r.canonical}`)
          if (r.subtype_diff) opts.push(`SUBTYPE_DIFF = ${r.subtype_diff}`)
          definition = `CREATE TYPE ${schema}.${typeName} AS RANGE (\n    ${opts.join(',\n    ')}\n);`
        } else {
          definition += `-- (Could not retrieve definition${res.error ? ': ' + res.error : ''})\n`
        }
      }
    } catch (err: any) {
      definition += `-- (Error fetching definition: ${err.message || String(err)})\n`
    }

    const tabId = generateId()
    const newTab: QueryTab = {
      id: tabId,
      kind: 'query',
      title: tabTitle,
      sql: definition,
      results: [],
      running: false,
      connectionId: connId,
      databaseName: dbName,
      schemaName: schema,
      tableName: `type:${typeName}`,
    }
    setTabs(prev => [...prev, newTab])
    setActiveTabId(tabId)
  }, [tabs, dbIpc])

  const commitSaveQuery = useCallback((tab: QueryTab, name: string) => {
    setSavedQueries(prev => {
      const existing = prev.find(q => q.id === tab.id)
      if (existing) {
        return prev.map(q => q.id === tab.id ? { ...q, title: name, sql: tab.sql, schemaName: tab.schemaName! } : q)
      }
      return [...prev, { id: tab.id, title: name, sql: tab.sql, connectionId: tab.connectionId!, databaseName: tab.databaseName!, schemaName: tab.schemaName! }]
    })
    setTabs(ts => ts.map(t => t.id === tab.id ? { ...t, title: name, originalSql: tab.sql } : t))
  }, [])

  const savedQueriesRef = useRef(savedQueries)
  useEffect(() => {
    persistSavedQueries(savedQueries, prevSavedQueriesRef.current)
    prevSavedQueriesRef.current = savedQueries
    savedQueriesRef.current = savedQueries
  }, [savedQueries])

  const handleSaveQuery = useCallback((tab: QueryTab) => {
    if (!tab.connectionId || !tab.databaseName || !tab.schemaName || !tab.sql.trim()) return
    const existing = savedQueriesRef.current.find(q => q.id === tab.id)
    if (existing) {
      setSavedQueries(prev => prev.map(q => q.id === tab.id ? { ...q, sql: tab.sql, schemaName: tab.schemaName! } : q))
      setTabs(ts => ts.map(t => t.id === tab.id ? { ...t, originalSql: tab.sql } : t))
    } else {
      // New save — open name dialog
      setSaveNameDialog(tab)
    }
  }, [])

  const handleDeleteSavedQuery = useCallback((id: string) => {
    setDeleteConfirmId(id)
  }, [])

  const commitDeleteSavedQuery = useCallback((id: string) => {
    setSavedQueries(prev => prev.filter(q => q.id !== id))
    setDeleteConfirmId(null)
  }, [])

  const handleRenameSavedQuery = useCallback((id: string, currentTitle: string) => {
    setRenameDialog({ id, title: currentTitle })
  }, [])

  const commitRename = useCallback((id: string, newTitle: string) => {
    setSavedQueries(prev => prev.map(q => q.id === id ? { ...q, title: newTitle } : q))
    setTabs(ts => ts.map(t => t.id === id ? { ...t, title: newTitle } : t))
    setRenameDialog(null)
  }, [])

  // The tab id is the saved query's id. The updater may run later (React doesn't run it right away
  // when other updates are queued), so the tab is activated directly rather than from inside it.
  const handleOpenSavedQuery = useCallback((sq: SavedQuery) => {
    setTabs(prev => prev.some(t => t.id === sq.id) ? prev : [...prev, {
      id: sq.id, kind: 'query', title: sq.title, sql: sq.sql, originalSql: sq.sql, results: [], running: false,
      connectionId: sq.connectionId, databaseName: sq.databaseName, schemaName: sq.schemaName,
    }])
    setActiveTabId(sq.id)
  }, [])


  const updateTab = useCallback((id: string, patch: Partial<QueryTab>) => {
    setTabs(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t))
  }, [])

  const activeTab = tabs.find(t => t.id === activeTabId) ?? tabs[0]
  const activeConn = connections.find(c => c.id === activeConnId) ?? null

  // Lent to the MCP bridge (components/mcp-bridge.tsx). Its accessors read refs, so commands that
  // wait for the UI see the latest state.
  const tabCounterRef = useRef(tabCounter)
  useEffect(() => { tabCounterRef.current = tabCounter }, [tabCounter])
  const mcpApi: McpAppApi = {
    tabs: () => tabsRef.current,
    activeTabId: () => activeTabIdRef.current,
    connections: () => connectionsRef.current,
    setTabs,
    setActiveTabId: id => { activeTabIdRef.current = id; setActiveTabId(id) },
    reconnect: handleReconnect,
    disconnect: handleDisconnect,
    runTableTab,
    sortTable: handleTableSort,
    saveTableEdits: tab => handleSaveTableEdits(tab, { confirmed: true }),
    closeTab,
    openErd: handleOpenErd,
    nextTabNumber: () => { const n = tabCounterRef.current; tabCounterRef.current = n + 1; setTabCounter(n + 1); return n },
    ipc: dbType => getIpc(dbType) as ReturnType<McpAppApi['ipc']>,
    dbTypeOf: tab => getTabDbType(tab, connectionsRef.current),
    makeTab: (n, connId, database) => makeTab(n, connId, database),
    makeTableTab: (connId, database, schema, table, dbType) => makeTableTab(connId, database, schema, table, dbType),
    cellEditKey,
    splitSql: splitSqlStatements,
    processMongoRows,
    buildRowDelete,
    pageSize: TABLE_PAGE_SIZE,
  }

  if (!isMounted) {
    return <div className="flex flex-col flex-1 min-h-0 bg-background" />
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <McpBridge api={mcpApi} />
      <ConfirmHost />
      <DbToolbar
        onNewConnection={() => openNewConnection()}
        onNewQuery={newQuery}
        onNewTable={newTable}
        onNewView={newView}
        onStructureSync={newStructureSync}
        onDataSync={newDataSync}
        activeConn={activeConn}
      />

      <ResizablePanelGroup direction="horizontal" className="flex-1 min-h-0">
        <ResizablePanel defaultSize={20} minSize={15} maxSize={35}>
          <ConnectionsPanel
            connections={connections}
            activeConnId={activeConnId}
            onSelectConn={handleSelectConn}
            onToggleDb={handleToggleDb}
            onToggleSchema={toggleSchema}
            onNewConnection={dbType => openNewConnection(dbType ? { initial: { dbType } } : undefined)}
            onDuplicateConnection={id => {
              const conn = connections.find(c => c.id === id)
              if (!conn) return
              const { id: _id, status: _status, databases: _databases, errorMsg: _errorMsg, ...settings } = conn
              openNewConnection({ title: 'Duplicate Connection', initial: { ...settings, label: `Copy of ${conn.label || conn.name}` } })
            }}
            onNewQueryFor={newQueryFor}
            onDatabaseAction={handleDatabaseAction}
            onNewTableIn={newTableIn}
            onNewViewIn={newViewIn}
            onNewCollectionIn={(connId, dbName) => setNewCollectionDialog({ connId, dbName })}
            onTableChanged={handleTableChanged}
            onRefresh={handleRefresh}
            onRefreshDb={handleRefreshDb}
            onOpenErd={handleOpenErd}
            onOpenRedis={openRedisTab}
            onDisconnect={handleDisconnect}
            onReconnect={handleReconnect}
            onCancelConnect={handleCancelConnect}
            onRemove={id => setRemoveConnId(id)}
            onEdit={id => setEditConnId(id)}
            onSelectDb={handleSelectDb}
            onSelectSchema={handleSelectSchema}
            onOpenTable={handleOpenTable}
            onOpenTableDesign={handleOpenTableDesign}
            onOpenFunction={handleOpenFunction}
            onOpenType={handleOpenType}
            activeDbPerConn={activeDbPerConn}
            activeSchemaPerDb={activeSchemaPerDb}
            openConns={openConns}
            setOpenConns={setOpenConns}
            openGroups={openGroups}
            setOpenGroups={setOpenGroups}
            savedQueries={savedQueries}
            onOpenSavedQuery={handleOpenSavedQuery}
            onDeleteSavedQuery={handleDeleteSavedQuery}
            onRenameSavedQuery={handleRenameSavedQuery}
          />
        </ResizablePanel>

        <ResizableHandle className="w-px bg-border" />

        <ResizablePanel defaultSize={80}>
          <div className="flex flex-col h-full">
            <QueryTabBar
              tabs={tabs}
              activeId={activeTabId}
              onSelect={setActiveTabId}
              onClose={closeTab}
              dbTypeOf={t => connections.find(c => c.id === t.connectionId)?.dbType ?? t.dbType}
              colorOf={t => connectionColor(connections.find(c => c.id === t.connectionId)?.options)}
            />
            {activeTab && (() => {
              // The active tab's connection, when tagged: a colored strip, and its environment spelled out
              const conn = connections.find(c => c.id === activeTab.connectionId)
              const color = connectionColor(conn?.options)
              const env = environmentInfo(conn?.options?.environment)
              if (!conn || !color) return null
              return (
                <div className="flex items-center gap-2 px-3 h-5 shrink-0 text-[10px] font-semibold tracking-wide"
                  style={{ background: `color-mix(in oklch, ${color} 16%, transparent)`, borderBottom: `1px solid color-mix(in oklch, ${color} 45%, transparent)`, color }}>
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
                  {env ? env.label.toUpperCase() : 'CONNECTION'}
                  <span className="font-normal text-muted-foreground truncate">{conn.label || conn.name}{activeTab.databaseName ? ` · ${activeTab.databaseName}` : ''}</span>
                </div>
              )
            })()}
            {activeTab && (
              <div className="flex-1 min-h-0">
                <QueryPane
                  tab={activeTab}
                  connections={connections}
                  onChange={updateTab}
                  onSave={handleSaveQuery}
                  onPageChange={handlePageChange}
                  onOpenTable={handleOpenTable}
                  onOpenTableDesign={handleOpenTableDesign}
                  onOpenFunction={handleOpenFunction}
                  onSavedAsFunction={handleSavedAsFunction}
                  onRefreshDb={handleRefreshDb}
                  onAfterRun={(t, ok) => { if (ok && t.connectionId && t.databaseName) handleRefreshDb(t.connectionId, t.databaseName) }}
                  onClose={removeTab}
                  isSaved={savedQueries.some(q => q.id === activeTab.id)}
                  isActive={isActive}
                  runTrigger={runTrigger}
                  onSaveTableEdits={handleSaveTableEdits}
                  onTableSort={handleTableSort}
                  onUpdateSync={updateSync}
                  onUpdateDataSync={updateDataSync}
                  onTableChanged={handleTableChanged}
                />
              </div>
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>

      {showNewConn && (
        <NewConnectionDialog
          key={newConnPreset.key}
          initial={newConnPreset.initial}
          title={newConnPreset.title}
          onConnect={handleConnect}
          onClose={() => setShowNewConn(false)}
        />
      )}

      {dbAdmin && dbAdminRun && (() => {
        const conn = connections.find(c => c.id === dbAdmin.connId)
        if (!conn) return null
        const empty: DatabaseSettings = { name: '', owner: '', encoding: '', template: '', connectionLimit: -1, comment: '' }
        switch (dbAdmin.kind) {
          case 'create':
            return <DatabaseDialog mode="create" initial={empty} run={dbAdminRun} onSubmit={createDatabase} onClose={closeDbAdmin} />
          case 'edit':
            return (
              <DatabaseDialog
                mode="edit" initial={dbAdmin.initial} run={dbAdminRun} onSubmit={editDatabase} onClose={closeDbAdmin}
                lockedName={dbAdmin.dbName === connectionBaseDb(conn) ? "The connection logs into this database, so it can't be renamed from here. Edit the connection to use another database first." : undefined}
              />
            )
          case 'drop':
            return (
              <DropDatabaseDialog
                name={dbAdmin.dbName}
                openTabs={tabs.filter(t => t.connectionId === dbAdmin.connId && t.databaseName === dbAdmin.dbName && (t.kind !== 'query' || !!t.isFunction)).length}
                onDrop={dropDatabase} onClose={closeDbAdmin}
              />
            )
          case 'schema':
            return <SchemaDialog database={dbAdmin.dbName} run={dbAdminRun} onCreate={createSchema} onClose={closeDbAdmin} />
          case 'extensions':
            return (
              <ExtensionsDialog
                database={dbAdmin.dbName}
                schemas={conn.databases.find(d => d.name === dbAdmin.dbName)?.schemas.map(sc => sc.name) ?? []}
                run={dbAdminRun}
                onChanged={() => { extensionsChangedRef.current = true }}
                onClose={closeDbAdmin}
              />
            )
        }
      })()}

      {removeConnId && (() => {
        const conn = connections.find(c => c.id === removeConnId)
        const openTabs = tabs.filter(t => t.connectionId === removeConnId).length
        return conn ? (
          <ConfirmDialog
            message={`Delete the connection "${conn.label || conn.name}"?${openTabs > 0 ? ` Its ${openTabs} open tab${openTabs === 1 ? ' stays' : 's stay'} open without a connection.` : ''} This cannot be undone.`}
            onConfirm={confirmRemoveConn}
            onClose={() => setRemoveConnId(null)}
          />
        ) : null
      })()}

      {editConnId && (() => {
        const conn = connections.find(c => c.id === editConnId)
        return conn ? (
          <EditConnectionDialog
            conn={conn}
            onSave={handleEditSave}
            onDisconnectAndEdit={handleDisconnectAndEdit}
            onClose={() => setEditConnId(null)}
          />
        ) : null
      })()}

      {saveNameDialog && (
        <NameQueryDialog
          title="Save Query"
          initial={saveNameDialog.title}
          onConfirm={name => { commitSaveQuery(saveNameDialog, name); setSaveNameDialog(null) }}
          onClose={() => setSaveNameDialog(null)}
        />
      )}

      {renameDialog && (
        <NameQueryDialog
          title="Rename Query"
          initial={renameDialog.title}
          onConfirm={name => commitRename(renameDialog.id, name)}
          onClose={() => setRenameDialog(null)}
        />
      )}

      {newCollectionDialog && (
        <NameQueryDialog
          title="New Collection"
          initial=""
          placeholder="Collection name…"
          onConfirm={name => { createCollection(newCollectionDialog.connId, newCollectionDialog.dbName, name); setNewCollectionDialog(null) }}
          onClose={() => setNewCollectionDialog(null)}
        />
      )}

      {deleteConfirmId && (
        <ConfirmDialog
          message={`Delete "${savedQueries.find(q => q.id === deleteConfirmId)?.title ?? 'this query'}"? This cannot be undone.`}
          onConfirm={() => commitDeleteSavedQuery(deleteConfirmId)}
          onClose={() => setDeleteConfirmId(null)}
        />
      )}

      {unsavedCloseTab && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setUnsavedCloseTab(null)}
        >
          <div
            className="bg-card border border-border rounded-lg shadow-2xl w-[400px] overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150 text-card-foreground text-left"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-muted/20">
              <div className="flex flex-col text-left">
                <span className="text-sm font-semibold text-foreground">Unsaved Changes</span>
                <span className="text-xs text-muted-foreground mt-0.5 max-w-[320px] truncate">
                  {unsavedCloseTab.title}
                </span>
              </div>
              <button
                onClick={() => setUnsavedCloseTab(null)}
                className="text-muted-foreground hover:text-foreground transition-colors p-1 hover:bg-accent/40 rounded"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            
            <div className="p-5 text-left text-sm text-muted-foreground">
              You have unsaved changes. Do you want to save them before closing?
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-3 bg-muted/10 border-t border-border">
              <button
                onClick={() => setUnsavedCloseTab(null)}
                className="px-3 py-1.5 rounded text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const id = unsavedCloseTab.id
                  setUnsavedCloseTab(null)
                  setTabs(prev => {
                    const next = prev.filter(t => t.id !== id)
                    if (next.length === 0) {
                      setActiveTabId('')
                      return []
                    }
                    setActiveTabId(curr => curr === id ? next[next.length - 1].id : curr)
                    return next
                  })
                }}
                className="px-3 py-1.5 rounded text-xs bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
              >
                Discard
              </button>
              <button
                onClick={async () => {
                  const tab = unsavedCloseTab
                  setUnsavedCloseTab(null)
                  let success = false
                  if (tab.kind === 'design') {
                    success = await handleSaveDesign(tab)
                  } else if (tab.isFunction) {
                    success = await handleSaveFunction(tab)
                  } else if (tab.kind === 'table') {
                    success = await handleSaveTableEdits(tab)
                  } else {
                    handleSaveQuery(tab)
                    success = true
                  }
                  if (success) {
                    setTabs(prev => {
                      const next = prev.filter(t => t.id !== tab.id)
                      if (next.length === 0) {
                        setActiveTabId('')
                        return []
                      }
                      setActiveTabId(curr => curr === tab.id ? next[next.length - 1].id : curr)
                      return next
                    })
                  }
                }}
                className="px-3 py-1.5 rounded text-xs bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
