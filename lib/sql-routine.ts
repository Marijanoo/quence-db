// What a query does to the database's objects: whether it changes the schema (so the sidebar and
// editor suggestions need a refresh), and whether it is one CREATE FUNCTION / PROCEDURE (saving it
// turns the query tab into that function's tab).

// Leading whitespace and comments
function stripLeading(sql: string): string {
  let s = sql
  for (;;) {
    const next = s.replace(/^\s+/, '').replace(/^--[^\n]*(\n|$)/, '').replace(/^\/\*[\s\S]*?\*\//, '')
    if (next === s) return s
    s = next
  }
}

const SCHEMA_CHANGE = /^(CREATE|ALTER|DROP|COMMENT\s+ON|RENAME)\b/i

export function changesSchema(statements: string[]): boolean {
  return statements.some(s => SCHEMA_CHANGE.test(stripLeading(s)))
}

export interface CreatedRoutine {
  kind: 'function' | 'procedure'
  schema?: string   // as written; unqualified names resolve through the search path
  name: string
}

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)`
const CREATE_ROUTINE = new RegExp(
  String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\s+(?:(${IDENT})\s*\.\s*)?(${IDENT})\s*\(`, 'i',
)

// Postgres folds unquoted names to lower case; quoted ones keep their spelling
function identName(ident: string): string {
  return ident.startsWith('"') ? ident.slice(1, -1).replace(/""/g, '"') : ident.toLowerCase()
}

// The routine a single CREATE [OR REPLACE] FUNCTION / PROCEDURE statement defines, else null
export function parseCreateRoutine(statement: string): CreatedRoutine | null {
  const m = CREATE_ROUTINE.exec(stripLeading(statement))
  if (!m) return null
  return {
    kind: m[1].toLowerCase() as CreatedRoutine['kind'],
    ...(m[2] ? { schema: identName(m[2]) } : {}),
    name: identName(m[3]),
  }
}
