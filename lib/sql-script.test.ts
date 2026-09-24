import { describe, expect, it } from 'vitest'
import { copyToInsert, decodeCopyField, splitIdentList, splitScript, SqlScriptSplitter, type ScriptDialect, type ScriptItem } from './sql-script'

const statements = (items: ScriptItem[]) => items.filter(i => i.kind === 'statement').map(i => (i as { sql: string }).sql)

function chunked(dialect: ScriptDialect, text: string, size: number): ScriptItem[] {
  const s = new SqlScriptSplitter(dialect)
  const out: ScriptItem[] = []
  for (let i = 0; i < text.length; i += size) out.push(...s.push(text.slice(i, i + size)))
  out.push(...s.end())
  // COPY batches may split differently; merge consecutive batches of the same block
  const merged: ScriptItem[] = []
  for (const item of out) {
    const last = merged[merged.length - 1]
    if (item.kind === 'copy' && last?.kind === 'copy' && last.table === item.table && last.line <= item.line) last.rows.push(...item.rows)
    else merged.push(item.kind === 'copy' ? { ...item, rows: [...item.rows] } : item)
  }
  return merged.map(i => i.kind === 'copy' ? { ...i, line: 0 } : i)
}

const PG_SCRIPT = `-- leading comment
SET search_path = public; /* block /* nested */ comment */
CREATE FUNCTION f() RETURNS text LANGUAGE plpgsql AS $body$
BEGIN
  RETURN 'semi; colon'; -- not a comment end
END $body$;
SELECT 'it''s', E'esc\\'aped;', "we;ird", $$dollar;$$, $1x, 'a--b';
\\restrict abc123
COPY public.users (id, "Full Name", note) FROM stdin;
1\tAnn\t\\N
2\tBob\\tTab\tline\\nbreak
\\.
INSERT INTO t VALUES (1);
SELECT 1`

const MYSQL_SCRIPT = `# comment
/*!40101 SET NAMES utf8mb4 */;
INSERT INTO \`t;x\` VALUES ('it\\'s; \\\\', "dq;\\"x", 1--1);
DELIMITER ;;
CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END ;;
DELIMITER ;
SELECT 'done';`

describe('SqlScriptSplitter', () => {
  it('splits PostgreSQL scripts', () => {
    const items = splitScript('postgres', PG_SCRIPT)
    expect(statements(items)).toEqual([
      'SET search_path = public',
      "CREATE FUNCTION f() RETURNS text LANGUAGE plpgsql AS $body$\nBEGIN\n  RETURN 'semi; colon'; -- not a comment end\nEND $body$",
      `SELECT 'it''s', E'esc\\'aped;', "we;ird", $$dollar;$$, $1x, 'a--b'`,
      'INSERT INTO t VALUES (1)',
      'SELECT 1',
    ])
    expect(items.find(i => i.kind === 'meta')).toMatchObject({ text: '\\restrict abc123' })
    const copy = items.find(i => i.kind === 'copy')
    expect(copy).toMatchObject({ table: 'public.users', columns: ['id', 'Full Name', 'note'], rows: [['1', 'Ann', null], ['2', 'Bob\tTab', 'line\nbreak']] })
  })

  it('splits MySQL scripts with DELIMITER and conditional comments', () => {
    expect(statements(splitScript('mysql', MYSQL_SCRIPT))).toEqual([
      '/*!40101 SET NAMES utf8mb4 */',
      "INSERT INTO `t;x` VALUES ('it\\'s; \\\\', \"dq;\\\"x\", 1--1)",
      'CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END',
      "SELECT 'done'",
    ])
  })

  it('reports statement start lines', () => {
    const items = splitScript('postgres', '\n\n-- c\nSELECT 1;\n\nSELECT\n2;')
    expect(items.map(i => i.line)).toEqual([4, 6])
  })

  it.each(['postgres', 'mysql'] as const)('gives the same result for every chunk size (%s)', dialect => {
    const script = dialect === 'postgres' ? PG_SCRIPT : MYSQL_SCRIPT
    const whole = chunked(dialect, script, script.length)
    for (let size = 1; size <= 40; size++) expect(chunked(dialect, script, size)).toEqual(whole)
  })

  it('flags unsupported COPY options and unterminated COPY data', () => {
    expect(splitScript('postgres', "COPY t FROM stdin WITH (FORMAT csv);\n1,2\n\\.\nSELECT 1;")).toMatchObject([
      { kind: 'error' }, { kind: 'statement', sql: 'SELECT 1' },
    ])
    expect(splitScript('postgres', 'COPY t FROM stdin;\n1\n').at(-1)).toMatchObject({ kind: 'error' })
  })

  it('drops comment-only tails and keeps an unterminated last statement', () => {
    expect(statements(splitScript('postgres', 'SELECT 1;\n-- the end\n'))).toEqual(['SELECT 1'])
    expect(statements(splitScript('mysql', 'SELECT 1'))).toEqual(['SELECT 1'])
  })
})

describe('COPY helpers', () => {
  it('decodes COPY text fields', () => {
    expect(decodeCopyField('\\N')).toBeNull()
    expect(decodeCopyField('a\\\\b\\tc\\nd\\101\\x42')).toBe('a\\b\tc\ndAB')
    expect(decodeCopyField('\\\\x00ff')).toBe('\\x00ff')
  })

  it('splits column lists', () => {
    expect(splitIdentList('id, "Full ""Q"" Name",x')).toEqual(['id', 'Full "Q" Name', 'x'])
  })

  it('builds parameterized inserts', () => {
    expect(copyToInsert('public.t', ['a', 'b'], [['1', null], ['2', 'x']])).toEqual({
      sql: 'INSERT INTO public.t ("a", "b") OVERRIDING SYSTEM VALUE VALUES ($1, $2), ($3, $4)',
      params: ['1', null, '2', 'x'],
    })
  })
})
