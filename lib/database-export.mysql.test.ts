// Full database dump and SQL import against MySQL: a dump (tables, data, views, routines, triggers)
// loads into an empty database with the same rows, and a mysqldump file imports.
// Opt-in: set QUENCE_MYSQL_TEST_URL, e.g. mysql://root:test@localhost:33306. The mysqldump test
// also needs QUENCE_MYSQL_DUMP_CMD, a command printing a dump of the database given last
// (e.g. "docker exec qdb-test-mysql mysqldump -uroot -ptest --routines --triggers --hex-blob").
// Without --hex-blob mysqldump writes binary columns as raw bytes, which a text import cannot keep.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as mysql from 'mysql2/promise'
import { execSync } from 'child_process'
import { orderViews, runDatabaseExport, stripDefiner, unqualifyDatabase, type DatabaseExportIO } from './database-export'
import { runSqlImport, type ImportSession } from './sql-import'

const url = process.env.QUENCE_MYSQL_TEST_URL
const suffix = Math.random().toString(36).slice(2, 8)
const SOURCE = `qdump_src_${suffix}`
const TARGET = `qdump_dst_${suffix}`
const TARGET2 = `qdump_myd_${suffix}`

// Imports use single-statement connections, like the app's pool
async function connect(db?: string, multipleStatements = true) {
  return mysql.createConnection({ uri: url!, database: db, multipleStatements, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true })
}

function ioFor(c: mysql.Connection, db: string, out: string[]): DatabaseExportIO {
  return {
    query: async (sql, params) => (await c.query(sql, params))[0] as Record<string, unknown>[],
    openSnapshot: async () => {
      const s = await connect(db)
      await s.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
      return { query: async sql => (await s.query(sql))[0] as Record<string, unknown>[], close: async () => { await s.query('ROLLBACK'); await s.end() } }
    },
    write: async text => { out.push(text) },
  }
}

const session = (c: mysql.Connection): ImportSession => ({
  execute: async (sql, params) => {
    const [res] = await c.query(sql, params)
    return { rowCount: Array.isArray(res) ? res.length : (res as mysql.ResultSetHeader).affectedRows }
  },
})

function reader(text: string, chunk = 333) {
  let pos = 0
  return async () => {
    const slice = text.slice(pos, pos + chunk)
    pos += slice.length
    return { text: slice, done: slice.length === 0, position: pos }
  }
}

const DATA = `SELECT
  (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', id, 'name', name, 'price', CAST(price AS CHAR), 'raw', HEX(raw), 'doc', doc, 'at', CAST(at AS CHAR), 'kind', kind)) FROM (SELECT * FROM items ORDER BY id) i) AS items,
  (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', id, 'item_id', item_id, 'qty', qty)) FROM (SELECT * FROM orders ORDER BY id) o) AS orders,
  (SELECT JSON_ARRAYAGG(n) FROM (SELECT n FROM item_names ORDER BY n) v) AS view_rows,
  (SELECT count(*) FROM audit) AS audit_rows`

describe.skipIf(!url)('database export and SQL import against MySQL', () => {
  let admin: mysql.Connection
  let src: mysql.Connection

  beforeAll(async () => {
    admin = await connect()
    for (const db of [SOURCE, TARGET, TARGET2]) await admin.query(`CREATE DATABASE \`${db}\``)
    src = await connect(SOURCE)
    await src.query(`
      CREATE TABLE items (
        id int AUTO_INCREMENT PRIMARY KEY,
        name varchar(100) NOT NULL,
        price decimal(20, 6),
        raw varbinary(16),
        doc json,
        at datetime(3),
        kind enum('a', 'b') DEFAULT 'a',
        name_len int GENERATED ALWAYS AS (char_length(name)) STORED
      );
      CREATE TABLE orders (
        id bigint AUTO_INCREMENT PRIMARY KEY,
        item_id int,
        qty int DEFAULT 1,
        CONSTRAINT fk_item FOREIGN KEY (item_id) REFERENCES items (id)
      );
      CREATE TABLE audit (id int AUTO_INCREMENT PRIMARY KEY, msg text);
      CREATE VIEW item_names AS SELECT name AS n FROM items;
      CREATE VIEW long_names AS SELECT n FROM item_names WHERE char_length(n) > 3;
      CREATE FUNCTION doubled(x int) RETURNS int DETERMINISTIC RETURN x * 2;
      CREATE PROCEDURE add_item(IN nm varchar(100)) BEGIN INSERT INTO items (name) VALUES (nm); SELECT LAST_INSERT_ID(); END;
      CREATE TRIGGER orders_audit AFTER INSERT ON orders FOR EACH ROW INSERT INTO audit (msg) VALUES (CONCAT('order ', NEW.id));
      INSERT INTO items (name, price, raw, doc, at, kind) VALUES
        ('Plain', 1.5, 0x00FF10, '{"a": [1, "x"]}', '2026-02-28 23:45:09.123', 'b'),
        ('quote '' backslash \\\\ newline\\n tab\\t;', 12345678901234.123456, '', 'null', NULL, NULL),
        ('Zé 🚀', NULL, NULL, NULL, '1970-01-01 00:00:01', 'a');
      INSERT INTO orders (item_id, qty) VALUES (1, 2), (3, NULL);
    `)
  })

  afterAll(async () => {
    await src?.end()
    for (const db of [SOURCE, TARGET, TARGET2]) await admin.query(`DROP DATABASE IF EXISTS \`${db}\``)
    await admin.end()
  })

  it('dumps a database that loads into an empty one with the same data and objects', async () => {
    const out: string[] = []
    const res = await runDatabaseExport(ioFor(src, SOURCE, out), {
      dbType: 'mysql', database: SOURCE, schemas: [], structure: true, data: true,
      dropObjects: true, transaction: false, rowsPerStatement: 2, batchSize: 2,
    })
    expect(res).toEqual({ tables: 3, rows: 7 }) // 3 items, 2 orders, 2 audit rows
    const dump = out.join('')
    expect(dump).not.toMatch(/DEFINERs*=/)
    expect(dump).not.toContain(SOURCE + '`.')

    const dst = await connect(TARGET, false)
    try {
      for (let i = 0; i < 2; i++) { // dropObjects: loads over itself
        const imported = await runSqlImport(reader(dump), session(dst), { dialect: 'mysql', transaction: false, continueOnError: false })
        expect(imported.errors).toEqual([])
      }
      const [[a]] = await src.query(DATA) as [Record<string, unknown>[], unknown]
      const [[b]] = await dst.query(DATA) as [Record<string, unknown>[], unknown]
      expect(b).toEqual(a)
      // Routines, trigger and auto_increment work in the copy
      const [[fn]] = await dst.query('SELECT doubled(21) AS v') as [Record<string, unknown>[], unknown]
      expect(Number(fn.v)).toBe(42)
      await dst.query(`CALL add_item('New')`)
      await dst.query('INSERT INTO orders (item_id) VALUES (4)')
      const [[after]] = await dst.query('SELECT (SELECT max(id) FROM items) AS item, (SELECT count(*) FROM audit) AS audit') as [Record<string, unknown>[], unknown]
      expect(after).toEqual({ item: 4, audit: '3' }) // count(*) is a BIGINT, returned as a string
    } finally {
      await dst.end()
    }
  })

  it.skipIf(!process.env.QUENCE_MYSQL_DUMP_CMD)('imports a mysqldump file', async () => {
    const dump = execSync(`${process.env.QUENCE_MYSQL_DUMP_CMD} ${SOURCE}`, { encoding: 'utf8', maxBuffer: 64 << 20 })
    expect(dump).toMatch(/DELIMITER ;;/)
    const dst = await connect(TARGET2, false)
    try {
      const res = await runSqlImport(reader(dump, 1000), session(dst), { dialect: 'mysql', transaction: false, continueOnError: false })
      expect(res.errors).toEqual([])
      const [[a]] = await src.query(DATA) as [Record<string, unknown>[], unknown]
      const [[b]] = await dst.query(DATA) as [Record<string, unknown>[], unknown]
      expect(b).toEqual(a)
    } finally {
      await dst.end()
    }
  })
})

describe('MySQL dump helpers', () => {
  it('strips DEFINER clauses', () => {
    expect(stripDefiner('CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `v` AS select 1'))
      .toBe('CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v` AS select 1')
    expect(stripDefiner("CREATE DEFINER='app'@'localhost' PROCEDURE p() BEGIN END")).toBe('CREATE PROCEDURE p() BEGIN END')
  })

  it('removes the database qualifier from view definitions', () => {
    expect(unqualifyDatabase('select `shop`.`t`.`id` AS `id` from `shop`.`t`', 'shop')).toBe('select `t`.`id` AS `id` from `t`')
  })

  it('orders views after the views they read', () => {
    expect(orderViews(['a', 'b', 'c'], [{ view_name: 'a', table_name: 'c' }, { view_name: 'c', table_name: 'b' }, { view_name: 'b', table_name: 'items' }]))
      .toEqual(['b', 'c', 'a'])
  })
})
