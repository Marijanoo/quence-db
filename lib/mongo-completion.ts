// Completion and highlighting for the MongoDB editor: collections after `db.`, collection and
// cursor methods after `db.users.` / `.find().`, `$` operators and stages, and shell
// commands/helpers at the top level.
import { snippetCompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { javascriptLanguage } from '@codemirror/lang-javascript'
import { syntaxTree } from '@codemirror/language'
import { RangeSetBuilder, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view'

function method(name: string, args: string, info: string, boost = 0): Completion {
  const plainArgs = args.replace(/#\{([^}]*)\}/g, '$1')
  return snippetCompletion(`${name}(${args})`, { label: name, type: 'method', detail: `(${plainArgs})`, info, boost })
}

export const DB_METHODS: Completion[] = [
  method('getCollection', '"#{name}"', 'A collection by name. Works for names that are not valid identifiers.', 2),
  method('getCollectionNames', '', 'Names of all collections in this database', 1),
  method('getCollectionInfos', '#{}', 'Collection details, optionally filtered'),
  method('createCollection', '"#{name}"', 'Create a collection'),
  method('dropDatabase', '', 'Drop the current database'),
  method('runCommand', '{ #{ping}: 1 }', 'Run a database command'),
  method('adminCommand', '{ #{serverStatus}: 1 }', 'Run a command against the admin database'),
  method('aggregate', '[#{}]', 'Database-level aggregation (e.g. $currentOp)'),
  method('stats', '', 'Database statistics'),
  method('getName', '', 'Name of the current database'),
  method('getSiblingDB', '"#{name}"', 'Another database on the same connection'),
  method('version', '', 'Server version'),
]

export const COLLECTION_METHODS: Completion[] = [
  method('find', '{#{}}', 'Documents matching a filter. Second argument is a projection.', 5),
  method('findOne', '{#{}}', 'First document matching a filter', 4),
  method('insertOne', '{#{}}', 'Insert one document', 3),
  method('insertMany', '[#{}]', 'Insert several documents', 3),
  method('updateOne', '{#{}}, { $set: {} }', 'Update the first matching document', 3),
  method('updateMany', '{#{}}, { $set: {} }', 'Update all matching documents', 3),
  method('replaceOne', '{#{}}, {}', 'Replace the first matching document'),
  method('deleteOne', '{#{}}', 'Delete the first matching document', 2),
  method('deleteMany', '{#{}}', 'Delete all matching documents', 2),
  method('aggregate', '[#{}]', 'Run an aggregation pipeline', 3),
  method('countDocuments', '{#{}}', 'Number of documents matching a filter', 2),
  method('estimatedDocumentCount', '', 'Fast document count from collection metadata'),
  method('distinct', '"#{field}"', 'Distinct values of a field'),
  method('findOneAndUpdate', '{#{}}, { $set: {} }', 'Update a document and return it'),
  method('findOneAndReplace', '{#{}}, {}', 'Replace a document and return it'),
  method('findOneAndDelete', '{#{}}', 'Delete a document and return it'),
  method('bulkWrite', '[#{}]', 'Several write operations in one call'),
  method('createIndex', '{ #{field}: 1 }', 'Create an index'),
  method('getIndexes', '', 'Indexes of this collection'),
  method('dropIndex', '"#{name}"', 'Drop an index'),
  method('drop', '', 'Drop this collection'),
  method('renameCollection', '"#{newName}"', 'Rename this collection'),
]

export const CURSOR_METHODS: Completion[] = [
  method('sort', '{ #{field}: 1 }', 'Sort ascending (1) or descending (-1)', 3),
  method('limit', '#{10}', 'Return at most n documents', 3),
  method('skip', '#{0}', 'Skip the first n documents', 2),
  method('project', '{ #{field}: 1 }', 'Only return these fields', 1),
  method('count', '', 'Number of matching documents', 1),
  method('toArray', '', 'All documents as an array'),
  method('pretty', '', 'No-op, kept for mongosh compatibility'),
  method('explain', '"#{executionStats}"', 'Query plan'),
  method('hint', '{ #{field}: 1 }', 'Force an index'),
  method('collation', '{ locale: "#{en}" }', 'Language-aware string comparison'),
  method('maxTimeMS', '#{5000}', 'Abort after this many milliseconds'),
  method('batchSize', '#{100}', 'Documents per server round trip'),
  method('map', '#{doc => doc}', 'Transform each document'),
  method('forEach', '#{doc => {}}', 'Run a function for each document'),
  method('next', '', 'Next document'),
  method('hasNext', '', 'Whether more documents remain'),
]

const OPERATOR_GROUPS: [string, string[]][] = [
  ['query', ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$and', '$or', '$nor', '$not', '$exists', '$type', '$regex', '$options', '$expr', '$elemMatch', '$size', '$all', '$text', '$search']],
  ['update', ['$set', '$unset', '$inc', '$mul', '$rename', '$push', '$pull', '$addToSet', '$pop', '$min', '$max', '$currentDate', '$setOnInsert', '$each']],
  ['stage', ['$match', '$group', '$project', '$sort', '$limit', '$skip', '$unwind', '$lookup', '$addFields', '$count', '$facet', '$replaceRoot', '$sample', '$out', '$merge', '$bucket', '$sortByCount']],
  ['accumulator', ['$sum', '$avg', '$first', '$last', '$push', '$addToSet', '$min', '$max', '$count']],
]

export const OPERATORS: Completion[] = (() => {
  const kinds = new Map<string, string[]>()
  for (const [kind, ops] of OPERATOR_GROUPS) {
    for (const op of ops) kinds.set(op, [...(kinds.get(op) ?? []), kind])
  }
  return [...kinds].map(([label, k]) => ({ label, type: 'keyword', detail: k.join(', ') }))
})()

export const TOP_LEVEL: Completion[] = [
  { label: 'db', type: 'variable', detail: 'current database', boost: 5 },
  snippetCompletion('use #{database}', { label: 'use', type: 'keyword', detail: '<database>', info: 'Switch the current database' }),
  { label: 'show dbs', type: 'keyword', info: 'List databases' },
  { label: 'show collections', type: 'keyword', info: 'List collections in the current database' },
  method('ObjectId', '"#{}"', 'An ObjectId, new or from a 24-character hex string'),
  method('ISODate', '"#{}"', 'A date from an ISO-8601 string (now when empty)'),
  method('NumberInt', '#{0}', '32-bit integer'),
  method('NumberLong', '"#{0}"', '64-bit integer'),
  method('NumberDecimal', '"#{0}"', '128-bit decimal'),
  method('UUID', '"#{}"', 'A UUID, new or from a string'),
  method('Timestamp', '#{0}, 0', 'BSON timestamp (seconds, increment)'),
  { label: 'const', type: 'keyword' },
  { label: 'let', type: 'keyword' },
  { label: 'await', type: 'keyword' },
]

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

export function collectionOptions(collections: string[]): Completion[] {
  return collections.map(name => IDENTIFIER.test(name)
    ? { label: name, type: 'class', detail: 'collection', boost: 10 }
    : { label: name, type: 'class', detail: 'collection', boost: 10, apply: `getCollection(${JSON.stringify(name)})` })
}

// What the text before a `.` refers to: the database, a collection, or a cursor/result.
export function memberTarget(before: string): 'db' | 'collection' | 'cursor' | null {
  if (/(^|[^\w$.])db\s*$/.test(before)) return 'db'
  if (/(^|[^\w$.])db\s*(\.\s*[\w$]+|\[[^\]]*\])\s*$/.test(before)) return 'collection'
  if (/\.\s*getCollection\s*\([^()]*\)\s*$/.test(before)) return 'collection'
  if (/\)\s*$/.test(before)) return 'cursor'
  return null
}

export function mongoCompletionSource(collections: string[]) {
  const dbOptions = [...collectionOptions(collections), ...DB_METHODS]
  return (context: CompletionContext): CompletionResult | null => {
    const node = syntaxTree(context.state).resolveInner(context.pos, -1)
    if (/Comment/.test(node.name)) return null

    // Operators also complete inside quotes: { "$set": ... }
    const op = context.matchBefore(/\$\w*/)
    if (op) return { from: op.from, options: OPERATORS, validFor: /^\$\w*$/ }
    if (node.name === 'String' || node.name === 'TemplateString') return null

    const word = context.matchBefore(/[\w$]*/)
    if (!word) return null
    const before = context.state.sliceDoc(Math.max(0, word.from - 500), word.from)
    if (before.endsWith('.')) {
      const target = memberTarget(before.slice(0, -1))
      const options = target === 'db' ? dbOptions
        : target === 'collection' ? COLLECTION_METHODS
        : target === 'cursor' ? CURSOR_METHODS
        : null
      return options ? { from: word.from, options, validFor: /^[\w$]*$/ } : null
    }
    if (word.from === word.to && !context.explicit) return null
    return { from: word.from, options: TOP_LEVEL, validFor: /^[\w$]*$/ }
  }
}

// ── Highlighting ──────────────────────────────────────────────────────────────
// Plain JavaScript highlighting leaves `db`, method names and `$` operators as ordinary text, so
// they are marked here and colored with the SQL palette (see quenceTheme): shell commands like
// keywords, collections and helpers like types, operators like operators.

export type MongoTokenKind = 'keyword' | 'type' | 'operator'

const METHOD_NAMES = new Set([...DB_METHODS, ...COLLECTION_METHODS, ...CURSOR_METHODS].map(c => c.label))
const HELPER_NAMES = new Set(['ObjectId', 'ObjectID', 'ISODate', 'NumberInt', 'NumberLong', 'NumberDecimal', 'UUID', 'Timestamp', 'BinData', 'MinKey', 'MaxKey'])
const QUOTED_OPERATOR = /^(["'`])\$\w+\1$/
const SHELL_COMMAND_LINE = /^(\s*)(use|show)\b(?=\s+\S)/

function followedByCall(state: EditorState, pos: number): boolean {
  return /^\s*\(/.test(state.sliceDoc(pos, Math.min(pos + 40, state.doc.length)))
}

export function mongoTokenRanges(state: EditorState, from: number, to: number): { from: number; to: number; kind: MongoTokenKind }[] {
  const ranges: { from: number; to: number; kind: MongoTokenKind }[] = []
  syntaxTree(state).iterate({
    from, to,
    enter: ({ name, from: start, to: end, node }) => {
      const text = state.sliceDoc(start, end)
      if (name === 'VariableName') {
        if (text === 'db') ranges.push({ from: start, to: end, kind: 'keyword' })
        else if (HELPER_NAMES.has(text) && followedByCall(state, end)) ranges.push({ from: start, to: end, kind: 'type' })
      } else if (name === 'PropertyName') {
        const object = node.parent?.name === 'MemberExpression' ? node.parent.firstChild : null
        const onDb = object?.name === 'VariableName' && state.sliceDoc(object.from, object.to) === 'db'
        if (METHOD_NAMES.has(text) && followedByCall(state, end)) ranges.push({ from: start, to: end, kind: 'keyword' })
        else if (onDb) ranges.push({ from: start, to: end, kind: 'type' })
      } else if (name === 'PropertyDefinition') {
        if (text.startsWith('$')) ranges.push({ from: start, to: end, kind: 'operator' })
      } else if (name === 'String' && node.parent?.name === 'Property' && QUOTED_OPERATOR.test(text)
        && /^\s*:/.test(state.sliceDoc(end, Math.min(end + 40, state.doc.length)))) {
        // A quoted key ({ "$or": ... }); a value like "$age" is a field path and stays a string
        ranges.push({ from: start, to: end, kind: 'operator' })
      }
    },
  })
  // `use <db>` / `show <what>` are shell syntax, not JavaScript, so the parser can't tag them
  for (let pos = from; pos <= to;) {
    const line = state.doc.lineAt(pos)
    const m = SHELL_COMMAND_LINE.exec(line.text)
    if (m) {
      const start = line.from + m[1].length
      ranges.push({ from: start, to: start + m[2].length, kind: 'keyword' })
    }
    pos = line.to + 1
  }
  return ranges.sort((a, b) => a.from - b.from)
}

const MONGO_MARKS: Record<MongoTokenKind, Decoration> = {
  keyword: Decoration.mark({ class: 'cm-mongo-keyword' }),
  type: Decoration.mark({ class: 'cm-mongo-type' }),
  operator: Decoration.mark({ class: 'cm-mongo-operator' }),
}

function buildMongoDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    for (const r of mongoTokenRanges(view.state, from, to)) builder.add(r.from, r.to, MONGO_MARKS[r.kind])
  }
  return builder.finish()
}

const mongoHighlighter = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = buildMongoDecorations(view) }
  update(u: ViewUpdate) {
    if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
      this.decorations = buildMongoDecorations(u.view)
    }
  }
}, { decorations: v => v.decorations })

// Language + completion for the MongoDB editor. Only JavaScript parsing is taken from
// lang-javascript: its generic JS completions would crowd out the shell ones.
export function mongoEditorLanguage(collections: string[]): Extension {
  return [
    javascriptLanguage,
    javascriptLanguage.data.of({ autocomplete: mongoCompletionSource(collections) }),
    mongoHighlighter,
  ]
}
