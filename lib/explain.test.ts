import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { sqliteCloseAll, sqliteConnect, sqliteQuery } from '../electron/sqlite-conn'
import {
  conditionColumns, createIndexSql, explainStatement, mysqlAliases, parseMysqlPlan, parseSqlitePlan, relKey, suggestIndexes,
} from './explain'

describe('columns in a condition', () => {
  it('reads PostgreSQL filters: equality first, casts and literals ignored', () => {
    expect(conditionColumns(`((o.status = 'pending'::text) AND (o.created_at > (now() - '3 days'::interval)))`, ['orders', 'o']))
      .toEqual({ eq: ['status'], range: ['created_at'], hasOr: false })
    expect(conditionColumns(`(("Email")::text = 'a@b.c'::text)`, ['customers'])).toEqual({ eq: ['Email'], range: [], hasOr: false })
    expect(conditionColumns(`(status = ANY ('{a,b}'::text[]))`, ['t']).eq).toEqual(['status'])
    expect(conditionColumns(`(deleted_at IS NULL)`, ['t']).eq).toEqual(['deleted_at'])
  })

  it('skips expressions, other tables, <> and IS NOT NULL, and notices OR', () => {
    expect(conditionColumns(`(lower(email) = 'x'::text)`, ['t'])).toEqual({ eq: [], range: [], hasOr: false })
    expect(conditionColumns(`(c.id = o.customer_id)`, ['orders', 'o']).eq).toEqual(['customer_id'])
    expect(conditionColumns(`((status <> 'x'::text) AND (note IS NOT NULL))`, ['t'])).toEqual({ eq: [], range: [], hasOr: false })
    expect(conditionColumns(`((a = 1) OR (b = 2))`, ['t']).hasOr).toBe(true)
  })

  it('reads MySQL conditions', () => {
    expect(conditionColumns("((`shop`.`o`.`status` = 'pending') and (`shop`.`o`.`qty` >= 3))", ['orders', 'o']))
      .toEqual({ eq: ['status'], range: ['qty'], hasOr: false })
  })
})

describe('index statements', () => {
  it('quotes only what needs quoting and keeps sort direction', () => {
    expect(createIndexSql('postgres', 'public', 'orders', ['status', 'created_at DESC']))
      .toBe('CREATE INDEX CONCURRENTLY orders_status_created_at_idx ON public.orders (status, created_at DESC);')
    expect(createIndexSql('postgres', 'Sales', 'user', ['Email'])).toBe('CREATE INDEX CONCURRENTLY user_email_idx ON "Sales"."user" ("Email");')
    expect(createIndexSql('mysql', 'shop', 'orders', ['status'])).toBe('CREATE INDEX `orders_status_idx` ON `shop`.`orders` (`status`);')
  })

  it('builds EXPLAIN statements', () => {
    expect(explainStatement('postgres', 'SELECT 1;', true)).toBe('EXPLAIN (FORMAT JSON, VERBOSE, COSTS, ANALYZE, BUFFERS) SELECT 1')
    expect(explainStatement('mysql', 'SELECT 1', false)).toBe('EXPLAIN FORMAT=JSON SELECT 1')
    expect(explainStatement('sqlite', 'SELECT 1', false)).toBe('EXPLAIN QUERY PLAN SELECT 1')
  })
})

describe('MySQL plans', () => {
  const JSON_PLAN = {
    query_block: {
      select_id: 1,
      cost_info: { query_cost: '20512.40' },
      ordering_operation: {
        using_filesort: true,
        nested_loop: [
          { table: { table_name: 'o', access_type: 'ALL', possible_keys: null, rows_examined_per_scan: 199860, rows_produced_per_join: 19986, filtered: '10.00',
            cost_info: { read_cost: '18013.15', eval_cost: '1998.60', prefix_cost: '20011.75' }, attached_condition: "(`shop`.`o`.`status` = 'pending')" } },
          { table: { table_name: 'c', access_type: 'eq_ref', possible_keys: ['PRIMARY'], key: 'PRIMARY', used_key_parts: ['id'], rows_examined_per_scan: 1,
            rows_produced_per_join: 19986, filtered: '100.00', cost_info: { read_cost: '4.99', eval_cost: '1.00', prefix_cost: '20512.40' } } },
        ],
      },
    },
  }
  const NOTE = "/* select#1 */ select `shop`.`o`.`id` AS `id` from `shop`.`orders` `o` join `shop`.`customers` `c` where ((`shop`.`c`.`id` = `shop`.`o`.`customer_id`) and (`shop`.`o`.`status` = 'pending')) order by `shop`.`o`.`created_at`"

  it('reads real table names from the rewritten query', () => {
    const a = mysqlAliases(NOTE)
    expect(a.get('o')).toEqual({ schema: 'shop', table: 'orders' })
    expect(a.get('c')).toEqual({ schema: 'shop', table: 'customers' })
  })

  it('builds the tree, flags the full scan and filesort, and suggests an index', () => {
    const plan = parseMysqlPlan(JSON.stringify(JSON_PLAN), 'SELECT …', mysqlAliases(NOTE), 'shop')
    expect(plan.root.totalCost).toBe(20512.4)
    const sort = plan.root.children[0]
    expect(sort.title).toBe('Sort')
    expect(sort.warnings.join(' ')).toMatch(/filesort/)
    const [o, c] = sort.children[0].children
    expect(o).toMatchObject({ title: 'Full Table Scan', subtitle: 'on shop.orders o', fullScan: true, rowsRead: 199860 })
    expect(c).toMatchObject({ title: 'Unique Index Lookup', fullScan: false })
    const { suggestions } = suggestIndexes(plan, new Map([[relKey('shop', 'orders'), { rows: 200000, indexes: [['id']] }]]))
    expect(suggestions).toEqual([expect.objectContaining({ table: 'shop.orders', columns: ['status'], sql: 'CREATE INDEX `orders_status_idx` ON `shop`.`orders` (`status`);', priority: 'high' })])
  })

  it('notes an index that exists but was not used', () => {
    const plan = parseMysqlPlan(JSON_PLAN, 'SELECT …', mysqlAliases(NOTE), 'shop')
    const r = suggestIndexes(plan, new Map([[relKey('shop', 'orders'), { rows: 200000, indexes: [['status', 'created_at']] }]]))
    expect(r.suggestions).toHaveLength(0)
    expect(r.notes.join(' ')).toMatch(/index on \(status, created_at\) exists but wasn't used/)
  })
})

describe('SQLite plans', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qdb-explain-'))
    sqliteConnect('e', path.join(dir, 'e.db'), true)
    sqliteQuery('e', 'CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INT, status TEXT)')
    sqliteQuery('e', 'CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT)')
    sqliteQuery('e', 'CREATE INDEX orders_customer ON orders (customer_id)')
  })
  afterEach(() => { sqliteCloseAll(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })

  it('shows scans, index searches and temp sorts', () => {
    const sql = "SELECT * FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.name = 'x' ORDER BY o.status"
    const plan = parseSqlitePlan(sqliteQuery('e', explainStatement('sqlite', sql, false)).rows, sql)
    const all = plan.root.children
    const scan = all.find(n => n.fullScan)!
    expect(scan).toMatchObject({ title: 'Full Table Scan', relation: { table: 'customers', alias: 'c' } })
    expect(all.some(n => n.title === 'Index Search' && n.subtitle.includes('orders_customer'))).toBe(true)
    expect(all.some(n => n.warnings.some(w => /temporary b-tree/.test(w)))).toBe(true)
  })
})
