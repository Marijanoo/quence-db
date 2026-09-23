// Round-trip test against a real PostgreSQL server. Opt-in: set QUENCE_PG_TEST_URL, e.g.
//   QUENCE_PG_TEST_URL=postgres://postgres@localhost:5432/postgres npm test
// It creates and drops its own uniquely named schemas.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { buildSyncScript, compareSchemas, fetchSchemaSnapshot, isSelectable, snapshotSearchPath, DEFAULT_SYNC_OPTIONS } from './structure-sync'

const url = process.env.QUENCE_PG_TEST_URL
const suffix = Math.random().toString(36).slice(2, 8)
const SRC = `qsync_src_${suffix}`
const DST = `qsync_dst_${suffix}`

describe.skipIf(!url)('structure sync against PostgreSQL', () => {
  let client: Client

  // Mirrors the pg:query IPC handler's searchPath option. The app gets a pooled client per query;
  // here one client is shared, so queries are serialized to keep each search_path with its query.
  const snapshotWith = (c: Client, schema: string) => {
    let queue: Promise<unknown> = Promise.resolve()
    return fetchSchemaSnapshot((sql, params) => {
      const run = queue.then(async () => {
        await c.query(`SELECT set_config('search_path', $1, false)`, [snapshotSearchPath(schema)])
        try { return (await c.query(sql, params)).rows } finally { await c.query('RESET search_path') }
      })
      queue = run.catch(() => {})
      return run
    }, schema)
  }
  const snapshot = (schema: string) => snapshotWith(client, schema)

  beforeAll(async () => {
    client = new Client({ connectionString: url })
    await client.connect()
    await client.query(`
      CREATE SCHEMA ${SRC};
      SET search_path TO ${SRC};
      CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');
      CREATE TABLE users (
        id serial PRIMARY KEY,
        email text NOT NULL,
        status mood NOT NULL DEFAULT 'ok',
        age integer CHECK (age >= 0),
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));
      CREATE TABLE posts (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title varchar(200) NOT NULL,
        words integer NOT NULL DEFAULT 0,
        score numeric GENERATED ALWAYS AS (words * 2) STORED,
        UNIQUE (user_id, title)
      );
      CREATE INDEX posts_title_idx ON posts (title) WHERE words > 0;
      CREATE VIEW active_users AS SELECT id, email FROM users WHERE status <> 'sad';
      CREATE VIEW active_user_count AS SELECT count(*) AS n FROM active_users;

      CREATE SCHEMA ${DST};
      SET search_path TO ${DST};
      CREATE TYPE mood AS ENUM ('sad', 'happy');
      CREATE TABLE users (
        id serial PRIMARY KEY,
        email varchar(100),
        legacy_flag boolean
      );
      CREATE TABLE audit_log (id serial PRIMARY KEY, user_id integer REFERENCES users(id));
      CREATE VIEW active_users AS SELECT id FROM users;
      CREATE VIEW stale_view AS SELECT 1 AS x;
      RESET search_path;
    `)
  })

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${SRC} CASCADE; DROP SCHEMA IF EXISTS ${DST} CASCADE`)
    await client.end()
  })

  it('finds no differences between a schema and itself', async () => {
    const src = await snapshot(SRC)
    expect(src.tables.map(t => t.name).sort()).toEqual(['posts', 'users'])
    const items = compareSchemas(src, await snapshot(SRC), SRC)
    expect(items.filter(i => i.action !== 'same')).toEqual([])
  })

  it('deploys every difference and leaves the target identical to the source', async () => {
    const options = { ...DEFAULT_SYNC_OPTIONS, dropColumns: true }
    const items = compareSchemas(await snapshot(SRC), await snapshot(DST), DST, options)
    const byKey = Object.fromEntries(items.map(i => [i.key, i.action]))
    expect(byKey).toMatchObject({
      'enum:mood': 'modify', 'table:users': 'modify', 'table:posts': 'create', 'table:audit_log': 'drop',
      'view:active_users': 'modify', 'view:active_user_count': 'create', 'view:stale_view': 'drop',
    })

    const script = buildSyncScript(items, items.filter(isSelectable).map(i => i.key), DST)
    expect(script).toContain('-- Part 1 of 2: new enum values')
    // Executed the same way as the pg:execute-script IPC handler: as-is, ROLLBACK on error
    try {
      await client.query(script)
    } catch (err) {
      await client.query('ROLLBACK')
      throw new Error(`${(err as Error).message}\n\n${script}`)
    }

    const again = compareSchemas(await snapshot(SRC), await snapshot(DST), DST, options)
    expect(again.filter(i => i.action !== 'same').map(i => ({ key: i.key, changes: i.changes, warnings: i.warnings }))).toEqual([])
  })

  it('installs a missing extension when syncing into another database', async () => {
    // Needs a database where citext isn't installed yet, so the test can own and remove it
    if ((await client.query(`SELECT 1 FROM pg_extension WHERE extname = 'citext'`)).rowCount) return
    const EXT_SRC = `qsync_ext_${suffix}`
    const TARGET_DB = `qsync_db_${suffix}`
    await client.query(`
      CREATE SCHEMA ${EXT_SRC};
      CREATE EXTENSION citext SCHEMA ${EXT_SRC};
      CREATE TABLE ${EXT_SRC}.accounts (id serial PRIMARY KEY, email ${EXT_SRC}.citext NOT NULL);
    `)
    // CREATE DATABASE can't run inside the multi-statement (implicit transaction) query above
    await client.query(`CREATE DATABASE ${TARGET_DB}`)
    const targetUrl = new URL(url!)
    targetUrl.pathname = `/${TARGET_DB}`
    const target = new Client({ connectionString: targetUrl.toString() })
    await target.connect()
    try {
      const items = compareSchemas(await snapshot(EXT_SRC), await snapshotWith(target, 'public'), 'public')
      expect(items.find(i => i.key === 'extension:citext')?.statements[0].sql).toBe('CREATE EXTENSION IF NOT EXISTS "citext" SCHEMA "public"')

      await target.query(buildSyncScript(items, items.filter(isSelectable).map(i => i.key), 'public'))

      const again = compareSchemas(await snapshot(EXT_SRC), await snapshotWith(target, 'public'), 'public')
      expect(again.filter(i => i.action !== 'same').map(i => i.key)).toEqual([])
    } finally {
      await target.end()
      await client.query(`DROP DATABASE IF EXISTS ${TARGET_DB}`)
      await client.query(`DROP SCHEMA IF EXISTS ${EXT_SRC} CASCADE`)
    }
  })
})
