import { describe, it, expect } from 'vitest'
import {
  buildDataMeta, clearReferencesSql, deleteSql, insertSql, lookupSql, orderByDependencies, planTables, scanSql, updateSql,
  type DataColumn, type DataTableMeta,
} from './data-sync'

const col = (name: string, extra: Partial<DataColumn> = {}): DataColumn => ({
  name, type: 'text', generated: false, identity: '', notNull: false, hasDefault: false, ownsSequence: false, pkPosition: 0, ...extra,
})
const table = (name: string, columns: DataColumn[], references: string[] = [], selfReferences: DataTableMeta['selfReferences'] = []): DataTableMeta =>
  ({ name, columns, estimatedRows: 10, references, selfReferences })

describe('planTables', () => {
  const source = [
    table('users', [col('id', { type: 'integer', pkPosition: 1, ownsSequence: true }), col('email'), col('legacy'), col('total', { generated: true })]),
    table('logs', [col('msg')]),
    table('gone', [col('id', { pkPosition: 1 })]),
  ]
  const target = [
    table('users', [
      col('id', { type: 'integer', pkPosition: 1, identity: 'a', ownsSequence: true }), col('email', { type: 'character varying(200)' }),
      col('total', { generated: true }), col('required', { notNull: true }),
    ]),
    table('logs', [col('msg')]),
  ]
  const plans = planTables(source, target)

  it('maps common, non-generated columns and the target types', () => {
    const users = plans.find(p => p.table === 'users')!
    expect(users.key).toEqual(['id'])
    expect(users.columns).toEqual(['id', 'email'])
    expect(users.updateColumns).toEqual(['email'])
    expect(users.targetTypes.email).toBe('character varying(200)')
    expect(users.overridingSystemValue).toBe(true)
    expect(users.sequenceColumns).toEqual(['id'])
    expect(users.warnings.join('\n')).toMatch(/legacy does not exist in the target/)
    expect(users.warnings.join('\n')).toMatch(/required is NOT NULL without a default/)
  })

  it('skips tables without a primary key or missing from the target', () => {
    expect(plans.find(p => p.table === 'logs')!.skipped).toMatch(/no primary key/)
    expect(plans.find(p => p.table === 'gone')!.skipped).toMatch(/Structure Sync/)
  })

  it('defers nullable self-references to the primary key, and warns about ones it cannot defer', () => {
    const messages = (replyNotNull: boolean) => table('messages',
      [col('id', { type: 'uuid', pkPosition: 1 }), col('replyToId', { type: 'uuid', notNull: replyNotNull }), col('threadCode')],
      [], [{ columns: ['replyToId'], refColumns: ['id'] }, { columns: ['threadCode'], refColumns: ['code'] }])
    const src = [table('messages', [col('id', { type: 'uuid', pkPosition: 1 }), col('replyToId', { type: 'uuid' }), col('threadCode')])]

    const ok = planTables(src, [messages(false)])[0]
    expect(ok.selfReferences).toEqual([{ columns: ['replyToId'], refColumns: ['id'] }])
    expect(ok.warnings.join('\n')).toMatch(/\(threadCode\) can't be deferred because it references columns other than the primary key/)

    const notNull = planTables(src, [messages(true)])[0]
    expect(notNull.selfReferences).toEqual([])
    expect(notNull.warnings.join('\n')).toMatch(/\(replyToId\) can't be deferred because its columns are NOT NULL/)
  })
})

describe('orderByDependencies', () => {
  it('puts referenced tables first and tolerates cycles', () => {
    const meta = [table('orders', [], ['customers']), table('customers', [], []), table('items', [], ['orders', 'products']), table('products', [])]
    expect(orderByDependencies(['items', 'orders', 'products', 'customers'], meta)).toEqual(['customers', 'orders', 'products', 'items'])
    const cyclic = [table('a', [], ['b']), table('b', [], ['a'])]
    expect(orderByDependencies(['a', 'b'], cyclic).sort()).toEqual(['a', 'b'])
  })
})

describe('buildDataMeta', () => {
  it('groups columns per table and treats unknown row estimates as null', () => {
    const meta = buildDataMeta(
      [{ table_name: 't', name: 'id', type: 'integer', generated: false, identity: 'd', not_null: true, has_default: false, owns_sequence: true, pk_position: 1, estimated_rows: -1 }],
      [{ table_name: 't', ref_table: 'p' }],
    )
    expect(meta).toEqual([{ name: 't', estimatedRows: null, references: ['p'], selfReferences: [], columns: [{ name: 'id', type: 'integer', generated: false, identity: 'd', notNull: true, hasDefault: false, ownsSequence: true, pkPosition: 1 }] }])
  })
})

describe('SQL builders', () => {
  const plan = { table: 'pairs', key: ['a', 'b'], columns: ['a', 'b', 'val'], updateColumns: ['val'], targetTypes: { a: 'integer', b: 'text', val: 'double precision' }, overridingSystemValue: false }

  it('scans in key order with a keyset cursor and hashes every compared column', () => {
    expect(scanSql('s', plan, false, 10)).toBe('SELECT "a"::text AS "__k0", "b"::text AS "__k1", md5(ROW("a", "b", "val")::text) AS "__h" FROM "s"."pairs" ORDER BY "a", "b" LIMIT 10')
    expect(scanSql('s', plan, true, 10)).toContain('WHERE ("a", "b") > ($1, $2) ORDER BY')
    expect(scanSql('s', { ...plan, key: ['a'] }, true, 10)).toContain('WHERE "a" > $1 ORDER BY')
  })

  it('looks up and deletes by key tuples', () => {
    expect(lookupSql('s', plan, 2)).toContain('WHERE ("a", "b") IN (($1, $2), ($3, $4))')
    expect(deleteSql('s', { table: 't', key: ['id'] }, 3)).toBe('DELETE FROM "s"."t" WHERE "id" IN ($1, $2, $3)')
    expect(clearReferencesSql('s', 'messages', ['replyToId'], 2)).toBe('UPDATE "s"."messages" SET "replyToId" = NULL WHERE "replyToId" IN ($1, $2)')
  })

  it('inserts multiple rows, overriding GENERATED ALWAYS identities when needed', () => {
    expect(insertSql('s', plan, 2)).toBe('INSERT INTO "s"."pairs" ("a", "b", "val") VALUES ($1, $2, $3), ($4, $5, $6)')
    expect(insertSql('s', { ...plan, overridingSystemValue: true }, 1)).toContain('("a", "b", "val") OVERRIDING SYSTEM VALUE VALUES')
  })

  it('updates from a VALUES list, casting the text parameters to the target types', () => {
    expect(updateSql('s', plan, 2)).toBe(
      'UPDATE "s"."pairs" AS x SET "val" = v."val"::double precision FROM (VALUES ($1, $2, $3), ($4, $5, $6)) AS v("__k0", "__k1", "val") ' +
      'WHERE x."a" = v."__k0"::integer AND x."b" = v."__k1"::text')
  })
})
