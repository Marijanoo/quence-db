import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Client } from 'pg'
import { sqliteCloseAll, sqliteConnect, sqliteQuery } from '../electron/sqlite-conn'
import { buildMongoFilter, buildSqlWhere, describeFilter, mongoValue, splitList, type FilterCondition, type FilterOp, type TableFilter } from './table-filter'

let n = 0
const c = (column: string, op: FilterOp, value = '', value2?: string): FilterCondition => ({ id: String(n++), enabled: true, column, op, value, value2 })
const f = (conditions: FilterCondition[], match: 'all' | 'any' = 'all'): TableFilter => ({ mode: 'builder', match, conditions, raw: '' })

describe('building the WHERE clause', () => {
  it('uses parameters, quotes names, and joins with AND or OR', () => {
    expect(buildSqlWhere('postgres', f([c('status', 'eq', 'open'), c('Total', 'gt', '5')]))).toEqual({ sql: 'WHERE "status" = $1 AND "Total" > $2', params: ['open', '5'] })
    expect(buildSqlWhere('mysql', f([c('status', 'eq', 'open'), c('qty', 'lte', '2')], 'any'))).toEqual({ sql: 'WHERE `status` = ? OR `qty` <= ?', params: ['open', '2'] })
    expect(buildSqlWhere('postgres', f([c('a', 'eq', '1')]), 3).sql).toBe('WHERE "a" = $3')
  })

  it('escapes LIKE wildcards and matches any column type as text', () => {
    expect(buildSqlWhere('postgres', f([c('name', 'contains', '50%_off!')]))).toEqual({ sql: `WHERE "name"::text ILIKE $1 ESCAPE '!'`, params: ['%50!%!_off!!%'] })
    expect(buildSqlWhere('mysql', f([c('n', 'starts', 'ab')])).sql).toBe("WHERE CAST(`n` AS CHAR) LIKE ? ESCAPE '!'")
  })

  it('keeps NULL rows for "not" conditions, and skips disabled or empty ones', () => {
    expect(buildSqlWhere('postgres', f([c('s', 'ne', 'x')])).sql).toBe('WHERE ("s" <> $1 OR "s" IS NULL)')
    expect(buildSqlWhere('postgres', f([{ ...c('s', 'eq', 'x'), enabled: false }, c('', 'eq', 'y')]))).toEqual({ sql: '', params: [] })
    expect(buildSqlWhere('postgres', { ...f([]), mode: 'sql', raw: "status = 'x';" }).sql).toBe("WHERE (status = 'x')")
  })

  it('splits lists, honoring quotes', () => {
    expect(splitList('a, b ,c')).toEqual(['a', 'b', 'c'])
    expect(splitList(`"x, y", 'it''s', z`)).toEqual(['x, y', "it's", 'z'])
    expect(buildSqlWhere('postgres', f([c('k', 'in', '1, 2')]))).toEqual({ sql: 'WHERE "k" IN ($1, $2)', params: ['1', '2'] })
  })

  it('describes the filter', () => {
    expect(describeFilter(f([c('status', 'eq', 'open'), c('qty', 'between', '1', '5'), c('x', 'null')]))).toBe('status = open and qty between 1 and 5 and x is NULL')
  })
})

describe('MongoDB filters', () => {
  it('reads typed values the way they are meant', () => {
    expect(mongoValue('42', 'qty')).toBe('42')
    expect(mongoValue('"42"', 'qty')).toBe('"42"')
    expect(mongoValue('true', 'ok')).toBe('true')
    expect(mongoValue('65f1c2a3b4d5e6f708192a3b', '_id')).toBe('ObjectId("65f1c2a3b4d5e6f708192a3b")')
    expect(mongoValue('2026-09-01', 'at')).toBe('ISODate("2026-09-01")')
    expect(mongoValue('hello', 'x')).toBe('"hello"')
  })
  it('builds find() filters', () => {
    expect(buildMongoFilter(f([c('status', 'eq', 'open')]))).toBe('{ "status": "open" }')
    expect(buildMongoFilter(f([c('qty', 'gt', '5'), c('name', 'contains', 'a.b')], 'any')))
      .toBe('{ $or: [{ "qty": { $gt: 5 } }, { "name": { $regex: "a\\\\.b", $options: "i" } }] }')
    expect(buildMongoFilter(undefined)).toBe('{}')
  })
})

// The clauses run for real: SQLite always, PostgreSQL when QUENCE_PG_TEST_URL is set
const ROWS: [number, string | null, number | null][] = [[1, 'open', 10], [2, 'closed', 5], [3, null, null], [4, '50% off_sale', 7], [5, "it's open", 12]]
const CASES: [string, TableFilter, number[]][] = [
  ['equals', f([c('status', 'eq', 'open')]), [1]],
  ['not equal keeps NULLs', f([c('status', 'ne', 'open')]), [2, 3, 4, 5]],
  ['contains, case-insensitive', f([c('status', 'contains', 'OPEN')]), [1, 5]],
  ['a literal % and _', f([c('status', 'contains', '% off_')]), [4]],
  ['a quote', f([c('status', 'starts', "it's")]), [5]],
  ['number range', f([c('qty', 'between', '6', '11')]), [1, 4]],
  ['greater than, on a number', f([c('qty', 'gt', '9')]), [1, 5]],
  ['contains on a number column', f([c('qty', 'contains', '1')]), [1, 5]],
  ['is NULL', f([c('status', 'null')]), [3]],
  ['is empty', f([c('qty', 'empty')]), [3]],
  ['one of', f([c('id', 'in', '2, 4, 9')]), [2, 4]],
  ['not one of keeps NULLs', f([c('status', 'not_in', 'open, closed')]), [3, 4, 5]],
  ['any of', f([c('status', 'eq', 'closed'), c('qty', 'gt', '11')], 'any'), [2, 5]],
]

describe('the WHERE clauses on SQLite', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qdb-filter-'))
    sqliteConnect('f', path.join(dir, 'f.db'), true)
    sqliteQuery('f', 'CREATE TABLE t (id INTEGER PRIMARY KEY, status TEXT, qty INTEGER)')
    for (const r of ROWS) sqliteQuery('f', 'INSERT INTO t VALUES ($1, $2, $3)', undefined, r)
  })
  afterEach(() => { sqliteCloseAll(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })

  it.each(CASES)('%s', (_name, filter, ids) => {
    const w = buildSqlWhere('sqlite', filter)
    expect(sqliteQuery('f', `SELECT id FROM t ${w.sql} ORDER BY id`, undefined, w.params).rows.map(r => r.id)).toEqual(ids)
  })
})

const url = process.env.QUENCE_PG_TEST_URL
describe.skipIf(!url)('the WHERE clauses on PostgreSQL', () => {
  let pg: Client
  const T = `qfilter_${Math.random().toString(36).slice(2, 8)}`
  beforeAll(async () => {
    pg = new Client({ connectionString: url })
    await pg.connect()
    await pg.query(`CREATE TABLE public.${T} (id int PRIMARY KEY, status text, qty int)`)
    for (const r of ROWS) await pg.query(`INSERT INTO public.${T} VALUES ($1, $2, $3)`, r)
  })
  afterAll(async () => { await pg.query(`DROP TABLE IF EXISTS public.${T}`); await pg.end() })

  it.each(CASES)('%s', async (_name, filter, ids) => {
    const w = buildSqlWhere('postgres', filter)
    expect((await pg.query(`SELECT id FROM public.${T} ${w.sql} ORDER BY id`, w.params)).rows.map(r => r.id)).toEqual(ids)
  })
})
