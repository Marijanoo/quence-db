// FK lookup queries against a real PostgreSQL server. Opt-in: set QUENCE_PG_TEST_URL (see structure-sync.pg.test.ts).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { FOREIGN_KEYS_SQL, KEY_ALIAS, TABLE_COLUMN_NAMES_SQL, lookupPageSql, lookupRowSql, parseForeignKeys, type FkRef } from './fk-lookup'

const url = process.env.QUENCE_PG_TEST_URL
const S = `qfk_${Math.random().toString(36).slice(2, 8)}`

describe.skipIf(!url)('foreign key lookup against PostgreSQL', () => {
  let c: Client
  let fks: FkRef[]

  beforeAll(async () => {
    c = new Client({ connectionString: url })
    await c.connect()
    await c.query(`
      CREATE SCHEMA ${S};
      CREATE TABLE ${S}.users (id integer PRIMARY KEY, name text, email text);
      INSERT INTO ${S}.users SELECT g, 'User ' || g, 'user' || g || '@example.com' FROM generate_series(1, 120) g;
      INSERT INTO ${S}.users VALUES (500, 'Zoë 100% real', 'zoe@example.com');
      CREATE TABLE ${S}.teams (code uuid PRIMARY KEY, label text);
      INSERT INTO ${S}.teams VALUES ('00000000-0000-0000-0000-000000000002', 'b'), ('00000000-0000-0000-0000-000000000001', 'a');
      CREATE TABLE ${S}.orders (
        id serial PRIMARY KEY,
        "userId" integer REFERENCES ${S}.users(id),
        team uuid REFERENCES ${S}.teams(code),
        a integer, b integer
      );
    `)
    fks = parseForeignKeys((await c.query(FOREIGN_KEYS_SQL.postgres, [S, 'orders'])).rows)
  })

  afterAll(async () => {
    await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`)
    await c.end()
  })

  const page = async (fk: FkRef, cols: string[], opts: Parameters<typeof lookupPageSql>[3]) => {
    const q = lookupPageSql('postgres', fk, cols, opts)
    return (await c.query(q.sql, q.params)).rows
  }

  it('finds the single-column foreign keys of a table', () => {
    expect(fks).toEqual([
      { column: 'userId', refSchema: S, refTable: 'users', refColumn: 'id' },
      { column: 'team', refSchema: S, refTable: 'teams', refColumn: 'code' },
    ])
  })

  it('pages through every referenced row in numeric key order without gaps or repeats', async () => {
    const users = fks[0]
    const seen: string[] = []
    let cursor: string | null = null
    for (;;) {
      const rows = await page(users, ['name'], { cursor, limit: 50 })
      if (rows.length === 0) break
      seen.push(...rows.map(r => r[KEY_ALIAS]))
      cursor = rows[rows.length - 1][KEY_ALIAS]
    }
    expect(seen).toHaveLength(121)
    expect(seen.slice(0, 3)).toEqual(['1', '2', '3'])
    expect(seen[seen.length - 1]).toBe('500')
  })

  it('searches display columns and the key, treating % literally', async () => {
    const users = fks[0]
    expect((await page(users, ['name', 'email'], { search: '100%' })).map(r => r[KEY_ALIAS])).toEqual(['500'])
    expect((await page(users, ['name', 'email'], { search: 'ZOË' })).map(r => r.name)).toEqual(['Zoë 100% real'])
    expect((await page(users, ['name'], { search: '11' })).map(r => r[KEY_ALIAS])).toEqual(['11', '110', '111', '112', '113', '114', '115', '116', '117', '118', '119'])
  })

  it('works with uuid keys and reads one row and the column list', async () => {
    const teams = fks[1]
    expect((await page(teams, ['label'], {})).map(r => r.label)).toEqual(['a', 'b'])
    const one = lookupRowSql('postgres', teams, ['label'], '00000000-0000-0000-0000-000000000002')
    expect((await c.query(one.sql, one.params)).rows[0].label).toBe('b')
    const cols = (await c.query(TABLE_COLUMN_NAMES_SQL.postgres, [S, 'users'])).rows.map(r => r.name)
    expect(cols).toEqual(['id', 'name', 'email'])
  })
})
