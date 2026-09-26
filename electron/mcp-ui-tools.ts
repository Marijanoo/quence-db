// MCP tools that drive the QuenceDB window: open tables and queries, page and sort, point at
// cells, and make changes the way a user would (staged edits, Save, Delete, running code in a
// query tab), so the user watches it happen. The window does the work (components/mcp-bridge.tsx);
// this side checks sharing and the write mode, and forwards the command.
//
// Writes follow the MCP panel's write mode: off refuses them, ask shows an Allow/Deny dialog in
// the app for each one (the window handles that), allow runs them.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { findConnection, McpToolError, type McpBackend } from './mcp-tools'
import type { McpWriteMode } from './mcp-settings'

export interface UiBridge {
  // Runs a command in the window; rejects when there is no window or the command fails
  request(command: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
  writeMode(): McpWriteMode
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }
type Register = (name: string, config: {
  title: string; description: string; inputSchema?: Record<string, z.ZodTypeAny>
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean; idempotentHint?: boolean }
}, cb: (args: any) => Promise<ToolResult>) => void
type Wrap = <A>(name: string, describe: (a: A) => { connection?: string; detail?: string }, fn: (a: A) => Promise<ToolResult>) => (a: A) => Promise<ToolResult>

const json = (v: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 1) }] })

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

export const UI_INSTRUCTIONS = `You can also drive the QuenceDB window; the user sees everything you do there.
app_state shows the open tabs (their ids are what the tab tools take). open_table opens a table in a tab and shows its first rows;
read_tab reads what a tab shows, with row numbers; select_cell points at one cell. Rows are numbered from 0 within the loaded page.
Changing data: edit_cells / insert_rows stage changes (shown as unsaved, amber) and save_table_changes saves them; delete_rows deletes rows;
execute runs any SQL or MongoDB shell code in a query tab. Depending on the user's settings, writes are off, need their approval in the app, or run directly.`

export function registerUiTools(server: McpServer, register: Register, tool: Wrap, backend: McpBackend, ui: UiBridge) {
  void server
  const view = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  const write = { readOnlyHint: false, destructiveHint: true, openWorldHint: false }

  const connected = (ref: string) => findConnection(backend, ref)
  const known = (ref: string) => findConnection(backend, ref, { requireConnected: false })
  const writesAllowed = (): 'ask' | 'allow' => {
    const mode = ui.writeMode()
    if (mode === 'off') throw new McpToolError('Changing data is turned off. The user can allow it in QuenceDB → MCP → Writes.')
    return mode
  }
  const run = async (command: string, args: Record<string, unknown>, timeoutMs?: number) => json(await ui.request(command, args, timeoutMs))

  const connection = z.string().describe('Connection name, as shown by list_connections')
  const database = z.string().optional().describe("Database; defaults to the connection's current database in the app")
  const tab = z.string().describe('Tab id, from app_state or open_table')
  const row = z.number().int().min(0).describe('Row number within the loaded page, from 0 (as read_tab shows)')
  const value = z.union([z.string(), z.number(), z.boolean(), z.null()]).describe('New value (null for NULL); sent as text and converted to the column type')

  // ── Looking around ──
  register('app_state', {
    title: 'What is open in QuenceDB',
    description: "The app's open tabs (id, kind, connection, database, table, page, unsaved changes), which one is active, and the shared connections with their databases.",
    annotations: view,
  }, tool('app_state', () => ({}), () => run('state', {})))

  register('read_tab', {
    title: 'Read a tab',
    description: 'The rows a tab currently shows (a table page or query result), numbered from 0, with column names, types, paging and any unsaved changes.',
    inputSchema: { tab, offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).optional().describe('Rows to return (default 100)') },
    annotations: view,
  }, tool('read_tab', (a: { tab: string }) => ({ detail: a.tab }), (a: { tab: string; offset?: number; limit?: number }) => run('readTab', a)))

  // ── Navigating ──
  register('connect', {
    title: 'Connect',
    description: 'Connects a shared connection in the app (as clicking it in the sidebar would).',
    inputSchema: { connection },
    annotations: { ...view, idempotentHint: true },
  }, tool('connect', (a: { connection: string }) => ({ connection: a.connection }), async (a: { connection: string }) =>
    run('connect', { connectionId: known(a.connection).id }, 60_000)))

  register('disconnect', {
    title: 'Disconnect',
    description: 'Disconnects a shared connection in the app.',
    inputSchema: { connection },
    annotations: { ...view, idempotentHint: true },
  }, tool('disconnect', (a: { connection: string }) => ({ connection: a.connection }), async (a: { connection: string }) =>
    run('disconnect', { connectionId: known(a.connection).id })))

  register('open_table', {
    title: 'Open a table',
    description: 'Opens a table, view or MongoDB collection in a tab (or switches to it if open) and returns the tab id and its first rows.',
    inputSchema: {
      connection, table: z.string(), database,
      schema: z.string().optional().describe('PostgreSQL schema (default public)'),
      preview_rows: z.number().int().min(0).max(100).optional().describe('Rows to return (default 10)'),
    },
    annotations: view,
  }, tool('open_table', (a: { connection: string; table: string }) => ({ connection: a.connection, detail: a.table }),
    async (a: { connection: string; table: string; database?: string; schema?: string; preview_rows?: number }) =>
      run('openTable', { connectionId: connected(a.connection).id, table: a.table, database: a.database, schema: a.schema, previewRows: a.preview_rows ?? 10 }, 60_000)))

  register('open_query', {
    title: 'Open a query tab',
    description: 'Opens a new query tab with SQL (or MongoDB shell code) in the editor, without running it. Use execute to run code that changes data, or run_query with show_in_app for read queries.',
    inputSchema: { connection, code: z.string().describe('SQL or MongoDB shell code for the editor'), database },
    annotations: view,
  }, tool('open_query', (a: { connection: string; code: string }) => ({ connection: a.connection, detail: a.code.slice(0, 300) }),
    async (a: { connection: string; code: string; database?: string }) => run('openQuery', { connectionId: connected(a.connection).id, code: a.code, database: a.database })))

  register('open_er_diagram', {
    title: 'Open the ER diagram',
    description: 'Opens the entity-relationship diagram of a database.',
    inputSchema: { connection, database },
    annotations: view,
  }, tool('open_er_diagram', (a: { connection: string }) => ({ connection: a.connection }),
    async (a: { connection: string; database?: string }) => run('openErd', { connectionId: connected(a.connection).id, database: a.database })))

  register('focus_tab', {
    title: 'Switch to a tab',
    description: 'Makes a tab the active one.',
    inputSchema: { tab },
    annotations: { ...view, idempotentHint: true },
  }, tool('focus_tab', (a: { tab: string }) => ({ detail: a.tab }), (a: { tab: string }) => run('focusTab', a)))

  register('close_tab', {
    title: 'Close a tab',
    description: 'Closes a tab. A tab with unsaved changes is not closed; the user is asked instead.',
    inputSchema: { tab },
    annotations: view,
  }, tool('close_tab', (a: { tab: string }) => ({ detail: a.tab }), (a: { tab: string }) => run('closeTab', a)))

  register('set_table_page', {
    title: 'Go to a page',
    description: 'Shows another page of a table tab (pages hold 200 rows; the first page is 0).',
    inputSchema: { tab, page: z.number().int().min(0) },
    annotations: view,
  }, tool('set_table_page', (a: { tab: string; page: number }) => ({ detail: `${a.tab} page ${a.page}` }), (a: { tab: string; page: number }) => run('setPage', a, 60_000)))

  register('sort_table', {
    title: 'Sort a table',
    description: 'Sorts a table tab by a column, on the server (the whole table, not just the page).',
    inputSchema: { tab, column: z.string(), direction: z.enum(['asc', 'desc', 'none']) },
    annotations: view,
  }, tool('sort_table', (a: { tab: string; column: string; direction: string }) => ({ detail: `${a.tab} ${a.column} ${a.direction}` }),
    (a: { tab: string; column: string; direction: string }) => run('sortTable', a, 60_000)))

  register('select_cell', {
    title: 'Point at a cell',
    description: 'Scrolls a tab to a cell, highlights it for the user, and returns its value with the rest of the row.',
    inputSchema: { tab, row, column: z.string() },
    annotations: view,
  }, tool('select_cell', (a: { tab: string; row: number; column: string }) => ({ detail: `${a.tab} row ${a.row} ${a.column}` }),
    (a: { tab: string; row: number; column: string }) => run('selectCell', a)))

  // ── Changing data ──
  register('edit_cells', {
    title: 'Edit cells',
    description: 'Stages new values for cells of a table tab. They show as unsaved changes; nothing is written until save_table_changes.',
    inputSchema: { tab, edits: z.array(z.object({ row, column: z.string(), value })).min(1).max(1000) },
    annotations: { ...view, readOnlyHint: false },
  }, tool('edit_cells', (a: { tab: string; edits: unknown[] }) => ({ detail: `${a.tab}: ${a.edits.length} cell(s)` }),
    async (a: { tab: string; edits: unknown[] }) => { writesAllowed(); return run('editCells', a) }))

  register('insert_rows', {
    title: 'Add rows',
    description: 'Stages new rows in a table tab, as column → value objects (columns left out get their default). Nothing is written until save_table_changes.',
    inputSchema: { tab, rows: z.array(z.record(z.string(), value)).min(1).max(500) },
    annotations: { ...view, readOnlyHint: false },
  }, tool('insert_rows', (a: { tab: string; rows: unknown[] }) => ({ detail: `${a.tab}: ${a.rows.length} row(s)` }),
    async (a: { tab: string; rows: unknown[] }) => { writesAllowed(); return run('insertRows', a) }))

  register('discard_table_changes', {
    title: 'Discard unsaved changes',
    description: "Throws away a table tab's unsaved changes.",
    inputSchema: { tab },
    annotations: { ...view, idempotentHint: true },
  }, tool('discard_table_changes', (a: { tab: string }) => ({ detail: a.tab }), (a: { tab: string }) => run('discardChanges', a)))

  register('save_table_changes', {
    title: 'Save changes',
    description: "Saves a table tab's unsaved edits and new rows to the database (like Ctrl+S). May need the user's approval in the app.",
    inputSchema: { tab },
    annotations: write,
  }, tool('save_table_changes', (a: { tab: string }) => ({ detail: a.tab }),
    async (a: { tab: string }) => run('saveChanges', { ...a, approval: writesAllowed() }, APPROVAL_TIMEOUT_MS)))

  register('delete_rows', {
    title: 'Delete rows',
    description: 'Deletes rows of a table tab from the database, by their primary key (MongoDB: _id). May need the user\'s approval in the app.',
    inputSchema: { tab, rows: z.array(row).min(1).max(500) },
    annotations: write,
  }, tool('delete_rows', (a: { tab: string; rows: number[] }) => ({ detail: `${a.tab}: rows ${a.rows.join(', ')}` }),
    async (a: { tab: string; rows: number[] }) => run('deleteRows', { ...a, approval: writesAllowed() }, APPROVAL_TIMEOUT_MS)))

  register('execute', {
    title: 'Run code that changes data',
    description: 'Runs SQL (any statements, e.g. INSERT, UPDATE, CREATE TABLE) or MongoDB shell code in a query tab the user can see, and returns the results. May need the user\'s approval in the app.',
    inputSchema: { connection, code: z.string(), database },
    annotations: write,
  }, tool('execute', (a: { connection: string; code: string }) => ({ connection: a.connection, detail: a.code.slice(0, 500) }),
    async (a: { connection: string; code: string; database?: string }) =>
      run('execute', { connectionId: connected(a.connection).id, code: a.code, database: a.database, approval: writesAllowed() }, APPROVAL_TIMEOUT_MS)))
}
