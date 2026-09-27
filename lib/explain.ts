// Visual EXPLAIN: turns PostgreSQL, MySQL and SQLite plans into one tree of steps, flags the
// expensive or suspicious ones, and suggests indexes for full-table scans that filter or sort.
// Everything here is plain data (plans are kept with the tab), and pure so it can be tested.

export type ExplainEngine = 'postgres' | 'mysql' | 'sqlite'

export interface PlanNode {
  id: string
  title: string          // e.g. "Seq Scan", "Hash Join (Left)"
  subtitle: string       // e.g. "on public.orders o", "using orders_pkey"
  relation?: { schema?: string; table: string; alias?: string }
  estRows: number | null     // per loop
  actualRows: number | null  // per loop (ANALYZE)
  loops: number | null
  totalMs: number | null     // inclusive, all loops
  selfMs: number | null
  totalCost: number | null   // inclusive
  selfCost: number | null
  details: [string, string][]
  // Detail labels whose values are SQL expressions (shown highlighted)
  sqlDetails: string[]
  warnings: string[]
  fullScan: boolean
  children: PlanNode[]
  // For index suggestions: the scan's filter, its rows read (all loops) and sort keys above it
  condition?: string
  rowsRead?: number | null
}

export interface IndexSuggestion {
  table: string        // for display, schema-qualified
  columns: string[]
  sql: string
  reason: string
  priority: 'high' | 'medium'
  nodeId: string
}

export interface ExplainPlan {
  engine: ExplainEngine
  analyzed: boolean
  statement: string
  root: PlanNode
  planningMs: number | null
  executionMs: number | null
  suggestions: IndexSuggestion[]
  notes: string[]
  raw: string
}

// What the database knows about a table: its size and the columns of its indexes, in order
export interface TableIndexInfo { rows: number | null; indexes: string[][] }
export const relKey = (schema: string | undefined, table: string) => `${(schema ?? '').toLowerCase()}.${table.toLowerCase()}`

type Json = Record<string, unknown>
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v))
const fmtN = (n: number) => Math.round(n).toLocaleString('en-US')

// Statements -------------------------------------------------------------------------------------

export function explainStatement(engine: ExplainEngine, sql: string, analyze: boolean): string {
  const body = sql.trim().replace(/;\s*$/, '')
  if (engine === 'postgres') return `EXPLAIN (FORMAT JSON, VERBOSE, COSTS${analyze ? ', ANALYZE, BUFFERS' : ''}) ${body}`
  if (engine === 'mysql') return `EXPLAIN FORMAT=JSON ${body}`
  return `EXPLAIN QUERY PLAN ${body}`
}

// PostgreSQL -------------------------------------------------------------------------------------

const PG_SQL_DETAILS = ['Filter', 'Index Cond', 'Recheck Cond', 'Hash Cond', 'Merge Cond', 'Join Filter', 'Sort Key', 'Group Key', 'One-Time Filter', 'Output']

export function parsePgPlan(value: unknown, statement: string): ExplainPlan {
  const top = (Array.isArray(value) ? value[0] : typeof value === 'string' ? JSON.parse(value)[0] : value) as Json
  const root = top?.Plan as Json | undefined
  if (!root) throw new Error('The server returned no plan')
  const analyzed = root['Actual Total Time'] !== undefined
  let seq = 0
  // underLimit: a LIMIT above stops this step early, so fewer rows than estimated is expected
  const build = (p: Json, underLimit = false): PlanNode => {
    const type = str(p['Node Type'])
    const children = ((p.Plans as Json[] | undefined) ?? []).map(ch => build(ch, underLimit || type === 'Limit'))
    const join = str(p['Join Type'])
    const strategy = str(p.Strategy)
    let title = type === 'Aggregate' && strategy === 'Hashed' ? 'HashAggregate' : type === 'Aggregate' && strategy === 'Sorted' ? 'GroupAggregate' : type
    if (p['Parallel Aware'] === true) title = `Parallel ${title}`
    if (join && join !== 'Inner') title += ` (${join})`
    const relName = str(p['Relation Name'])
    const alias = str(p.Alias)
    const schema = str(p.Schema) || undefined
    const sub: string[] = []
    if (p['Subplan Name']) sub.push(str(p['Subplan Name']))
    if (relName) sub.push(`on ${schema ? `${schema}.` : ''}${relName}${alias && alias !== relName ? ` ${alias}` : ''}`)
    else if (p['CTE Name']) sub.push(`on CTE ${p['CTE Name']}`)
    else if (p['Function Name']) sub.push(`on ${p['Function Name']}()`)
    if (p['Index Name']) sub.push(`using ${p['Index Name']}`)

    const loops = num(p['Actual Loops'])
    const perLoopMs = num(p['Actual Total Time'])
    const totalMs = perLoopMs !== null ? perLoopMs * (loops ?? 1) : null
    const childMs = children.reduce((a, c) => a + (c.totalMs ?? 0), 0)
    const totalCost = num(p['Total Cost'])
    const childCost = children.reduce((a, c) => a + (c.totalCost ?? 0), 0)

    const details: [string, string][] = []
    const add = (label: string, v: unknown) => {
      if (v === undefined || v === null || v === '') return
      details.push([label, Array.isArray(v) ? v.join(', ') : typeof v === 'number' ? v.toLocaleString('en-US') : str(v)])
    }
    for (const k of ['Filter', 'Index Cond', 'Recheck Cond', 'Hash Cond', 'Merge Cond', 'Join Filter', 'One-Time Filter', 'Sort Key', 'Group Key']) add(k, p[k])
    add('Rows Removed by Filter', p['Rows Removed by Filter'])
    add('Rows Removed by Join Filter', p['Rows Removed by Join Filter'])
    add('Rows Removed by Index Recheck', p['Rows Removed by Index Recheck'])
    if (p['Sort Method']) add('Sort Method', `${p['Sort Method']}${p['Sort Space Used'] !== undefined ? ` (${p['Sort Space Type']}: ${p['Sort Space Used']} kB)` : ''}`)
    add('Heap Fetches', p['Heap Fetches'])
    add('Hash Batches', p['Hash Batches'])
    add('Peak Memory', p['Peak Memory Usage'] !== undefined ? `${p['Peak Memory Usage']} kB` : undefined)
    add('Workers', p['Workers Launched'] !== undefined ? `${p['Workers Launched']} of ${p['Workers Planned']} launched` : undefined)
    if (p['Shared Hit Blocks'] !== undefined) add('Buffers', `hit ${p['Shared Hit Blocks']}, read ${p['Shared Read Blocks'] ?? 0}${p['Temp Written Blocks'] ? `, temp written ${p['Temp Written Blocks']}` : ''}`)
    add('Cost', totalCost !== null ? `${num(p['Startup Cost'])}..${totalCost}` : undefined)
    add('Width', p['Plan Width'] !== undefined ? `${p['Plan Width']} bytes` : undefined)
    add('Output', p.Output)

    const fullScan = type === 'Seq Scan'
    const removed = (num(p['Rows Removed by Filter']) ?? 0) * (loops ?? 1)
    const actualRows = num(p['Actual Rows'])
    const estRows = num(p['Plan Rows'])
    const warnings: string[] = []
    if (fullScan && analyzed && removed >= 1000 && removed / (removed + (actualRows ?? 0) * (loops ?? 1)) >= 0.9) {
      warnings.push(`Read ${fmtN(removed + (actualRows ?? 0) * (loops ?? 1))} rows to keep ${fmtN((actualRows ?? 0) * (loops ?? 1))}`)
    }
    if (analyzed && actualRows !== null && estRows !== null) {
      const hi = Math.max(actualRows, estRows), lo = Math.max(1, Math.min(actualRows, estRows))
      if (hi >= 100 && hi / lo >= 10 && !(underLimit && actualRows < estRows)) warnings.push(`Estimated ${fmtN(estRows)} rows, got ${fmtN(actualRows)}: the table statistics may be out of date (ANALYZE)`)
    }
    if (p['Sort Space Type'] === 'Disk') warnings.push(`Sort spilled to disk (${p['Sort Space Used']} kB); more work_mem or an index on the sort keys avoids it`)
    if ((num(p['Hash Batches']) ?? 1) > 1) warnings.push(`Hash spilled to disk in ${p['Hash Batches']} batches; more work_mem avoids it`)
    if (fullScan && (loops ?? 1) >= 100) warnings.push(`Scanned the whole table ${fmtN(loops!)} times (once per outer row)`)
    if ((num(p['Heap Fetches']) ?? 0) >= 1000) warnings.push(`${fmtN(num(p['Heap Fetches'])!)} heap fetches in an index-only scan; VACUUM the table to cut them`)

    return {
      id: String(seq++),
      title,
      subtitle: sub.join(' '),
      relation: relName ? { schema, table: relName, alias: alias || undefined } : undefined,
      estRows, actualRows, loops,
      totalMs, selfMs: totalMs !== null ? Math.max(0, totalMs - childMs) : null,
      totalCost, selfCost: totalCost !== null ? Math.max(0, totalCost - childCost) : null,
      details, sqlDetails: PG_SQL_DETAILS, warnings, fullScan, children,
      condition: p.Filter ? str(p.Filter) : undefined,
      rowsRead: analyzed ? removed + (actualRows ?? 0) * (loops ?? 1) : estRows,
    }
  }
  const tree = build(root)
  return {
    engine: 'postgres', analyzed, statement, root: tree,
    planningMs: num(top['Planning Time']), executionMs: num(top['Execution Time']),
    suggestions: [], notes: [], raw: JSON.stringify(top, null, 2),
  }
}

// Every table the plan reads, for looking up its indexes and size
export function planRelations(plan: ExplainPlan): { schema?: string; table: string }[] {
  const out = new Map<string, { schema?: string; table: string }>()
  const walk = (n: PlanNode) => {
    if (n.relation) out.set(relKey(n.relation.schema, n.relation.table), { schema: n.relation.schema, table: n.relation.table })
    n.children.forEach(walk)
  }
  walk(plan.root)
  return [...out.values()]
}

export function pgIndexInfoQuery(rels: { schema?: string; table: string }[]): { sql: string; params: unknown[] } {
  const params: unknown[] = []
  const pairs = rels.map(r => { params.push(r.schema ?? 'public', r.table); return `($${params.length - 1}, $${params.length})` })
  return {
    sql: `SELECT n.nspname AS schema, c.relname AS table, c.reltuples::bigint AS est_rows,
  (SELECT json_agg(cols) FROM (
     SELECT ARRAY(SELECT a.attname FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum ORDER BY k.ord) AS cols
     FROM pg_index i WHERE i.indrelid = c.oid) x) AS indexes
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE (n.nspname, c.relname) IN (VALUES ${pairs.join(', ')})`,
    params,
  }
}

export function indexInfoFromRows(rows: Json[]): Map<string, TableIndexInfo> {
  const m = new Map<string, TableIndexInfo>()
  for (const r of rows) {
    const est = num(r.est_rows)
    const idx = (typeof r.indexes === 'string' ? JSON.parse(r.indexes) : r.indexes ?? []) as string[][]
    m.set(relKey(str(r.schema), str(r.table)), { rows: est !== null && est >= 0 ? est : null, indexes: idx })
  }
  return m
}

// MySQL ------------------------------------------------------------------------------------------

// `db`.`table` `alias` pairs from the rewritten query MySQL leaves in SHOW WARNINGS after EXPLAIN
export function mysqlAliases(note: string): Map<string, { schema: string; table: string }> {
  const out = new Map<string, { schema: string; table: string }>()
  const re = /(?:from|join|,)\s+`([^`]+)`\.`([^`]+)`(?:\s+`([^`]+)`)?/gi
  for (let m = re.exec(note); m; m = re.exec(note)) out.set((m[3] ?? m[2]).toLowerCase(), { schema: m[1], table: m[2] })
  return out
}

// `defaultSchema`: the database the query ran in, for tables the rewritten query didn't name
export function parseMysqlPlan(value: unknown, statement: string, aliases = new Map<string, { schema: string; table: string }>(), defaultSchema?: string): ExplainPlan {
  const doc = (typeof value === 'string' ? JSON.parse(value) : value) as Json
  let seq = 0
  const node = (title: string, subtitle: string, children: PlanNode[], extra: Partial<PlanNode> = {}): PlanNode => {
    const totalCost = extra.totalCost ?? null
    return {
      id: String(seq++), title, subtitle, estRows: null, actualRows: null, loops: null, totalMs: null, selfMs: null,
      totalCost, selfCost: totalCost, details: [], sqlDetails: ['Condition'], warnings: [], fullScan: false, children, ...extra,
    }
  }
  const ACCESS: Record<string, string> = {
    ALL: 'Full Table Scan', index: 'Full Index Scan', range: 'Index Range Scan', ref: 'Index Lookup', eq_ref: 'Unique Index Lookup',
    const: 'Single Row (constant)', system: 'Single Row', fulltext: 'Fulltext Index', ref_or_null: 'Index Lookup (or NULL)', index_merge: 'Index Merge',
  }
  const table = (t: Json): PlanNode => {
    const name = str(t.table_name)
    const access = str(t.access_type)
    const real = aliases.get(name.toLowerCase())
    const rows = num(t.rows_examined_per_scan)
    const cost = t.cost_info as Json | undefined
    const inner = [
      ...(t.materialized_from_subquery ? [block(((t.materialized_from_subquery as Json).query_block ?? {}) as Json, 'Materialized subquery')] : []),
      ...((t.attached_subqueries as Json[] | undefined) ?? []).map(s => block((s.query_block ?? {}) as Json, 'Subquery')),
    ]
    const n = node(ACCESS[access] ?? (access || 'Table'), `on ${real ? `${real.schema}.${real.table}${real.table !== name ? ` ${name}` : ''}` : name}${t.key ? ` using ${t.key}` : ''}`, inner, {
      relation: { schema: real?.schema ?? defaultSchema, table: real?.table ?? name, alias: name },
      estRows: num(t.rows_produced_per_join) ?? rows,
      totalCost: num(cost?.prefix_cost),
      fullScan: access === 'ALL',
      condition: t.attached_condition ? str(t.attached_condition) : undefined,
      rowsRead: rows,
    })
    n.selfCost = num(cost?.read_cost) !== null ? (num(cost?.read_cost) ?? 0) + (num(cost?.eval_cost) ?? 0) : n.totalCost
    const d = n.details
    if (t.attached_condition) d.push(['Condition', str(t.attached_condition)])
    if (t.possible_keys) d.push(['Possible keys', (t.possible_keys as string[]).join(', ')])
    if (t.key) d.push(['Key', `${t.key}${t.used_key_parts ? ` (${(t.used_key_parts as string[]).join(', ')})` : ''}`])
    if (rows !== null) d.push(['Rows examined per scan', fmtN(rows)])
    if (t.filtered !== undefined) d.push(['Filtered', `${t.filtered}%`])
    if (t.using_index) d.push(['Covering index', 'yes'])
    if (access === 'ALL' && (rows ?? 0) >= 1000) n.warnings.push(`Reads every row (about ${fmtN(rows!)})`)
    if (access === 'ALL' && t.possible_keys) n.warnings.push(`Index ${(t.possible_keys as string[]).join(', ')} could be used but the optimizer chose a full scan`)
    return n
  }
  const body = (b: Json): PlanNode[] => {
    const out: PlanNode[] = []
    if (b.table) out.push(table(b.table as Json))
    if (Array.isArray(b.nested_loop)) {
      const parts = (b.nested_loop as Json[]).map(x => table((x.table ?? x) as Json))
      out.push(node('Nested Loop', `${parts.length} tables, first to last`, parts))
    }
    for (const [key, label] of [['ordering_operation', 'Sort'], ['grouping_operation', 'Group'], ['duplicates_removal', 'Distinct'], ['windowing', 'Window']] as const) {
      const op = b[key] as Json | undefined
      if (!op) continue
      const n = node(label, op.using_filesort ? 'using filesort' : op.using_temporary_table ? 'using a temporary table' : '', body(op))
      if (op.using_filesort) n.warnings.push('Sorts the rows itself (filesort); an index in ORDER BY order avoids it')
      if (op.using_temporary_table) n.warnings.push('Builds a temporary table')
      out.push(n)
    }
    if (b.union_result) {
      const u = b.union_result as Json
      const specs = ((u.query_specifications as Json[] | undefined) ?? []).map(s => block((s.query_block ?? {}) as Json, 'Part'))
      out.push(node(u.using_temporary_table ? 'Union' : 'Union All', '', specs))
    }
    return out
  }
  const block = (b: Json, title: string): PlanNode => {
    const cost = num((b.cost_info as Json | undefined)?.query_cost)
    return node(title, b.select_id !== undefined ? `select #${b.select_id}` : '', body(b), { totalCost: cost, selfCost: 0 })
  }
  const qb = (doc.query_block ?? doc) as Json
  const root = block(qb, 'Query')
  if (b0(qb).message) root.warnings.push(str(b0(qb).message))
  return { engine: 'mysql', analyzed: false, statement, root, planningMs: null, executionMs: null, suggestions: [], notes: [], raw: JSON.stringify(doc, null, 2) }
}
const b0 = (b: Json) => b as { message?: string }

// Sizes and index columns of the tables, from information_schema (works on MySQL and MariaDB)
export async function mysqlIndexInfo(rels: { schema?: string; table: string }[], run: (sql: string, params: unknown[]) => Promise<Json[]>): Promise<Map<string, TableIndexInfo>> {
  const params: unknown[] = []
  const pairs = rels.map(r => { params.push(r.schema ?? '', r.table); return '(?, ?)' }).join(', ')
  const [tables, stats] = await Promise.all([
    run(`SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t, TABLE_ROWS AS n FROM information_schema.TABLES WHERE (TABLE_SCHEMA, TABLE_NAME) IN (${pairs})`, params),
    run(`SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t, INDEX_NAME AS i, COLUMN_NAME AS c FROM information_schema.STATISTICS
         WHERE (TABLE_SCHEMA, TABLE_NAME) IN (${pairs}) ORDER BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`, params),
  ])
  const m = new Map<string, TableIndexInfo>()
  for (const r of tables) m.set(relKey(str(r.s), str(r.t)), { rows: num(r.n), indexes: [] })
  const byIndex = new Map<string, string[]>()
  for (const r of stats) {
    const k = JSON.stringify([relKey(str(r.s), str(r.t)), str(r.i)])
    byIndex.set(k, [...(byIndex.get(k) ?? []), str(r.c)])
  }
  for (const [k, cols] of byIndex) m.get(JSON.parse(k)[0])?.indexes.push(cols)
  return m
}

// SQLite -----------------------------------------------------------------------------------------

export function parseSqlitePlan(rows: Json[], statement: string): ExplainPlan {
  const nodes = new Map<string, PlanNode>()
  const root: PlanNode = {
    id: 'root', title: 'Query', subtitle: '', estRows: null, actualRows: null, loops: null, totalMs: null, selfMs: null,
    totalCost: null, selfCost: null, details: [], sqlDetails: [], warnings: [], fullScan: false, children: [],
  }
  nodes.set('0', root)
  // SQLite names a scanned table by its alias when it has one; map aliases back from the query
  const aliases = new Map<string, string>()
  const aliasRe = /\b(?:from|join)\s+((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?)\s+(?:as\s+)?("[^"]+"|[\w$]+)/gi
  for (let m = aliasRe.exec(statement); m; m = aliasRe.exec(statement)) {
    const alias = unquote(m[2])
    if (!/^(where|on|join|left|right|inner|outer|cross|natural|group|order|limit|using|union|natural)$/i.test(alias)) {
      aliases.set(alias.toLowerCase(), unquote(m[1].split('.').pop()!))
    }
  }
  for (const r of rows) {
    const detail = str(r.detail)
    const scan = /^SCAN (?:TABLE )?(\S+)(?: AS (\S+))?(.*)$/i.exec(detail)
    const search = /^SEARCH (?:TABLE )?(\S+)(?: AS (\S+))?(.*)$/i.exec(detail)
    const m = scan ?? search
    const fullScan = !!scan && !/USING (?:COVERING )?INDEX|USING INTEGER PRIMARY KEY/i.test(scan[3] ?? '')
    const n: PlanNode = {
      id: str(r.id),
      title: scan ? (fullScan ? 'Full Table Scan' : 'Index Scan') : search ? 'Index Search' : detail.replace(/ .*/, '') === 'USE' ? 'Temp B-Tree' : detail,
      subtitle: m ? `${m[1]}${m[2] ? ` ${m[2]}` : ''}${m[3] ?? ''}` : detail.startsWith('USE TEMP B-TREE') ? detail.slice('USE TEMP B-TREE '.length).toLowerCase() : '',
      relation: m ? (m[2] ? { table: m[1], alias: m[2] } : aliases.has(m[1].toLowerCase()) ? { table: aliases.get(m[1].toLowerCase())!, alias: m[1] } : { table: m[1] }) : undefined,
      estRows: null, actualRows: null, loops: null, totalMs: null, selfMs: null, totalCost: null, selfCost: null,
      details: [['Detail', detail]], sqlDetails: [], warnings: [], fullScan, children: [],
    }
    if (fullScan) n.warnings.push('Reads every row of the table')
    if (/^USE TEMP B-TREE FOR (ORDER BY|GROUP BY|DISTINCT)/i.test(detail)) n.warnings.push('Sorts in a temporary b-tree; an index in that order avoids it')
    nodes.set(str(r.id), n)
    ;(nodes.get(str(r.parent)) ?? root).children.push(n)
  }
  const note = rows.some(r => /^SCAN /i.test(str(r.detail)))
    ? ['SQLite shows no row counts or costs; full scans of big tables are the thing to look for.'] : []
  return { engine: 'sqlite', analyzed: false, statement, root, planningMs: null, executionMs: null, suggestions: [], notes: note, raw: rows.map(r => `${r.id} ${r.parent} ${r.detail}`).join('\n') }
}

// Conditions → columns ---------------------------------------------------------------------------

const IDENT = '(?:"[^"]+"|`[^`]+`|[A-Za-z_][\\w$]*)'
const COLREF = `${IDENT}(?:\\.${IDENT}){0,2}`
const NOT_COLUMNS = new Set(['and', 'or', 'not', 'true', 'false', 'null', 'any', 'all', 'is', 'in', 'like'])

const unquote = (s: string) => /^["`]/.test(s) ? s.slice(1, -1) : s
function splitRef(ref: string): string[] {
  return (ref.match(new RegExp(IDENT, 'g')) ?? []).map(unquote)
}

export interface ConditionColumns { eq: string[]; range: string[]; hasOr: boolean }

// Columns a condition compares with = (or IS NULL) and with ranges, belonging to one table (its
// name or alias qualifies them, or nothing does). Function calls and expressions are skipped:
// a plain index on the column wouldn't serve them.
export function conditionColumns(cond: string, names: string[]): ConditionColumns {
  let c = cond.replace(/'(?:[^'\\]|\\.|'')*'/g, '?')
  c = c.replace(/::(?:character varying|timestamp (?:with|without) time zone|time (?:with|without) time zone|double precision|bit varying|"[^"]+"|[\w.]+)(?:\[\])?/gi, '')
  // "(email)" → "email", but not the argument of a function call "lower(email)"
  const unwrap = new RegExp(`\\((${COLREF})\\)`, 'g')
  for (let prevText = ''; prevText !== c;) {
    prevText = c
    c = c.replace(unwrap, (m, ref: string, offset: number) => /[\w$"`]/.test(c[offset - 1] ?? '') ? m : ref)
  }
  const own = new Set(names.filter(Boolean).map(n => n.toLowerCase()))
  const eq: string[] = [], range: string[] = []
  const take = (ref: string, op: string) => {
    const parts = splitRef(ref)
    const col = parts[parts.length - 1]
    if (!col || NOT_COLUMNS.has(col.toLowerCase()) || /^\d/.test(col)) return
    const qualifier = parts[parts.length - 2]
    if (qualifier !== undefined && !own.has(qualifier.toLowerCase())) return
    const target = /^(=|IS NULL)$/i.test(op) ? eq : range
    if (!eq.includes(col) && !range.includes(col)) target.push(col)
  }
  const left = new RegExp(`(^|[\\s(,])(${COLREF})\\s*(<>|!=|<=|>=|=|<|>|IS NOT NULL|IS NULL)`, 'gi')
  for (let m = left.exec(c); m; m = left.exec(c)) if (!/^(<>|!=|IS NOT NULL)$/i.test(m[3])) take(m[2], m[3].toUpperCase())
  const right = new RegExp(`(<>|!=|<=|>=|=|<|>)\\s*(${COLREF})(?=\\s*[),]|\\s*$)`, 'g')
  for (let m = right.exec(c); m; m = right.exec(c)) if (!/^(<>|!=)$/.test(m[1])) take(m[2], m[1])
  // An equality column also listed as a range stays an equality
  return { eq, range: range.filter(r => !eq.includes(r)), hasOr: /\bor\b/i.test(c) }
}

// Suggestions ------------------------------------------------------------------------------------

const PG_RESERVED = new Set(['all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'check', 'collate', 'column', 'constraint', 'create', 'default',
  'desc', 'distinct', 'do', 'else', 'end', 'except', 'false', 'for', 'foreign', 'from', 'grant', 'group', 'having', 'in', 'into', 'limit', 'not', 'null',
  'offset', 'on', 'only', 'or', 'order', 'primary', 'references', 'select', 'table', 'then', 'to', 'true', 'union', 'unique', 'user', 'using', 'when', 'where', 'with'])
function qIdent(engine: ExplainEngine, name: string): string {
  if (engine === 'mysql') return '`' + name.replace(/`/g, '``') + '`'
  return /^[a-z_][a-z0-9_]*$/.test(name) && !PG_RESERVED.has(name) ? name : '"' + name.replace(/"/g, '""') + '"'
}

export function indexName(table: string, cols: string[]): string {
  const base = `${table}_${cols.map(c => c.replace(/ (DESC|ASC)$/i, '')).join('_')}`.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_')
  return `${base.slice(0, 59)}_idx`
}

export function createIndexSql(engine: ExplainEngine, schema: string | undefined, table: string, cols: string[]): string {
  const name = indexName(table, cols)
  const target = `${schema ? `${qIdent(engine, schema)}.` : ''}${qIdent(engine, table)}`
  const list = cols.map(c => { const m = / (DESC|ASC)$/i.exec(c); return m ? `${qIdent(engine, c.slice(0, -m[0].length))} ${m[1].toUpperCase()}` : qIdent(engine, c) }).join(', ')
  // CONCURRENTLY: doesn't block writes to the table while it builds
  return engine === 'postgres'
    ? `CREATE INDEX CONCURRENTLY ${qIdent(engine, name)} ON ${target} (${list});`
    : `CREATE INDEX ${qIdent(engine, name)} ON ${target} (${list});`
}

// Whether an existing index already starts with these columns (equality columns in any order)
function covered(indexes: string[][], eq: string[], range: string[]): string[] | null {
  const lead = [...eq, ...range.slice(0, 1)]
  for (const idx of indexes) {
    const lower = idx.map(c => c.toLowerCase())
    const eqPart = new Set(lower.slice(0, eq.length))
    if (eq.every(c => eqPart.has(c.toLowerCase())) && (eq.length > 0 || lower[0] === lead[0]?.toLowerCase())) return idx
  }
  return null
}

const SMALL_TABLE = 1000

export function suggestIndexes(plan: ExplainPlan, info: Map<string, TableIndexInfo>): { suggestions: IndexSuggestion[]; notes: string[] } {
  if (plan.engine === 'sqlite') return { suggestions: [], notes: [] }
  const suggestions: IndexSuggestion[] = []
  const notes: string[] = []
  const total = plan.executionMs ?? plan.root.totalMs ?? plan.root.totalCost ?? 0
  const seen = new Set<string>()

  const visit = (n: PlanNode, ancestors: PlanNode[]) => {
    n.children.forEach(ch => visit(ch, [n, ...ancestors]))
    if (!n.fullScan || !n.relation) return
    const rel = n.relation
    const label = `${rel.schema ? `${rel.schema}.` : ''}${rel.table}`
    const tinfo = info.get(relKey(rel.schema, rel.table))
    const cols = n.condition ? conditionColumns(n.condition, [rel.table, rel.alias ?? '']) : { eq: [], range: [], hasOr: false }
    // Top-N: Limit ← (Gather Merge) ← Sort ← (Gather) ← this scan. An index in sort order lets the
    // database read rows in order and stop early.
    let at = 0
    const skipGather = () => { while (/^(Parallel )?Gather/.test(ancestors[at]?.title ?? '')) at++ }
    skipGather()
    const sortAbove = /^(Sort|Incremental Sort)/.test(ancestors[at]?.title ?? '') ? ancestors[at++] : undefined
    skipGather()
    const limited = !!sortAbove && ancestors[at]?.title === 'Limit'
    const sortKeys = sortAbove && limited && plan.engine === 'postgres'
      ? (sortAbove.details.find(d => d[0] === 'Sort Key')?.[1] ?? '').split(', ').map(k => {
        const m = new RegExp(`^(${COLREF})(?: (DESC|ASC))?(?: NULLS (?:FIRST|LAST))?$`, 'i').exec(k.trim())
        if (!m) return null
        const parts = splitRef(m[1])
        const q = parts[parts.length - 2]
        if (q !== undefined && q.toLowerCase() !== rel.table.toLowerCase() && q.toLowerCase() !== (rel.alias ?? '').toLowerCase()) return null
        return `${parts[parts.length - 1]}${m[2]?.toUpperCase() === 'DESC' ? ' DESC' : ''}`
      })
      : []
    const usableSort = sortKeys.length > 0 && sortKeys.every(Boolean) ? sortKeys as string[] : []

    if (cols.hasOr) { notes.push(`${label}: the filter uses OR, so one index won't cover it; consider an index per branch or UNION`); return }
    const eq = cols.eq.slice(0, 3)
    const range = eq.length < 3 ? cols.range.slice(0, 1) : []
    const keyCols = usableSort.length && range.length === 0 ? [...eq, ...usableSort] : [...eq, ...range]
    if (keyCols.length === 0) return

    const rows = tinfo?.rows ?? n.rowsRead ?? null
    if (rows !== null && rows < SMALL_TABLE) { notes.push(`${label} is small (about ${fmtN(rows)} rows): reading all of it is cheap, so no index is suggested`); return }
    const existing = tinfo ? covered(tinfo.indexes, eq, range.length ? range : usableSort.map(s => s.replace(/ DESC$/, ''))) : null
    if (existing) {
      notes.push(`${label}: an index on (${existing.join(', ')}) exists but wasn't used; the planner expected to read much of the table anyway, or its statistics are out of date (ANALYZE ${label})`)
      return
    }
    const key = `${relKey(rel.schema, rel.table)}(${keyCols.join(',').toLowerCase()})`
    if (seen.has(key)) return
    seen.add(key)
    const share = total > 0 ? ((plan.analyzed ? n.totalMs : n.totalCost) ?? 0) / total : 0
    const what = [
      eq.length ? `filters on ${eq.join(', ')}` : '',
      range.length ? `${eq.length ? 'and ' : 'filters on a range of '}${range.join(', ')}` : '',
      usableSort.length && range.length === 0 ? `${eq.length ? 'then ' : ''}sorts by ${usableSort.join(', ')} for a LIMIT` : '',
    ].filter(Boolean).join(' ')
    suggestions.push({
      table: label,
      columns: keyCols,
      sql: createIndexSql(plan.engine, rel.schema, rel.table, keyCols),
      reason: `A full scan of ${label}${rows !== null ? ` (${plan.analyzed ? 'read' : 'about'} ${fmtN(rows)} rows)` : ''} ${what}${share >= 0.05 ? `; ${Math.round(share * 100)}% of the ${plan.analyzed ? 'time' : 'cost'}` : ''}.`,
      priority: (rows ?? 0) >= 100_000 || share >= 0.3 ? 'high' : 'medium',
      nodeId: n.id,
    })
  }
  visit(plan.root, [])
  suggestions.sort((a, b) => (a.priority === b.priority ? 0 : a.priority === 'high' ? -1 : 1))
  return { suggestions, notes }
}

// The step that takes the most time (or cost), for highlighting
export function hottestNode(plan: ExplainPlan): string | null {
  let best: PlanNode | null = null
  const metric = (n: PlanNode) => (plan.analyzed ? n.selfMs : n.selfCost) ?? 0
  const walk = (n: PlanNode) => { if (n.id !== 'root' && (!best || metric(n) > metric(best))) best = n; n.children.forEach(walk) }
  walk(plan.root)
  return best && metric(best) > 0 ? (best as PlanNode).id : null
}
