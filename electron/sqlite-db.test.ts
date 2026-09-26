import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import Database from 'better-sqlite3'

let encryptionAvailable = true
// Fake "OS keychain": XOR with a fixed key, base64-encoded — good enough to prove
// values are transformed on write and reversed on read without needing real OS crypto in tests.
function fakeEncrypt(plain: string): Buffer {
  const key = 42
  const bytes = Buffer.from(plain, 'utf8').map(b => b ^ key)
  return Buffer.from(bytes)
}
function fakeDecrypt(buf: Buffer): string {
  const key = 42
  const bytes = Buffer.from(buf).map(b => b ^ key)
  return Buffer.from(bytes).toString('utf8')
}

let tmpDir: string

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpDir,
  },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (s: string) => fakeEncrypt(s),
    decryptString: (b: Buffer) => fakeDecrypt(b),
  },
}))

describe('sqlite-db credential encryption', () => {
  beforeEach(() => {
    encryptionAvailable = true
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quence-db-test-'))
    vi.resetModules()
  })

  afterEach(() => {
    // better-sqlite3 keeps its file handle open for the lifetime of the module-level
    // singleton in sqlite-db.ts, which vi.resetModules() doesn't close. On Windows this
    // can make the temp dir briefly undeletable; best-effort cleanup, not test-critical.
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
  })

  it('stores an encrypted (non-plaintext) value and returns the decrypted password on read', async () => {
    const { dbCreateConnection, dbGetConnection } = await import('./sqlite-db')
    dbCreateConnection({ id: 'c1', name: 'conn1', password: 'hunter2', vpnPassword: 'vpnsecret' })

    const raw = new Database(path.join(tmpDir, 'quence-db.db'))
    const row = raw.prepare('SELECT password, vpn_password FROM connections WHERE id = ?').get('c1') as any
    raw.close()
    expect(row.password).not.toBe('hunter2')
    expect(row.password.startsWith('enc:v1:')).toBe(true)
    expect(row.vpn_password.startsWith('enc:v1:')).toBe(true)

    const conn = dbGetConnection('c1')
    expect(conn.password).toBe('hunter2')
    expect(conn.vpnPassword).toBe('vpnsecret')
  })

  it('round-trips through dbUpdateConnection', async () => {
    const { dbCreateConnection, dbUpdateConnection, dbGetConnection } = await import('./sqlite-db')
    dbCreateConnection({ id: 'c1', name: 'conn1', password: 'first' })
    dbUpdateConnection('c1', { password: 'second' })
    expect(dbGetConnection('c1').password).toBe('second')
  })

  it('falls back to plaintext when encryption is unavailable', async () => {
    encryptionAvailable = false
    const { dbCreateConnection, dbGetConnection } = await import('./sqlite-db')
    dbCreateConnection({ id: 'c1', name: 'conn1', password: 'plainpass' })

    const raw = new Database(path.join(tmpDir, 'quence-db.db'))
    const row = raw.prepare('SELECT password FROM connections WHERE id = ?').get('c1') as any
    raw.close()
    expect(row.password).toBe('plainpass')
    expect(dbGetConnection('c1').password).toBe('plainpass')
  })

  it('treats legacy unprefixed plaintext rows as already-decrypted', async () => {
    const { dbCreateConnection, dbGetConnection } = await import('./sqlite-db')
    dbCreateConnection({ id: 'c1', name: 'conn1', password: 'x' })

    const raw = new Database(path.join(tmpDir, 'quence-db.db'))
    raw.prepare('UPDATE connections SET password = ? WHERE id = ?').run('legacy-plaintext', 'c1')
    raw.close()

    expect(dbGetConnection('c1').password).toBe('legacy-plaintext')
  })

  it('leaves empty/absent passwords as empty', async () => {
    const { dbCreateConnection, dbGetConnection } = await import('./sqlite-db')
    dbCreateConnection({ id: 'c1', name: 'conn1' })
    const conn = dbGetConnection('c1')
    expect(conn.password).toBe('')
    expect(conn.vpnPassword).toBeUndefined()
  })
})

describe('sqlite-db connection options', () => {
  beforeEach(() => {
    encryptionAvailable = true
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quence-db-test-'))
    vi.resetModules()
  })

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  })

  it('upgrades a database from before the options columns without losing connections', async () => {
    const old = new Database(path.join(tmpDir, 'quence-db.db'))
    old.exec(`CREATE TABLE connections (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, db_type TEXT NOT NULL DEFAULT 'pg', host TEXT NOT NULL DEFAULT '',
      port INTEGER NOT NULL DEFAULT 5432, database TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '',
      password TEXT NOT NULL DEFAULT '', ssl INTEGER NOT NULL DEFAULT 0, vpn_config_path TEXT, vpn_username TEXT,
      vpn_password TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
    old.prepare(`INSERT INTO connections (id, name, created_at, updated_at) VALUES ('old', 'Old one', 1, 1)`).run()
    old.close()

    const { dbGetConnections } = await import('./sqlite-db')
    const [conn] = dbGetConnections()
    expect(conn).toMatchObject({ id: 'old', name: 'Old one', options: {} })
    expect(conn.sshPassword).toBeUndefined()
  })

  it('round-trips options, and encrypts the SSH secrets', async () => {
    const { dbCreateConnection, dbUpdateConnection, dbGetConnection } = await import('./sqlite-db')
    const options = { environment: 'production', color: 'red', ssh: { enabled: true, host: 'bastion', port: 22, user: 'me', auth: 'key', keyPath: '/k' } }
    dbCreateConnection({ id: 'c1', name: 'conn1', options, sshPassword: 'sshpw', sshPassphrase: 'keypw' })

    const raw = new Database(path.join(tmpDir, 'quence-db.db'))
    const row = raw.prepare('SELECT options, ssh_password, ssh_passphrase FROM connections WHERE id = ?').get('c1') as any
    raw.close()
    expect(JSON.parse(row.options)).toEqual(options)
    expect(row.ssh_password.startsWith('enc:v1:')).toBe(true)
    expect(row.ssh_passphrase.startsWith('enc:v1:')).toBe(true)

    expect(dbGetConnection('c1')).toMatchObject({ options, sshPassword: 'sshpw', sshPassphrase: 'keypw' })
    dbUpdateConnection('c1', { options: { environment: 'staging' } })
    expect(dbGetConnection('c1').options).toEqual({ environment: 'staging' })
  })
})
