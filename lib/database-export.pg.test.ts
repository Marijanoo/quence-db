// Full database dump and SQL import against PostgreSQL: a dump loads into an empty database and
// reproduces the structure and every row, and a pg_dump file (COPY blocks, psql commands) imports.
// Opt-in: set QUENCE_PG_TEST_URL (see structure-sync.pg.test.ts). The pg_dump test also needs
// QUENCE_PG_DUMP_CMD, a command that prints a plain-format dump of the database given as its
// last argument (e.g. "docker exec qdb-test-pg pg_dump -U postgres").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { execSync } from 'child_process'
import { runDatabaseExport, type DatabaseExportIO } from './database-export'
import { runSqlImport, type ImportSession } from './sql-import'
import { fetchSchemaSnapshot, snapshotSearchPath } from './structure-sync'

const url = process.env.QUENCE_PG_TEST_URL
const suffix = Math.random().toString(36).slice(2, 8)
const SOURCE = `qdump_src_${suffix}`
const TARGET = `qdump_dst_${suffix}`
const TARGET2 = `qdump_pgd_${suffix}`

const dbUrl = (db: string) => { const u = new URL(url!); u.pathname = `/${db}`; return u.toString() }

async function connect(db: string) {
  const c = new Client({ connectionString: dbUrl(db) })
  await c.connect()
  return c
}

function ioFor(c: Client, db: string, out: string[]): DatabaseExportIO {
  return {
    query: async (sql, params, searchPath) => {
      if (!searchPath) return (await c.query(sql, params as unknown[])).rows
      await c.query(`SET search_path TO ${searchPath}`)
      try { return (await c.query(sql, params as unknown[])).rows } finally { await c.query('RESET search_path') }
    },
    openSnapshot: async () => {
      const s = await connect(db)
      await s.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      return { query: async sql => (await s.query(sql)).rows, close: async () => { await s.query('ROLLBACK'); await s.end() } }
    },
    write: async text => { out.push(text) },
  }
}

const session = (c: Client): ImportSession => ({ execute: async (sql, params) => ({ rowCount: (await c.query(sql, params as unknown[])).rowCount }) })

function reader(text: string, chunk = 777) {
  let pos = 0
  return async () => {
    const slice = text.slice(pos, pos + chunk)
    pos += slice.length
    return { text: slice, done: pos >= text.length && slice.length === 0, position: pos }
  }
}

const DATA_QUERY = (schema: string) => `
  SELECT 'items' AS t, count(*)::int AS n, md5(string_agg(i::text, '|' ORDER BY id)) AS h FROM ${schema}.items i
  UNION ALL SELECT 'orders', count(*)::int, md5(string_agg(o::text, '|' ORDER BY id)) FROM ${schema}.orders o
  UNION ALL SELECT 'people', count(*)::int, md5(string_agg(p::text, '|' ORDER BY id)) FROM ${schema}.people p`

describe.skipIf(!url)('database export and SQL import against PostgreSQL', () => {
  let admin: Client
  let src: Client

  beforeAll(async () => {
    admin = new Client({ connectionString: url })
    await admin.connect()
    for (const db of [SOURCE, TARGET, TARGET2]) await admin.query(`CREATE DATABASE ${db}`)
    src = await connect(SOURCE)
    await src.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE SCHEMA app;
      SET search_path TO app, public;
      CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');
      CREATE DOMAIN email AS text CHECK (VALUE LIKE '%@%');
      CREATE TYPE money_pair AS (amount numeric(12,2), currency char(3));
      CREATE SEQUENCE invoice_no START 1000 INCREMENT 5;
      SELECT nextval('invoice_no'), nextval('invoice_no'); -- 1000, 1005; the two items take 1010, 1015
      CREATE FUNCTION slugify(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT lower(replace(t, ' ', '-')) $$;
      CREATE TABLE people (
        id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        name text NOT NULL,
        mail email UNIQUE,
        boss_id int REFERENCES people(id),
        feeling mood DEFAULT 'ok',
        slug text GENERATED ALWAYS AS (lower(name)) STORED
      );
      CREATE TABLE items (
        id serial PRIMARY KEY,
        title text CHECK (length(title) > 0),
        price numeric(30, 10),
        pair money_pair,
        doc jsonb,
        raw bytea,
        tags text[],
        at timestamptz,
        invoice int DEFAULT nextval('invoice_no')
      );
      CREATE TABLE orders (
        id bigserial PRIMARY KEY,
        person_id int NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        item_id int REFERENCES items(id),
        qty int DEFAULT 1
      );
      CREATE INDEX orders_person ON orders (person_id) WHERE qty > 0;
      CREATE FUNCTION person_orders(p people) RETURNS bigint LANGUAGE sql STABLE AS $$ SELECT count(*) FROM app.orders WHERE person_id = p.id $$;
      CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.qty := coalesce(NEW.qty, 1); RETURN NEW; END $$;
      CREATE TRIGGER orders_touch BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION touch();
      CREATE VIEW order_totals AS SELECT person_id, sum(qty) AS total FROM orders GROUP BY person_id;
      CREATE VIEW big_spenders AS SELECT * FROM order_totals WHERE total > 1;
      CREATE MATERIALIZED VIEW item_count AS SELECT count(*) AS n FROM items;
      CREATE UNIQUE INDEX item_count_n ON item_count (n);
      COMMENT ON TABLE items IS 'Things we sell';
      COMMENT ON COLUMN items.title IS 'Shown to customers';

      INSERT INTO people (name, mail) VALUES ('Ann', 'ann@x.io');
      INSERT INTO people (name, mail, boss_id, feeling) VALUES ('Bob', 'bob@x.io', 1, 'happy'), ('Cy', NULL, 2, NULL);
      INSERT INTO items (title, price, pair, doc, raw, tags, at) VALUES
        ('Plain', 1.5, '(3.50,EUR)', '{"a": [1, "x"]}', '\\x00ff10', '{a,b}', '2026-02-28 23:45:09.123456+13'),
        (E'quote '' backslash \\\\ newline\\n tab\\t', 12345678901234567890.0123456789, NULL, 'null', '', '{}', NULL);
      INSERT INTO orders (person_id, item_id, qty) VALUES (1, 1, 2), (2, 2, NULL), (3, NULL, 0);
      REFRESH MATERIALIZED VIEW item_count;
      RESET search_path;
    `)
  })

  afterAll(async () => {
    await src?.end()
    for (const db of [SOURCE, TARGET, TARGET2]) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`)
    await admin.end()
  })

  it('dumps a database that loads into an empty one with the same structure and data', async () => {
    const out: string[] = []
    const progress: number[] = []
    const res = await runDatabaseExport(ioFor(src, SOURCE, out), {
      dbType: 'postgres', database: SOURCE, schemas: ['app'], structure: true, data: true,
      dropObjects: false, transaction: true, rowsPerStatement: 2, batchSize: 2,
    }, { onProgress: p => progress.push(p.rows) })
    expect(res).toEqual({ tables: 3, rows: 8 })
    expect(progress.at(-1)).toBe(8)
    const dump = out.join('')

    const dst = await connect(TARGET)
    try {
      const imported = await runSqlImport(reader(dump), session(dst), { dialect: 'postgres', transaction: false, continueOnError: false })
      expect(imported.stoppedAt).toBeUndefined()
      expect(imported.errors).toEqual([])

      // Same structure, as Structure Sync sees it
      const snap = async (c: Client) => fetchSchemaSnapshot(async (sql, params) => {
        await c.query(`SET search_path TO ${snapshotSearchPath('app')}`)
        try { return (await c.query(sql, params)).rows } finally { await c.query('RESET search_path') }
      }, 'app')
      expect(await snap(dst)).toEqual(await snap(src))
      // Same rows
      expect((await dst.query(DATA_QUERY('app'))).rows).toEqual((await src.query(DATA_QUERY('app'))).rows)

      // The rest of the objects came along and work
      const check = await dst.query(`
        SELECT app.slugify('Hello World') AS slug,
          (SELECT app.person_orders(p) FROM app.people p WHERE id = 1) AS orders,
          (SELECT n FROM app.item_count) AS mat,
          (SELECT count(*) FROM app.big_spenders)::int AS spenders,
          obj_description('app.items'::regclass) AS comment,
          nextval('app.invoice_no') AS next_invoice`)
      expect(check.rows[0]).toMatchObject({ slug: 'hello-world', orders: '1', mat: '2', spenders: 1, comment: 'Things we sell', next_invoice: '1020' })
      // identity and serial counters continue after the restored ids; the trigger fires
      await dst.query(`INSERT INTO app.people (name) VALUES ('Dee')`)
      await dst.query(`INSERT INTO app.orders (person_id, qty) VALUES (4, NULL)`)
      expect((await dst.query(`SELECT id, qty FROM app.orders WHERE person_id = 4`)).rows).toEqual([{ id: '4', qty: 1 }])
      expect((await dst.query(`SELECT max(id) AS id FROM app.people`)).rows[0].id).toBe(4)
      // the domain is enforced
      await expect(dst.query(`INSERT INTO app.people (name, mail) VALUES ('Eve', 'nope')`)).rejects.toThrow(/email/)
    } finally {
      await dst.end()
    }
  })

  it('writes a structure-only dump with DROP statements that loads twice', async () => {
    const out: string[] = []
    await runDatabaseExport(ioFor(src, SOURCE, out), {
      dbType: 'postgres', database: SOURCE, schemas: ['app'], structure: true, data: false,
      dropObjects: true, transaction: true, rowsPerStatement: 100,
    })
    const dump = out.join('')
    expect(dump).not.toMatch(/INSERT INTO/)
    const dst = await connect(TARGET)
    try {
      for (let i = 0; i < 2; i++) {
        const res = await runSqlImport(reader(dump), session(dst), { dialect: 'postgres', transaction: false, continueOnError: false })
        expect(res.errors).toEqual([])
      }
      expect((await dst.query('SELECT count(*)::int AS n FROM app.items')).rows[0].n).toBe(0)
    } finally {
      await dst.end()
    }
  })

  it('rolls back everything when a transactional import fails, and can continue past errors', async () => {
    const script = `CREATE TABLE public.tx_test (id int PRIMARY KEY);\nBEGIN;\nINSERT INTO public.tx_test VALUES (1);\nINSERT INTO public.tx_test VALUES (1);\nINSERT INTO public.tx_test VALUES (2);\nCOMMIT;\n`
    const dst = await connect(TARGET)
    try {
      await dst.query('BEGIN')
      const stopped = await runSqlImport(reader(script, 5), session(dst), { dialect: 'postgres', transaction: true, continueOnError: false })
      await dst.query('ROLLBACK')
      expect(stopped.stoppedAt).toMatchObject({ line: 4, message: expect.stringMatching(/duplicate key/) })
      expect(stopped.skipped).toEqual(['line 2: BEGIN'])
      expect((await dst.query(`SELECT to_regclass('public.tx_test') AS t`)).rows[0].t).toBeNull()

      await dst.query('BEGIN')
      const continued = await runSqlImport(reader(script, 5), session(dst), { dialect: 'postgres', transaction: true, continueOnError: true })
      await dst.query('COMMIT')
      expect(continued.failed).toBe(1)
      expect((await dst.query('SELECT array_agg(id ORDER BY id) AS ids FROM public.tx_test')).rows[0].ids).toEqual([1, 2])
    } finally {
      await dst.end()
    }
  })

  it.skipIf(!process.env.QUENCE_PG_DUMP_CMD)('imports a pg_dump file with COPY data', async () => {
    const dump = execSync(`${process.env.QUENCE_PG_DUMP_CMD} ${SOURCE}`, { encoding: 'utf8', maxBuffer: 64 << 20 })
    expect(dump).toMatch(/COPY app\.items/)
    const dst = await connect(TARGET2)
    try {
      const res = await runSqlImport(reader(dump, 4096), session(dst), { dialect: 'postgres', transaction: false, continueOnError: false })
      expect(res.errors).toEqual([])
      expect(res.copyRows).toBe(8)
      expect(res.skipped.some(s => s.includes('\\restrict') || s.includes('\\connect'))).toBe(dump.includes('\\restrict') || dump.includes('\\connect'))
      expect((await dst.query(DATA_QUERY('app'))).rows).toEqual((await src.query(DATA_QUERY('app'))).rows)
    } finally {
      await dst.end()
    }
  })
})
