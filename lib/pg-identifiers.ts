// PostgreSQL folds unquoted identifiers to lowercase: SELECT * FROM tableName looks for
// "tablename", so a table created as "tableName" can only be reached quoted. This quotes such
// names before a query runs, but only where the query as typed could not work anyway: the name
// has capitals, an object with exactly that spelling exists, and none with the lowercase one.
// A name right after AS is the user's own alias and is left alone. Strings, comments, $$ bodies
// and already-quoted names are skipped.

const IDENT_START = /[A-Za-z_\u0080-￿]/
const IDENT_PART = /[A-Za-z0-9_$\u0080-￿]/

export interface QuoteResult {
  sql: string
  quoted: string[]   // the names that were quoted, once each
}

// `known` holds the exact names of the schemas, tables, views, columns, functions and types the
// query may refer to
export function quoteMixedCaseIdentifiers(sql: string, known: Set<string>): QuoteResult {
  let out = ''
  let i = 0
  let prevWord = ''     // the last bare word, uppercased (to spot AS)
  const quoted = new Set<string>()
  const n = sql.length

  while (i < n) {
    const ch = sql[i]
    const next = sql[i + 1]

    // -- comment
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      const stop = end < 0 ? n : end
      out += sql.slice(i, stop); i = stop
      continue
    }
    // /* comment */ (PostgreSQL nests them)
    if (ch === '/' && next === '*') {
      let depth = 0
      let j = i
      while (j < n) {
        if (sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2; continue }
        if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2; if (depth === 0) break; continue }
        j++
      }
      out += sql.slice(i, j); i = j
      continue
    }
    // 'string', E'string' (backslash escapes), "quoted identifier"
    if (ch === "'" || ch === '"') {
      const escapes = ch === "'" && /[eE]/.test(sql[i - 1] ?? '') && !IDENT_PART.test(sql[i - 2] ?? '')
      let j = i + 1
      while (j < n) {
        if (escapes && sql[j] === '\\') { j += 2; continue }
        if (sql[j] === ch) { if (sql[j + 1] === ch) { j += 2; continue } j++; break }
        j++
      }
      out += sql.slice(i, j); i = j
      if (ch === '"') prevWord = ''
      continue
    }
    // $tag$ … $tag$
    if (ch === '$' && !IDENT_PART.test(sql[i - 1] ?? '')) {
      const m = /^\$([A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/.exec(sql.slice(i, i + 64))
      if (m) {
        const close = sql.indexOf(m[0], i + m[0].length)
        const stop = close < 0 ? n : close + m[0].length
        out += sql.slice(i, stop); i = stop
        continue
      }
    }
    // a bare word
    if (IDENT_START.test(ch) && !IDENT_PART.test(sql[i - 1] ?? '')) {
      let j = i + 1
      while (j < n && IDENT_PART.test(sql[j])) j++
      const word = sql.slice(i, j)
      const isAlias = prevWord === 'AS'
      // E'…' is a string prefix, not a name
      const isStringPrefix = (word === 'E' || word === 'e') && sql[j] === "'"
      if (!isAlias && !isStringPrefix && word !== word.toLowerCase() && known.has(word) && !known.has(word.toLowerCase())) {
        out += `"${word}"`
        quoted.add(word)
      } else {
        out += word
      }
      prevWord = word.toUpperCase()
      i = j
      continue
    }
    if (!/\s/.test(ch)) prevWord = ''
    out += ch
    i++
  }
  return { sql: out, quoted: [...quoted] }
}
