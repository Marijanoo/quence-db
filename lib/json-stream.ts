// Splits a stream of JSON text into its documents, chunk by chunk, without parsing them: either
// the elements of one top-level array ([{…}, {…}]) or a sequence of values (JSON Lines, or
// mongoexport output). Each document comes out as its raw text, to be parsed where it's used
// (Extended JSON for MongoDB, plain JSON for table imports).

export class JsonDocumentSplitter {
  private rest = ''
  private mode: 'unknown' | 'array' | 'values' | 'finished' = 'unknown'
  private depth = 0          // nesting inside the current document
  private inString = false
  private escaped = false
  private current = ''       // text of the document being read
  private started = false    // current holds a document (not just separators)
  private arrayClosed = false

  push(chunk: string): string[] {
    return this.scan(this.rest + chunk)
  }

  end(): string[] {
    const out = this.scan(this.rest)
    if (this.started) {
      if (this.depth > 0 || this.inString) throw new Error('The JSON ends in the middle of a document')
      out.push(this.current.trim())
      this.current = ''
      this.started = false
    }
    if (this.mode === 'array' && !this.arrayClosed) throw new Error('The JSON array is not closed (missing "]")')
    return out
  }

  private scan(text: string): string[] {
    const out: string[] = []
    let i = 0
    if (this.mode === 'unknown') {
      text = text.replace(/^﻿/, '')
      const first = text.search(/\S/)
      if (first < 0) { this.rest = text; return out }
      this.mode = text[first] === '[' ? 'array' : 'values'
      if (this.mode === 'array') i = first + 1
    }
    let docStart = i
    const take = (end: number) => { if (this.started) this.current += text.slice(docStart, end); docStart = end }

    for (; i < text.length; i++) {
      const ch = text[i]
      if (this.inString) {
        if (this.escaped) this.escaped = false
        else if (ch === '\\') this.escaped = true
        else if (ch === '"') this.inString = false
        continue
      }
      if (this.depth === 0) {
        // between documents
        if (/\s/.test(ch) || (this.mode === 'array' && ch === ',')) {
          if (this.started) { take(i); this.emit(out) } // end of a scalar document
          docStart = i + 1
          continue
        }
        if (this.mode === 'array' && ch === ']') {
          if (this.started) { take(i); this.emit(out) }
          this.arrayClosed = true
          this.mode = 'finished'
          docStart = i + 1
          continue
        }
        if (this.mode === 'finished') {
          throw new Error('Unexpected text after the end of the JSON array')
        }
        if (!this.started) { this.started = true; this.current = ''; docStart = i }
      }
      if (ch === '"') this.inString = true
      else if (ch === '{' || ch === '[') this.depth++
      else if (ch === '}' || ch === ']') {
        this.depth--
        if (this.depth < 0) throw new Error(`Unexpected "${ch}" in the JSON`)
        if (this.depth === 0) { take(i + 1); this.emit(out) }
      }
    }
    take(text.length)
    this.rest = ''
    return out
  }

  private emit(out: string[]) {
    const doc = this.current.trim()
    this.current = ''
    this.started = false
    if (doc) out.push(doc)
  }
}

export function splitJsonDocuments(text: string): string[] {
  const s = new JsonDocumentSplitter()
  return [...s.push(text), ...s.end()]
}
