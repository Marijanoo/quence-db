'use client'

// Carries out MCP clients' UI commands in the window (see electron/mcp-ui-tools.ts): opening
// tables and queries, paging, pointing at cells, staging and saving edits, deleting rows and
// running code, all through the app's own actions so the user sees them happen. Writes in
// "ask" mode wait for the user's Allow in a dialog.
import React, { useEffect, useRef, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import type { DbConnection, QueryResult, QueryTab } from '@/components/database-view'
import { DialogShell, buttonCls, primaryCls } from '@/components/database-transfer'
import { buildMongoCellScript } from '@/lib/mongo-cell'
import { cellText } from '@/lib/grid-copy'
import { dataToolEnabled, type DataTool, type DataToolSettings } from '@/lib/mcp-data-tools'

type DbType = 'postgres' | 'mysql' | 'mongodb' | 'sqlite' | 'redis'
type Ipc = { query: (id: string, sql: string, database?: string, params?: unknown[]) => Promise<{ ok: boolean; rows?: Record<string, unknown>[]; fields?: string[]; rowCount?: number | null; ms?: number; error?: string; types?: Record<string, string>[] }> }

// What the database view lends the bridge
export interface McpAppApi {
  tabs(): QueryTab[]
  activeTabId(): string
  connections(): DbConnection[]
  setTabs: React.Dispatch<React.SetStateAction<QueryTab[]>>
  setActiveTabId(id: string): void
  reconnect(connId: string): Promise<void>
  disconnect(connId: string): Promise<void>
  runTableTab(tab: QueryTab, page?: number): Promise<void>
  sortTable(tab: QueryTab, column: string, dir: 'asc' | 'desc' | null): void
  saveTableEdits(tab: QueryTab): Promise<boolean>
  closeTab(id: string): void
  openErd(connId: string, database: string): void
  nextTabNumber(): number
  // helpers of the database view
  ipc(dbType: DbType): Ipc
  dbTypeOf(tab: QueryTab): DbType
  makeTab(n: number, connId: string, database: string | null): QueryTab
  makeTableTab(connId: string, database: string, schema: string, table: string, dbType: DbType): QueryTab
  cellEditKey(rowIndex: number, col: string): string
  splitSql(code: string): string[]
  processMongoRows(rows: Record<string, unknown>[]): { rows: Record<string, unknown>[]; fields: string[] }
  buildRowDelete(dbType: 'postgres' | 'mysql', schema: string, table: string, primaryKeys: string[], row: Record<string, unknown>): { sql: string; params: unknown[] }
  pageSize: number
}

type Args = Record<string, any> & { sharedConnectionIds: string[]; dataTools?: DataToolSettings }

class CommandError extends Error {}
const fail = (message: string): never => { throw new CommandError(message) }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Values as JSON: dates as ISO text, bytes as hex
function plain(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return isNaN(v.getTime()) ? String(v) : v.toISOString()
  if (v instanceof Uint8Array) return `\\x${Array.from(v, b => b.toString(16).padStart(2, '0')).join('')}`
  if (typeof v === 'string') return v.length > 2000 ? `${v.slice(0, 2000)}… (${v.length} chars)` : v
  if (typeof v === 'bigint') return v.toString()
  if (Array.isArray(v)) return v.map(plain)
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, plain(x)]))
  return v
}

interface Approval { id: number; title: string; target: string; details: string; resolve: (ok: boolean) => void }

export function McpBridge({ api }: { api: McpAppApi }) {
  const apiRef = useRef(api)
  useEffect(() => { apiRef.current = api })
  const [approvals, setApprovals] = useState<Approval[]>([])
  const nextApproval = useRef(1)

  useEffect(() => {
    const mcp = window.electronAPI?.mcp
    if (!mcp?.onUiRequest || !mcp.respond) return
    const askUser = (title: string, target: string, details: string) => new Promise<boolean>(resolve => {
      setApprovals(q => [...q, { id: nextApproval.current++, title, target, details, resolve }])
    })
    return mcp.onUiRequest(req => {
      runMcpCommand(apiRef.current, req.command, req.args as Args, askUser)
        .then(result => mcp.respond!(req.id, { ok: true, result }))
        .catch(err => mcp.respond!(req.id, { ok: false, error: err instanceof Error ? err.message : String(err) }))
    })
  }, [])

  const current = approvals[0]
  if (!current) return null
  const answer = (ok: boolean) => {
    current.resolve(ok)
    setApprovals(q => q.slice(1))
  }
  return (
    <DialogShell title={current.title} subtitle={current.target} busy={false} onClose={() => answer(false)} width="w-[560px]">
      <div className="px-5 py-4 space-y-3 overflow-y-auto">
        <div className="flex items-start gap-2 text-xs text-amber-300">
          <ShieldAlert className="h-4 w-4 shrink-0 mt-px" />
          <span>An MCP client (such as Claude) wants to change data. Nothing happens unless you allow it.</span>
        </div>
        <pre className="text-[11px] font-mono bg-background border border-border rounded px-2 py-1.5 whitespace-pre-wrap break-words max-h-80 overflow-y-auto">{current.details}</pre>
        {approvals.length > 1 && <p className="text-[11px] text-muted-foreground">{approvals.length - 1} more request{approvals.length > 2 ? 's' : ''} waiting</p>}
      </div>
      <div className="flex justify-end gap-2 px-5 py-3 border-t border-border shrink-0">
        <button onClick={() => answer(false)} className={buttonCls}>Deny</button>
        <button onClick={() => answer(true)} className={primaryCls} autoFocus>Allow</button>
      </div>
    </DialogShell>
  )
}

// ── Commands ──────────────────────────────────────────────────────────────────

export type AskUser = (title: string, target: string, details: string) => Promise<boolean>

export async function runMcpCommand(api: McpAppApi, command: string, args: Args, askUser: AskUser): Promise<unknown> {
  const shared = new Set(args.sharedConnectionIds)
  const conns = () => api.connections()
  // The name the sidebar shows, as list_connections reports it
  const labelOf = (c: DbConnection) => c.label || c.name
  const connName = (id: string | null) => { const c = conns().find(x => x.id === id); return c ? labelOf(c) : null }
  const connOf = (id: string) => conns().find(c => c.id === id) ?? fail('Unknown connection')
  const visible = (t: QueryTab) => !!t.connectionId && shared.has(t.connectionId)

  const findTab = (id: string) => {
    const t = api.tabs().find(x => x.id === id)
    if (!t || !visible(t)) fail(`No tab ${JSON.stringify(id)} (see app_state for the open tabs)`)
    return t!
  }
  // Throws if the tool is off for this connection, globally or by a per-connection override.
  // No settings sent (e.g. an older main process) means nothing is restricted.
  const requireDataTool = (tool: DataTool, connectionId: string | null) => {
    if (!args.dataTools) return
    if (!connectionId || !dataToolEnabled(args.dataTools, tool, connectionId)) {
      fail(`${tool} is turned off for "${connName(connectionId) ?? 'this connection'}" (QuenceDB → MCP → Data tools).`)
    }
  }
  // Waits until React has applied the change and the tab is idle
  const settle = async (id: string, done: (t: QueryTab) => boolean, timeoutMs = 60_000) => {
    const until = Date.now() + timeoutMs
    for (;;) {
      await sleep(40)
      const t = api.tabs().find(x => x.id === id)
      if (!t) fail('The tab was closed')
      if (done(t!)) return t!
      if (Date.now() > until) fail('Timed out waiting for the tab')
    }
  }
  const idle = (t: QueryTab) => !t.running && !t.savingEdits

  const defaultDb = (conn: DbConnection, database?: string) => {
    if (database) return database
    if (conn.databases.some(d => d.name === conn.database)) return conn.database
    return conn.database || conn.databases[0]?.name || fail('Say which database')
  }

  const summary = (t: QueryTab) => ({
    tab: t.id,
    title: t.title,
    kind: t.kind,
    active: t.id === api.activeTabId(),
    connection: connName(t.connectionId),
    database: t.databaseName,
    schema: t.kind === 'table' ? t.schemaName : undefined,
    table: t.tableName,
    page: t.kind === 'table' ? t.page ?? 0 : undefined,
    total_rows: t.totalRows,
    rows_loaded: t.results[0]?.rows.length,
    unsaved_changes: Object.keys(t.pendingEdits ?? {}).length || undefined,
    error: t.results.find(r => r.error)?.error,
  })

  const rowsOf = (t: QueryTab, index = 0) => t.results[index] ?? fail('This tab has no result yet')

  const preview = (r: QueryResult | undefined, n: number) => r && ({
    columns: r.fields,
    rows: r.rows.slice(0, n).map((row, i) => ({ row: i, ...(plain(Object.fromEntries(r.fields.map(f => [f, row[f]]))) as object) })),
    error: r.error,
  })

  // Runs code the way a query tab does and shows it in one; returns the results
  const runInNewTab = async (connId: string, database: string, code: string, precomputed?: QueryResult[]) => {
    const conn = connOf(connId)
    const tab: QueryTab = { ...api.makeTab(api.nextTabNumber(), connId, database), sql: code, originalSql: code, dbType: conn.dbType, running: !precomputed, results: precomputed ?? [] }
    api.setTabs(prev => [...prev, tab])
    api.setActiveTabId(tab.id)
    if (precomputed) return { tab: tab.id, results: precomputed }
    const ipc = api.ipc(conn.dbType)
    const statements = conn.dbType === 'mongodb' ? [code] : api.splitSql(code)
    const results: QueryResult[] = []
    for (const statement of statements) {
      const res = await ipc.query(connId, statement, database)
      if (!res.ok) { results.push({ fields: [], rows: [], rowCount: null, ms: 0, error: res.error, statement }); break }
      const { rows, fields } = conn.dbType === 'mongodb' && (res.rows ?? []).length
        ? api.processMongoRows(res.rows ?? [])
        : { rows: res.rows ?? [], fields: res.fields ?? [] }
      results.push({ fields, rows, rowCount: res.rowCount ?? null, ms: res.ms ?? 0, statement })
    }
    api.setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, running: false, results } : t))
    return { tab: tab.id, results }
  }
  const resultSummary = (results: QueryResult[]) => results.map(r => ({
    statement: r.statement && r.statement.length > 200 ? r.statement.slice(0, 200) + '…' : r.statement,
    error: r.error,
    row_count: r.rowCount,
    rows: r.error ? undefined : r.rows.slice(0, 20).map(row => plain(row)),
  }))

  const tableTab = (id: string) => {
    const t = findTab(id)
    if (t.kind !== 'table') fail('This is not a table tab (open_table opens one)')
    return t
  }
  const describeEdits = (t: QueryTab) => {
    const r = t.results[0]
    const lines: string[] = []
    const byRow = new Map<number, { col: string; value: string | null }[]>()
    for (const e of Object.values(t.pendingEdits ?? {})) byRow.set(e.rowIndex, [...(byRow.get(e.rowIndex) ?? []), e])
    for (const [rowIndex, edits] of [...byRow].sort((a, b) => a[0] - b[0])) {
      const row = r?.rows[rowIndex]
      if (!row) {
        lines.push(`INSERT new row: ${edits.map(e => `${e.col} = ${e.value === null ? 'NULL' : JSON.stringify(e.value)}`).join(', ')}`)
        continue
      }
      const key = (t.primaryKeys?.length ? t.primaryKeys : ['_id']).map(k => `${k}=${cellText(row[k])}`).join(', ')
      lines.push(`UPDATE row ${rowIndex} (${key}):`)
      for (const e of edits) lines.push(`  ${e.col}: ${JSON.stringify(cellText(row[e.col]))} → ${e.value === null ? 'NULL' : JSON.stringify(e.value)}`)
    }
    return lines.join('\n')
  }

  switch (command) {
    case 'state': {
      const tabs = api.tabs()
      return {
        active_tab: tabs.find(t => t.id === api.activeTabId() && visible(t))?.id ?? null,
        tabs: tabs.filter(visible).map(summary),
        other_tabs: tabs.filter(t => !visible(t)).length || undefined,
        connections: conns().filter(c => shared.has(c.id)).map(c => ({
          name: labelOf(c), type: c.dbType, status: c.status, error: c.errorMsg,
          databases: c.databases.map(d => d.name),
        })),
      }
    }

    case 'connect': {
      const conn = connOf(args.connectionId)
      if (conn.status !== 'connected') {
        await api.reconnect(conn.id)
        for (let i = 0; i < 200; i++) {
          const c = connOf(conn.id)
          if (c.status === 'connected') break
          if (c.status === 'error') fail(`Could not connect: ${c.errorMsg ?? 'unknown error'}`)
          await sleep(100)
        }
      }
      const c = connOf(conn.id)
      return { connection: labelOf(c), status: c.status, databases: c.databases.map(d => d.name) }
    }

    case 'disconnect': {
      await api.disconnect(args.connectionId)
      return { connection: connName(args.connectionId), status: 'disconnected' }
    }

    case 'openTable': {
      const conn = connOf(args.connectionId)
      const database = defaultDb(conn, args.database)
      const schema = conn.dbType === 'postgres' ? (args.schema || 'public') : database
      const existing = api.tabs().find(t => t.kind === 'table' && t.connectionId === conn.id && t.databaseName === database && t.schemaName === schema && t.tableName === args.table)
      let id: string
      if (existing) {
        id = existing.id
        api.setActiveTabId(id)
      } else {
        const tab = api.makeTableTab(conn.id, database, schema, args.table, conn.dbType)
        id = tab.id
        api.setTabs(prev => [...prev, tab])
        api.setActiveTabId(id)
        await sleep(0)
        await api.runTableTab(tab)
      }
      const t = await settle(id, t => idle(t) && t.results.length > 0)
      return { ...summary(t), ...preview(t.results[0], args.previewRows ?? 10) }
    }

    case 'openQuery': {
      const conn = connOf(args.connectionId)
      const database = defaultDb(conn, args.database)
      const tab: QueryTab = { ...api.makeTab(api.nextTabNumber(), conn.id, database), sql: args.code, originalSql: '', dbType: conn.dbType }
      api.setTabs(prev => [...prev, tab])
      api.setActiveTabId(tab.id)
      return { tab: tab.id, title: tab.title }
    }

    case 'showResult': {
      const rows = (args.rows as Record<string, unknown>[]) ?? []
      const fields = rows.length ? Object.keys(rows[0]) : []
      const res = await runInNewTab(args.connectionId, args.database, args.code, [{ fields, rows, rowCount: rows.length, ms: 0, statement: args.code }])
      return { tab: res.tab }
    }

    case 'openErd': {
      const conn = connOf(args.connectionId)
      const database = defaultDb(conn, args.database)
      const before = new Set(api.tabs().map(t => t.id))
      api.openErd(conn.id, database)
      await sleep(100)
      const erd = api.tabs().find(t => t.kind === 'erd' && t.connectionId === conn.id && t.databaseName === database)
      return { tab: erd?.id ?? null, opened: erd ? !before.has(erd.id) : false }
    }

    case 'focusTab': {
      const t = findTab(args.tab)
      api.setActiveTabId(t.id)
      return { tab: t.id, active: true }
    }

    case 'closeTab': {
      const t = findTab(args.tab)
      api.closeTab(t.id)
      await sleep(100)
      const closed = !api.tabs().some(x => x.id === t.id)
      return closed ? { tab: t.id, closed: true } : { tab: t.id, closed: false, reason: 'It has unsaved changes; the user was asked what to do' }
    }

    case 'readTab': {
      const t = findTab(args.tab)
      const result = t.results.length ? t.results[t.results.length > 1 ? t.results.length - 1 : 0] : undefined
      const offset = args.offset ?? 0
      const limit = args.limit ?? 100
      const pending = Object.values(t.pendingEdits ?? {})
      return {
        ...summary(t),
        page_size: t.kind === 'table' ? t.pageSize ?? api.pageSize : undefined,
        sort: t.tableSort,
        primary_key: t.primaryKeys,
        columns: result?.fields.map(f => ({ name: f, type: t.columnTypes?.find(c => c.name === f)?.type ?? result.types?.[0]?.[f] })),
        rows: result?.rows.slice(offset, offset + limit).map((row, i) => ({ row: offset + i, ...(plain(Object.fromEntries(result.fields.map(f => [f, row[f]]))) as object) })),
        more_rows: result ? result.rows.length > offset + limit : undefined,
        unsaved_changes: pending.length ? pending.map(e => ({ row: e.rowIndex, column: e.col, value: e.value, new_row: e.rowIndex >= (result?.rows.length ?? 0) || undefined })) : undefined,
        results: t.results.length > 1 ? t.results.map((r, i) => ({ index: i, statement: r.statement, row_count: r.rowCount, error: r.error })) : undefined,
      }
    }

    case 'setPage': {
      const t = tableTab(args.tab)
      if (Object.keys(t.pendingEdits ?? {}).length) fail('The tab has unsaved changes; save or discard them first')
      api.setActiveTabId(t.id)
      await api.runTableTab(t, args.page)
      const done = await settle(t.id, x => idle(x) && (x.page ?? 0) === args.page)
      return { ...summary(done), ...preview(done.results[0], 5) }
    }

    case 'sortTable': {
      const t = tableTab(args.tab)
      if (Object.keys(t.pendingEdits ?? {}).length) fail('The tab has unsaved changes; save or discard them first')
      if (!t.results[0]?.fields.includes(args.column)) fail(`No column ${JSON.stringify(args.column)} in this table`)
      api.setActiveTabId(t.id)
      api.sortTable(t, args.column, args.direction === 'none' ? null : args.direction)
      await sleep(50)
      const done = await settle(t.id, idle)
      return { ...summary(done), sort: done.tableSort ?? null, ...preview(done.results[0], 5) }
    }

    case 'selectCell': {
      const t = findTab(args.tab)
      const r = rowsOf(t)
      if (!r.fields.includes(args.column)) fail(`No column ${JSON.stringify(args.column)} (columns: ${r.fields.join(', ')})`)
      const row = r.rows[args.row] ?? fail(`No row ${args.row}; the tab has rows 0 to ${r.rows.length - 1}`)
      api.setActiveTabId(t.id)
      api.setTabs(prev => prev.map(x => x.id === t.id ? { ...x, focusCell: { row: args.row, col: args.column, nonce: Date.now() } } : x))
      const pending = t.pendingEdits?.[api.cellEditKey(args.row, args.column)]
      return {
        tab: t.id, row: args.row, column: args.column,
        value: plain(row[args.column]),
        unsaved_value: pending ? pending.value : undefined,
        row_values: plain(Object.fromEntries(r.fields.map(f => [f, row[f]]))),
      }
    }

    case 'editCells': {
      const t = tableTab(args.tab)
      requireDataTool('edit_cells', t.connectionId)
      const r = rowsOf(t)
      const dbType = api.dbTypeOf(t)
      if (dbType !== 'mongodb' && !(t.primaryKeys?.length)) fail('This table has no primary key, so its rows can\'t be edited')
      if (t.savingEdits) fail('The tab is saving; try again in a moment')
      const pendingNew = Object.values(t.pendingEdits ?? {}).filter(e => e.rowIndex >= r.rows.length).map(e => e.rowIndex)
      const lastRow = Math.max(r.rows.length - 1, ...pendingNew)
      const next = { ...(t.pendingEdits ?? {}) }
      for (const e of args.edits as { row: number; column: string; value: unknown }[]) {
        if (e.row > lastRow) fail(`No row ${e.row} (use insert_rows to add rows)`)
        if (!r.fields.includes(e.column)) fail(`No column ${JSON.stringify(e.column)} (columns: ${r.fields.join(', ')})`)
        if (dbType === 'mongodb' && (e.column === '_id' || e.column.startsWith('_id.'))) fail("_id can't be changed")
        const text = e.value === null || e.value === undefined ? null : String(e.value)
        const key = api.cellEditKey(e.row, e.column)
        const row = r.rows[e.row]
        const unchanged = row && (text === null ? row[e.column] === null || row[e.column] === undefined : row[e.column] !== null && row[e.column] !== undefined && text === cellText(row[e.column]))
        if (unchanged) delete next[key]
        else next[key] = { rowIndex: e.row, col: e.column, value: text }
      }
      api.setActiveTabId(t.id)
      api.setTabs(prev => prev.map(x => x.id === t.id ? { ...x, pendingEdits: Object.keys(next).length ? next : undefined, editError: undefined } : x))
      return { tab: t.id, unsaved_changes: Object.keys(next).length, note: 'Staged, not saved. Call save_table_changes to write them.' }
    }

    case 'insertRows': {
      const t = tableTab(args.tab)
      requireDataTool('insert_rows', t.connectionId)
      const r = rowsOf(t)
      if (api.dbTypeOf(t) === 'mongodb') fail('Adding documents here is not supported; use execute with insertOne/insertMany')
      if (!(t.primaryKeys?.length)) fail("This table has no primary key, so rows can't be added here; use execute with an INSERT")
      const pendingNew = Object.values(t.pendingEdits ?? {}).filter(e => e.rowIndex >= r.rows.length).map(e => e.rowIndex)
      let index = Math.max(r.rows.length - 1, ...pendingNew) + 1
      const next = { ...(t.pendingEdits ?? {}) }
      const added: number[] = []
      for (const values of args.rows as Record<string, unknown>[]) {
        const entries = Object.entries(values)
        if (!entries.length) fail('A new row needs at least one value')
        for (const [col, v] of entries) {
          if (!r.fields.includes(col)) fail(`No column ${JSON.stringify(col)} (columns: ${r.fields.join(', ')})`)
          next[api.cellEditKey(index, col)] = { rowIndex: index, col, value: v === null || v === undefined ? null : String(v) }
        }
        added.push(index++)
      }
      api.setActiveTabId(t.id)
      api.setTabs(prev => prev.map(x => x.id === t.id ? { ...x, pendingEdits: next, editError: undefined } : x))
      return { tab: t.id, new_rows: added, note: 'Staged, not saved. Call save_table_changes to insert them.' }
    }

    case 'discardChanges': {
      const t = findTab(args.tab)
      api.setTabs(prev => prev.map(x => x.id === t.id ? { ...x, pendingEdits: undefined, editError: undefined, insertError: undefined } : x))
      return { tab: t.id, discarded: Object.keys(t.pendingEdits ?? {}).length }
    }

    case 'saveChanges': {
      const t = tableTab(args.tab)
      requireDataTool('save_table_changes', t.connectionId)
      if (!Object.keys(t.pendingEdits ?? {}).length) fail('The tab has no unsaved changes')
      api.setActiveTabId(t.id)
      if (args.approval === 'ask' && !await askUser('Save changes?', `${connName(t.connectionId)} · ${t.schemaName}.${t.tableName}`, describeEdits(t))) {
        return { saved: false, denied: true, note: 'The user did not allow it. The changes are still staged.' }
      }
      const latest = api.tabs().find(x => x.id === t.id)!
      const ok = await api.saveTableEdits(latest)
      const after = await settle(t.id, idle)
      return {
        saved: ok,
        error: after.editError?.message ?? after.insertError,
        unsaved_changes: Object.keys(after.pendingEdits ?? {}).length,
      }
    }

    case 'deleteRows': {
      const t = tableTab(args.tab)
      requireDataTool('delete_rows', t.connectionId)
      const r = rowsOf(t)
      const dbType = api.dbTypeOf(t)
      if (Object.keys(t.pendingEdits ?? {}).length) fail('The tab has unsaved changes; save or discard them first')
      if (dbType !== 'mongodb' && !(t.primaryKeys?.length)) fail("This table has no primary key, so rows can't be deleted here; use execute with a DELETE")
      const rows = [...new Set(args.rows as number[])].map(i => ({ i, row: r.rows[i] ?? fail(`No row ${i}`) }))
      const keys = dbType === 'mongodb' ? ['_id'] : t.primaryKeys!
      api.setActiveTabId(t.id)
      const details = rows.map(({ i, row }) => `DELETE row ${i} (${keys.map(k => `${k}=${cellText(row[k])}`).join(', ')})`).join('\n')
      if (args.approval === 'ask' && !await askUser(`Delete ${rows.length} row${rows.length === 1 ? '' : 's'}?`, `${connName(t.connectionId)} · ${t.schemaName}.${t.tableName}`, details)) {
        return { deleted: 0, denied: true }
      }
      const ipc = api.ipc(dbType)
      let deleted = 0
      const errors: string[] = []
      for (const { i, row } of rows) {
        const res = dbType === 'mongodb'
          ? await ipc.query(t.connectionId!, buildMongoCellScript(t.tableName!, row._id, r.types?.[i]?._id, { kind: 'deleteDocument' }), t.databaseName ?? undefined)
          : await (() => { const d = api.buildRowDelete(dbType === 'mysql' ? 'mysql' : 'postgres', t.schemaName!, t.tableName!, t.primaryKeys!, row); return ipc.query(t.connectionId!, d.sql, t.databaseName ?? undefined, d.params) })()
        if (!res.ok) { errors.push(`row ${i}: ${res.error}`); continue }
        deleted += dbType === 'mongodb' ? Number(res.rows?.[0]?.deletedCount ?? 0) : (res.rowCount ?? 0)
      }
      await api.runTableTab({ ...t, totalRows: undefined }, t.page ?? 0)
      await settle(t.id, idle)
      return { deleted, errors: errors.length ? errors : undefined }
    }

    case 'execute': {
      const conn = connOf(args.connectionId)
      requireDataTool('execute', conn.id)
      const database = defaultDb(conn, args.database)
      if (args.approval === 'ask' && !await askUser(conn.dbType === 'mongodb' ? 'Run MongoDB code?' : 'Run SQL?', `${labelOf(conn)} · ${database}`, args.code)) {
        return { ran: false, denied: true }
      }
      const res = await runInNewTab(conn.id, database, args.code)
      return { tab: res.tab, results: resultSummary(res.results) }
    }

    default:
      return fail(`Unknown command ${command}`)
  }
}
