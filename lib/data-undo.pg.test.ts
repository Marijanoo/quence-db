// Undoing saved data changes against a real PostgreSQL server. Opt-in: set QUENCE_PG_TEST_URL.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { stepsFromSave, undoChange, type DataChange, type UndoStep } from './data-undo'

const url = process.env.QUENCE_PG_TEST_URL
const S = `qundo_${Math.random().toString(36).slice(2, 8)}`

describe.skipIf(!url)('undoing data changes on PostgreSQL', () => {
  let c: Client
  const q = async (sql: string, params?: unknown[]) => (await c.query(sql, params)).rows
  const row = async (id: number) => (await q(`SELECT * FROM ${S}."Order Items" WHERE id = $1`, [id]))[0]
  const change = (steps: UndoStep[]): DataChange => ({
    id: 'x', at: 0, label: '', engine: 'postgres', schema: S, table: 'Order Items', primaryKeys: ['id'], jsonColumns: ['meta'], steps,
  })
  // In a transaction, committed only when the undo worked, as the app does
  const undo = async (ch: DataChange, force = false) => {
    await c.query('BEGIN')
    const result = await undoChange({
      query: async (sql, params) => {
        try { const r = await c.query(sql, params); return { ok: true, rows: r.rows, rowCount: r.rowCount } }
        catch (e) { return { ok: false, error: (e as Error).message } }
      },
    }, ch, { force })
    await c.query(result.ok ? 'COMMIT' : 'ROLLBACK')
    return result
  }

  beforeAll(async () => {
    c = new Client({ connectionString: url })
    await c.connect()
    await c.query(`
      CREATE SCHEMA ${S};
      CREATE TABLE ${S}."Order Items" (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        name text NOT NULL,
        qty integer,
        doubled integer GENERATED ALWAYS AS (qty * 2) STORED,
        meta jsonb,
        tags text[],
        pic bytea,
        due date,
        at timestamptz
      );
      INSERT INTO ${S}."Order Items" (name, qty, meta, tags, pic, due, at) VALUES
        ('one', 1, '[1, {"a": "b"}]', '{x,"y z"}', '\\x0102ff', '2024-02-29', '2024-01-01 10:00:00.123+00'),
        ('two', 2, '{"k": null}', NULL, NULL, NULL, NULL);
    `)
  })

  afterAll(async () => {
    await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`)
    await c.end()
  })

  it('puts back edits, removes inserts and re-inserts a deleted row with its id and every type intact', async () => {
    const before1 = await row(1)
    const [after1] = await q(`UPDATE ${S}."Order Items" SET name = $1, meta = $2, due = $3 WHERE id = 1 RETURNING *`, ['uno', '{"new": true}', '2025-01-01'])
    const [inserted] = await q(`INSERT INTO ${S}."Order Items" (name) VALUES ('three') RETURNING *`)
    const deleted = await row(2)
    await q(`DELETE FROM ${S}."Order Items" WHERE id = 2`)
    const steps = stepsFromSave(['id'], [
      { before: before1, after: after1, edits: { name: 'uno', meta: '{"new": true}', due: '2025-01-01' } },
      { after: inserted, edits: { name: 'three' } },
    ]).steps

    expect(await undo(change([...steps, { kind: 'delete', row: deleted }]))).toEqual({ ok: true, skipped: [] })
    expect(await q(`SELECT * FROM ${S}."Order Items" ORDER BY id`)).toEqual([before1, deleted])
  })

  it('re-inserts rows with arrays, JSON arrays, bytes and generated columns', async () => {
    const deleted = await row(1)
    await q(`DELETE FROM ${S}."Order Items" WHERE id = 1`)
    expect(await undo(change([{ kind: 'delete', row: deleted }]))).toEqual({ ok: true, skipped: [] })
    expect(await row(1)).toEqual(deleted)
    expect(deleted.meta).toEqual([1, { a: 'b' }])
    expect(deleted.tags).toEqual(['x', 'y z'])
  })

  it('refuses when the row was changed since, then restores it when forced', async () => {
    const before = await row(1)
    const [after] = await q(`UPDATE ${S}."Order Items" SET qty = 5 WHERE id = 1 RETURNING *`)
    await q(`UPDATE ${S}."Order Items" SET qty = 6 WHERE id = 1`)
    const ch = change(stepsFromSave(['id'], [{ before, after, edits: { qty: '5' } }]).steps)
    expect(await undo(ch)).toEqual({ ok: false, conflicts: ['row id=1 was changed since (qty)'] })
    expect((await row(1)).qty).toBe(6)
    expect(await undo(ch, true)).toEqual({ ok: true, skipped: [] })
    expect(await row(1)).toEqual(before)
  })
})
