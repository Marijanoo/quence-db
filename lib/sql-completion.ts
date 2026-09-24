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

// ── Go to definition (Ctrl+click) ─────────────────────────────────────────────
// A table/view or function name in the editor resolves to the object it names in the connected
// database; Ctrl+hover underlines it and Ctrl+click opens it.

export type SqlTarget =
  | { kind: 'table'; schema: string; name: string }
  | { kind: 'function'; schema: string; name: string; arguments: string }

export interface SqlReference { from: number; to: number; target: SqlTarget }

interface SqlObjects {
  tables: Map<string, string[]> // schema → table names
  functions: FunctionInfo[]
  defaultSchema?: string
}

const sqlObjectsFacet = Facet.define<SqlObjects, SqlObjects>({
  combine: values => values[values.length - 1] ?? { tables: new Map(), functions: [] },
})

function objectsFromConfig(schema: SQLNamespace | undefined, functions: FunctionInfo[], defaultSchema: string | undefined): SqlObjects {
  const tables = new Map<string, string[]>()
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    for (const [schemaName, t] of Object.entries(schema as Record<string, unknown>)) {
      tables.set(schemaName, t && typeof t === 'object' && !Array.isArray(t) ? Object.keys(t) : [])
    }
  }
  return { tables, functions, defaultSchema }
}

// Exact spelling wins, otherwise a case-insensitive match (unquoted names fold case)
function findName<T>(items: T[], name: string, key: (item: T) => string, quoted: boolean): T[] {
  const exact = items.filter(i => key(i) === name)
  if (exact.length > 0 || quoted) return exact
  const lower = name.toLowerCase()
  return items.filter(i => key(i).toLowerCase() === lower)
}

function findSchema(objects: SqlObjects, name: string, quoted: boolean): string | undefined {
  return findName([...objects.tables.keys()], name, s => s, quoted)[0]
}

// Unqualified names: the editor's schema, then public, then a schema where the name is unique
function pickBySchema<T>(matches: T[], schemaOf: (m: T) => string, defaultSchema: string | undefined): T | undefined {
  for (const preferred of [defaultSchema, 'public']) {
    const hit = preferred ? matches.find(m => schemaOf(m) === preferred) : undefined
    if (hit) return hit
  }
  return new Set(matches.map(schemaOf)).size === 1 ? matches[0] : undefined
}

function resolveTable(objects: SqlObjects, schema: string | undefined, name: string, quoted: boolean): SqlTarget | undefined {
  const all = [...objects.tables.entries()].flatMap(([s, names]) => names.map(n => ({ schema: s, name: n })))
  const matches = findName(schema ? all.filter(t => t.schema === schema) : all, name, t => t.name, quoted)
  const hit = schema ? matches[0] : pickBySchema(matches, t => t.schema, objects.defaultSchema)
  return hit && { kind: 'table', ...hit }
}

function resolveFunction(objects: SqlObjects, schema: string | undefined, name: string, quoted: boolean): SqlTarget | undefined {
  const pool = schema ? objects.functions.filter(f => f.schema === schema) : objects.functions
  const matches = findName(pool, name, f => f.name, quoted)
  const hit = schema ? matches[0] : pickBySchema(matches, f => f.schema, objects.defaultSchema)
  return hit && { kind: 'function', schema: hit.schema, name: hit.name, arguments: hit.arguments }
}

const WORD_CHAR = /[\w$]/

// A name part around `pos`: a bare word, or a "quoted" / `quoted` identifier
interface NamePart { from: number; to: number; name: string; quoted: boolean }

function namePartAt(text: string, offset: number): NamePart | null {
  // Quoted identifier containing the position
  for (const q of ['"', '`']) {
    const open = text.lastIndexOf(q, offset - 1)
    if (open === -1) continue
    const close = text.indexOf(q, open + 1)
    if (close !== -1 && close >= offset && !text.slice(open + 1, close).includes('\n')) {
      // Make sure `open` is an opening quote: an even number of quotes precede it
      const before = text.slice(0, open).split(q).length - 1
      if (before % 2 === 0) return { from: open, to: close + 1, name: text.slice(open + 1, close), quoted: true }
    }
  }
  let from = offset, to = offset
  while (from > 0 && WORD_CHAR.test(text[from - 1])) from--
  while (to < text.length && WORD_CHAR.test(text[to])) to++
  if (from === to || /^\d/.test(text.slice(from, to))) return null
  return { from, to, name: text.slice(from, to), quoted: false }
}

// The name part directly before a "." that precedes `pos` (the qualifier of `schema.name`)
function qualifierBefore(text: string, pos: number): NamePart | null {
  let i = pos
  while (i > 0 && text[i - 1] === ' ') i--
  if (text[i - 1] !== '.') return null
  i--
  while (i > 0 && text[i - 1] === ' ') i--
  if (i === 0) return null
  return namePartAt(text, text[i - 1] === '"' || text[i - 1] === '`' ? i - 1 : i)
}

const NON_CODE_NODES = /String|Comment/

export function sqlReferenceAt(state: EditorState, pos: number): SqlReference | null {
  const objects = state.facet(sqlObjectsFacet)
  if (objects.tables.size === 0 && objects.functions.length === 0) return null
  const node = syntaxTree(state).resolveInner(pos, 1)
  if (NON_CODE_NODES.test(node.name)) return null

  const line = state.doc.lineAt(pos)
  const text = line.text
  const part = namePartAt(text, pos - line.from)
  if (!part) return null
  const qualifier = qualifierBefore(text, part.from)
  const rest = text.slice(part.to)
  const isCall = /^\s*\(/.test(rest)
  const qualifiesSomething = /^\s*\.\s*["`\w$]/.test(rest)

  let schema: string | undefined
  if (qualifier) {
    schema = findSchema(objects, qualifier.name, qualifier.quoted)
    if (!schema) return null // alias.column, or a schema we don't know
  }
  if (!qualifier && qualifiesSomething && findSchema(objects, part.name, part.quoted)) return null // the schema in schema.table

  const target = isCall
    ? resolveFunction(objects, schema, part.name, part.quoted) ?? resolveTable(objects, schema, part.name, part.quoted)
    : resolveTable(objects, schema, part.name, part.quoted) ?? resolveFunction(objects, schema, part.name, part.quoted)
  if (!target) return null
  return { from: line.from + part.from, to: line.from + part.to, target }
}

const linkMark = Decoration.mark({ class: 'cm-sql-link' })

// Tracks Ctrl/Cmd and the mouse, underlines the reference under the mouse while the key is held,
// and calls `onNavigate` on Ctrl/Cmd+click
export function sqlNavigation(onNavigate: (target: SqlTarget) => void): Extension {
  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet = Decoration.none
    mod = false
    mouse: { x: number; y: number } | null = null
    link: SqlReference | null = null

    constructor(readonly view: EditorView) {
      window.addEventListener('keydown', this.onKey)
      window.addEventListener('keyup', this.onKey)
      window.addEventListener('blur', this.onBlur)
    }

    onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod !== this.mod) { this.mod = mod; this.refresh() }
    }
    onBlur = () => { this.mod = false; this.refresh() }

    refresh() {
      let link: SqlReference | null = null
      if (this.mod && this.mouse) {
        const pos = this.view.posAtCoords(this.mouse)
        if (pos !== null) {
          const ref = sqlReferenceAt(this.view.state, pos)
          // posAtCoords snaps to the nearest character; only link when the mouse is over the name
          const start = ref && this.view.coordsAtPos(ref.from)
          const end = ref && this.view.coordsAtPos(ref.to, -1)
          if (ref && start && end && this.mouse.y >= start.top && this.mouse.y <= start.bottom
            && (start.top !== end.top || (this.mouse.x >= start.left && this.mouse.x <= end.right))) link = ref
        }
      }
      if (link?.from === this.link?.from && link?.to === this.link?.to) return
      this.link = link
      this.decorations = link ? Decoration.set([linkMark.range(link.from, link.to)]) : Decoration.none
      this.view.dispatch({}) // redraw decorations
    }

    update(u: ViewUpdate) {
      if (this.link && u.docChanged) { this.link = null; this.decorations = Decoration.none }
    }

    destroy() {
      window.removeEventListener('keydown', this.onKey)
      window.removeEventListener('keyup', this.onKey)
      window.removeEventListener('blur', this.onBlur)
    }
  }, {
    decorations: v => v.decorations,
    eventHandlers: {
      mousemove(e) {
        this.mouse = { x: e.clientX, y: e.clientY }
        this.mod = e.ctrlKey || e.metaKey
        if (this.mod || this.link) this.refresh()
      },
      mouseleave() { this.mouse = null; if (this.link) this.refresh() },
      mousedown(e) {
        if (e.button !== 0 || !(e.ctrlKey || e.metaKey)) return false
        this.mouse = { x: e.clientX, y: e.clientY }
        this.mod = true
        this.refresh()
        if (!this.link) return false
        e.preventDefault() // no cursor move or extra selection range
        onNavigate(this.link.target)
        return true
      },
    },
  })
  return plugin
}

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
    sqlObjectsFacet.of(objectsFromConfig(config.schema, config.functions ?? [], config.defaultSchema)),
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
