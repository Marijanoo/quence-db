// The MCP tools that read or write actual row data — not schema metadata (list_databases,
// list_tables, describe_table stay always-on, like list_connections) and not the GUI/navigation
// tools (open_table, focus_tab, …), which the user can't turn off since they don't touch data.
// Each one can be turned off globally and overridden per connection, so "off everywhere except
// this one connection" is possible. Shared between the main process (electron/mcp-settings.ts,
// electron/mcp-tools.ts) and the renderer (components/mcp-bridge.tsx), so both sides agree on the
// same list and the same "is this allowed" rule without importing across that boundary.

export const DATA_TOOLS = ['run_query', 'mongo_find', 'mongo_aggregate', 'edit_cells', 'insert_rows', 'save_table_changes', 'delete_rows', 'execute'] as const
export type DataTool = typeof DATA_TOOLS[number]

export const DATA_TOOL_LABELS: Record<DataTool, string> = {
  run_query: 'Run read-only SQL',
  mongo_find: 'Find MongoDB documents',
  mongo_aggregate: 'Aggregate MongoDB documents',
  edit_cells: 'Edit cells',
  insert_rows: 'Add rows',
  save_table_changes: 'Save changes',
  delete_rows: 'Delete rows',
  execute: 'Run code that changes data',
}

export interface DataToolSettings {
  global: Record<DataTool, boolean>
  perConnection: Record<string, Partial<Record<DataTool, boolean>>>   // connectionId -> overrides
}

export const defaultDataToolSettings = (): DataToolSettings => ({
  global: Object.fromEntries(DATA_TOOLS.map(t => [t, true])) as Record<DataTool, boolean>,
  perConnection: {},
})

// Whether a data tool may run for a connection: a per-connection override wins over the global switch.
export function dataToolEnabled(settings: DataToolSettings, tool: DataTool, connectionId: string): boolean {
  const override = settings.perConnection[connectionId]?.[tool]
  return override !== undefined ? override : settings.global[tool]
}

export function parseDataToolSettings(raw: unknown): DataToolSettings {
  const defaults = defaultDataToolSettings()
  if (!raw || typeof raw !== 'object') return defaults
  const r = raw as Partial<DataToolSettings>
  const global = { ...defaults.global }
  if (r.global && typeof r.global === 'object') {
    for (const t of DATA_TOOLS) if (typeof r.global[t] === 'boolean') global[t] = r.global[t]
  }
  const perConnection: DataToolSettings['perConnection'] = {}
  if (r.perConnection && typeof r.perConnection === 'object') {
    for (const [connId, overrides] of Object.entries(r.perConnection)) {
      if (!overrides || typeof overrides !== 'object') continue
      const clean: Partial<Record<DataTool, boolean>> = {}
      for (const t of DATA_TOOLS) {
        const v = (overrides as Partial<Record<DataTool, boolean>>)[t]
        if (typeof v === 'boolean') clean[t] = v
      }
      if (Object.keys(clean).length > 0) perConnection[connId] = clean
    }
  }
  return { global, perConnection }
}
