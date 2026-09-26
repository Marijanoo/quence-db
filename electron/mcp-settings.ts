import * as fs from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'

// MCP server settings, kept in the app's data folder (not in the renderer's localStorage: the
// token has to survive, and the main process needs it before any window loads)

export interface McpSettings {
  enabled: boolean
  port: number
  token: string
  sharedConnectionIds: string[]   // connections MCP clients may use; none until the user picks
  writeMode: McpWriteMode
  dataTools: DataToolSettings
}

// off: no writes; ask: every write waits for Allow in the app; allow: writes run without asking
export type McpWriteMode = 'off' | 'ask' | 'allow'

// The MCP tools that read or write actual row data (not schema metadata, and not the GUI/navigation
// tools like open_table or focus_tab, which stay always available). Each can be turned off globally
// and overridden per connection, so "off everywhere except this one connection" is possible.
// Kept in sync by hand with lib/mcp-data-tools.ts, the renderer's copy of the same list and rule
// (the electron/ build compiles standalone and can't import across into lib/).
export const DATA_TOOLS = ['run_query', 'mongo_find', 'mongo_aggregate', 'edit_cells', 'insert_rows', 'save_table_changes', 'delete_rows', 'execute'] as const
export type DataTool = typeof DATA_TOOLS[number]

export interface DataToolSettings {
  global: Record<DataTool, boolean>
  perConnection: Record<string, Partial<Record<DataTool, boolean>>>   // connectionId -> overrides
}

const defaultDataToolSettings = (): DataToolSettings => ({
  global: Object.fromEntries(DATA_TOOLS.map(t => [t, true])) as Record<DataTool, boolean>,
  perConnection: {},
})

// Whether a data tool may run for a connection: a per-connection override wins over the global switch.
export function dataToolEnabled(settings: DataToolSettings, tool: DataTool, connectionId: string): boolean {
  const override = settings.perConnection[connectionId]?.[tool]
  return override !== undefined ? override : settings.global[tool]
}

function parseDataToolSettings(raw: unknown): DataToolSettings {
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

export const DEFAULT_MCP_PORT = 7429

export const newToken = () => randomBytes(24).toString('base64url')

export function loadMcpSettings(dir: string): McpSettings {
  const defaults: McpSettings = { enabled: false, port: DEFAULT_MCP_PORT, token: newToken(), sharedConnectionIds: [], writeMode: 'off', dataTools: defaultDataToolSettings() }
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8')) as Partial<McpSettings>
    return {
      enabled: raw.enabled === true,
      port: Number.isInteger(raw.port) && raw.port! > 0 && raw.port! < 65536 ? raw.port! : DEFAULT_MCP_PORT,
      token: typeof raw.token === 'string' && raw.token.length >= 16 ? raw.token : defaults.token,
      sharedConnectionIds: Array.isArray(raw.sharedConnectionIds) ? raw.sharedConnectionIds.filter((x): x is string => typeof x === 'string') : [],
      writeMode: raw.writeMode === 'ask' || raw.writeMode === 'allow' ? raw.writeMode : 'off',
      dataTools: parseDataToolSettings(raw.dataTools),
    }
  } catch {
    return defaults
  }
}

export function saveMcpSettings(dir: string, s: McpSettings) {
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify(s, null, 2), { mode: 0o600 })
}
