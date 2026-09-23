// Function suggestions for the SQL editor: the connected database's own functions plus common
// built-ins. Tables and columns come from CodeMirror's schema completion (see buildSqlNamespace).
import { snippetCompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import { sql, MySQL, PostgreSQL, type SQLNamespace } from '@codemirror/lang-sql'
import { Facet, RangeSetBuilder, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view'

// ── Keyword ranking ───────────────────────────────────────────────────────────

// Most used first. Everything not listed ranks below tables, columns and functions.
const COMMON_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'JOIN', 'LEFT', 'ON', 'AS', 'ORDER', 'BY', 'GROUP', 'LIMIT', 'OR', 'NOT', 'NULL', 'IS', 'IN',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'DISTINCT', 'INNER', 'OUTER', 'RIGHT', 'FULL', 'CROSS', 'HAVING', 'OFFSET',
  'ASC', 'DESC', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'LIKE', 'ILIKE', 'BETWEEN', 'EXISTS', 'UNION', 'ALL', 'WITH', 'RETURNING',
  'TRUE', 'FALSE', 'CREATE', 'TABLE', 'ALTER', 'DROP', 'INDEX', 'VIEW', 'DEFAULT', 'PRIMARY', 'KEY', 'REFERENCES', 'CAST', 'USING',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'EXPLAIN', 'ANALYZE', 'TRUNCATE', 'CONFLICT', 'DO', 'NOTHING', 'OVER', 'PARTITION', 'FILTER', 'ANY',
]
const KEYWORD_RANK = new Map(COMMON_KEYWORDS.map((k, i) => [k, i]))

export function keywordBoost(label: string, type: string): number {
  const rank = KEYWORD_RANK.get(label.toUpperCase())
  if (rank !== undefined) return 20 - (rank * 15) / (COMMON_KEYWORDS.length - 1) // 20 … 5, strictly by rank
  return type === 'type' ? -5 : -10
}

// ── Schema-aware highlighting ─────────────────────────────────────────────────
// SQL dialects treat many common names (id, name, type, user, value, data, …) as keywords, so
// columns and tables would be colored like SELECT. Names that exist in the connected schema are
// recolored: tables/views/schemas like types, columns like plain text.

export interface SqlNames { tables: Set<string>; columns: Set<string> }

export function namesFromNamespace(ns: SQLNamespace | undefined): SqlNames {
  const names: SqlNames = { tables: new Set(), columns: new Set() }
  if (!ns || typeof ns !== 'object' || Array.isArray(ns)) return names
  for (const [schemaName, tables] of Object.entries(ns as Record<string, unknown>)) {
    names.tables.add(schemaName.toLowerCase())
    if (!tables || typeof tables !== 'object' || Array.isArray(tables)) continue
    for (const [table, columns] of Object.entries(tables as Record<string, unknown>)) {
      names.tables.add(table.toLowerCase())
      if (Array.isArray(columns)) for (const c of columns) if (typeof c === 'string') names.columns.add(c.toLowerCase())
    }
  }
  return names
}

const sqlNamesFacet = Facet.define<SqlNames, SqlNames>({
  combine: values => values[values.length - 1] ?? { tables: new Set(), columns: new Set() },
})

const RECOLORED_NODES = new Set(['Keyword', 'Identifier', 'Type'])

export function semanticRanges(state: EditorState, from: number, to: number): { from: number; to: number; kind: 'table' | 'column' }[] {
  const names = state.facet(sqlNamesFacet)
  const ranges: { from: number; to: number; kind: 'table' | 'column' }[] = []
  if (names.tables.size === 0 && names.columns.size === 0) return ranges
  syntaxTree(state).iterate({
    from, to,
    enter: node => {
      if (!RECOLORED_NODES.has(node.name)) return
      const word = state.sliceDoc(node.from, node.to).toLowerCase()
      if (names.tables.has(word)) ranges.push({ from: node.from, to: node.to, kind: 'table' })
      else if (names.columns.has(word)) ranges.push({ from: node.from, to: node.to, kind: 'column' })
    },
  })
  return ranges
}

const tableMark = Decoration.mark({ class: 'cm-sql-table' })
const columnMark = Decoration.mark({ class: 'cm-sql-column' })

function buildSemanticDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    for (const r of semanticRanges(view.state, from, to)) builder.add(r.from, r.to, r.kind === 'table' ? tableMark : columnMark)
  }
  return builder.finish()
}

const semanticHighlighter = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = buildSemanticDecorations(view) }
  update(u: ViewUpdate) {
    if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)
      || u.startState.facet(sqlNamesFacet) !== u.state.facet(sqlNamesFacet)) {
      this.decorations = buildSemanticDecorations(u.view)
    }
  }
}, { decorations: v => v.decorations })

export interface FunctionInfo { schema: string; name: string; arguments: string }

const PG_BUILTINS = [
  'count', 'sum', 'avg', 'min', 'max', 'coalesce', 'nullif', 'greatest', 'least',
  'now', 'current_date', 'date_trunc', 'date_part', 'extract', 'age', 'to_char', 'to_date', 'to_timestamp', 'make_interval',
  'lower', 'upper', 'length', 'trim', 'substring', 'replace', 'concat', 'concat_ws', 'split_part', 'left', 'right', 'position', 'regexp_replace', 'format',
  'round', 'ceil', 'floor', 'abs', 'random',
  'array_agg', 'string_agg', 'unnest', 'array_length', 'array_to_string', 'cardinality',
  'jsonb_build_object', 'jsonb_agg', 'jsonb_array_elements', 'jsonb_each', 'jsonb_set', 'json_build_object', 'to_jsonb', 'row_to_json',
  'row_number', 'rank', 'dense_rank', 'lag', 'lead', 'first_value', 'last_value',
  'gen_random_uuid', 'generate_series', 'exists',
]

const MYSQL_BUILTINS = [
  'count', 'sum', 'avg', 'min', 'max', 'coalesce', 'ifnull', 'nullif', 'if', 'greatest', 'least',
  'now', 'curdate', 'date', 'date_format', 'date_add', 'date_sub', 'datediff', 'timestampdiff', 'year', 'month', 'day', 'unix_timestamp', 'from_unixtime',
  'lower', 'upper', 'length', 'char_length', 'trim', 'substring', 'replace', 'concat', 'concat_ws', 'left', 'right', 'locate',
  'round', 'ceil', 'floor', 'abs', 'rand',
  'group_concat', 'json_object', 'json_arrayagg', 'json_extract', 'json_unquote',
  'row_number', 'rank', 'dense_rank', 'lag', 'lead', 'uuid',
]

// Functions in these schemas resolve without a schema prefix
export function visibleFunctions(functions: FunctionInfo[], defaultSchema: string | undefined): FunctionInfo[] {
  const visible = new Set(['public', ...(defaultSchema ? [defaultSchema] : [])])
  return functions.filter(f => visible.has(f.schema))
}

export function functionOptions(functions: FunctionInfo[], dialect: 'postgres' | 'mysql'): Completion[] {
  const seen = new Set<string>()
  const options: Completion[] = []
  for (const f of functions) {
    const key = `${f.name}(${f.arguments})`
    if (seen.has(key)) continue
    seen.add(key)
    options.push(snippetCompletion(`${f.name}(#{})`, {
      label: f.name,
      type: 'function',
      detail: `(${f.arguments})`,
      info: `${f.schema}.${f.name}(${f.arguments})`,
      boost: 2,
    }))
  }
  const userNames = new Set(functions.map(f => f.name))
  for (const name of dialect === 'mysql' ? MYSQL_BUILTINS : PG_BUILTINS) {
    if (userNames.has(name)) continue
    options.push(snippetCompletion(`${name}(#{})`, { label: name, type: 'function', detail: 'built-in', boost: -1 }))
  }
  return options
}

export interface SqlEditorLanguageConfig {
  dialect: 'postgres' | 'mysql'
  schema?: SQLNamespace      // schema → table → columns
  defaultSchema?: string     // whose tables are suggested without a "schema." prefix
  defaultTable?: string
  functions?: FunctionInfo[]
}

// Language + completion setup for the SQL editor. Without `defaultSchema` the schema completion
// only offers schema names at the top level, so tables would need a "schema." prefix to show up.
export function sqlEditorLanguage(config: SqlEditorLanguageConfig): Extension {
  const dialect = config.dialect === 'mysql' ? MySQL : PostgreSQL
  const options = functionOptions(visibleFunctions(config.functions ?? [], config.defaultSchema), config.dialect)
  return [
    sql({
      dialect, schema: config.schema, defaultSchema: config.defaultSchema, defaultTable: config.defaultTable, upperCaseKeywords: true,
      keywordCompletion: (label, type) => ({ label, type, boost: keywordBoost(label, type) }),
    }),
    dialect.language.data.of({ autocomplete: functionCompletionSource(options) }),
    sqlNamesFacet.of(namesFromNamespace(config.schema)),
    semanticHighlighter,
  ]
}

const SKIP_NODES = /String|Comment|QuotedIdentifier/

export function functionCompletionSource(options: Completion[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/[\w$]*/)
    if (!word || (word.from === word.to && !context.explicit)) return null
    // "schema.table" and "alias.column" are left to the schema completion
    if (context.state.sliceDoc(word.from - 1, word.from) === '.') return null
    const node = syntaxTree(context.state).resolveInner(context.pos, -1)
    if (SKIP_NODES.test(node.name)) return null
    return { from: word.from, options, validFor: /^[\w$]*$/ }
  }
}
