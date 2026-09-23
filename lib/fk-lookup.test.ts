import { describe, it, expect } from 'vitest'
import { defaultDisplayColumns, lookupPageSql, lookupRowSql, parseForeignKeys, type FkRef } from './fk-lookup'

const fk: FkRef = { column: 'userId', refSchema: 'public', refTable: 'users', refColumn: 'id' }

describe('lookupPageSql', () => {
  it('pages the referenced table in key order', () => {
    expect(lookupPageSql('postgres', fk, ['name'])).toEqual({
      sql: 'SELECT "id"::text AS "__key", "name"::text AS "name" FROM "public"."users" ORDER BY "id" LIMIT 50',
      params: [],
    })
    expect(lookupPageSql('postgres', fk, ['name'], { cursor: '42', limit: 10 })).toEqual({
      sql: 'SELECT "id"::text AS "__key", "name"::text AS "name" FROM "public"."users" WHERE "id" > $1 ORDER BY "id" LIMIT 10',
      params: ['42'],
    })
  })

  it('searches the key and display columns case-insensitively, escaping LIKE wildcards', () => {
    const q = lookupPageSql('postgres', fk, ['name', 'email'], { cursor: '7', search: ' 50%_off ' })
    expect(q.sql).toContain('WHERE "id" > $1 AND ("id"::text ILIKE $2 OR "name"::text ILIKE $2 OR "email"::text ILIKE $2)')
    expect(q.params).toEqual(['7', '%50\\%\\_off%'])
  })

  it('uses backticks, CAST and one placeholder per use on MySQL', () => {
    const q = lookupPageSql('mysql', { ...fk, refSchema: 'shop' }, ['name'], { cursor: '3', search: 'ann' })
    expect(q.sql).toBe('SELECT CAST(`id` AS CHAR) AS `__key`, CAST(`name` AS CHAR) AS `name` FROM `shop`.`users` WHERE `id` > ? AND (CAST(`id` AS CHAR) LIKE ? OR CAST(`name` AS CHAR) LIKE ?) ORDER BY `id` LIMIT 50')
    expect(q.params).toEqual(['3', '%ann%', '%ann%'])
  })

  it('never selects the key twice', () => {
    expect(lookupPageSql('postgres', fk, ['id', 'name']).sql).toBe('SELECT "id"::text AS "__key", "name"::text AS "name" FROM "public"."users" ORDER BY "id" LIMIT 50')
  })
})

describe('lookupRowSql', () => {
  it('fetches the currently referenced row', () => {
    expect(lookupRowSql('postgres', fk, ['email'], '9')).toEqual({
      sql: 'SELECT "id"::text AS "__key", "email"::text AS "email" FROM "public"."users" WHERE "id" = $1 LIMIT 1',
      params: ['9'],
    })
  })
})

describe('defaultDisplayColumns', () => {
  it('guesses up to two descriptive columns, in preference order', () => {
    expect(defaultDisplayColumns(['id', 'Email', 'username', 'created_at', 'name'], 'id')).toEqual(['name', 'username'])
    expect(defaultDisplayColumns(['id', 'created_at'], 'id')).toEqual([])
  })
})

describe('parseForeignKeys', () => {
  it('maps rows and keeps the first FK when a column has several', () => {
    expect(parseForeignKeys([
      { column_name: 'userId', ref_schema: 'public', ref_table: 'users', ref_column: 'id' },
      { column_name: 'userId', ref_schema: 'public', ref_table: 'accounts', ref_column: 'id' },
    ])).toEqual([fk])
  })
})
