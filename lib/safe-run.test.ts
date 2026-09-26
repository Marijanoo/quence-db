import { describe, expect, it } from 'vitest'
import { cannotRollBack, classifyStatement, previewWrap } from './safe-run'

describe('classifyStatement', () => {
  it.each([
    ['SELECT * FROM t', 'read', 'SELECT', undefined, false],
    ['-- note\nshow tables', 'read', 'SHOW', undefined, false],
    ['WITH x AS (SELECT 1) SELECT * FROM x', 'read', 'WITH', undefined, false],
    ['WITH d AS (DELETE FROM items RETURNING *) SELECT count(*) FROM d', 'dml', 'DELETE', 'items', true],
    ['UPDATE public.items SET price = 1 WHERE id = 3', 'dml', 'UPDATE', 'public.items', false],
    ['update items set price = 1', 'dml', 'UPDATE', 'items', true],
    ['DELETE FROM "Order Items"', 'dml', 'DELETE', '"Order Items"', true],
    ['UPDATE app."My Table" SET a = 1 WHERE b', 'dml', 'UPDATE', 'app."My Table"', false],
    ["DELETE FROM t WHERE note = 'where'", 'dml', 'DELETE', 't', false],
    ["UPDATE t SET note = 'no where here'", 'dml', 'UPDATE', 't', true],
    ['INSERT INTO t (a) VALUES (1)', 'dml', 'INSERT', 't', false],
    ['TRUNCATE TABLE logs', 'ddl', 'TRUNCATE', 'logs', false],
    ['DROP TABLE IF EXISTS old_stuff', 'ddl', 'DROP', 'old_stuff', false],
    ['ALTER TABLE t ADD COLUMN c int', 'ddl', 'ALTER', 't', false],
    ['CALL do_things()', 'other', 'CALL', undefined, false],
  ] as const)('%s', (sql, kind, verb, table, missingWhere) => {
    expect(classifyStatement(sql)).toEqual({ kind, verb, table, missingWhere })
  })
})

describe('previewWrap', () => {
  const wrap = (sql: string) => previewWrap(sql, classifyStatement(sql))
  it('wraps plain writes so they return a capped preview and the total', () => {
    expect(wrap('UPDATE t SET a = 1 WHERE b;')).toBe('WITH quence_changed AS (\nUPDATE t SET a = 1 WHERE b\nRETURNING *\n) SELECT *, count(*) OVER () AS quence_total FROM quence_changed LIMIT 200')
    expect(wrap("INSERT INTO t VALUES ('returning')")).toContain("INSERT INTO t VALUES ('returning')\nRETURNING *")
  })
  it('leaves reads, WITH statements and explicit RETURNING alone', () => {
    for (const sql of ['SELECT 1', 'DELETE FROM t RETURNING id', 'WITH d AS (DELETE FROM t RETURNING 1) SELECT 1', 'TRUNCATE t']) expect(wrap(sql)).toBe(sql)
  })
})

describe('cannotRollBack', () => {
  it('flags MySQL DDL only', () => {
    expect(cannotRollBack('mysql', classifyStatement('DROP TABLE t'))).toBe(true)
    expect(cannotRollBack('postgres', classifyStatement('DROP TABLE t'))).toBe(false)
    expect(cannotRollBack('mysql', classifyStatement('DELETE FROM t WHERE a'))).toBe(false)
  })
})
