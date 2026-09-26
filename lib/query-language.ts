export type DbType = 'postgres' | 'mysql' | 'mongodb' | 'sqlite' | 'redis'

const DB_LABELS: Record<DbType, string> = { postgres: 'PostgreSQL', mysql: 'MySQL', mongodb: 'MongoDB', sqlite: 'SQLite', redis: 'Redis' }

// Statements that can only be SQL. `use` and `show` are left out: mongosh has them too.
const SQL_START = /^(select|insert|update|delete|with|create|alter|drop|truncate|explain|grant|revoke|begin|commit|rollback|describe|desc|call|replace|merge|vacuum|analyze|copy|values|table|lock|refresh|reindex|cluster|savepoint|release)\b/i

// `db.users.find()`, `db["users"]`, `show dbs`, or a script that declares variables and then uses `db.`.
const MONGO_START = /^(db\s*[.[]|show\s+(dbs|collections)\b)/i
const MONGO_SCRIPT = /^(const|let|var)\s[\s\S]*\bdb\s*[.[]/

// Drops leading whitespace and comments (SQL `--`/`#`, JS `//`, and block comments).
export function stripLeadingComments(text: string): string {
  let rest = text
  for (;;) {
    const trimmed = rest.replace(/^\s+/, '')
    const line = /^(--|\/\/|#)[^\n]*(\n|$)/.exec(trimmed)
    if (line) { rest = trimmed.slice(line[0].length); continue }
    if (trimmed.startsWith('/*')) {
      const end = trimmed.indexOf('*/', 2)
      rest = end === -1 ? '' : trimmed.slice(end + 2)
      continue
    }
    return trimmed
  }
}

export function looksLikeSql(text: string): boolean {
  return SQL_START.test(stripLeadingComments(text))
}

export function looksLikeMongoShell(text: string): boolean {
  const body = stripLeadingComments(text)
  return MONGO_START.test(body) || MONGO_SCRIPT.test(body)
}

// Returns an error message when the query is written for a different kind of database than the
// connection it would run on, or null when it can be sent.
export function queryLanguageMismatch(dbType: DbType | undefined, text: string): string | null {
  if (!dbType) return null
  if (dbType === 'mongodb') {
    return looksLikeSql(text)
      ? 'This is a MongoDB connection, so SQL queries can\'t run here. Use MongoDB shell syntax instead, e.g. db.users.find({ age: { $gt: 18 } })'
      : null
  }
  return looksLikeMongoShell(text)
    ? `This is a ${DB_LABELS[dbType]} connection, so MongoDB shell commands can't run here. Use SQL instead, e.g. SELECT * FROM users LIMIT 10;`
    : null
}
