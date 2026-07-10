import { describe, it, expect } from 'vitest'
import {
  splitSqlStatements,
  buildSchemaEntries,
  parseConnectionString,
  getNestedValue,
  flattenObject,
  processMongoRows,
} from './database-view'

describe('splitSqlStatements', () => {
  it('splits simple statements on semicolons', () => {
    expect(splitSqlStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('ignores a trailing statement with no semicolon', () => {
    expect(splitSqlStatements('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('drops empty statements', () => {
    expect(splitSqlStatements('SELECT 1;;  ;SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('does not split on semicolons inside single-quoted strings', () => {
    expect(splitSqlStatements(`INSERT INTO t VALUES ('a;b'); SELECT 1;`)).toEqual([
      `INSERT INTO t VALUES ('a;b')`,
      'SELECT 1',
    ])
  })

  it('does not split on semicolons inside double-quoted identifiers', () => {
    expect(splitSqlStatements(`SELECT "weird;name" FROM t; SELECT 1;`)).toEqual([
      `SELECT "weird;name" FROM t`,
      'SELECT 1',
    ])
  })

  it('does not split on semicolons inside line comments', () => {
    expect(splitSqlStatements('SELECT 1; -- comment; still comment\nSELECT 2;')).toEqual([
      'SELECT 1',
      '-- comment; still comment\nSELECT 2',
    ])
  })

  it('does not split on semicolons inside block comments', () => {
    expect(splitSqlStatements('SELECT 1; /* a; b; c */ SELECT 2;')).toEqual([
      'SELECT 1',
      '/* a; b; c */ SELECT 2',
    ])
  })

  it('does not split on semicolons inside dollar-quoted bodies', () => {
    const sql = `CREATE FUNCTION f() RETURNS void AS $$ BEGIN SELECT 1; SELECT 2; END; $$ LANGUAGE plpgsql;`
    expect(splitSqlStatements(sql)).toEqual([sql.slice(0, -1)])
  })

  it('handles escaped quotes inside single-quoted strings', () => {
    expect(splitSqlStatements(`SELECT 'it''s a test'; SELECT 2;`)).toEqual([
      `SELECT 'it''s a test'`,
      'SELECT 2',
    ])
  })
})

describe('buildSchemaEntries', () => {
  it('groups tables, views, and materialized views by schema', () => {
    const result = buildSchemaEntries([
      { table_schema: 'public', table_name: 'users', table_type: 'BASE TABLE' },
      { table_schema: 'public', table_name: 'active_users', table_type: 'VIEW' },
      { table_schema: 'public', table_name: 'summary', table_type: 'MATERIALIZED VIEW' },
    ])
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('public')
    expect(result[0].tables).toEqual([{ name: 'users', type: 'TABLE' }])
    expect(result[0].views).toEqual([{ name: 'active_users', type: 'VIEW' }])
    expect(result[0].materializedViews).toEqual([{ name: 'summary', type: 'MATERIALIZED VIEW' }])
  })

  it('deduplicates function overloads with the same name and arguments', () => {
    const result = buildSchemaEntries([], [
      { routine_schema: 'public', routine_name: 'f', arguments: 'int' },
      { routine_schema: 'public', routine_name: 'f', arguments: 'int' },
      { routine_schema: 'public', routine_name: 'f', arguments: 'text' },
    ])
    expect(result[0].functions).toEqual([
      { name: 'f', arguments: 'int' },
      { name: 'f', arguments: 'text' },
    ])
  })

  it('parses comma-separated enum value strings', () => {
    const result = buildSchemaEntries([], [], [{ schema: 'public', name: 'status', values: 'a,b,c' }])
    expect(result[0].enums).toEqual([{ name: 'status', values: ['a', 'b', 'c'] }])
  })

  it('returns an empty array when given no input', () => {
    expect(buildSchemaEntries()).toEqual([])
  })
})

describe('parseConnectionString', () => {
  it('parses a postgres connection string', () => {
    expect(parseConnectionString('postgresql://user:pass@localhost:5432/mydb', 'postgres')).toEqual({
      host: 'localhost',
      port: '5432',
      database: 'mydb',
      user: 'user',
      password: 'pass',
      ssl: false,
    })
  })

  it('falls back to the default port per db type when unspecified', () => {
    expect(parseConnectionString('mysql://localhost/mydb', 'mysql').port).toBe('3306')
    expect(parseConnectionString('mongodb://localhost/mydb', 'mongodb').port).toBe('27017')
  })

  it('detects sslmode=require', () => {
    expect(parseConnectionString('postgresql://localhost/db?sslmode=require', 'postgres').ssl).toBe(true)
  })

  it('returns an empty object for an unparseable string', () => {
    expect(parseConnectionString('not a url', 'postgres')).toEqual({})
  })
})

describe('getNestedValue', () => {
  it('returns a top-level flat key even if it contains dots', () => {
    expect(getNestedValue({ 'a.b': 1 }, 'a.b')).toBe(1)
  })

  it('traverses nested paths', () => {
    expect(getNestedValue({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42)
  })

  it('returns undefined for missing paths', () => {
    expect(getNestedValue({ a: {} }, 'a.b.c')).toBeUndefined()
  })

  it('returns undefined for null/undefined input', () => {
    expect(getNestedValue(null, 'a')).toBeUndefined()
    expect(getNestedValue(undefined, 'a')).toBeUndefined()
  })
})

describe('flattenObject', () => {
  it('flattens nested plain objects with dot-separated keys', () => {
    expect(flattenObject({ a: { b: 1, c: 2 } })).toEqual({ 'a.b': 1, 'a.c': 2 })
  })

  it('does not descend into arrays', () => {
    expect(flattenObject({ a: [1, 2, 3] })).toEqual({ a: [1, 2, 3] })
  })

  it('does not descend into Date instances', () => {
    const d = new Date()
    expect(flattenObject({ a: d })).toEqual({ a: d })
  })

  it('does not descend into ObjectId-like values', () => {
    const oid = { constructor: { name: 'ObjectId' }, toString: () => 'abc123' }
    expect(flattenObject({ a: oid })).toEqual({ a: oid })
  })

  it('returns an empty object for non-object input', () => {
    expect(flattenObject(null)).toEqual({})
    expect(flattenObject('str')).toEqual({})
  })
})

describe('processMongoRows', () => {
  it('flattens nested documents and merges keys across rows', () => {
    const result = processMongoRows([
      { _id: 1, info: { name: 'a' } },
      { _id: 2, info: { name: 'b', extra: 'x' } },
    ])
    expect(result.rows).toEqual([
      { _id: 1, info: { name: 'a' }, 'info.name': 'a' },
      { _id: 2, info: { name: 'b', extra: 'x' }, 'info.name': 'b', 'info.extra': 'x' },
    ])
    expect(result.fields).toEqual(expect.arrayContaining(['_id', 'info', 'info.name', 'info.extra']))
  })

  it('handles an empty row set', () => {
    const result = processMongoRows([])
    expect(result.rows).toEqual([])
    expect(result.fields).toEqual([])
  })
})
