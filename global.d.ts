import type { DataTool, DataToolSettings } from './lib/mcp-data-tools'

export {}

// A Redis key's value as electron/redis-conn.ts reads it (collections capped; `size` is the full size)
interface RedisValue {
  key: string
  type: string
  ttl: number
  size: number
  truncated: boolean
  unsupported?: boolean
  value?: string
  fields?: { field: string; value: string }[]
  items?: { index: number; value: string }[]
  members?: string[] | { member: string; score: string }[]
  entries?: { id: string; fields: Record<string, string> }[]
}

// MCP server state, as the main process reports it (see electron/main.ts)
interface McpStatus {
  enabled: boolean
  running: boolean
  port: number
  url: string
  token: string
  error: string | null
  sharedConnectionIds: string[]
  writeMode: 'off' | 'ask' | 'allow'
  dataTools: DataToolSettings
  connections: { id: string; name: string; dbType: 'pg' | 'mysql' | 'mongodb'; connected: boolean }[]
}

declare global {
  type McpServerStatus = McpStatus
  type RedisKeyValue = RedisValue
  interface Window {
    electronAPI?: {
      minimize: () => void
      maximize: () => void
      close: () => void
      zoomIn: () => void
      zoomOut: () => void
      onUpdateAvailable?: (cb: () => void) => void
      onUpdateProgress?: (cb: (percent: number) => void) => void
      onUpdateDownloaded: (cb: () => void) => void
      installUpdate?: () => void
      cancelConnect: (id: string) => Promise<{ ok: boolean }>
      // Writing exports: pick a path, then stream text into it
      files?: {
        saveDialog:   (opts: { title?: string; defaultName?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>
        openWrite:    (filePath: string) => Promise<{ ok: boolean; fileId?: string; error?: string }>
        write:        (fileId: string, text: string) => Promise<{ ok: boolean; error?: string }>
        close:        (fileId: string, discard?: boolean) => Promise<{ ok: boolean; error?: string }>
        showInFolder: (filePath: string) => Promise<{ ok: boolean }>
        openDialog:   (opts: { title?: string; filters?: { name: string; extensions: string[] }[]; directory?: boolean; multiple?: boolean }) => Promise<string[] | null>
        openRead:     (filePath: string) => Promise<{ ok: boolean; fileId?: string; size?: number; error?: string }>
        // Text of the next chunk; done once the end was reached (text then holds any leftover bytes)
        read:         (fileId: string, maxBytes?: number) => Promise<{ ok: boolean; text?: string; done?: boolean; position?: number; size?: number; error?: string }>
        closeRead:    (fileId: string) => Promise<{ ok: boolean }>
        listDir:      (dirPath: string) => Promise<{ ok: boolean; files?: { name: string; size: number }[]; error?: string }>
        join:         (...parts: string[]) => Promise<string>
      }
      mcp?: {
        status:   () => Promise<McpStatus>
        update:   (patch: { enabled?: boolean; port?: number; sharedConnectionIds?: string[]; writeMode?: 'off' | 'ask' | 'allow' }) => Promise<McpStatus>
        setDataTool: (args: { tool: DataTool; connectionId?: string; enabled: boolean | null }) => Promise<McpStatus>
        newToken: () => Promise<McpStatus>
        log:      () => Promise<{ at: number; tool: string; connection?: string; detail?: string; ok: boolean; error?: string; ms: number }[]>
        onUiRequest?: (cb: (req: { id: string; command: string; args: Record<string, unknown> }) => void) => () => void
        respond?: (id: string, answer: { ok: boolean; result?: unknown; error?: string }) => Promise<void>
      }
      onRunQuery?: (cb: () => void) => void
      offRunQuery?: (cb: () => void) => void
      onCloseActiveTab?: (cb: () => void) => void
      onNewQueryTab?: (cb: () => void) => void
      offCloseActiveTab?: (cb: () => void) => void
      offNewQueryTab?: (cb: () => void) => void
      db: {
        connections: {
          get: () => Promise<any[]>
          getOne: (id: string) => Promise<any>
          create: (c: any) => Promise<void>
          update: (id: string, data: any) => Promise<void>
          delete: (id: string) => Promise<void>
        }
        savedQueries: {
          get: (connectionId?: string) => Promise<any[]>
          create: (q: any) => Promise<void>
          update: (id: string, data: any) => Promise<void>
          delete: (id: string) => Promise<void>
        }
      }
      pg: {
        connect:        (opts: { id: string; host: string; port: number; database: string; user: string; password: string; ssl: boolean; vpnConfigPath?: string; vpnUsername?: string; vpnPassword?: string }) => Promise<{ ok: boolean; cancelled?: boolean; error?: string }>
        disconnect:     (id: string) => Promise<{ ok: boolean; error?: string }>
        query:          (id: string, sql: string, database?: string, params?: unknown[], opts?: { searchPath?: string; settings?: Record<string, string> }) => Promise<{ ok: boolean; rows?: Record<string, unknown>[]; fields?: string[]; rowCount?: number | null; ms?: number; error?: string }>
        sessionOpen:    (id: string, database?: string, settings?: Record<string, string>, readOnly?: boolean, autocommit?: boolean) => Promise<{ ok: boolean; sessionId?: string; error?: string }>
        sessionQuery:   (sessionId: string, sql: string, params?: unknown[]) => Promise<{ ok: boolean; rows?: Record<string, unknown>[]; rowCount?: number | null; error?: string }>
        sessionClose:   (sessionId: string, commit: boolean) => Promise<{ ok: boolean; error?: string }>
        sessionCancel:  (sessionId: string) => Promise<{ ok: boolean; error?: string }>
        executeScript:  (id: string, sql: string, database?: string) => Promise<{ ok: boolean; error?: string; position?: number }>
        introspect:     (id: string) => Promise<{ ok: boolean; databases?: string[]; error?: string }>
        introspectDb:   (id: string, database: string) => Promise<{ ok: boolean; tables?: any[]; functions?: any[]; enums?: any[]; types?: any[]; columns?: any[]; error?: string }>
        // Ends the app's own connections to one database (before it is renamed or dropped)
        closeDbPool:    (id: string, database: string) => Promise<{ ok: boolean }>
        selectOvpnFile: () => Promise<string | null>
      }
      mysql: {
        connect:      (opts: { id: string; host: string; port: number; database: string; user: string; password: string; ssl: boolean; vpnConfigPath?: string; vpnUsername?: string; vpnPassword?: string }) => Promise<{ ok: boolean; cancelled?: boolean; error?: string }>
        disconnect:   (id: string) => Promise<{ ok: boolean; error?: string }>
        query:        (id: string, sql: string, database?: string, params?: unknown[]) => Promise<{ ok: boolean; rows?: Record<string, unknown>[]; fields?: string[]; rowCount?: number | null; ms?: number; error?: string }>
        sessionOpen:  (id: string, database?: string, opts?: { autocommit?: boolean; consistentSnapshot?: boolean }) => Promise<{ ok: boolean; sessionId?: string; error?: string }>
        sessionQuery: (sessionId: string, sql: string, params?: unknown[]) => Promise<{ ok: boolean; rows?: Record<string, unknown>[]; rowCount?: number | null; error?: string }>
        sessionClose: (sessionId: string, commit: boolean) => Promise<{ ok: boolean; error?: string }>
        sessionCancel: (sessionId: string) => Promise<{ ok: boolean; error?: string }>
        introspect:   (id: string) => Promise<{ ok: boolean; databases?: string[]; error?: string }>
        introspectDb: (id: string, database: string) => Promise<{ ok: boolean; tables?: any[]; functions?: any[]; enums?: any[]; types?: any[]; columns?: any[]; error?: string }>
      }
      redis: {
        connect:    (opts: { id: string; host: string; port?: number; user?: string; password?: string; database?: string; ssl?: boolean; [key: string]: unknown }) => Promise<{ ok: boolean; cancelled?: boolean; error?: string }>
        disconnect: (id: string) => Promise<{ ok: boolean; error?: string }>
        databases:  (id: string) => Promise<{ ok: boolean; databases?: { index: number; keys: number }[]; error?: string }>
        info:       (id: string) => Promise<{ ok: boolean; info?: Record<string, Record<string, string>>; error?: string }>
        scan:       (id: string, db: number, opts: { pattern?: string; cursor?: string; count?: number; type?: string }) => Promise<{ ok: boolean; cursor?: string; keys?: { key: string; type: string; ttl: number }[]; error?: string }>
        get:        (id: string, db: number, key: string, limit?: number) => Promise<{ ok: boolean; value?: RedisValue; error?: string }>
        edit:       (id: string, db: number, edit: unknown) => Promise<{ ok: boolean; changed?: number; error?: string }>
        command:    (id: string, db: number, line: string) => Promise<{ ok: boolean; reply?: unknown; ms?: number; error?: string }>
      }
      // SQLite: `host` is the database file; `create` makes a new one
      sqlite: {
        connect:      (opts: { id: string; host: string; create?: boolean; [key: string]: unknown }) => Promise<{ ok: boolean; cancelled?: boolean; error?: string }>
        disconnect:   (id: string) => Promise<{ ok: boolean; error?: string }>
        query:        (id: string, sql: string, database?: string, params?: unknown[]) => Promise<{ ok: boolean; rows?: Record<string, unknown>[]; fields?: string[]; rowCount?: number | null; ms?: number; error?: string }>
        sessionOpen:  (id: string, database?: string, opts?: { autocommit?: boolean; readOnly?: boolean }) => Promise<{ ok: boolean; sessionId?: string; error?: string }>
        sessionQuery: (sessionId: string, sql: string, params?: unknown[]) => Promise<{ ok: boolean; rows?: Record<string, unknown>[]; rowCount?: number | null; error?: string }>
        sessionClose: (sessionId: string, commit: boolean) => Promise<{ ok: boolean; error?: string }>
        sessionCancel: (sessionId: string) => Promise<{ ok: boolean; error?: string }>
        introspect:   (id: string) => Promise<{ ok: boolean; databases?: string[]; error?: string }>
        introspectDb: (id: string, database: string) => Promise<{ ok: boolean; tables?: any[]; functions?: any[]; enums?: any[]; types?: any[]; columns?: any[]; error?: string }>
        pickFile:     (create?: boolean) => Promise<string | null>
      }
      mongodb: {
        connect:      (opts: { id: string; host: string; port: number; database: string; user: string; password: string; ssl: boolean; vpnConfigPath?: string; vpnUsername?: string; vpnPassword?: string }) => Promise<{ ok: boolean; cancelled?: boolean; error?: string }>
        disconnect:   (id: string) => Promise<{ ok: boolean; error?: string }>
        // params is accepted for signature parity with pg/mysql but ignored. typed keeps Int32/Double/Long
        // distinct in find results; types holds each row's BSON field types (dotted paths).
        query:        (id: string, sql: string, database?: string, params?: unknown[], options?: { typed?: boolean }) => Promise<{ ok: boolean; rows?: Record<string, unknown>[]; fields?: string[]; rowCount?: number | null; ms?: number; types?: Record<string, string>[]; error?: string }>
        introspect:   (id: string) => Promise<{ ok: boolean; databases?: string[]; error?: string }>
        introspectDb: (id: string, database: string) => Promise<{ ok: boolean; tables?: any[]; functions?: any[]; enums?: any[]; types?: any[]; columns?: any[]; error?: string }>
        // Database export/import. metadata is a collection's options + indexes as Extended JSON.
        exportCollections: (id: string, database: string) => Promise<{ ok: boolean; collections?: { metadata: string; estimate: number }[]; error?: string }>
        exportOpen:   (id: string, database: string, collection: string) => Promise<{ ok: boolean; cursorId?: string; error?: string }>
        exportRead:   (cursorId: string, limit: number) => Promise<{ ok: boolean; lines?: string[]; done?: boolean; error?: string }>
        exportClose:  (cursorId: string) => Promise<{ ok: boolean }>
        importPrepare: (id: string, database: string, metadata: string, drop: boolean) => Promise<{ ok: boolean; created?: boolean; error?: string }>
        importDocuments: (id: string, database: string, collection: string, documents: string[]) => Promise<{ ok: boolean; inserted?: number; errors?: string[]; error?: string }>
        importIndexes: (id: string, database: string, metadata: string) => Promise<{ ok: boolean; created?: number; error?: string }>
      }
    }
  }
}
