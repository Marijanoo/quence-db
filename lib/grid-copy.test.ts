import { describe, expect, it } from 'vitest'
import { buildInsertStatement, buildUpdateStatement, rowsToTsv, sqlLiteral } from './grid-copy'

describe('sqlLiteral', () => {
  it('formats values per dialect', () => {
    expect(sqlLiteral(null, 'postgres')).toBe('NULL')
    expect(sqlLiteral(5, 'postgres')).toBe('5')
    expect(sqlLiteral(true, 'postgres')).toBe('TRUE')
    expect(sqlLiteral(true, 'mysql')).toBe('1')
    expect(sqlLiteral("O'Brien", 'postgres')).toBe("'O''Brien'")
    expect(sqlLiteral('a\\b', 'postgres')).toBe("'a\\b'")
    expect(sqlLiteral('a\\b', 'mysql')).toBe("'a\\\\b'")
    expect(sqlLiteral({ a: 1 }, 'postgres')).toBe(`'{"a":1}'`)
  })
})

describe('statements', () => {
  const row = { id: 7, name: "O'Brien", note: null }
  it('builds INSERT', () => {
    expect(buildInsertStatement('postgres', 'public', 'users', ['id', 'name', 'note'], row))
      .toBe(`INSERT INTO "public"."users" ("id", "name", "note") VALUES (7, 'O''Brien', NULL);`)
    expect(buildInsertStatement('mysql', 'shop', 'users', ['id'], row))
      .toBe('INSERT INTO `shop`.`users` (`id`) VALUES (7);')
  })

  it('builds UPDATE keyed by the primary key', () => {
    expect(buildUpdateStatement('postgres', 'public', 'users', ['id'], ['id', 'name', 'note'], row))
      .toBe(`UPDATE "public"."users" SET "name" = 'O''Brien', "note" = NULL WHERE "id" = 7;`)
  })
})

describe('rowsToTsv', () => {
  it('writes tab-separated rows, with or without the header', () => {
    const rows = [{ a: 1, b: 'x\ty' }, { a: null, b: { k: 1 } }]
    expect(rowsToTsv(['a', 'b'], rows, true)).toBe('a\tb\n1\tx y\n\t{"k":1}')
    expect(rowsToTsv(['a', 'b'], [], true)).toBe('a\tb')
    expect(rowsToTsv(['a'], rows.slice(0, 1), false)).toBe('1')
  })
})
