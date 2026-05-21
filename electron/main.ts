import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { Pool } from 'pg'
import * as mysql from 'mysql2/promise'
import * as path from 'path'
import * as fs from 'fs'
import { spawn, ChildProcess } from 'child_process'
import * as os from 'os'
import serve from 'electron-serve'
import { autoUpdater } from 'electron-updater'
import {
  dbGetConnections, dbGetConnection, dbCreateConnection, dbUpdateConnection, dbDeleteConnection,
  dbGetSavedQueries, dbCreateSavedQuery, dbUpdateSavedQuery, dbDeleteSavedQuery,
} from './sqlite-db'

const isProd = app.isPackaged || process.env.NODE_ENV === 'production'

if (isProd) {
  serve({ directory: 'out' })
} else {
  app.setPath('userData', `${app.getPath('userData')} (development)`)
}

let mainWindow: BrowserWindow | null = null

function getWindowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json')
}

function loadWindowState(): { width: number; height: number; x?: number; y?: number; isMaximized?: boolean } {
  try {
    const raw = fs.readFileSync(getWindowStatePath(), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return { width: 1200, height: 800 }
  }
}

function saveWindowState() {
  if (!mainWindow) return
  try {
    const isMaximized = mainWindow.isMaximized()
    let bounds: { width: number; height: number; x?: number; y?: number; isMaximized?: boolean } = { width: 1200, height: 800 }
    try {
      const raw = fs.readFileSync(getWindowStatePath(), 'utf-8')
      bounds = JSON.parse(raw)
    } catch {}
    if (!isMaximized) {
      const b = mainWindow.getBounds()
      bounds.x = b.x; bounds.y = b.y; bounds.width = b.width; bounds.height = b.height
    }
    bounds.isMaximized = isMaximized
    fs.writeFileSync(getWindowStatePath(), JSON.stringify(bounds))
  } catch {}
}

async function createWindow() {
  const windowState = loadWindowState()
  mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    x: windowState.x,
    y: windowState.y,
    minWidth: 600,
    minHeight: 400,
    frame: false,
    show: false,
    icon: path.join(__dirname, '..', 'public', process.platform === 'win32' ? 'logo.ico' : 'logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  if (windowState.isMaximized) mainWindow.maximize()
  mainWindow.show()

  if (isProd) {
    await mainWindow.loadURL('app://-')
  } else {
    const port = process.argv[2] || 3000
    mainWindow.webContents.session.webRequest.onBeforeRequest(
      { urls: ['ws://_next/*', 'wss://_next/*'] },
      (details, callback) => {
        callback({ redirectURL: details.url.replace(/^wss?:\/\/_next\//, `ws://localhost:${port}/_next/`) })
      }
    )
    await mainWindow.loadURL(`http://localhost:${port}`)
  }

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F12') {
      if (!isProd) mainWindow!.webContents.toggleDevTools()
      event.preventDefault()
    } else if ((input.control || input.meta) && (input.key === '=' || input.key === '+')) {
      mainWindow!.webContents.setZoomLevel(mainWindow!.webContents.getZoomLevel() + 0.5)
      event.preventDefault()
    } else if ((input.control || input.meta) && input.key === '-') {
      mainWindow!.webContents.setZoomLevel(mainWindow!.webContents.getZoomLevel() - 0.5)
      event.preventDefault()
    } else if ((input.control || input.meta) && input.key === '0') {
      mainWindow!.webContents.setZoomLevel(0)
      event.preventDefault()
    }
  })

  mainWindow.webContents.on('will-reload' as any, (event: Electron.Event) => event.preventDefault())
  mainWindow.on('resize', saveWindowState)
  mainWindow.on('move', saveWindowState)
  mainWindow.on('closed', () => { saveWindowState(); mainWindow = null })
}

app.on('ready', () => {
  createWindow()

  ipcMain.on('window-minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('window-maximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win?.isMaximized()) win.unmaximize()
    else win?.maximize()
  })
  ipcMain.on('window-close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.on('window-zoom-in',  () => mainWindow?.webContents.setZoomLevel(mainWindow.webContents.getZoomLevel() + 0.5))
  ipcMain.on('window-zoom-out', () => mainWindow?.webContents.setZoomLevel(mainWindow.webContents.getZoomLevel() - 0.5))

  // ── SQLite IPC ──────────────────────────────────────────────────────────────
  const handle = (ch: string, fn: (...args: any[]) => any) =>
    ipcMain.handle(ch, async (_e, ...args) => {
      try { return { ok: true, data: await fn(...args) } }
      catch (err: any) { return { ok: false, error: err.message ?? String(err) } }
    })

  handle('db:connections:get',    () => dbGetConnections())
  handle('db:connections:getOne', (id) => dbGetConnection(id))
  handle('db:connections:create', (c) => dbCreateConnection(c))
  handle('db:connections:update', (id, data) => dbUpdateConnection(id, data))
  handle('db:connections:delete', (id) => dbDeleteConnection(id))

  handle('db:savedQueries:get',    (connectionId) => dbGetSavedQueries(connectionId))
  handle('db:savedQueries:create', (q) => dbCreateSavedQuery(q))
  handle('db:savedQueries:update', (id, data) => dbUpdateSavedQuery(id, data))
  handle('db:savedQueries:delete', (id) => dbDeleteSavedQuery(id))

  // ── File picker for .ovpn files ─────────────────────────────────────────────
  ipcMain.handle('pg:select-ovpn-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Select OpenVPN Config',
      filters: [{ name: 'OpenVPN Config', extensions: ['ovpn'] }, { name: 'All Files', extensions: ['*'] }],
      properties: ['openFile'],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // ── Postgres connections ────────────────────────────────────────────────────
  const pgPools = new Map<string, Pool>()
  const vpnProcesses = new Map<string, ChildProcess>()

  function spawnVpn(id: string, configPath: string, username?: string, password?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const safeId = id.replace(/[^a-zA-Z0-9]/g, '')
      const tmpDir = os.tmpdir()
      const tmpConfig = path.join(tmpDir, `ovpn-${safeId}.ovpn`)
      fs.writeFileSync(tmpConfig, fs.readFileSync(configPath, 'utf-8'))

      const args = ['--config', tmpConfig]
      let tmpAuth: string | null = null
      if (username || password) {
        tmpAuth = path.join(tmpDir, `ovpn-auth-${safeId}.txt`)
        fs.writeFileSync(tmpAuth, `${username ?? ''}\n${password ?? ''}\n`, { mode: 0o600 })
        args.push('--auth-user-pass', tmpAuth)
      }

      const openvpnBin = process.platform === 'win32'
        ? 'C:\\Program Files\\OpenVPN\\bin\\openvpn.exe' : 'openvpn'
      const proc = spawn(openvpnBin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      vpnProcesses.set(id, proc)

      let settled = false
      let outputLog = ''
      const timeout = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error(`OpenVPN timed out (30s).\n\n${outputLog}`)) }
      }, 30000)

      const cleanup = () => {
        try { fs.unlinkSync(tmpConfig) } catch {}
        if (tmpAuth) try { fs.unlinkSync(tmpAuth) } catch {}
      }

      const onData = (chunk: Buffer) => {
        const text = chunk.toString()
        outputLog += text
        if (!settled) {
          if (text.includes('Initialization Sequence Completed')) {
            settled = true; clearTimeout(timeout); resolve()
          } else if (text.includes('AUTH_FAILED')) {
            settled = true; clearTimeout(timeout); reject(new Error('OpenVPN authentication failed.'))
          } else if (text.includes('TLS handshake failed') || text.includes('TLS Error')) {
            settled = true; clearTimeout(timeout); reject(new Error(`OpenVPN TLS error.\n\n${outputLog}`))
          }
        }
      }
      proc.stdout?.on('data', onData)
      proc.stderr?.on('data', onData)
      proc.on('error', (err) => {
        if (!settled) { settled = true; clearTimeout(timeout); cleanup(); vpnProcesses.delete(id); reject(err) }
      })
      proc.on('exit', (code) => {
        cleanup(); vpnProcesses.delete(id)
        if (!settled) { settled = true; clearTimeout(timeout); reject(new Error(`OpenVPN exited (code ${code}).\n\n${outputLog}`)) }
      })
    })
  }

  function killVpn(id: string) {
    const proc = vpnProcesses.get(id)
    if (!proc) return
    try { proc.kill() } catch {}
    vpnProcesses.delete(id)
  }

  ipcMain.handle('pg:connect', async (_e, { id, host, port, database, user, password, ssl, vpnConfigPath, vpnUsername, vpnPassword }: {
    id: string; host: string; port: number; database: string; user: string; password: string; ssl: boolean; vpnConfigPath?: string; vpnUsername?: string; vpnPassword?: string
  }) => {
    try {
      if (pgPools.has(id)) { await pgPools.get(id)!.end(); pgPools.delete(id) }
      killVpn(id)
      if (vpnConfigPath) await spawnVpn(id, vpnConfigPath, vpnUsername, vpnPassword)
      const pool = new Pool({ host, port, database, user, password, ssl: ssl ? { rejectUnauthorized: false } : false, connectionTimeoutMillis: 30000 })
      const client = await Promise.race([
        pool.connect(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Connection timed out after 30s')), 30000)),
      ])
      client.release()
      pgPools.set(id, pool)
      return { ok: true }
    } catch (err) {
      killVpn(id)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('pg:disconnect', async (_e, { id }: { id: string }) => {
    try { await pgPools.get(id)?.end(); pgPools.delete(id); killVpn(id); return { ok: true } }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
  })

  const dbQueryPools = new Map<string, Pool>()

  ipcMain.handle('pg:query', async (_e, { id, sql, database }: { id: string; sql: string; database?: string }) => {
    const basePool = pgPools.get(id)
    if (!basePool) return { ok: false, error: 'Not connected' }
    try {
      let pool = basePool
      if (database) {
        const key = `${id}::${database}`
        if (!dbQueryPools.has(key)) {
          const opts = (basePool as any).options as { host: string; port: number; user: string; password: string; ssl: any }
          dbQueryPools.set(key, new Pool({ host: opts.host, port: opts.port, user: opts.user, password: opts.password, database, ssl: opts.ssl, connectionTimeoutMillis: 15000 }))
        }
        pool = dbQueryPools.get(key)!
      }
      const start = Date.now()
      const result = await pool.query(sql)
      return { ok: true, rows: result.rows, fields: result.fields.map(f => f.name), rowCount: result.rowCount, ms: Date.now() - start }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('pg:introspect', async (_e, { id }: { id: string }) => {
    const pool = pgPools.get(id)
    if (!pool) return { ok: false, error: 'Not connected' }
    try {
      const dbRes = await pool.query(`SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname`)
      return { ok: true, databases: dbRes.rows.map((r: { datname: string }) => r.datname) }
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
  })

  ipcMain.handle('pg:introspect-db', async (_e, { id, database }: { id: string; database: string }) => {
    const basePool = pgPools.get(id)
    if (!basePool) return { ok: false, error: 'Not connected' }
    const opts = (basePool as any).options as { host: string; port: number; user: string; password: string; ssl: any }
    const dbPool = new Pool({ host: opts.host, port: opts.port, user: opts.user, password: opts.password, database, ssl: opts.ssl, connectionTimeoutMillis: 15000 })
    try {
      const [tablesRes, funcsRes, enumsRes, typesRes] = await Promise.all([
        dbPool.query(`
          SELECT n.nspname AS table_schema, c.relname AS table_name,
            CASE WHEN c.relkind = 'r' THEN 'BASE TABLE' WHEN c.relkind = 'v' THEN 'VIEW' WHEN c.relkind = 'm' THEN 'MATERIALIZED VIEW' ELSE 'OTHER' END AS table_type
          FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
          WHERE c.relkind IN ('r','v','m') AND n.nspname NOT IN ('pg_catalog','information_schema')
          ORDER BY table_schema, table_name
        `),
        dbPool.query(`
          SELECT n.nspname AS routine_schema, p.proname AS routine_name, pg_get_function_arguments(p.oid) AS arguments
          FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
          WHERE n.nspname NOT IN ('pg_catalog','information_schema')
          ORDER BY routine_schema, routine_name
        `),
        dbPool.query(`
          SELECT n.nspname AS schema, t.typname AS name, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS values
          FROM pg_type t JOIN pg_namespace n ON t.typnamespace = n.oid JOIN pg_enum e ON e.enumtypid = t.oid
          WHERE n.nspname NOT IN ('pg_catalog','information_schema')
          GROUP BY n.nspname, t.typname ORDER BY schema, name
        `),
        dbPool.query(`
          SELECT n.nspname AS schema, t.typname AS name,
            CASE t.typtype WHEN 'c' THEN 'composite' WHEN 'd' THEN 'domain' WHEN 'r' THEN 'range' ELSE 'other' END AS definition
          FROM pg_type t JOIN pg_namespace n ON t.typnamespace = n.oid
          WHERE t.typtype IN ('c','d','r') AND n.nspname NOT IN ('pg_catalog','information_schema')
          ORDER BY schema, name
        `),
      ])
      return { ok: true, tables: tablesRes.rows, functions: funcsRes.rows, enums: enumsRes.rows, types: typesRes.rows }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      await dbPool.end()
    }
  })

  // ── MySQL connections ───────────────────────────────────────────────────────
  const mysqlPools = new Map<string, mysql.Pool>()

  ipcMain.handle('mysql:connect', async (_e, { id, host, port, database, user, password, ssl, vpnConfigPath, vpnUsername, vpnPassword }: {
    id: string; host: string; port: number; database: string; user: string; password: string; ssl: boolean; vpnConfigPath?: string; vpnUsername?: string; vpnPassword?: string
  }) => {
    try {
      if (mysqlPools.has(id)) { await mysqlPools.get(id)!.end(); mysqlPools.delete(id) }
      killVpn(id)
      if (vpnConfigPath) await spawnVpn(id, vpnConfigPath, vpnUsername, vpnPassword)
      const pool = mysql.createPool({
        host, port, database: database || undefined, user, password,
        ssl: ssl ? { rejectUnauthorized: false } : undefined,
        connectTimeout: 10000, waitForConnections: true, connectionLimit: 5,
      })
      const conn = await Promise.race([
        pool.getConnection(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Connection timed out after 10s')), 10000)),
      ])
      conn.release()
      mysqlPools.set(id, pool)
      return { ok: true }
    } catch (err) {
      killVpn(id)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('mysql:disconnect', async (_e, { id }: { id: string }) => {
    try { await mysqlPools.get(id)?.end(); mysqlPools.delete(id); killVpn(id); return { ok: true } }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
  })

  ipcMain.handle('mysql:query', async (_e, { id, sql, database }: { id: string; sql: string; database?: string }) => {
    const pool = mysqlPools.get(id)
    if (!pool) return { ok: false, error: 'Not connected' }
    try {
      const conn = await pool.getConnection()
      try {
        if (database) await conn.query(`USE \`${database}\``)
        const start = Date.now()
        const [rows, fields] = await conn.query({ sql, rowsAsArray: false }) as [any[], mysql.FieldPacket[]]
        const ms = Date.now() - start
        const fieldNames = Array.isArray(fields) ? fields.map((f: any) => f.name) : []
        const normalizedRows = Array.isArray(rows) ? rows : []
        return { ok: true, rows: normalizedRows, fields: fieldNames, rowCount: normalizedRows.length, ms }
      } finally { conn.release() }
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
  })

  ipcMain.handle('mysql:introspect', async (_e, { id }: { id: string }) => {
    const pool = mysqlPools.get(id)
    if (!pool) return { ok: false, error: 'Not connected' }
    try {
      const [rows] = await pool.query(`SHOW DATABASES`) as [any[], mysql.FieldPacket[]]
      const databases = rows.map((r: any) => Object.values(r)[0] as string)
        .filter(d => !['information_schema', 'performance_schema', 'mysql', 'sys'].includes(d))
      return { ok: true, databases }
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
  })

  ipcMain.handle('mysql:introspect-db', async (_e, { id, database }: { id: string; database: string }) => {
    const pool = mysqlPools.get(id)
    if (!pool) return { ok: false, error: 'Not connected' }
    try {
      const conn = await pool.getConnection()
      try {
        await conn.query(`USE \`${database}\``)
        const [[tablesRows], [funcsRows], [enumsRows]] = await Promise.all([
          conn.query(`
            SELECT TABLE_NAME AS table_name, TABLE_TYPE AS table_type
            FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME
          `, [database]) as Promise<[any[], mysql.FieldPacket[]]>,
          conn.query(`
            SELECT ROUTINE_NAME AS routine_name, ROUTINE_TYPE AS routine_type
            FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME
          `, [database]) as Promise<[any[], mysql.FieldPacket[]]>,
          conn.query(`
            SELECT COLUMN_NAME AS name, COLUMN_TYPE AS col_type, TABLE_NAME AS table_name
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ? AND COLUMN_TYPE LIKE 'enum(%)'
            GROUP BY COLUMN_TYPE, COLUMN_NAME, TABLE_NAME ORDER BY TABLE_NAME, COLUMN_NAME
          `, [database]) as Promise<[any[], mysql.FieldPacket[]]>,
        ])

        const tables = (tablesRows as any[]).map(r => ({
          table_schema: database, table_name: r.table_name,
          table_type: r.table_type === 'BASE TABLE' ? 'BASE TABLE' : r.table_type === 'VIEW' ? 'VIEW' : 'OTHER',
        }))
        const functions = (funcsRows as any[]).map(r => ({
          routine_schema: database, routine_name: r.routine_name,
          arguments: r.routine_type === 'PROCEDURE' ? '(procedure)' : '',
        }))
        const enumMap = new Map<string, string[]>()
        for (const r of enumsRows as any[]) {
          const match = /^enum\((.+)\)$/i.exec(r.col_type)
          if (!match) continue
          const values = match[1].split(',').map((v: string) => v.replace(/^'|'$/g, '').trim())
          enumMap.set(`${r.table_name}.${r.name}`, values)
        }
        const enums = [...enumMap.entries()].map(([name, values]) => ({ schema: database, name, values }))
        return { ok: true, tables, functions, enums, types: [] }
      } finally { conn.release() }
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
  })

  app.on('will-quit', () => {
    for (const [id] of vpnProcesses) killVpn(id)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Auto-updater
if (isProd) {
  const logFile = fs.createWriteStream(path.join(app.getPath('userData'), 'updater.log'), { flags: 'a' })
  const log = {
    info:  (...a: unknown[]) => { const msg = `[${new Date().toISOString()}] INFO  ${a.join(' ')}\n`; logFile.write(msg) },
    warn:  (...a: unknown[]) => { const msg = `[${new Date().toISOString()}] WARN  ${a.join(' ')}\n`; logFile.write(msg) },
    error: (...a: unknown[]) => { const msg = `[${new Date().toISOString()}] ERROR ${a.join(' ')}\n`; logFile.write(msg) },
  }
  autoUpdater.logger = log
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.setFeedURL({ provider: 'github', owner: 'Marijanoo', repo: 'quence-db' })

  autoUpdater.on('update-available', (info) => { log.info('Update available:', info.version); mainWindow?.webContents.send('update-available') })
  autoUpdater.on('download-progress', (info) => { mainWindow?.webContents.send('update-progress', info.percent) })
  autoUpdater.on('update-downloaded', (info) => { log.info('Downloaded:', info.version); mainWindow?.webContents.send('update-downloaded') })
  autoUpdater.on('error', (err) => log.error('Error:', err?.message ?? err))

  process.on('unhandledRejection', () => {})
  ipcMain.on('install-update', () => autoUpdater.quitAndInstall(true, false))

  app.on('browser-window-created', (_, win) => {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 3000)
      setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000)
    })
  })
}

app.on('activate', () => {
  if (mainWindow === null) createWindow()
})
