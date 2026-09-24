import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { CompletionContext } from '@codemirror/autocomplete'
import { sql, PostgreSQL } from '@codemirror/lang-sql'
import {
  functionCompletionSource, functionOptions, keywordBoost, semanticRanges, sqlEditorLanguage, sqlReferenceAt, visibleFunctions,
  type FunctionInfo, type SqlEditorLanguageConfig,
} from './sql-completion'
import type { CompletionResult, CompletionSource } from '@codemirror/autocomplete'

// Every completion the editor would offer at the end of `doc` (all sources, like the popup)
async function editorCompletions(doc: string, config: SqlEditorLanguageConfig) {
  const state = EditorState.create({ doc, extensions: [sqlEditorLanguage(config)] })
  const sources = state.languageDataAt<CompletionSource>('autocomplete', doc.length)
  const results = await Promise.all(sources.map(s => s(new CompletionContext(state, doc.length, false))))
  return results.filter((r): r is CompletionResult => !!r).flatMap(r => r.options.map(o => `${o.type}:${o.label}`))
}

describe('schema-aware highlighting', () => {
  it('marks known tables and columns, including names the dialect treats as keywords', () => {
    const doc = `SELECT id, name, email, "user" FROM app.users WHERE type = 'name' AND status IS NOT NULL`
    const schema = { app: { users: ['id', 'name', 'email', 'type', 'status'] } }
    const state = EditorState.create({ doc, extensions: [sqlEditorLanguage({ dialect: 'postgres', schema, defaultSchema: 'app' })] })
    const marked = semanticRanges(state, 0, doc.length).map(r => `${r.kind}:${doc.slice(r.from, r.to)}`)
    expect(marked).toEqual([
      'column:id', 'column:name', 'column:email', 'table:app', 'table:users', 'column:type', 'column:status',
    ])
  })

  it('marks nothing without schema information', () => {
    const state = EditorState.create({ doc: 'SELECT id FROM users', extensions: [sqlEditorLanguage({ dialect: 'postgres' })] })
    expect(semanticRanges(state, 0, 20)).toEqual([])
  })
})

describe('editor completion setup', () => {
  const schema = { app: { users: ['id', 'email'], orders: ['id', 'user_id'] }, public: { settings: ['key'] } }

  it('suggests tables of the selected schema without a prefix, plus functions', async () => {
    const found = await editorCompletions('SELECT * FROM us', { dialect: 'postgres', schema, defaultSchema: 'app', functions: fns })
    expect(found).toContain('type:users')
    const fnFound = await editorCompletions('SELECT cal', { dialect: 'postgres', schema, defaultSchema: 'app', functions: fns })
    expect(fnFound).toContain('function:calc_total')
  })

  it('suggests columns after a table name and dot', async () => {
    const found = await editorCompletions('SELECT users.', { dialect: 'postgres', schema, defaultSchema: 'app' })
    expect(found).toEqual(expect.arrayContaining(['property:id', 'property:email']))
  })

  it('ranks common keywords first and rare keywords below tables and functions (boost 0 and up)', async () => {
    expect(keywordBoost('SELECT', 'keyword')).toBeGreaterThan(keywordBoost('WHERE', 'keyword'))
    expect(keywordBoost('WHERE', 'keyword')).toBeGreaterThan(keywordBoost('RETURNING', 'keyword'))
    expect(keywordBoost('RETURNING', 'keyword')).toBeGreaterThan(0)
    expect(keywordBoost('SAVEPOINT', 'keyword')).toBeLessThan(0)
    expect(keywordBoost('varchar', 'type')).toBeLessThan(0)
    // The boosts reach the completions the editor shows
    const state = EditorState.create({ doc: 'SE', extensions: [sqlEditorLanguage({ dialect: 'postgres' })] })
    const sources = state.languageDataAt<CompletionSource>('autocomplete', 2)
    const results = await Promise.all(sources.map(s => s(new CompletionContext(state, 2, false))))
    const options = results.filter((r): r is CompletionResult => !!r).flatMap(r => r.options)
    const boostOf = (label: string) => options.find(o => o.label === label)?.boost
    expect(boostOf('SELECT')).toBe(20)
    expect(boostOf('SECURITY')).toBe(-10)
  })

  it('without a default schema only schema names are offered (the old behaviour)', async () => {
    const found = await editorCompletions('SELECT * FROM us', { dialect: 'postgres', schema })
    expect(found).not.toContain('type:users')
  })
})

const fns: FunctionInfo[] = [
  { schema: 'app', name: 'calc_total', arguments: 'order_id integer' },
  { schema: 'public', name: 'slugify', arguments: 'text' },
  { schema: 'other', name: 'hidden_fn', arguments: '' },
  { schema: 'public', name: 'now', arguments: '' },
]

function complete(doc: string, explicit = false) {
  const options = functionOptions(visibleFunctions(fns, 'app'), 'postgres')
  const state = EditorState.create({ doc, extensions: [sql({ dialect: PostgreSQL })] })
  return functionCompletionSource(options)(new CompletionContext(state, doc.length, explicit))
}

describe('function completion', () => {
  it('offers functions from the default schema and public, then built-ins', () => {
    const labels = functionOptions(visibleFunctions(fns, 'app'), 'postgres').map(o => o.label)
    expect(labels.slice(0, 3)).toEqual(['calc_total', 'slugify', 'now'])
    expect(labels).toContain('coalesce')
    expect(labels).not.toContain('hidden_fn')
    expect(labels.filter(l => l === 'now')).toHaveLength(1)
  })

  it('completes a word being typed', () => {
    const result = complete('SELECT calc')
    expect(result?.from).toBe(7)
    expect(result?.options.some(o => o.label === 'calc_total' && o.type === 'function')).toBe(true)
  })

  it('stays quiet after a dot, inside strings and comments, and on empty input unless requested', () => {
    expect(complete('SELECT u.na')).toBeNull()
    expect(complete("SELECT 'cal")).toBeNull()
    expect(complete('-- cal')).toBeNull()
    expect(complete('SELECT ')).toBeNull()
    expect(complete('SELECT ', true)).not.toBeNull()
  })
})

describe('sqlReferenceAt (Ctrl+click navigation)', () => {
  const schema = {
    public: { message: ['id', 'body'], users: ['id'] },
    app: { users: ['id', 'name'], orders: ['id'] },
    audit: { orders: ['id'] },
  }
  const functions: FunctionInfo[] = [
    { schema: 'public', name: 'touch_updated', arguments: '' },
    { schema: 'app', name: 'order_total', arguments: 'order_id integer' },
  ]
  // The reference under the first "|" in `doc` (the marker is removed)
  function refAt(marked: string, defaultSchema = 'public') {
    const pos = marked.indexOf('|')
    const doc = marked.replace('|', '')
    const state = EditorState.create({ doc, extensions: [sqlEditorLanguage({ dialect: 'postgres', schema, defaultSchema, functions })] })
    const ref = sqlReferenceAt(state, pos)
    return ref && { text: doc.slice(ref.from, ref.to), ...ref.target }
  }

  it('resolves table names in the default schema', () => {
    expect(refAt('SELECT * FROM mes|sage')).toEqual({ text: 'message', kind: 'table', schema: 'public', name: 'message' })
    expect(refAt('SELECT * FROM |MESSAGE m')).toMatchObject({ kind: 'table', name: 'message' })
    expect(refAt('SELECT * FROM us|ers', 'app')).toMatchObject({ schema: 'app', name: 'users' })
    expect(refAt('SELECT * FROM us|ers', 'public')).toMatchObject({ schema: 'public', name: 'users' })
  })

  it('uses the schema qualifier, and leaves the schema itself alone', () => {
    expect(refAt('SELECT * FROM app.us|ers')).toEqual({ text: 'users', kind: 'table', schema: 'app', name: 'users' })
    expect(refAt('SELECT * FROM "app"."us|ers"')).toEqual({ text: '"users"', kind: 'table', schema: 'app', name: 'users' })
    expect(refAt('SELECT * FROM a|pp.users')).toBeNull()
    expect(refAt('SELECT * FROM nope.us|ers')).toBeNull()
  })

  it('skips names that are ambiguous or unknown', () => {
    expect(refAt('SELECT * FROM ord|ers')).toBeNull() // app.orders and audit.orders
    expect(refAt('SELECT * FROM ord|ers', 'audit')).toMatchObject({ schema: 'audit' })
    expect(refAt('SELECT * FROM nothing_he|re')).toBeNull()
    expect(refAt('SEL|ECT * FROM message')).toBeNull()
  })

  it('treats alias.column as a column, but table.column qualifies with the table', () => {
    expect(refAt('SELECT m.bo|dy FROM message m')).toBeNull()
    expect(refAt('SELECT mess|age.body FROM message')).toMatchObject({ kind: 'table', name: 'message' })
  })

  it('resolves functions, with their arguments', () => {
    expect(refAt('SELECT touch_up|dated()')).toEqual({ text: 'touch_updated', kind: 'function', schema: 'public', name: 'touch_updated', arguments: '' })
    expect(refAt('SELECT app.order_to|tal(5)')).toMatchObject({ kind: 'function', schema: 'app', arguments: 'order_id integer' })
    expect(refAt('SELECT order_to|tal (5)', 'app')).toMatchObject({ kind: 'function', name: 'order_total' })
  })

  it('ignores strings and comments', () => {
    expect(refAt("SELECT 'mess|age'")).toBeNull()
    expect(refAt('-- from mess|age\nSELECT 1')).toBeNull()
  })
})
