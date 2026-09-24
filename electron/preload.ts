import { contextBridge, ipcRenderer } from 'electron'

async function invoke(channel: string, ...args: any[]) {
  const result = await ipcRenderer.invoke(channel, ...args)
  if (result && !result.ok) throw new Error(result.error)
  return result?.data
}

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close:    () => ipcRenderer.send('window-close'),
  zoomIn:   () => ipcRenderer.send('window-zoom-in'),
  zoomOut:  () => ipcRenderer.send('window-zoom-out'),
  onUpdateAvailable:  (cb: () => void) => ipcRenderer.on('update-available', cb),
  onUpdateProgress:   (cb: (percent: number) => void) => ipcRenderer.on('update-progress', (_e, percent) => cb(percent)),
  onUpdateDownloaded: (cb: () => void) => ipcRenderer.on('update-downloaded', cb),
  installUpdate: () => ipcRenderer.send('install-update'),

  db: {
    connections: {
      get:    () => invoke('db:connections:get'),
      getOne: (id: string) => invoke('db:connections:getOne', id),
      create: (c: any) => invoke('db:connections:create', c),
      update: (id: string, data: any) => invoke('db:connections:update', id, data),
      delete: (id: string) => invoke('db:connections:delete', id),
    },
    savedQueries: {
      get:    (connectionId?: string) => invoke('db:savedQueries:get', connectionId),
      create: (q: any) => invoke('db:savedQueries:create', q),
      update: (id: string, data: any) => invoke('db:savedQueries:update', id, data),
      delete: (id: string) => invoke('db:savedQueries:delete', id),
    },
  },

  pg: {
    connect:        (opts: any) => ipcRenderer.invoke('pg:connect', opts),
    disconnect:     (id: string) => ipcRenderer.invoke('pg:disconnect', { id }),
    query:          (id: string, sql: string, database?: string, params?: unknown[], opts?: { searchPath?: string; settings?: Record<string, string> }) =>
                      ipcRenderer.invoke('pg:query', { id, sql, database, params, searchPath: opts?.searchPath, settings: opts?.settings }),
    sessionOpen:    (id: string, database?: string, settings?: Record<string, string>, readOnly?: boolean) => ipcRenderer.invoke('pg:session-open', { id, database, settings, readOnly }),
    sessionQuery:   (sessionId: string, sql: string, params?: unknown[]) => ipcRenderer.invoke('pg:session-query', { sessionId, sql, params }),
    sessionClose:   (sessionId: string, commit: boolean) => ipcRenderer.invoke('pg:session-close', { sessionId, commit }),
    sessionCancel:  (sessionId: string) => ipcRenderer.invoke('pg:session-cancel', { sessionId }),
    executeScript:  (id: string, sql: string, database?: string) => ipcRenderer.invoke('pg:execute-script', { id, sql, database }),
    introspect:     (id: string) => ipcRenderer.invoke('pg:introspect', { id }),
    introspectDb:   (id: string, database: string) => ipcRenderer.invoke('pg:introspect-db', { id, database }),
    closeDbPool:    (id: string, database: string) => ipcRenderer.invoke('pg:close-db-pool', { id, database }),
    selectOvpnFile: () => ipcRenderer.invoke('pg:select-ovpn-file'),
  },

  mysql: {
    connect:      (opts: any) => ipcRenderer.invoke('mysql:connect', opts),
    disconnect:   (id: string) => ipcRenderer.invoke('mysql:disconnect', { id }),
    query:        (id: string, sql: string, database?: string, params?: unknown[]) => ipcRenderer.invoke('mysql:query', { id, sql, database, params }),
    sessionOpen:  (id: string, database?: string) => ipcRenderer.invoke('mysql:session-open', { id, database }),
    sessionQuery: (sessionId: string, sql: string, params?: unknown[]) => ipcRenderer.invoke('mysql:session-query', { sessionId, sql, params }),
    sessionClose: (sessionId: string, commit: boolean) => ipcRenderer.invoke('mysql:session-close', { sessionId, commit }),
    sessionCancel: (sessionId: string) => ipcRenderer.invoke('mysql:session-cancel', { sessionId }),
    introspect:   (id: string) => ipcRenderer.invoke('mysql:introspect', { id }),
    introspectDb: (id: string, database: string) => ipcRenderer.invoke('mysql:introspect-db', { id, database }),
  },

  mongodb: {
    connect:      (opts: any) => ipcRenderer.invoke('mongodb:connect', opts),
    disconnect:   (id: string) => ipcRenderer.invoke('mongodb:disconnect', { id }),
    // params is unused (signature parity with pg/mysql); typed keeps exact BSON number types
    query:        (id: string, sql: string, database?: string, _params?: unknown[], options?: { typed?: boolean }) =>
      ipcRenderer.invoke('mongodb:query', { id, sql, database, typed: options?.typed }),
    introspect:   (id: string) => ipcRenderer.invoke('mongodb:introspect', { id }),
    introspectDb: (id: string, database: string) => ipcRenderer.invoke('mongodb:introspect-db', { id, database }),
  },

  files: {
    saveDialog:   (opts: { title?: string; defaultName?: string; filters?: { name: string; extensions: string[] }[] }) => ipcRenderer.invoke('file:save-dialog', opts),
    openWrite:    (filePath: string) => ipcRenderer.invoke('file:open-write', { filePath }),
    write:        (fileId: string, text: string) => ipcRenderer.invoke('file:write', { fileId, text }),
    close:        (fileId: string, discard?: boolean) => ipcRenderer.invoke('file:close', { fileId, discard }),
    showInFolder: (filePath: string) => ipcRenderer.invoke('file:show-in-folder', { filePath }),
  },

  cancelConnect: (id: string) => ipcRenderer.invoke('db:cancel-connect', { id }),

  onRunQuery:  (cb: () => void) => ipcRenderer.on('run-query', cb),
  offRunQuery: (cb: () => void) => ipcRenderer.removeListener('run-query', cb),
})
