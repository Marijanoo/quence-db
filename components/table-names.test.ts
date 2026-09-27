// Opening tables whose names need quoting: the page and count queries the table tab runs, against
// SQLite always and PostgreSQL when QUENCE_PG_TEST_URL is set
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Client } from 'pg'
import { sqliteCloseAll, sqliteConnect, sqliteQuery } from '../electron/sqlite-conn'
import { buildTableOrderBy, tablePageSql, tableRefSql } from './database-view'

const NAMES = ['Order Items', 'tableName', 'user', 'order', 'order-items', '2024 sales', 'say "hi"']

describe('table references', () => {
  it('quote and escape names for each dialect', () => {
    expect(tableRefSql('postgres', 'public', 'say "hi"')).toBe('"public"."say ""hi"""')
    expect(tableRefSql('mysql', 'shop', 'odd`name')).toBe('`shop`.`odd``name`')
    expect(tablePageSql('public', 'Order Items', 1, 'ORDER BY "id"')).toBe('SELECT *\nFROM "public"."Order Items"\nORDER BY "id"\nLIMIT 200 OFFSET 200;')
  })
})

describe('opening awkwardly named tables on SQLite', () => {
  let dir: string
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qdb-names-'))
    sqliteConnect('n', path.join(dir, 'names.db'), true)
    for (const n of NAMES) {
      sqliteQuery('n', `CREATE TABLE ${tableRefSql('postgres', 'main', n)} (id INTEGER PRIMARY KEY, v TEXT)`)
      sqliteQuery('n', `INSERT INTO ${tableRefSql('postgres', 'main', n)} (v) VALUES ('a'), ('b')`)
    }
  })
  afterAll(() => { sqliteCloseAll(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })

  it.each(NAMES)('%s', name => {
    const page = sqliteQuery('n', tablePageSql('main', name, 0, buildTableOrderBy('postgres', undefined, ['id'])))
    expect(page.rows.map(r => r.v)).toEqual(['a', 'b'])
    expect(sqliteQuery('n', `SELECT COUNT(*) AS __count FROM ${tableRefSql('postgres', 'main', name)};`).rows[0].__count).toBe(2)
  })
})

const url = process.env.QUENCE_PG_TEST_URL
const S = `qnames_${Math.random().toString(36).slice(2, 8)}`

describe.skipIf(!url)('opening awkwardly named tables on PostgreSQL', () => {
  let c: Client
  beforeAll(async () => {
    c = new Client({ connectionString: url })
    await c.connect()
    await c.query(`CREATE SCHEMA "${S}"`)
    for (const n of NAMES) {
      await c.query(`CREATE TABLE ${tableRefSql('postgres', S, n)} (id serial PRIMARY KEY, v text)`)
      await c.query(`INSERT INTO ${tableRefSql('postgres', S, n)} (v) VALUES ('a'), ('b')`)
    }
  })
  afterAll(async () => {
    await c.query(`DROP SCHEMA IF EXISTS "${S}" CASCADE`)
    await c.end()
  })

  it.each(NAMES)('%s', async name => {
    const page = await c.query(tablePageSql(S, name, 0, buildTableOrderBy('postgres', { column: 'v', dir: 'desc' }, ['id'])))
    expect(page.rows.map(r => r.v)).toEqual(['b', 'a'])
    expect((await c.query(`SELECT COUNT(*) AS __count FROM ${tableRefSql('postgres', S, name)};`)).rows[0].__count).toBe('2')
  })
})
