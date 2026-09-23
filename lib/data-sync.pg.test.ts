// Data sync against a real PostgreSQL server. Opt-in: set QUENCE_PG_TEST_URL (see structure-sync.pg.test.ts).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import {
  compareTable, dataSyncSettings, deployData, loadDataMeta, planTables, DataSyncCancelled,
  type Endpoint, type SqlRunner, type TablePlan,
} from './data-sync'

const url = process.env.QUENCE_PG_TEST_URL
const suffix = Math.random().toString(36).slice(2, 8)
const SRC = `qdata_src_${suffix}`
const DST = `qdata_dst_${suffix}`

const schemaDdl = (s: string) => `
  CREATE SCHEMA ${s};
  SET search_path TO ${s};
  CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');
  CREATE TABLE parents (
    id serial PRIMARY KEY,
    name text NOT NULL,
    created timestamptz,
    meta jsonb,
    blob bytea,
    tags text[],
    score numeric(10,2),
    feeling mood,
    ref uuid,
    ratio double precision
  );
  CREATE TABLE children (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    parent_id integer NOT NULL REFERENCES parents(id),
    qty integer NOT NULL,
    doubled integer GENERATED ALWAYS AS (qty * 2) STORED
  );
  CREATE TABLE pairs (a integer, b text, val double precision, PRIMARY KEY (a, b));
  CREATE TABLE big (id integer PRIMARY KEY, v text);
  CREATE TABLE no_key (x integer);
  CREATE TABLE messages (
    id uuid PRIMARY KEY,
    body text NOT NULL,
    "replyToMessageId" uuid,
    CONSTRAINT "message_replyToMessageId" FOREIGN KEY ("replyToMessageId") REFERENCES messages(id)
  );
  RESET search_path;
`

describe.skipIf(!url)('data sync against PostgreSQL', () => {
  let srcClient: Client
  let dstClient: Client

  const runnerFor = (c: Client): SqlRunner => ({
    query: async (sql, params) => { const r = await c.query(sql, params); return { rows: r.rows, rowCount: r.rowCount ?? 0 } },
  })
  const connectWithSettings = async (schema: string) => {
    const c = new Client({ connectionString: url })
    await c.connect()
    for (const [k, v] of Object.entries(dataSyncSettings(schema))) await c.query(`SELECT set_config($1, $2, false)`, [k, v])
    return c
  }
  let source: Endpoint
  let target: Endpoint
  let plans: TablePlan[]

  beforeAll(async () => {
    const admin = new Client({ connectionString: url })
    await admin.connect()
    await admin.query(schemaDdl(SRC) + schemaDdl(DST))
    await admin.query(`
      SET search_path TO ${SRC};
      INSERT INTO parents (name, created, meta, blob, tags, score, feeling, ref, ratio) VALUES
        ('same', '2026-01-02 03:04:05+02', '{"a": [1, 2]}', '\\x00ff', '{x,"y z"}', 1.50, 'ok', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 0.1),
        ('changed in source', '2026-05-06 07:08:09+00', '{"b": null}', '\\xdeadbeef', '{}', 99.99, 'happy', NULL, 1e-10),
        ('only in source', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
      INSERT INTO children (parent_id, qty) VALUES (1, 5), (2, 7), (3, 9);
      INSERT INTO pairs VALUES (1, 'plain', 1), (1, 'quote''s "and" ünïcødé', 2), (2, 'plain', 3);
      INSERT INTO big SELECT g, 'v' || g FROM generate_series(1, 25000) g;
      UPDATE big SET v = 'changed' WHERE id % 5000 = 0;

      SET search_path TO ${DST};
      INSERT INTO parents (id, name, created, meta, blob, tags, score, feeling, ref, ratio) VALUES
        (1, 'same', '2026-01-02 01:04:05+00', '{"a": [1, 2]}', '\\x00ff', '{x,"y z"}', 1.5, 'ok', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 0.1),
        (2, 'old name', '2026-05-06 07:08:09+00', '{"b": null}', '\\xdeadbeef', '{}', 99.99, 'happy', NULL, 1e-10),
        (50, 'only in target', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
      SELECT setval(pg_get_serial_sequence('parents', 'id'), 50);
      INSERT INTO children (id, parent_id, qty) OVERRIDING SYSTEM VALUE VALUES (1, 1, 5), (2, 2, 1), (40, 50, 1);
      INSERT INTO pairs VALUES (1, 'plain', 1), (2, 'plain', 30), (9, 'extra', 0);
      INSERT INTO big SELECT g, 'v' || g FROM generate_series(1, 24990) g;
      INSERT INTO big VALUES (30000, 'target only');
      RESET search_path;
    `)
    await admin.end()

    srcClient = await connectWithSettings(SRC)
    dstClient = await connectWithSettings(DST)
    source = { runner: runnerFor(srcClient), schema: SRC }
    target = { runner: runnerFor(dstClient), schema: DST }
    plans = planTables(await loadDataMeta(source.runner, SRC), await loadDataMeta(target.runner, DST))
  })

  afterAll(async () => {
    await srcClient?.end()
    await dstClient?.end()
    const admin = new Client({ connectionString: url })
    await admin.connect()
    await admin.query(`DROP SCHEMA IF EXISTS ${SRC} CASCADE; DROP SCHEMA IF EXISTS ${DST} CASCADE`)
    await admin.end()
  })

  const plan = (t: string) => plans.find(p => p.table === t)!

  it('plans keys, copyable columns and skips tables without a primary key', () => {
    expect(plan('no_key').skipped).toMatch(/no primary key/)
    expect(plan('pairs').key).toEqual(['a', 'b'])
    expect(plan('children').columns).toEqual(['id', 'parent_id', 'qty'])
    expect(plan('children').overridingSystemValue).toBe(true)
    expect(plan('parents').sequenceColumns).toEqual(['id'])
  })

  it('counts inserts, updates and deletes; equal values in different formats count as identical', async () => {
    const parents = await compareTable(source, target, plan('parents'))
    // Row 1 was written with a different time zone offset and numeric literal (1.5 vs 1.50) but
    // holds the same values, so it must count as identical
    expect({ ins: parents.inserts, upd: parents.updates, del: parents.deletes, same: parents.identical }).toEqual({ ins: 1, upd: 1, del: 1, same: 1 })
    expect(parents.samples.updates[0].source.name).toBe('changed in source')
    expect(parents.samples.updates[0].target.name).toBe('old name')
    expect(parents.samples.inserts[0].name).toBe('only in source')

    const big = await compareTable(source, target, plan('big'))
    expect({ src: big.sourceRows, dst: big.targetRows, ins: big.inserts, upd: big.updates, del: big.deletes }).toEqual({ src: 25000, dst: 24991, ins: 10, upd: 4, del: 1 })

    const pairs = await compareTable(source, target, plan('pairs'))
    expect({ ins: pairs.inserts, upd: pairs.updates, del: pairs.deletes }).toEqual({ ins: 1, upd: 1, del: 1 })
    expect(pairs.samples.inserts[0].b).toBe(`quote's "and" ünïcødé`)
  })

  it('stops with DataSyncCancelled when aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(compareTable(source, target, plan('big'), { signal: controller.signal })).rejects.toBeInstanceOf(DataSyncCancelled)
  })

  it('deploys all changes in one transaction and leaves the tables identical', async () => {
    const tables = ['parents', 'children', 'pairs', 'big'].map(t => ({ plan: plan(t), ops: { insert: true, update: true, delete: true } }))
    const targetMeta = await loadDataMeta(target.runner, DST)
    await dstClient.query('BEGIN')
    try {
      const results = await deployData(source, target, tables, targetMeta)
      await dstClient.query('COMMIT')
      expect(results.big).toEqual({ inserted: 10, updated: 4, deleted: 1 })
      expect(results.children).toEqual({ inserted: 1, updated: 1, deleted: 1 })
    } catch (err) {
      await dstClient.query('ROLLBACK')
      throw err
    }

    for (const t of ['parents', 'children', 'pairs', 'big']) {
      const d = await compareTable(source, target, plan(t))
      expect({ table: t, ins: d.inserts, upd: d.updates, del: d.deletes }).toEqual({ table: t, ins: 0, upd: 0, del: 0 })
    }
    // Generated column recomputed, and the sequence was moved past the copied ids
    const child = await dstClient.query(`SELECT doubled FROM ${DST}.children WHERE id = 3`)
    expect(child.rows[0].doubled).toBe(18)
    const next = await dstClient.query(`INSERT INTO ${DST}.parents (name) VALUES ('new') RETURNING id::text`)
    expect(Number(next.rows[0].id)).toBeGreaterThan(50)
  })

  it('syncs self-referencing rows in any key order, and deletes rows that are still referenced', async () => {
    const KEPT = '55555555-0000-0000-0000-000000000005'
    const GONE = '99999999-0000-0000-0000-000000000009'
    const admin = new Client({ connectionString: url })
    await admin.connect()
    // 6000 replies, each pointing at a row with a random (md5) UUID, so most point at rows that
    // come later in key order and often in a later scan batch
    await admin.query(`
      INSERT INTO ${SRC}.messages SELECT md5(g::text)::uuid, 'm' || g, NULL FROM generate_series(1, 6000) g;
      UPDATE ${SRC}.messages SET "replyToMessageId" = md5((substr(body, 2)::int + 1)::text)::uuid WHERE substr(body, 2)::int < 6000;
      INSERT INTO ${SRC}.messages VALUES ('${KEPT}', 'kept', NULL);
      INSERT INTO ${DST}.messages VALUES ('${GONE}', 'only in target', NULL), ('${KEPT}', 'kept', '${GONE}');
    `)
    await admin.end()

    const messages = plan('messages')
    expect(messages.selfReferences).toEqual([{ columns: ['replyToMessageId'], refColumns: ['id'] }])
    const targetMeta = await loadDataMeta(target.runner, DST)
    const ops = { insert: true, update: true, delete: true }

    // Without deferring the self-reference, the foreign key blocks the deploy
    await dstClient.query('BEGIN')
    await expect(deployData(source, target, [{ plan: { ...messages, selfReferences: [] }, ops }], targetMeta)).rejects.toThrow(/message_replyToMessageId/)
    await dstClient.query('ROLLBACK')

    await dstClient.query('BEGIN')
    const results = await deployData(source, target, [{ plan: messages, ops }], targetMeta)
    await dstClient.query('COMMIT')
    // The kept row needs no update: clearing its reference before the delete already made it NULL,
    // which is its value in the source
    expect(results.messages).toEqual({ inserted: 6000, updated: 0, deleted: 1 })

    const after = await compareTable(source, target, messages)
    expect({ ins: after.inserts, upd: after.updates, del: after.deletes, same: after.identical }).toEqual({ ins: 0, upd: 0, del: 0, same: 6001 })
  })

  it('rolls back everything when a batch fails', async () => {
    await srcClient.query(`INSERT INTO ${SRC}.big VALUES (40000, 'will fail')`)
    await dstClient.query(`ALTER TABLE ${DST}.big ADD CONSTRAINT no_fail CHECK (v <> 'will fail')`)
    await srcClient.query(`UPDATE ${SRC}.pairs SET val = 99 WHERE a = 1 AND b = 'plain'`)
    const targetMeta = await loadDataMeta(target.runner, DST)
    await dstClient.query('BEGIN')
    await expect(deployData(source, target, [
      { plan: plan('pairs'), ops: { insert: true, update: true, delete: true } },
      { plan: plan('big'), ops: { insert: true, update: true, delete: true } },
    ], targetMeta)).rejects.toThrow(/no_fail/)
    await dstClient.query('ROLLBACK')
    const pairs = await dstClient.query(`SELECT val FROM ${DST}.pairs WHERE a = 1 AND b = 'plain'`)
    expect(Number(pairs.rows[0].val)).toBe(1)
  })
})
