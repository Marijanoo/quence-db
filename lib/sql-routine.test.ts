import { describe, expect, it } from 'vitest'
import { changesSchema, parseCreateRoutine } from './sql-routine'

describe('parseCreateRoutine', () => {
  it('reads the schema and name of CREATE [OR REPLACE] FUNCTION / PROCEDURE', () => {
    expect(parseCreateRoutine('CREATE OR REPLACE FUNCTION public.get_name(p_name text) RETURNS text AS $$ SELECT p_name $$ LANGUAGE sql'))
      .toEqual({ kind: 'function', schema: 'public', name: 'get_name' })
    expect(parseCreateRoutine('create function Get_Name (p text) returns text language sql as $$ select p $$'))
      .toEqual({ kind: 'function', name: 'get_name' })
    expect(parseCreateRoutine('CREATE PROCEDURE "App"."Do It"() LANGUAGE sql AS $$ $$'))
      .toEqual({ kind: 'procedure', schema: 'App', name: 'Do It' })
  })

  it('skips leading comments', () => {
    expect(parseCreateRoutine('-- returns the name\n/* v2 */\n  CREATE OR REPLACE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql'))
      .toEqual({ kind: 'function', name: 'f' })
  })

  it('is null for anything else', () => {
    expect(parseCreateRoutine('SELECT get_name(\'x\')')).toBeNull()
    expect(parseCreateRoutine('CREATE TABLE f (id int)')).toBeNull()
    expect(parseCreateRoutine('DROP FUNCTION f()')).toBeNull()
    expect(parseCreateRoutine('-- CREATE FUNCTION f()\nSELECT 1')).toBeNull()
  })
})

describe('changesSchema', () => {
  it('spots DDL among the statements', () => {
    expect(changesSchema(['SELECT 1', 'create or replace function f() returns int as $$ select 1 $$ language sql'])).toBe(true)
    expect(changesSchema(['-- tidy up\nDROP TABLE t'])).toBe(true)
    expect(changesSchema(['ALTER TABLE t ADD c int'])).toBe(true)
    expect(changesSchema(['COMMENT ON TABLE t IS \'x\''])).toBe(true)
  })

  it('ignores queries and data changes', () => {
    expect(changesSchema(['SELECT * FROM created_items', 'UPDATE t SET dropped = true', 'INSERT INTO t VALUES (1)'])).toBe(false)
  })
})
