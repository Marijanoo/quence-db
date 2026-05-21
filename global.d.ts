export {}

declare global {
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
        connect:        (opts: { id: string; host: string; port: number; database: string; user: string; password: string; ssl: boolean; vpnConfigPath?: string; vpnUsername?: string; vpnPassword?: string }) => Promise<{ ok: boolean; error?: string }>
        disconnect:     (id: string) => Promise<{ ok: boolean; error?: string }>
        query:          (id: string, sql: string, database?: string) => Promise<{ ok: boolean; rows?: Record<string, unknown>[]; fields?: string[]; rowCount?: number | null; ms?: number; error?: string }>
        introspect:     (id: string) => Promise<{ ok: boolean; databases?: string[]; error?: string }>
        introspectDb:   (id: string, database: string) => Promise<{ ok: boolean; tables?: any[]; functions?: any[]; enums?: any[]; types?: any[]; error?: string }>
        selectOvpnFile: () => Promise<string | null>
      }
      mysql: {
        connect:      (opts: { id: string; host: string; port: number; database: string; user: string; password: string; ssl: boolean; vpnConfigPath?: string; vpnUsername?: string; vpnPassword?: string }) => Promise<{ ok: boolean; error?: string }>
        disconnect:   (id: string) => Promise<{ ok: boolean; error?: string }>
        query:        (id: string, sql: string, database?: string) => Promise<{ ok: boolean; rows?: Record<string, unknown>[]; fields?: string[]; rowCount?: number | null; ms?: number; error?: string }>
        introspect:   (id: string) => Promise<{ ok: boolean; databases?: string[]; error?: string }>
        introspectDb: (id: string, database: string) => Promise<{ ok: boolean; tables?: any[]; functions?: any[]; enums?: any[]; types?: any[]; error?: string }>
      }
    }
  }
}
