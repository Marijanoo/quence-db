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
    query:          (id: string, sql: string, database?: string) => ipcRenderer.invoke('pg:query', { id, sql, database }),
    introspect:     (id: string) => ipcRenderer.invoke('pg:introspect', { id }),
    introspectDb:   (id: string, database: string) => ipcRenderer.invoke('pg:introspect-db', { id, database }),
    selectOvpnFile: () => ipcRenderer.invoke('pg:select-ovpn-file'),
  },

  mysql: {
    connect:      (opts: any) => ipcRenderer.invoke('mysql:connect', opts),
    disconnect:   (id: string) => ipcRenderer.invoke('mysql:disconnect', { id }),
    query:        (id: string, sql: string, database?: string) => ipcRenderer.invoke('mysql:query', { id, sql, database }),
    introspect:   (id: string) => ipcRenderer.invoke('mysql:introspect', { id }),
    introspectDb: (id: string, database: string) => ipcRenderer.invoke('mysql:introspect-db', { id, database }),
  },
})
