// The window side of MCP UI commands, against an in-memory stand-in for the database view
import { describe, expect, it } from 'vitest'
import { runMcpCommand, type McpAppApi } from './mcp-bridge'
import type { DbConnection, QueryTab } from './database-view'

const key = (r: number, c: string) => `${r}\u0000${c}`

function fakeApp() {
  const connections: DbConnection[] = [
    { id: 'c1', dbType: 'postgres', label: 'Shop', name: 'Shop', host: '', port: 5432, database: 'shop', user: '', password: '', ssl: false, status: 'connected', databases: [] } as unknown as DbConnection,
    { id: 'c2', dbType: 'postgres', label: 'Private', name: 'Private', host: '', port: 5432, database: 'p', user: '', password: '', ssl: false, status: 'connected', databases: [] } as unknown as DbConnection,
  ]
  const table: QueryTab = {
    id: 't1', kind: 'table', title: 'items', sql: '', running: false, connectionId: 'c1', databaseName: 'shop', schemaName: 'public', tableName: 'items',
    page: 0, totalRows: 2, primaryKeys: ['id'], originalSql: '',
    results: [{ fields: ['id', 'name', 'price'], rows: [{ id: 1, name: 'Pen', price: '1.50' }, { id: 2, name: 'Cup', price: null }], rowCount: 2, ms: 1 }],
  } as QueryTab
  const hidden: QueryTab = { ...table, id: 't2', connectionId: 'c2' }
  let tabs: QueryTab[] = [table, hidden]
  let active = 't1'
  const executed: { sql: string; params?: unknown[] }[] = []
  let saved = 0
  const api: McpAppApi = {
    tabs: () => tabs,
    activeTabId: () => active,
    connections: () => connections,
    setTabs: u => { tabs = typeof u === 'function' ? u(tabs) : u },
    setActiveTabId: id => { active = id },
    reconnect: async () => {},
    disconnect: async () => {},
    runTableTab: async () => {},
    sortTable: () => {},
    saveTableEdits: async t => { saved++; tabs = tabs.map(x => x.id === t.id ? { ...x, pendingEdits: undefined } : x); return true },
    closeTab: id => { tabs = tabs.filter(t => t.id !== id) },
    openErd: () => {},
    nextTabNumber: () => 7,
    ipc: () => ({ query: async (_id, sql, _db, params) => { executed.push({ sql, params }); return { ok: true, rows: [{ n: 1 }], fields: ['n'], rowCount: 1, ms: 1 } } }),
    dbTypeOf: () => 'postgres',
    makeTab: (n, connId, db) => ({ id: `q${n}`, kind: 'query', title: `Query ${n}`, sql: '', results: [], running: false, connectionId: connId, databaseName: db, originalSql: '' }) as QueryTab,
    makeTableTab: (c, d, s, t) => ({ ...table, id: 'new', connectionId: c, databaseName: d, schemaName: s, tableName: t }) as QueryTab,
    cellEditKey: key,
    splitSql: code => code.split(';').map(s => s.trim()).filter(Boolean),
    processMongoRows: rows => ({ rows, fields: Object.keys(rows[0] ?? {}) }),
    buildRowDelete: (_t, schema, table, pks, row) => ({ sql: `DELETE FROM ${schema}.${table} WHERE ${pks[0]} = $1`, params: [row[pks[0]]] }),
    pageSize: 200,
  }
  const shared = { sharedConnectionIds: ['c1'] }
  const yes = async () => true
  return { api, shared, yes, get tabs() { return tabs }, get active() { return active }, executed, get saved() { return saved } }
}

describe('MCP window commands', () => {
  it('shows only tabs and connections that are shared', async () => {
    const app = fakeApp()
    const state = await runMcpCommand(app.api, 'state', app.shared, app.yes) as { tabs: { tab: string }[]; other_tabs: number; connections: { name: string }[] }
    expect(state.tabs.map(t => t.tab)).toEqual(['t1'])
    expect(state.other_tabs).toBe(1)
    expect(state.connections.map(c => c.name)).toEqual(['Shop'])
    await expect(runMcpCommand(app.api, 'readTab', { ...app.shared, tab: 't2' }, app.yes)).rejects.toThrow(/No tab/)
  })

  it('reads rows with their numbers and points at a cell', async () => {
    const app = fakeApp()
    const read = await runMcpCommand(app.api, 'readTab', { ...app.shared, tab: 't1', offset: 1 }, app.yes) as { rows: unknown[] }
    expect(read.rows).toEqual([{ row: 1, id: 2, name: 'Cup', price: null }])
    const cell = await runMcpCommand(app.api, 'selectCell', { ...app.shared, tab: 't1', row: 0, column: 'price' }, app.yes)
    expect(cell).toMatchObject({ value: '1.50', row_values: { id: 1, name: 'Pen', price: '1.50' } })
    expect(app.tabs[0].focusCell).toMatchObject({ row: 0, col: 'price' })
    await expect(runMcpCommand(app.api, 'selectCell', { ...app.shared, tab: 't1', row: 5, column: 'price' }, app.yes)).rejects.toThrow(/No row 5/)
  })

  it('stages edits and new rows, drops edits back to the original value, and saves only when allowed', async () => {
    const app = fakeApp()
    await runMcpCommand(app.api, 'editCells', { ...app.shared, tab: 't1', edits: [{ row: 0, column: 'price', value: 2 }, { row: 1, column: 'name', value: 'Cup' }, { row: 1, column: 'price', value: null }] }, app.yes)
    expect(app.tabs[0].pendingEdits).toEqual({ [key(0, 'price')]: { rowIndex: 0, col: 'price', value: '2' } })
    const inserted = await runMcpCommand(app.api, 'insertRows', { ...app.shared, tab: 't1', rows: [{ name: 'Mug', price: 3 }, { name: 'Box' }] }, app.yes) as { new_rows: number[] }
    expect(inserted.new_rows).toEqual([2, 3])
    expect(app.tabs[0].pendingEdits?.[key(3, 'name')]).toEqual({ rowIndex: 3, col: 'name', value: 'Box' })

    let shown = ''
    const denied = await runMcpCommand(app.api, 'saveChanges', { ...app.shared, tab: 't1', approval: 'ask' }, async (_t, _target, details) => { shown = details; return false })
    expect(denied).toMatchObject({ saved: false, denied: true })
    expect(app.saved).toBe(0)
    expect(shown).toContain('price: "1.50" → "2"')
    expect(shown).toContain('INSERT new row: name = "Mug", price = "3"')

    expect(await runMcpCommand(app.api, 'saveChanges', { ...app.shared, tab: 't1', approval: 'ask' }, app.yes)).toMatchObject({ saved: true })
    expect(app.saved).toBe(1)
  })

  it('refuses edits to unknown rows and columns', async () => {
    const app = fakeApp()
    await expect(runMcpCommand(app.api, 'editCells', { ...app.shared, tab: 't1', edits: [{ row: 9, column: 'name', value: 'x' }] }, app.yes)).rejects.toThrow(/insert_rows/)
    await expect(runMcpCommand(app.api, 'editCells', { ...app.shared, tab: 't1', edits: [{ row: 0, column: 'nope', value: 'x' }] }, app.yes)).rejects.toThrow(/No column/)
  })

  it('deletes rows by primary key after approval, and not at all when denied', async () => {
    const app = fakeApp()
    expect(await runMcpCommand(app.api, 'deleteRows', { ...app.shared, tab: 't1', rows: [1], approval: 'ask' }, async () => false)).toMatchObject({ deleted: 0, denied: true })
    expect(app.executed).toEqual([])
    expect(await runMcpCommand(app.api, 'deleteRows', { ...app.shared, tab: 't1', rows: [1], approval: 'allow' }, async () => { throw new Error('should not ask') })).toMatchObject({ deleted: 1 })
    expect(app.executed).toEqual([{ sql: 'DELETE FROM public.items WHERE id = $1', params: [2] }])
  })

  it('runs code in a new query tab and returns its results', async () => {
    const app = fakeApp()
    const res = await runMcpCommand(app.api, 'execute', { ...app.shared, connectionId: 'c1', code: 'UPDATE items SET price = 1; SELECT 1 AS n', approval: 'allow' }, app.yes) as { tab: string; results: unknown[] }
    expect(res.tab).toBe('q7')
    expect(app.active).toBe('q7')
    expect(app.executed.map(e => e.sql)).toEqual(['UPDATE items SET price = 1', 'SELECT 1 AS n'])
    expect(app.tabs.find(t => t.id === 'q7')?.results).toHaveLength(2)
  })
})
