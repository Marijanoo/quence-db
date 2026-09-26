// The table grid's SQL (built for PostgreSQL) run against a real SQLite file through the SQLite
// driver: loading a page, then saving, inserting and deleting rows
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { sqliteCloseAll, sqliteConnect, sqliteQuery } from '../electron/sqlite-conn'
import { buildRowDelete, buildRowSavePlans, buildTableOrderBy } from './database-view'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qdb-sqlite-grid-'))
  sqliteConnect('c', path.join(dir, 'shop.db'), true)
  sqliteQuery('c', 'CREATE TABLE "Order Items" (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price REAL, note TEXT)')
  for (let i = 1; i <= 5; i++) sqliteQuery('c', 'INSERT INTO "Order Items" (name, price) VALUES (?, ?)', undefined, [`item ${i}`, i * 1.5])
})

afterEach(() => {
  sqliteCloseAll()
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
})

const q = (sql: string, params?: unknown[]) => sqliteQuery('c', sql, 'main', params)

describe('the table grid on SQLite', () => {
  it('finds the primary key, the column types and nullability, and pages in key order', () => {
    const pk = q('SELECT name AS column_name FROM pragma_table_info($2, $1) WHERE pk > 0 ORDER BY pk', ['main', 'Order Items'])
    expect(pk.rows).toEqual([{ column_name: 'id' }])
    const cols = q(`SELECT name AS column_name, type AS udt_name, CASE WHEN "notnull" THEN 'NO' ELSE 'YES' END AS is_nullable FROM pragma_table_xinfo($2, $1) WHERE hidden = 0 ORDER BY cid`, ['main', 'Order Items'])
    expect(cols.rows).toEqual([
      { column_name: 'id', udt_name: 'INTEGER', is_nullable: 'YES' },
      { column_name: 'name', udt_name: 'TEXT', is_nullable: 'NO' },
      { column_name: 'price', udt_name: 'REAL', is_nullable: 'YES' },
      { column_name: 'note', udt_name: 'TEXT', is_nullable: 'YES' },
    ])
    const order = buildTableOrderBy('postgres', { column: 'price', dir: 'desc' }, ['id'])
    const page = q(`SELECT * FROM "main"."Order Items" ${order} LIMIT 2 OFFSET 0`)
    expect(page.rows.map(r => r.id)).toEqual([5, 4])
  })

  it('saves edited cells (UPDATE … RETURNING with $n placeholders), inserts new rows and deletes', () => {
    const rows = q('SELECT * FROM "Order Items" ORDER BY id').rows
    const plans = buildRowSavePlans('postgres', 'main', 'Order Items', ['id'], rows, [
      { rowIndex: 0, col: 'name', value: 'Pen' },
      { rowIndex: 0, col: 'note', value: null },
      { rowIndex: 5, col: 'name', value: 'New thing' }, // past the loaded rows: an insert
    ])
    const results = plans.map(p => q(p.update.sql, p.update.params))
    expect(results[0].rows).toEqual([{ id: 1, name: 'Pen', price: 1.5, note: null }])
    expect(results[1].rows).toEqual([{ id: 6, name: 'New thing', price: null, note: null }])

    const del = buildRowDelete('postgres', 'main', 'Order Items', ['id'], { id: 2 })
    expect(q(del.sql, del.params).rowCount).toBe(1)
    expect(q('SELECT id FROM "Order Items" ORDER BY id').rows.map(r => r.id)).toEqual([1, 3, 4, 5, 6])
  })
})
