import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  numberedToNamed, sqliteCloseAll, sqliteConnect, sqliteDatabases, sqliteIntrospect, sqliteQuery, sqliteSessionClose,
  sqliteSessionOpen, sqliteSessionQuery,
} from './sqlite-conn'

let dir: string
let file: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qdb-sqlite-'))
  file = path.join(dir, 'shop.db')
})

afterEach(() => {
  sqliteCloseAll()
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
})

describe('SQLite connections', () => {
  it('opens only existing files unless asked to create one, and refuses non-SQLite files', () => {
    expect(() => sqliteConnect('c', file)).toThrow(/File not found/)
    const junk = path.join(dir, 'junk.db')
    fs.writeFileSync(junk, 'not a database, just some text that is long enough to not be empty')
    expect(() => sqliteConnect('c', junk)).toThrow()
    sqliteConnect('c', file, true)
    expect(fs.existsSync(file)).toBe(true)
  })

  it('runs statements, keeps big integers exact, and lists tables, views and columns', () => {
    sqliteConnect('c', file, true)
    sqliteQuery('c', 'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, big INTEGER, raw BLOB, gen TEXT GENERATED ALWAYS AS (upper(name)) VIRTUAL)')
    sqliteQuery('c', 'CREATE VIEW item_names AS SELECT name FROM items')
    const ins = sqliteQuery('c', 'INSERT INTO items (name, big, raw) VALUES (?, ?, ?), (?, ?, ?)', undefined, ['Pen', 7, Buffer.from([0, 255]), 'Cup', '9223372036854775807', null])
    expect(ins.rowCount).toBe(2)

    const res = sqliteQuery('c', 'SELECT id, name, big, raw, gen FROM items ORDER BY id')
    expect(res.fields).toEqual(['id', 'name', 'big', 'raw', 'gen'])
    expect(res.rows[0]).toMatchObject({ id: 1, name: 'Pen', big: 7, gen: 'PEN' })
    expect(Buffer.from(res.rows[0].raw as Uint8Array)).toEqual(Buffer.from([0, 255]))
    expect(res.rows[1].big).toBe('9223372036854775807')

    expect(sqliteDatabases('c')).toEqual(['main'])
    const intro = sqliteIntrospect('c', 'main')
    expect(intro.tables).toEqual([
      { table_schema: 'main', table_name: 'item_names', table_type: 'VIEW' },
      { table_schema: 'main', table_name: 'items', table_type: 'BASE TABLE' },
    ])
    expect(intro.columns.filter(c => c.table_name === 'items').map(c => c.column_name)).toEqual(['id', 'name', 'big', 'raw', 'gen'])
  })

  it('enforces foreign keys', () => {
    sqliteConnect('c', file, true)
    sqliteQuery('c', 'CREATE TABLE a (id INTEGER PRIMARY KEY)')
    sqliteQuery('c', 'CREATE TABLE b (a_id INTEGER REFERENCES a(id))')
    expect(() => sqliteQuery('c', 'INSERT INTO b VALUES (1)')).toThrow(/FOREIGN KEY/)
  })

  it('runs sessions as transactions that commit or roll back', () => {
    sqliteConnect('c', file, true)
    sqliteQuery('c', 'CREATE TABLE t (n INTEGER)')
    const rolled = sqliteSessionOpen('c')
    sqliteSessionQuery(rolled, 'INSERT INTO t VALUES (1)')
    expect(sqliteSessionQuery(rolled, 'SELECT count(*) AS n FROM t').rows[0].n).toBe(1)
    sqliteSessionClose(rolled, false)
    expect(sqliteQuery('c', 'SELECT count(*) AS n FROM t').rows[0].n).toBe(0)

    const kept = sqliteSessionOpen('c')
    sqliteSessionQuery(kept, 'INSERT INTO t VALUES (2)')
    sqliteSessionClose(kept, true)
    expect(sqliteQuery('c', 'SELECT n FROM t').rows).toEqual([{ n: 2 }])

    const ro = sqliteSessionOpen('c', { readOnly: true })
    expect(() => sqliteSessionQuery(ro, 'INSERT INTO t VALUES (3)')).toThrow(/readonly/)
    sqliteSessionClose(ro, false)
  })
})

describe('PostgreSQL-style placeholders', () => {
  it('turns $N into named parameters outside strings, names and comments', () => {
    expect(numberedToNamed(`UPDATE "t$1" SET a = $1, b = '$2' -- $3
WHERE id = $2`).sql).toBe(`UPDATE "t$1" SET a = @p1, b = '$2' -- $3
WHERE id = @p2`)
    expect(numberedToNamed('SELECT ?').changed).toBe(false)
  })

  it('binds them, including RETURNING (as the grid save uses)', () => {
    sqliteConnect('c', file, true)
    sqliteQuery('c', 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
    sqliteQuery('c', 'INSERT INTO t VALUES (1, ?)', undefined, ['old'])
    const res = sqliteQuery('c', 'UPDATE "main"."t" SET "name" = $1 WHERE "id" = $2 RETURNING *', undefined, ['new', 1])
    expect(res.rows).toEqual([{ id: 1, name: 'new' }])
  })
})
