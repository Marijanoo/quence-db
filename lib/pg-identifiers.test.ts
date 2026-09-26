import { describe, expect, it } from 'vitest'
import { quoteMixedCaseIdentifiers } from './pg-identifiers'

const known = new Set(['public', 'tableName', 'firstName', 'id', 'Orders', 'orders', 'myFunc', 'appSchema'])
const q = (sql: string) => quoteMixedCaseIdentifiers(sql, known)

describe('quoteMixedCaseIdentifiers', () => {
  it('quotes mixed-case names that only exist with that spelling', () => {
    expect(q('SELECT * FROM tableName')).toEqual({ sql: 'SELECT * FROM "tableName"', quoted: ['tableName'] })
    expect(q('select t.firstName, id from appSchema.tableName t where firstName = 1').sql)
      .toBe('select t."firstName", id from "appSchema"."tableName" t where "firstName" = 1')
    expect(q('SELECT myFunc(1)').sql).toBe('SELECT "myFunc"(1)')
  })

  it('leaves names alone when the lowercase spelling exists, or the name is unknown', () => {
    expect(q('SELECT * FROM Orders').sql).toBe('SELECT * FROM Orders') // means "orders", which exists
    expect(q('SELECT * FROM SomethingElse').quoted).toEqual([])
    expect(q('SELECT * FROM tablename').quoted).toEqual([])
  })

  it('skips aliases, strings, comments, dollar bodies and quoted names', () => {
    const sql = `SELECT id AS firstName, 'tableName', E'it\\'s tableName', "tableName" -- tableName
/* tableName /* nested tableName */ */ FROM tableName WHERE $$ tableName $$ = $tag$tableName$tag$`
    expect(q(sql).sql).toBe(`SELECT id AS firstName, 'tableName', E'it\\'s tableName', "tableName" -- tableName
/* tableName /* nested tableName */ */ FROM "tableName" WHERE $$ tableName $$ = $tag$tableName$tag$`)
  })

  it('does not touch keywords written in capitals or parameters', () => {
    expect(q('SELECT $1, COUNT(*) FROM tableName WHERE id = $2').sql).toBe('SELECT $1, COUNT(*) FROM "tableName" WHERE id = $2')
  })
})
