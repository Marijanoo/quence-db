import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { Pool, PoolClient } from 'pg'
import { randomUUID } from 'crypto'
import * as mysql from 'mysql2/promise'
import { MongoClient } from 'mongodb'
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
import { runMongoShell } from './mongo-shell'

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
    } else if ((input.control || input.meta) && input.key.toLowerCase() === 'r') {
      mainWindow!.webContents.send('run-query')
      event.preventDefault()
    }
  })

  mainWindow.webContents.on('will-reload' as any, (event: Electron.Event) => event.preventDefault())
  mainWindow.on('resize', saveWindowState)
  mainWindow.on('move', saveWindowState)
  mainWindow.on('closed', () => { saveWindowState(); mainWindow = null })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
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

  // ── Export files: save dialog + streaming writes (exports are written batch by batch) ──
  const exportFiles = new Map<string, { handle: fs.promises.FileHandle; filePath: string }>()

  ipcMain.handle('file:save-dialog', async (_e, { title, defaultName, filters }: { title?: string; defaultName?: string; filters?: { name: string; extensions: string[] }[] }) => {
    const result = await dialog.showSaveDialog(mainWindow!, { title, defaultPath: defaultName, filters })
    return result.canceled || !result.filePath ? null : result.filePath
  })

  ipcMain.handle('file:open-write', async (_e, { filePath }: { filePath: string }) => {
    try {
      const handle = await fs.promises.open(filePath, 'w')
      const fileId = randomUUID()
      exportFiles.set(fileId, { handle, filePath })
      return { ok: true, fileId }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('file:write', async (_e, { fileId, text }: { fileId: string; text: string }) => {
    const file = exportFiles.get(fileId)
    if (!file) return { ok: false, error: 'File is not open' }
    try {
      await file.handle.write(text)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // discard: delete the partial file (a cancelled or failed export)
  ipcMain.handle('file:close', async (_e, { fileId, discard }: { fileId: string; discard?: boolean }) => {
    const file = exportFiles.get(fileId)
    if (!file) return { ok: true }
    exportFiles.delete(fileId)
    try {
      await file.handle.close()
      if (discard) await fs.promises.unlink(file.filePath).catch(() => {})
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('file:show-in-folder', (_e, { filePath }: { filePath: string }) => {
    shell.showItemInFolder(filePath)
    return { ok: true }
  })

  // ── Postgres connections ────────────────────────────────────────────────────
  const pgPools = new Map<string, Pool>()
  const vpnProcesses = new Map<string, ChildProcess>()

  function spawnVpn(id: string, configPath: string, username?: string, password?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Unique per spawn, so a superseded attempt's cleanup can't delete a newer attempt's files
      const safeId = `${id.replace(/[^a-zA-Z0-9]/g, '')}-${Date.now()}`
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
        if (vpnProcesses.get(id) === proc) vpnProcesses.delete(id)
        if (!settled) { settled = true; clearTimeout(timeout); cleanup(); reject(err) }
      })
      proc.on('exit', (code) => {
        cleanup()
        if (vpnProcesses.get(id) === proc) vpnProcesses.delete(id)
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

  // ── Connect attempts ────────────────────────────────────────────────────────
  // Each connect is an attempt that a newer connect for the same id, or an explicit cancel,
  // aborts immediately instead of leaving the renderer waiting on a stale handshake.
  const CANCELLED = 'Connection cancelled'
  const connectAttempts = new Map<string, () => void>()

  function beginConnectAttempt(id: string) {
    connectAttempts.get(id)?.()
    let reject!: (err: Error) => void
    const cancelled = new Promise<never>((_, rej) => { reject = rej })
    cancelled.catch(() => {})
    let isCancelled = false
    const cancel = () => { isCancelled = true; reject(new Error(CANCELLED)) }
    connectAttempts.set(id, cancel)
    return {
      race: <T>(p: Promise<T>) => Promise.race([p, cancelled]),
      get cancelled() { return isCancelled },
      finish: () => { if (connectAttempts.get(id) === cancel) connectAttempts.delete(id) },
    }
  }

  function connectFailure(attempt: { cancelled: boolean }, id: string, err: unknown) {
    // A cancelled attempt must not kill the VPN: it may already belong to the newer attempt
    if (attempt.cancelled) return { ok: false, cancelled: true, error: CANCELLED }
    killVpn(id)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  ipcMain.handle('db:cancel-connect', (_e, { id }: { id: string }) => {
    connectAttempts.get(id)?.()
    connectAttempts.delete(id)
    killVpn(id)
    return { ok: true }
  })

  function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>
    return Promise.race([
      p,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) }),
    ]).finally(() => clearTimeout(timer))
  }

  // pg emits 'error' when an idle pooled client drops (VPN down, server restart). Without a
  // listener that is an uncaught exception in the main process.
  function newPgPool(config: ConstructorParameters<typeof Pool>[0]) {
    const pool = new Pool(config)
    pool.on('error', err => console.warn('[pg] idle client error:', err.message))
    return pool
  }

  function endPgPoolsFor(id: string) {
    // Not awaited: end() waits for checked-out clients, which a long-running query can hold
    pgPools.get(id)?.end().catch(() => {})
    pgPools.delete(id)
    for (const [key, pool] of dbQueryPools) {
      if (key.startsWith(`${id}::`)) { pool.end().catch(() => {}); dbQueryPools.delete(key) }
    }
  }

  ipcMain.handle('pg:connect', async (_e, { id, host, port, database, user, password, ssl, vpnConfigPath, vpnUsername, vpnPassword }: {
    id: string; host: string; port: number; database: string; user: string; password: string; ssl: boolean; vpnConfigPath?: string; vpnUsername?: string; vpnPassword?: string
  }) => {
    const attempt = beginConnectAttempt(id)
    let pool: Pool | undefined
    try {
      endPgPoolsFor(id)
      killVpn(id)
      if (vpnConfigPath) await attempt.race(spawnVpn(id, vpnConfigPath, vpnUsername, vpnPassword))
      pool = newPgPool({ host, port, database, user, password, ssl: ssl ? { rejectUnauthorized: false } : false, connectionTimeoutMillis: 30000 })
      const client = await attempt.race(withTimeout(pool.connect(), 30000, 'Connection timed out after 30s'))
      client.release()
      pgPools.set(id, pool)
      return { ok: true }
    } catch (err) {
      pool?.end().catch(() => {})
      return connectFailure(attempt, id, err)
    } finally {
      attempt.finish()
    }
  })

  ipcMain.handle('pg:disconnect', async (_e, { id }: { id: string }) => {
    endPgPoolsFor(id)
    killVpn(id)
    return { ok: true }
  })

  const dbQueryPools = new Map<string, Pool>()

  function pgPoolFor(id: string, database?: string): Pool | undefined {
    const basePool = pgPools.get(id)
    if (!basePool || !database) return basePool
    const key = `${id}::${database}`
    if (!dbQueryPools.has(key)) {
      const opts = (basePool as any).options as { host: string; port: number; user: string; password: string; ssl: any }
      dbQueryPools.set(key, newPgPool({ host: opts.host, port: opts.port, user: opts.user, password: opts.password, database, ssl: opts.ssl, connectionTimeoutMillis: 15000 }))
    }
    return dbQueryPools.get(key)!
  }

  // Renaming or dropping a database needs every connection to it closed, including ours. Awaited
  // (unlike endPgPoolsFor): the caller runs the DROP/RENAME right after.
  ipcMain.handle('pg:close-db-pool', async (_e, { id, database }: { id: string; database: string }) => {
    const key = `${id}::${database}`
    const pool = dbQueryPools.get(key)
    dbQueryPools.delete(key)
    await pool?.end().catch(() => {})
    return { ok: true }
  })

  // Applies session settings in a single round trip (set_config accepts any GUC by name)
  async function applySettings(client: PoolClient, settings: Record<string, string>, local: boolean) {
    const entries = Object.entries(settings)
    if (entries.length === 0) return
    const calls = entries.map((_, i) => `set_config($${i * 2 + 1}, $${i * 2 + 2}, ${local})`).join(', ')
    await client.query(`SELECT ${calls}`, entries.flat())
  }

  ipcMain.handle('pg:query', async (_e, { id, sql, database, params, searchPath, settings }: {
    id: string; sql: string; database?: string; params?: unknown[]; searchPath?: string; settings?: Record<string, string>
  }) => {
    const pool = pgPoolFor(id, database)
    if (!pool) return { ok: false, error: 'Not connected' }
    try {
      const start = Date.now()
      let result
      const sessionSettings = { ...settings, ...(searchPath ? { search_path: searchPath } : {}) }
      if (Object.keys(sessionSettings).length > 0) {
        // Settings such as search_path (pg_get_*def() omits schema names found on it) or
        // TimeZone/DateStyle (deterministic text output) need a dedicated client
        const client = await pool.connect()
        try {
          await applySettings(client, sessionSettings, false)
          result = await client.query(sql, params)
        } finally {
          await client.query('RESET ALL').catch(() => {})
          client.release()
        }
      } else {
        result = await pool.query(sql, params)
      }
      return { ok: true, rows: result.rows, fields: result.fields.map(f => f.name), rowCount: result.rowCount, ms: Date.now() - start }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ── Transaction sessions ──────────────────────────────────────────────────
  // A session is one dedicated client inside an open transaction that the renderer drives with
  // many queries (e.g. a batched data sync), then commits or rolls back. Idle sessions are rolled
  // back automatically so an abandoned renderer can't hold locks forever.
  const SESSION_IDLE_MS = 15 * 60 * 1000
  const sessions = new Map<string, { client: PoolClient; pool: Pool; timer: ReturnType<typeof setTimeout> }>()

  async function closeSession(sessionId: string, commit: boolean) {
    const session = sessions.get(sessionId)
    if (!session) throw new Error('Transaction session not found (it may have timed out and been rolled back)')
    sessions.delete(sessionId)
    clearTimeout(session.timer)
    try {
      await session.client.query(commit ? 'COMMIT' : 'ROLLBACK')
    } catch (err) {
      await session.client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      await session.client.query('RESET ALL').catch(() => {})
      session.client.release()
    }
  }

  function touchSession(sessionId: string) {
    const session = sessions.get(sessionId)
    if (!session) return undefined
    clearTimeout(session.timer)
    session.timer = setTimeout(() => { closeSession(sessionId, false).catch(() => {}) }, SESSION_IDLE_MS)
    return session
  }

  ipcMain.handle('pg:session-open', async (_e, { id, database, settings, readOnly }: { id: string; database?: string; settings?: Record<string, string>; readOnly?: boolean }) => {
    const pool = pgPoolFor(id, database)
    if (!pool) return { ok: false, error: 'Not connected' }
    let client: PoolClient | undefined
    try {
      client = await pool.connect()
      // Read-only sessions see one consistent snapshot for their whole lifetime
      await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN')
      await applySettings(client, settings ?? {}, true)
      const sessionId = randomUUID()
      sessions.set(sessionId, { client, pool, timer: setTimeout(() => {}, 0) })
      touchSession(sessionId)
      return { ok: true, sessionId }
    } catch (err) {
      if (client) { await client.query('ROLLBACK').catch(() => {}); client.release() }
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('pg:session-query', async (_e, { sessionId, sql, params }: { sessionId: string; sql: string; params?: unknown[] }) => {
    const session = touchSession(sessionId)
    if (!session) return { ok: false, error: 'Transaction session not found (it may have timed out and been rolled back)' }
    try {
      const result = await session.client.query(sql, params)
      return { ok: true, rows: result.rows, rowCount: result.rowCount }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('pg:session-close', async (_e, { sessionId, commit }: { sessionId: string; commit: boolean }) => {
    try { await closeSession(sessionId, commit); return { ok: true } }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
  })

  // Interrupts the statement a session is running (from a separate connection); the session's
  // query then fails and the caller rolls back
  ipcMain.handle('pg:session-cancel', async (_e, { sessionId }: { sessionId: string }) => {
    const session = sessions.get(sessionId)
    if (!session) return { ok: false, error: 'Transaction session not found' }
    try {
      await session.pool.query('SELECT pg_cancel_backend($1)', [(session.client as unknown as { processID: number }).processID])
      return { ok: true }
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
  })

  // Runs a multi-statement script as one simple query on a dedicated client. The script manages its
  // own transactions (BEGIN/COMMIT blocks); without any, the server runs it as a single implicit
  // transaction. On error the open transaction, if any, is rolled back.
  ipcMain.handle('pg:execute-script', async (_e, { id, sql, database }: { id: string; sql: string; database?: string }) => {
    const pool = pgPoolFor(id, database)
    if (!pool) return { ok: false, error: 'Not connected' }
    let client
    try { client = await pool.connect() }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
    try {
      await client.query(sql)
      return { ok: true }
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {})
      return { ok: false, error: err?.message ?? String(err), position: err?.position ? Number(err.position) : undefined }
    } finally {
      await client.query('RESET ALL').catch(() => {})
      client.release()
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
    const dbPool = newPgPool({ host: opts.host, port: opts.port, user: opts.user, password: opts.password, database, ssl: opts.ssl, connectionTimeoutMillis: 15000 })
    try {
      const [tablesRes, funcsRes, enumsRes, typesRes, columnsRes] = await Promise.all([
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
        dbPool.query(`
          SELECT n.nspname AS table_schema, c.relname AS table_name, a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS data_type
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r','v','m') AND n.nspname NOT IN ('pg_catalog','information_schema')
          ORDER BY table_schema, table_name, a.attnum
        `),
      ])
      return { ok: true, tables: tablesRes.rows, functions: funcsRes.rows, enums: enumsRes.rows, types: typesRes.rows, columns: columnsRes.rows }
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
    const attempt = beginConnectAttempt(id)
    let pool: mysql.Pool | undefined
    try {
      mysqlPools.get(id)?.end().catch(() => {})
      mysqlPools.delete(id)
      killVpn(id)
      if (vpnConfigPath) await attempt.race(spawnVpn(id, vpnConfigPath, vpnUsername, vpnPassword))
      pool = mysql.createPool({
        host, port, database: database || undefined, user, password,
        ssl: ssl ? { rejectUnauthorized: false } : undefined,
        connectTimeout: 10000, waitForConnections: true, connectionLimit: 5,
      })
      const conn = await attempt.race(withTimeout(pool.getConnection(), 10000, 'Connection timed out after 10s'))
      conn.release()
      mysqlPools.set(id, pool)
      return { ok: true }
    } catch (err) {
      pool?.end().catch(() => {})
      return connectFailure(attempt, id, err)
    } finally {
      attempt.finish()
    }
  })

  ipcMain.handle('mysql:disconnect', async (_e, { id }: { id: string }) => {
    mysqlPools.get(id)?.end().catch(() => {})
    mysqlPools.delete(id)
    killVpn(id)
    return { ok: true }
  })

  // Same idea as the PostgreSQL transaction sessions. Note that MySQL implicitly commits DDL
  // (TRUNCATE, DROP, RENAME, CREATE), so only DML inside a session can really be rolled back.
  const mysqlSessions = new Map<string, { conn: mysql.PoolConnection; pool: mysql.Pool; timer: ReturnType<typeof setTimeout> }>()

  async function closeMysqlSession(sessionId: string, commit: boolean) {
    const session = mysqlSessions.get(sessionId)
    if (!session) throw new Error('Transaction session not found (it may have timed out and been rolled back)')
    mysqlSessions.delete(sessionId)
    clearTimeout(session.timer)
    try {
      if (commit) await session.conn.commit()
      else await session.conn.rollback()
    } catch (err) {
      await session.conn.rollback().catch(() => {})
      throw err
    } finally {
      session.conn.release()
    }
  }

  function touchMysqlSession(sessionId: string) {
    const session = mysqlSessions.get(sessionId)
    if (!session) return undefined
    clearTimeout(session.timer)
    session.timer = setTimeout(() => { closeMysqlSession(sessionId, false).catch(() => {}) }, SESSION_IDLE_MS)
    return session
  }

  ipcMain.handle('mysql:session-open', async (_e, { id, database }: { id: string; database?: string }) => {
    const pool = mysqlPools.get(id)
    if (!pool) return { ok: false, error: 'Not connected' }
    let conn: mysql.PoolConnection | undefined
    try {
      conn = await pool.getConnection()
      if (database) await conn.query(`USE \`${database.replace(/`/g, '``')}\``)
      await conn.beginTransaction()
      const sessionId = randomUUID()
      mysqlSessions.set(sessionId, { conn, pool, timer: setTimeout(() => {}, 0) })
      touchMysqlSession(sessionId)
      return { ok: true, sessionId }
    } catch (err) {
      if (conn) { await conn.rollback().catch(() => {}); conn.release() }
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('mysql:session-query', async (_e, { sessionId, sql, params }: { sessionId: string; sql: string; params?: unknown[] }) => {
    const session = touchMysqlSession(sessionId)
    if (!session) return { ok: false, error: 'Transaction session not found (it may have timed out and been rolled back)' }
    try {
      const [rows] = await session.conn.query(sql, params) as [any, mysql.FieldPacket[]]
      return Array.isArray(rows)
        ? { ok: true, rows, rowCount: rows.length }
        : { ok: true, rows: [], rowCount: (rows as mysql.ResultSetHeader).affectedRows ?? 0 }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('mysql:session-close', async (_e, { sessionId, commit }: { sessionId: string; commit: boolean }) => {
    try { await closeMysqlSession(sessionId, commit); return { ok: true } }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
  })

  ipcMain.handle('mysql:session-cancel', async (_e, { sessionId }: { sessionId: string }) => {
    const session = mysqlSessions.get(sessionId)
    if (!session) return { ok: false, error: 'Transaction session not found' }
    try {
      await session.pool.query(`KILL QUERY ${Number(session.conn.threadId)}`)
      return { ok: true }
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
  })

  ipcMain.handle('mysql:query', async (_e, { id, sql, database, params }: { id: string; sql: string; database?: string; params?: unknown[] }) => {
    const pool = mysqlPools.get(id)
    if (!pool) return { ok: false, error: 'Not connected' }
    try {
      const conn = await pool.getConnection()
      try {
        if (database) await conn.query(`USE \`${database}\``)
        const start = Date.now()
        const [rows, fields] = await conn.query({ sql, rowsAsArray: false }, params) as [any[], mysql.FieldPacket[]]
        const ms = Date.now() - start
        const fieldNames = Array.isArray(fields) ? fields.map((f: any) => f.name) : []
        const normalizedRows = Array.isArray(rows) ? rows : []
        const rowCount = Array.isArray(rows) ? rows.length : ((rows as mysql.ResultSetHeader).affectedRows ?? 0)
        return { ok: true, rows: normalizedRows, fields: fieldNames, rowCount, ms }
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

  // ── MongoDB connections ─────────────────────────────────────────────────────
  const mongoClients = new Map<string, MongoClient>()

  ipcMain.handle('mongodb:connect', async (_e, { id, host }: { id: string; host: string }) => {
    const attempt = beginConnectAttempt(id)
    let client: MongoClient | undefined
    try {
      mongoClients.get(id)?.close().catch(() => {})
      mongoClients.delete(id)
      client = new MongoClient(host, { connectTimeoutMS: 15000, serverSelectionTimeoutMS: 15000 })
      await attempt.race(client.connect())
      mongoClients.set(id, client)
      return { ok: true }
    } catch (err) {
      client?.close().catch(() => {})
      return connectFailure(attempt, id, err)
    } finally {
      attempt.finish()
    }
  })

  ipcMain.handle('mongodb:disconnect', async (_e, { id }: { id: string }) => {
    mongoClients.get(id)?.close().catch(() => {})
    mongoClients.delete(id)
    return { ok: true }
  })

  ipcMain.handle('mongodb:introspect', async (_e, { id }: { id: string }) => {
    const client = mongoClients.get(id)
    if (!client) return { ok: false, error: 'Not connected' }
    try {
      const res = await client.db().admin().listDatabases()
      const databases = res.databases.map(d => d.name)
        .filter(d => !['admin', 'local', 'config'].includes(d))
      return { ok: true, databases }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('mongodb:introspect-db', async (_e, { id, database }: { id: string; database: string }) => {
    const client = mongoClients.get(id)
    if (!client) return { ok: false, error: 'Not connected' }
    try {
      const db = client.db(database)
      const list = await db.listCollections().toArray()
      const tables = list.map(c => ({
        table_schema: database,
        table_name: c.name,
        table_type: c.type === 'view' ? 'VIEW' : 'BASE TABLE'
      }))
      return { ok: true, tables, functions: [], enums: [], types: [] }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('mongodb:query', async (_e, { id, sql, database, typed }: { id: string; sql: string; database?: string; typed?: boolean }) => {
    const client = mongoClients.get(id)
    if (!client) return { ok: false, error: 'Not connected' }
    try {
      return { ok: true, ...(await runMongoShell(client, database, sql, { typed })) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  app.on('will-quit', () => {
    for (const [id] of vpnProcesses) killVpn(id)
    for (const [id, client] of mongoClients) {
      client.close().catch(() => {})
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Auto-updater
if (isProd) {
  const logFile = fs.createWriteStream(path.join(app.getPath('userData'), 'updater.log'), { flags: 'a' })
  const log = {
    info:  (...a: unknown[]) => { const msg = `[${new Date().toISOString()}] INFO  ${a.join(' ')}\n`; logFile.write(msg); console.log(msg.trimEnd()) },
    warn:  (...a: unknown[]) => { const msg = `[${new Date().toISOString()}] WARN  ${a.join(' ')}\n`; logFile.write(msg); console.warn(msg.trimEnd()) },
    error: (...a: unknown[]) => { const msg = `[${new Date().toISOString()}] ERROR ${a.join(' ')}\n`; logFile.write(msg); console.error(msg.trimEnd()) },
  }
  autoUpdater.logger = log
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  if (process.platform === 'darwin') {
    autoUpdater.channel = 'latest'
  }

  autoUpdater.setFeedURL({ provider: 'github', owner: 'Marijanoo', repo: 'quence-db' })

  autoUpdater.on('checking-for-update', () => { log.info('[updater] Checking for update…') })
  autoUpdater.on('update-available', (info) => { log.info('[updater] Update available:', info.version); mainWindow?.webContents.send('update-available') })
  autoUpdater.on('update-not-available', (info) => { log.info('[updater] Already up to date:', info.version) })
  autoUpdater.on('download-progress', (info) => {
    log.info(`[updater] Downloading… ${info.percent.toFixed(1)}% (${(info.transferred / 1024 / 1024).toFixed(1)} / ${(info.total / 1024 / 1024).toFixed(1)} MB)`)
    mainWindow?.webContents.send('update-progress', info.percent)
  })
  autoUpdater.on('update-downloaded', (info) => { log.info('[updater] Update downloaded, ready to install:', info.version); mainWindow?.webContents.send('update-downloaded') })
  autoUpdater.on('error', (err) => { log.error('[updater] Error:', err?.message ?? err) })

  process.on('unhandledRejection', () => {})
  ipcMain.on('install-update', () => { log.info('[updater] install-update requested, calling quitAndInstall'); autoUpdater.quitAndInstall(true, false) })

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
