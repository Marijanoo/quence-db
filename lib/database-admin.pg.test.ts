// Database administration statements against PostgreSQL. Opt-in: set QUENCE_PG_TEST_URL (see structure-sync.pg.test.ts).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import {
  DATABASE_INFO_SQL, EXTENSIONS_SQL, ROLES_SQL, TEMPLATES_SQL, buildAlterDatabase, buildCreateDatabase, buildCreateSchema,
  buildDropDatabase, buildDropExtension, buildInstallExtension, maintenanceSql, parseDatabaseInfo, parseExtensions,
  type MaintenanceKind,
} from './database-admin'

const url = process.env.QUENCE_PG_TEST_URL
const suffix = Math.random().toString(36).slice(2, 8)
const DB = `qadmin_${suffix}`
const RENAMED = `qadmin_${suffix} renamed`
const ROLE = `qadmin_role_${suffix}`

function urlFor(database: string) {
  const u = new URL(url!)
  u.pathname = '/' + encodeURIComponent(database)
  return u.toString()
}

describe.skipIf(!url)('database administration against PostgreSQL', () => {
  let admin: Client

  beforeAll(async () => {
    admin = new Client({ connectionString: url })
    await admin.connect()
    await admin.query(`CREATE ROLE "${ROLE}"`)
  })

  afterAll(async () => {
    for (const name of [DB, RENAMED]) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {})
    await admin.query(`DROP ROLE IF EXISTS "${ROLE}"`).catch(() => {})
    await admin.end()
  })

  it('creates, edits and force-drops a database', async () => {
    const roles = (await admin.query(ROLES_SQL)).rows.map(r => r.rolname)
    expect(roles).toContain(ROLE)
    expect((await admin.query(TEMPLATES_SQL)).rows.map(r => r.datname)).toContain('template0')

    for (const sql of buildCreateDatabase({ name: DB, owner: '', encoding: 'UTF8', template: 'template0', connectionLimit: 10, comment: 'made by a test' })) {
      await admin.query(sql)
    }
    const created = parseDatabaseInfo((await admin.query(DATABASE_INFO_SQL, [DB])).rows[0])
    expect(created).toMatchObject({ name: DB, encoding: 'UTF8', connectionLimit: 10, comment: 'made by a test' })

    for (const sql of buildAlterDatabase(created, { ...created, name: RENAMED, owner: ROLE, connectionLimit: -1, comment: "it's renamed" })) {
      await admin.query(sql)
    }
    const edited = parseDatabaseInfo((await admin.query(DATABASE_INFO_SQL, [RENAMED])).rows[0])
    expect(edited).toMatchObject({ name: RENAMED, owner: ROLE, connectionLimit: -1, comment: "it's renamed" })

    // Another session holds the database open: a plain drop fails, FORCE disconnects it
    const other = new Client({ connectionString: urlFor(RENAMED) })
    await other.connect()
    other.on('error', () => {})
    await expect(admin.query(buildDropDatabase(RENAMED, false))).rejects.toThrow(/being accessed by other users/)
    await admin.query(buildDropDatabase(RENAMED, true))
    expect((await admin.query(DATABASE_INFO_SQL, [RENAMED])).rowCount).toBe(0)
    await other.end().catch(() => {})
  }, 30_000) // a plain DROP waits ~5s for other sessions before failing

  it('creates schemas, manages extensions and runs maintenance inside a database', async () => {
    for (const sql of buildCreateDatabase({ name: DB, owner: '', encoding: '', template: '', connectionLimit: -1, comment: '' })) await admin.query(sql)
    const db = new Client({ connectionString: urlFor(DB) })
    await db.connect()
    try {
      await db.query(buildCreateSchema('sales', ROLE))
      expect((await db.query(`SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'sales'`)).rows[0].owner).toBe(ROLE)

      const extensions = parseExtensions((await db.query(EXTENSIONS_SQL)).rows)
      expect(extensions.find(e => e.name === 'plpgsql')).toMatchObject({ installedVersion: expect.any(String), schema: 'pg_catalog' })
      // Contrib extensions ship with most installs; use one if this server has it
      const contrib = extensions.find(e => e.name === 'pg_trgm' || e.name === 'hstore' || e.name === 'citext')
      if (contrib) {
        await db.query(buildInstallExtension(contrib.name, 'sales', false))
        expect(parseExtensions((await db.query(EXTENSIONS_SQL)).rows).find(e => e.name === contrib.name)).toMatchObject({ schema: 'sales', installedVersion: contrib.defaultVersion })
        await db.query(buildDropExtension(contrib.name, true))
        expect(parseExtensions((await db.query(EXTENSIONS_SQL)).rows).find(e => e.name === contrib.name)?.installedVersion).toBeNull()
      }

      await db.query('CREATE TABLE sales.t (id int PRIMARY KEY)')
      for (const kind of ['analyze', 'vacuum', 'vacuumAnalyze', 'vacuumFull', 'reindex'] as MaintenanceKind[]) {
        await db.query(maintenanceSql(kind, DB))
      }
    } finally {
      await db.end()
    }
  })
})
