// Safe Run: queries that change data run inside a transaction and wait for Commit or Roll back,
// and some statements are checked before they run at all (an UPDATE/DELETE without WHERE, MySQL
// DDL that commits on its own). This file classifies statements; the query tab does the running.

export type SqlDialect = 'postgres' | 'mysql' | 'sqlite'

export interface StatementInfo {
  kind: 'read' | 'dml' | 'ddl' | 'other'
  verb: string           // first keyword, uppercased (for WITH: the writing verb inside, if any)
  table?: string         // target of INSERT/UPDATE/DELETE/TRUNCATE/DROP/ALTER, as written
  missingWhere: boolean  // UPDATE or DELETE with no WHERE: changes every row
}

const READ = new Set(['SELECT', 'SHOW', 'EXPLAIN', 'VALUES', 'TABLE', 'DESCRIBE', 'DESC', 'FETCH'])
const DML = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE', 'UPSERT', 'COPY', 'LOAD'])
const DDL = new Set(['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME', 'COMMENT', 'GRANT', 'REVOKE', 'REINDEX', 'CLUSTER', 'VACUUM'])

// The statement with string literals, quoted identifiers and comments blanked out, so keyword
// checks only see SQL
export function codeOnly(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === '-' && next === '-') { const end = sql.indexOf('\n', i); const stop = end < 0 ? sql.length : end; out += ' '.repeat(stop - i); i = stop; continue }
    if (ch === '#') { const end = sql.indexOf('\n', i); const stop = end < 0 ? sql.length : end; out += ' '.repeat(stop - i); i = stop; continue }
    if (ch === '/' && next === '*') { const end = sql.indexOf('*/', i + 2); const stop = end < 0 ? sql.length : end + 2; out += ' '.repeat(stop - i); i = stop; continue }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === '\\' && ch !== '"') { j += 2; continue }
        if (sql[j] === ch) { if (sql[j + 1] === ch) { j += 2; continue } j++; break }
        j++
      }
      // quoted identifiers keep a placeholder name so "table" positions still parse
      out += ch === "'" ? ' '.repeat(j - i) : 'q' + ' '.repeat(Math.max(0, j - i - 1))
      i = j
      continue
    }
    if (ch === '$') {
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i, i + 64))
      if (m) { const close = sql.indexOf(m[0], i + m[0].length); const stop = close < 0 ? sql.length : close + m[0].length; out += ' '.repeat(stop - i); i = stop; continue }
    }
    out += ch
    i++
  }
  return out
}

const TARGET: Record<string, RegExp> = {
  INSERT: /^\s*INSERT\s+(?:IGNORE\s+)?INTO\s+([^\s(]+)/i,
  REPLACE: /^\s*REPLACE\s+(?:INTO\s+)?([^\s(]+)/i,
  UPDATE: /^\s*UPDATE\s+(?:ONLY\s+)?(?:LOW_PRIORITY\s+)?(?:IGNORE\s+)?([^\s(]+)/i,
  DELETE: /^\s*DELETE\s+(?:LOW_PRIORITY\s+)?(?:QUICK\s+)?(?:IGNORE\s+)?FROM\s+(?:ONLY\s+)?([^\s(]+)/i,
  TRUNCATE: /^\s*TRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?([^\s(,;]+)/i,
  DROP: /^\s*DROP\s+(?:TABLE|VIEW|MATERIALIZED\s+VIEW|SCHEMA|DATABASE|INDEX|SEQUENCE|FUNCTION|PROCEDURE|TYPE)\s+(?:IF\s+EXISTS\s+)?([^\s(,;]+)/i,
  ALTER: /^\s*ALTER\s+(?:TABLE|VIEW|SCHEMA|DATABASE|INDEX|SEQUENCE|TYPE)\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([^\s(,;]+)/i,
}

export function classifyStatement(sql: string): StatementInfo {
  const code = codeOnly(sql)
  const first = (/^\s*([A-Za-z]+)/.exec(code)?.[1] ?? '').toUpperCase()
  let verb = first
  let body = sql
  // WITH … INSERT/UPDATE/DELETE writes; a plain WITH … SELECT reads
  if (first === 'WITH') {
    const writing = /\b(INSERT|UPDATE|DELETE|MERGE)\b/i.exec(code)
    if (!writing) return { kind: 'read', verb: 'WITH', missingWhere: false }
    verb = writing[1].toUpperCase()
    body = sql.slice(writing.index)
  }
  const kind: StatementInfo['kind'] = READ.has(verb) ? 'read' : DML.has(verb) ? 'dml' : DDL.has(verb) ? 'ddl' : 'other'
  const bodyCode = codeOnly(body)
  // Found on the code-only text, read from the original (quoted names keep their spaces)
  const target = TARGET[verb] ? new RegExp(TARGET[verb].source, 'id').exec(bodyCode) : null
  const table = target?.indices?.[1] ? readName(body, target.indices[1][0]) : undefined
  const missingWhere = (verb === 'UPDATE' || verb === 'DELETE') && !/\bWHERE\b/i.test(bodyCode)
  return { kind, verb, table, missingWhere }
}

// A possibly qualified, possibly quoted name starting at `start`: schema."My Table"
function readName(sql: string, start: number): string {
  let i = start
  let name = ''
  for (;;) {
    const ch = sql[i]
    if (ch === '"' || ch === '`') {
      let j = i + 1
      while (j < sql.length && !(sql[j] === ch && sql[j + 1] !== ch)) j += sql[j] === ch ? 2 : 1
      name += sql.slice(i, j + 1)
      i = j + 1
    } else {
      const m = /^[^\s(,;."`]+/.exec(sql.slice(i))
      if (!m) break
      name += m[0]
      i += m[0].length
    }
    if (sql[i] !== '.') break
    name += '.'
    i++
  }
  return name
}

export const PREVIEW_ROWS = 200
export const PREVIEW_TOTAL_COLUMN = 'quence_total'

// PostgreSQL: runs an INSERT/UPDATE/DELETE as a data-modifying CTE, so the rows it touched come
// back (at most PREVIEW_ROWS of them, plus the exact total in PREVIEW_TOTAL_COLUMN) while the
// statement itself still runs to completion. Statements starting with WITH, or already saying
// RETURNING, run as they are.
export function previewWrap(sql: string, info: StatementInfo): string {
  if (!['INSERT', 'UPDATE', 'DELETE'].includes(info.verb)) return sql
  const code = codeOnly(sql)
  if (!code.trimStart().toUpperCase().startsWith(info.verb) || /\bRETURNING\b/i.test(code)) return sql
  const body = sql.replace(/;\s*$/, '').trimEnd()
  return `WITH quence_changed AS (\n${body}\nRETURNING *\n) SELECT *, count(*) OVER () AS ${PREVIEW_TOTAL_COLUMN} FROM quence_changed LIMIT ${PREVIEW_ROWS}`
}

// Statements that can't be undone once run: MySQL commits DDL immediately, even in a transaction
export function cannotRollBack(dialect: SqlDialect, info: StatementInfo): boolean {
  return dialect === 'mysql' && info.kind === 'ddl'
}

// MongoDB shell code that changes data (Safe Run asks before running it: MongoDB can't hold the
// change for review the way a SQL transaction can)
const MONGO_WRITE = /\.\s*(insert\w*|update\w*|replaceOne|delete\w*|remove|findOneAnd\w+|bulkWrite|drop\w*|rename\w*|create\w*)\s*\(/i
export function mongoScriptWrites(code: string): boolean {
  return MONGO_WRITE.test(codeOnly(code))
}
