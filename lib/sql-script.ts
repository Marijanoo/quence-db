// Splits a SQL script into statements as it streams in, chunk by chunk, so a multi-gigabyte dump
// never has to be in memory at once. Understands what dumps contain:
//   PostgreSQL: '…' and E'…' strings, "identifiers", $tag$ bodies $tag$, nested /* comments */,
//               COPY … FROM stdin data blocks (pg_dump's default), psql \meta-commands (skipped)
//   MySQL:      '…' "…" `…` with backslash escapes, # comments, /*! conditional code */ (kept: the
//               server runs it), DELIMITER directives (mysqldump routines and triggers)
// Comments outside strings are dropped from the statement text.

export type ScriptDialect = 'postgres' | 'mysql'

export type ScriptItem =
  | { kind: 'statement'; sql: string; line: number }
  // Rows of a COPY block, in batches; values are text (null = \N), in the order of `columns`
  | { kind: 'copy'; table: string; columns: string[] | null; rows: (string | null)[][]; line: number }
  | { kind: 'meta'; text: string; line: number }       // a psql command such as \connect; not SQL
  | { kind: 'error'; message: string; line: number }

type Mode =
  | 'normal' | 'line-comment' | 'block-comment' | 'conditional' | 'squote' | 'dquote' | 'backtick' | 'dollar'
  | 'copy-skip' | 'copy'

const COPY_BATCH_ROWS = 500
const IDENT_CHAR = /[\w$\u0080-￿]/
const DOLLAR_TAG = /^\$([A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/

// COPY <table> [(<columns>)] FROM stdin — only the default text format is supported
const COPY_HEADER = /^COPY\s+((?:"(?:[^"]|"")*"|[^\s(."]+)(?:\s*\.\s*(?:"(?:[^"]|"")*"|[^\s(."]+))?)\s*(?:\(([^)]*)\))?\s+FROM\s+stdin\s*$/i

export class SqlScriptSplitter {
  private rest = ''            // unprocessed input carried to the next chunk
  private buf = ''             // text of the statement being built
  private hasContent = false   // buf holds more than whitespace
  private mode: Mode = 'normal'
  private line = 1
  private startLine = 1
  private atLineStart = true
  private prev = ''            // last character processed (for E'' and identifier checks)
  private prev2 = ''           // the one before it
  private delimiter = ';'
  private commentDepth = 0
  private dollarTag = ''
  private escapes = false      // backslash escapes in the current string
  private copy: { table: string; columns: string[] | null; rows: (string | null)[][]; line: number } | null = null

  constructor(private readonly dialect: ScriptDialect) {}

  push(chunk: string): ScriptItem[] {
    return this.process(this.rest + chunk, false)
  }

  end(): ScriptItem[] {
    const out = this.process(this.rest, true)
    if (this.mode === 'copy' || this.mode === 'copy-skip') {
      if (this.copy && this.copy.rows.length) out.push(this.flushCopy())
      out.push({ kind: 'error', message: 'The script ended inside COPY data (missing "\\." line)', line: this.line })
    } else if (this.hasContent) {
      out.push({ kind: 'statement', sql: this.buf.trim(), line: this.startLine })
    }
    this.buf = ''
    this.hasContent = false
    return out
  }

  private emitStatement(out: ScriptItem[]) {
    const sql = this.buf.trim()
    const had = this.hasContent
    this.buf = ''
    this.hasContent = false
    if (!had || !sql) return
    const copy = this.dialect === 'postgres' ? COPY_HEADER.exec(sql) : null
    if (copy) {
      this.copy = { table: copy[1], columns: copy[2] !== undefined ? splitIdentList(copy[2]) : null, rows: [], line: this.startLine }
      this.mode = 'copy-skip'
      return
    }
    if (this.dialect === 'postgres' && /^COPY\b[\s\S]*\bFROM\s+stdin\b/i.test(sql)) {
      out.push({ kind: 'error', message: 'Only COPY … FROM stdin in the default text format is supported (no CSV/BINARY options)', line: this.startLine })
      this.copy = null
      this.mode = 'copy-skip'
      return
    }
    out.push({ kind: 'statement', sql, line: this.startLine })
  }

  private flushCopy(): ScriptItem {
    const c = this.copy!
    const item: ScriptItem = { kind: 'copy', table: c.table, columns: c.columns, rows: c.rows, line: c.line }
    c.rows = []
    return item
  }

  private markContent() {
    if (!this.hasContent) { this.hasContent = true; this.startLine = this.line }
  }

  private process(text: string, final: boolean): ScriptItem[] {
    const out: ScriptItem[] = []
    const mysql = this.dialect === 'mysql'
    let i = 0
    let seg = 0 // start of text not yet appended to buf
    const flush = (end: number) => { if (end > seg) this.buf += text.slice(seg, end); seg = end }
    const advance = (to: number) => {
      for (let k = i; k < to; k++) if (text.charCodeAt(k) === 10) this.line++
      if (to > i) {
        this.prev2 = to - i >= 2 ? text[to - 2] : this.prev
        this.prev = text[to - 1]
        this.atLineStart = this.prev === '\n'
      }
      i = to
    }

    outer:
    while (i < text.length) {
      switch (this.mode) {
        // ── COPY data: whole lines ──
        case 'copy-skip':
        case 'copy': {
          const nl = text.indexOf('\n', i)
          if (nl < 0 && !final) break outer
          const end = nl < 0 ? text.length : nl
          const lineText = text.slice(i, end).replace(/\r$/, '')
          const lineNo = this.line
          advance(nl < 0 ? end : nl + 1)
          seg = i
          if (this.mode === 'copy-skip') {
            // rest of the COPY statement's own line
            this.mode = 'copy'
            continue
          }
          if (lineText === '\\.') {
            if (this.copy) {
              if (this.copy.rows.length) out.push(this.flushCopy())
              this.copy = null
            }
            this.mode = 'normal'
            continue
          }
          if (this.copy) {
            if (this.copy.rows.length === 0) this.copy.line = lineNo
            this.copy.rows.push(lineText.split('\t').map(decodeCopyField))
            if (this.copy.rows.length >= COPY_BATCH_ROWS) out.push(this.flushCopy())
          }
          continue
        }

        case 'line-comment': {
          const nl = text.indexOf('\n', i)
          if (nl < 0) { advance(text.length); seg = i; break outer }
          advance(nl) // the newline itself is kept as whitespace
          seg = i
          this.mode = 'normal'
          continue
        }

        case 'block-comment': {
          const ch = text[i]
          if (ch === '*' || ch === '/') {
            if (i + 1 >= text.length && !final) break outer
            const two = text.slice(i, i + 2)
            if (two === '*/') {
              advance(i + 2)
              seg = i
              if (--this.commentDepth === 0) { this.mode = 'normal'; this.buf += ' ' }
              continue
            }
            if (two === '/*' && !mysql) { this.commentDepth++; advance(i + 2); seg = i; continue }
          }
          advance(i + 1)
          seg = i
          continue
        }

        case 'conditional': {
          // MySQL /*! … */: executable, copied into the statement
          const close = text.indexOf('*/', i)
          if (close < 0) {
            // keep a trailing '*' in case the next chunk starts with '/'
            advance(final ? text.length : Math.max(i, text.length - 1))
            break outer
          }
          advance(close + 2)
          this.mode = 'normal'
          continue
        }

        case 'squote':
        case 'dquote':
        case 'backtick': {
          const quote = this.mode === 'squote' ? "'" : this.mode === 'dquote' ? '"' : '`'
          const ch = text[i]
          if (ch === '\\' && this.escapes) {
            if (i + 1 >= text.length && !final) break outer
            advance(Math.min(i + 2, text.length))
            continue
          }
          if (ch === quote) {
            if (i + 1 >= text.length && !final) break outer
            if (text[i + 1] === quote) { advance(i + 2); continue } // doubled quote
            advance(i + 1)
            this.mode = 'normal'
            continue
          }
          // jump to the next interesting character
          let j = i + 1
          while (j < text.length && text[j] !== quote && !(this.escapes && text[j] === '\\')) j++
          advance(j)
          continue
        }

        case 'dollar': {
          const close = text.indexOf(this.dollarTag, i)
          if (close < 0) {
            // keep enough of the tail to recognize a closing tag split across chunks
            const keep = Math.max(i, text.length - (this.dollarTag.length - 1))
            if (final) { advance(text.length); break outer }
            advance(keep)
            break outer
          }
          advance(close + this.dollarTag.length)
          this.mode = 'normal'
          continue
        }

        case 'normal': {
          // Line-level directives, only between statements
          if (this.atLineStart && !this.hasContent) {
            const nl = text.indexOf('\n', i)
            if (nl < 0 && !final) {
              // need the whole line to decide; keep it unless it clearly isn't a directive
              const head = text.slice(i).trimStart()
              if (head === '' || (mysql ? /^d(e(l(i(m(i(t(e(r)?)?)?)?)?)?)?)?$/i.test(head) || /^delimiter\s/i.test(head) : head.startsWith('\\'))) break outer
            }
            const end = nl < 0 ? text.length : nl
            const lineText = text.slice(i, end).replace(/\r$/, '')
            if (mysql) {
              const m = /^\s*DELIMITER\s+(\S+)\s*$/i.exec(lineText)
              if (m) {
                flush(i)
                this.buf = ''
                this.delimiter = m[1]
                advance(nl < 0 ? end : nl + 1)
                seg = i
                continue
              }
            } else if (/^\s*\\/.test(lineText)) {
              flush(i)
              this.buf = ''
              out.push({ kind: 'meta', text: lineText.trim(), line: this.line })
              advance(nl < 0 ? end : nl + 1)
              seg = i
              continue
            }
          }

          const ch = text[i]
          // statement delimiter
          if (ch === this.delimiter[0]) {
            if (i + this.delimiter.length > text.length && !final) break outer
            if (text.startsWith(this.delimiter, i)) {
              flush(i)
              this.emitStatement(out)
              advance(i + this.delimiter.length)
              seg = i
              continue
            }
          }
          if (ch === '-' ) {
            if (i + 2 >= text.length && !final) break outer
            if (text[i + 1] === '-' && (!mysql || i + 2 >= text.length || /\s/.test(text[i + 2]))) {
              flush(i)
              this.mode = 'line-comment'
              advance(i + 2)
              seg = i
              continue
            }
          }
          if (ch === '#' && mysql) {
            flush(i)
            this.mode = 'line-comment'
            advance(i + 1)
            seg = i
            continue
          }
          if (ch === '/') {
            if (i + 2 >= text.length && !final) break outer
            if (text[i + 1] === '*') {
              if (mysql && text[i + 2] === '!') {
                this.markContent()
                this.mode = 'conditional'
                advance(i + 3)
                continue
              }
              flush(i)
              this.mode = 'block-comment'
              this.commentDepth = 1
              advance(i + 2)
              seg = i
              continue
            }
          }
          if (ch === "'") {
            this.markContent()
            // PostgreSQL E'…' strings take backslash escapes; MySQL strings always do
            this.escapes = mysql || ((this.prev === 'E' || this.prev === 'e') && !IDENT_CHAR.test(this.prev2))
            this.mode = 'squote'
            advance(i + 1)
            continue
          }
          if (ch === '"') {
            this.markContent()
            this.escapes = mysql
            this.mode = 'dquote'
            advance(i + 1)
            continue
          }
          if (ch === '`' && mysql) {
            this.markContent()
            this.escapes = false
            this.mode = 'backtick'
            advance(i + 1)
            continue
          }
          if (ch === '$' && !mysql && !IDENT_CHAR.test(this.prev)) {
            const window = text.slice(i, i + 128)
            const m = DOLLAR_TAG.exec(window)
            if (!m && !final && window.length < 128 && /^\$[\w\u0080-￿]*$/.test(window)) break outer
            if (m) {
              this.markContent()
              this.dollarTag = m[0]
              this.mode = 'dollar'
              advance(i + m[0].length)
              continue
            }
          }
          if (!/\s/.test(ch)) this.markContent()
          advance(i + 1)
          continue
        }
      }
    }

    // text[seg..i] is scanned statement text (empty in comment and COPY modes, which keep seg at
    // i); text[i..] couldn't be decided yet and is carried to the next chunk
    flush(i)
    this.rest = text.slice(i)
    return out
  }
}

// Splits a column list like `id, "Full Name", x` into names
export function splitIdentList(list: string): string[] {
  const out: string[] = []
  const re = /\s*("(?:[^"]|"")*"|[^,]+?)\s*(?:,|$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(list)) && m[0] !== '') {
    const name = m[1].trim()
    if (name) out.push(name.startsWith('"') ? name.slice(1, -1).replace(/""/g, '"') : name)
    if (re.lastIndex >= list.length) break
  }
  return out
}

// One field of COPY text format: \N is NULL; backslash escapes as documented for COPY
export function decodeCopyField(field: string): string | null {
  if (field === '\\N') return null
  if (!field.includes('\\')) return field
  return field.replace(/\\(?:([0-7]{1,3})|x([0-9A-Fa-f]{1,2})|(.))/g, (_all, oct: string, hex: string, ch: string) => {
    if (oct) return String.fromCharCode(parseInt(oct, 8))
    if (hex) return String.fromCharCode(parseInt(hex, 16))
    switch (ch) {
      case 'b': return '\b'
      case 'f': return '\f'
      case 'n': return '\n'
      case 'r': return '\r'
      case 't': return '\t'
      case 'v': return '\v'
      default: return ch
    }
  })
}

// COPY rows as a parameterized multi-row INSERT (PostgreSQL). Values go in as text parameters;
// the server converts each to its column's type, exactly as COPY would. COPY also writes
// GENERATED ALWAYS identity columns, which INSERT only does with OVERRIDING SYSTEM VALUE (a no-op
// on tables without one).
export function copyToInsert(table: string, columns: string[] | null, rows: (string | null)[][]): { sql: string; params: (string | null)[] } {
  const params: (string | null)[] = []
  const values = rows.map(r => `(${r.map(v => { params.push(v); return `$${params.length}` }).join(', ')})`)
  const cols = columns ? ` (${columns.map(c => '"' + c.replace(/"/g, '""') + '"').join(', ')})` : ''
  return { sql: `INSERT INTO ${table}${cols} OVERRIDING SYSTEM VALUE VALUES ${values.join(', ')}`, params }
}

// Convenience for tests and small scripts
export function splitScript(dialect: ScriptDialect, text: string): ScriptItem[] {
  const s = new SqlScriptSplitter(dialect)
  return [...s.push(text), ...s.end()]
}
