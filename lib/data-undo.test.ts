// Undoing saved data changes: how saves are recorded, and full round trips on a real SQLite file
// through the SQLite driver and a transaction session, as the app runs them
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { sqliteCloseAll, sqliteConnect, sqliteQuery, sqliteSessionClose, sqliteSessionOpen, sqliteSessionQuery } from '../electron/sqlite-conn'
import { changeLabel, sameValue, stepsFromSave, undoChange, undoSql, type DataChange, type UndoStep, type UndoTx } from './data-undo'

describe('recording a save', () => {
  it('turns edited and inserted rows into steps with their keys', () => {
    const { steps, unrecorded } = stepsFromSave(['id'], [
      { before: { id: 1, name: 'a', qty: 1 }, after: { id: 1, name: 'b', qty: 1 }, edits: { name: 'b' } },
      { before: undefined, after: { id: 7, name: 'new', qty: 0 }, edits: { name: 'new' } },
    ])
    expect(unrecorded).toBe(0)
    expect(steps).toEqual([
      { kind: 'update', key: { id: 1 }, before: { name: 'a' }, after: { name: 'b' } },
      { kind: 'insert', key: { id: 7 }, after: { id: 7, name: 'new', qty: 0 } },
    ])
    expect(changeLabel(steps)).toBe('Edited 1 row, inserted 1 row')
  })

  it('uses the new key when the key itself was edited', () => {
    const { steps } = stepsFromSave(['id'], [{ before: { id: 1, n: 'x' }, after: { id: 2, n: 'x' }, edits: { id: '2' } }])
    expect(steps[0]).toMatchObject({ key: { id: 2 }, before: { id: 1 }, after: { id: 2 } })
  })

  it('falls back to the typed key for inserts the database did not return, and skips unknown keys', () => {
    const { steps, unrecorded } = stepsFromSave(['id'], [
      { after: {}, edits: { id: 42, name: 'typed' } },
      { after: {}, edits: { name: 'no key' } },
    ])
    expect(steps).toEqual([{ kind: 'insert', key: { id: 42 }, after: { id: 42 } }])
    expect(unrecorded).toBe(1)
  })

  it('compares values the way drivers return them', () => {
    expect(sameValue(new Date(5), new Date(5))).toBe(true)
    expect(sameValue(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true)
    expect(sameValue({ a: [1] }, { a: [1] })).toBe(true)
    expect(sameValue(null, undefined)).toBe(true)
    expect(sameValue('1', 1)).toBe(true)
    expect(sameValue(null, '')).toBe(false)
  })

  it('writes MySQL statements with ? and JSON as text', () => {
    const change: DataChange = { id: 'x', at: 0, label: '', engine: 'mysql', schema: 'shop', table: 'my table', primaryKeys: ['id'], jsonColumns: [], steps: [] }
    const sql = undoSql(change)
    expect(sql.update({ id: 3 }, { meta: { a: 1 }, name: 'n' })).toEqual({
      sql: 'UPDATE `shop`.`my table` SET `meta` = ?, `name` = ? WHERE `id` = ?',
      params: ['{"a":1}', 'n', 3],
    })
    expect(sql.select({ id: 3 }).sql).toBe('SELECT * FROM `shop`.`my table` WHERE `id` = ? FOR UPDATE')
  })
})

describe('undoing on SQLite', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qdb-undo-'))
    sqliteConnect('c', path.join(dir, 'shop.db'), true)
    q('CREATE TABLE "Order Items" (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price REAL, pic BLOB, total REAL GENERATED ALWAYS AS (price * 2) STORED)')
    q('INSERT INTO "Order Items" (id, name, price, pic) VALUES (1, \'one\', 1.5, x\'0102\'), (2, \'two\', 3, NULL)')
  })
  afterEach(() => {
    sqliteCloseAll()
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  })

  const q = (sql: string, params?: unknown[]) => sqliteQuery('c', sql, 'main', params)
  const row = (id: number) => q('SELECT * FROM "Order Items" WHERE id = $1', [id]).rows[0]
  const change = (steps: UndoStep[]): DataChange => ({ id: 'x', at: 0, label: changeLabel(steps), engine: 'sqlite', schema: 'main', table: 'Order Items', primaryKeys: ['id'], jsonColumns: [], steps })
  // The same path as the app: a session with autocommit off, committed only when the undo worked
  const undo = async (c: DataChange, force = false) => {
    const sessionId = sqliteSessionOpen('c', { autocommit: false })
    const tx: UndoTx = { query: async (sql, params) => { try { return { ok: true, ...sqliteSessionQuery(sessionId, sql, params) } } catch (e) { return { ok: false, error: (e as Error).message } } } }
    const result = await undoChange(tx, c, { force })
    sqliteSessionClose(sessionId, result.ok)
    return result
  }

  it('restores edited values, deletes inserted rows and re-inserts deleted ones, blobs included', async () => {
    const before1 = row(1)
    const after1 = q('UPDATE "Order Items" SET name = $1, price = $2 WHERE id = $3 RETURNING *', ['uno', '9', 1]).rows[0]
    const inserted = q('INSERT INTO "Order Items" (name) VALUES ($1) RETURNING *', ['three']).rows[0]
    const deleted = row(2)
    q('DELETE FROM "Order Items" WHERE id = 2')

    const saved = stepsFromSave(['id'], [
      { before: before1, after: after1, edits: { name: 'uno', price: '9' } },
      { after: inserted, edits: { name: 'three' } },
    ]).steps
    expect(await undo(change([...saved, { kind: 'delete', row: deleted }]))).toEqual({ ok: true, skipped: [] })
    expect(q('SELECT * FROM "Order Items" ORDER BY id').rows).toEqual([before1, deleted])
    expect(row(1).pic).toEqual(before1.pic)
  })

  it('stops on rows changed since, rolls back, and goes ahead when forced', async () => {
    const before = row(1)
    const after = q('UPDATE "Order Items" SET name = $1 WHERE id = 1 RETURNING *', ['mine']).rows[0]
    const deletedRow = row(2)
    q('DELETE FROM "Order Items" WHERE id = 2')
    q('UPDATE "Order Items" SET name = \'theirs\' WHERE id = 1')
    const c = change([{ kind: 'delete', row: deletedRow }, ...stepsFromSave(['id'], [{ before, after, edits: { name: 'mine' } }]).steps])

    const result = await undo(c)
    expect(result).toEqual({ ok: false, conflicts: ['row id=1 was changed since (name)'] })
    expect(row(2)).toBeUndefined() // rolled back: the re-insert didn't stay
    expect(await undo(c, true)).toEqual({ ok: true, skipped: [] })
    expect(row(1).name).toBe('one')
    expect(row(2)).toEqual(deletedRow)
  })

  it('fails as a whole when a deleted row cannot come back', async () => {
    const deletedRow = row(2)
    q('DELETE FROM "Order Items" WHERE id = 2')
    q('INSERT INTO "Order Items" (id, name) VALUES (2, \'someone else\')')
    const result = await undo(change([{ kind: 'delete', row: deletedRow }]))
    expect(result.ok).toBe(false)
    expect('error' in result && result.error).toMatch(/^Couldn't re-insert row id=2: .*UNIQUE/)
    expect(row(2).name).toBe('someone else')
  })

  it('skips an inserted row that is already gone', async () => {
    const inserted = q('INSERT INTO "Order Items" (name) VALUES (\'tmp\') RETURNING *').rows[0]
    q('DELETE FROM "Order Items" WHERE id = $1', [inserted.id])
    const c = change(stepsFromSave(['id'], [{ after: inserted, edits: { name: 'tmp' } }]).steps)
    expect(await undo(c)).toEqual({ ok: true, skipped: [`row id=${inserted.id} was already deleted`] })
  })
})
