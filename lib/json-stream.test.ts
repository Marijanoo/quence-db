import { describe, expect, it } from 'vitest'
import { JsonDocumentSplitter, splitJsonDocuments } from './json-stream'

function chunked(text: string, size: number) {
  const s = new JsonDocumentSplitter()
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(...s.push(text.slice(i, i + size)))
  return [...out, ...s.end()]
}

const ARRAY = '﻿[\n  {"a": "x]}\\"{", "b": [1, {"c": 2}]},\n  {"_id": {"$oid": "64b000000000000000000001"}},\n  42, "s", null\n]\n'
const LINES = '{"a":1}\n{"b":"line\nbreak"}\r\n\n{"c":[{"d":{}}]}{"e":2}'

describe('JsonDocumentSplitter', () => {
  it('splits the elements of an array', () => {
    expect(splitJsonDocuments(ARRAY)).toEqual([
      '{"a": "x]}\\"{", "b": [1, {"c": 2}]}',
      '{"_id": {"$oid": "64b000000000000000000001"}}',
      '42', '"s"', 'null',
    ])
  })

  it('splits JSON Lines and concatenated documents', () => {
    expect(splitJsonDocuments(LINES)).toEqual(['{"a":1}', '{"b":"line\nbreak"}', '{"c":[{"d":{}}]}', '{"e":2}'])
  })

  it('gives the same result for every chunk size', () => {
    for (const text of [ARRAY, LINES]) {
      const whole = splitJsonDocuments(text)
      for (let size = 1; size <= 30; size++) expect(chunked(text, size)).toEqual(whole)
    }
  })

  it('handles empty input and empty arrays', () => {
    expect(splitJsonDocuments('')).toEqual([])
    expect(splitJsonDocuments(' [ ] ')).toEqual([])
  })

  it('reports truncated or malformed JSON', () => {
    expect(() => splitJsonDocuments('[{"a": 1}')).toThrow(/not closed/)
    expect(() => splitJsonDocuments('{"a": [1, 2}')).toThrow()
    expect(() => splitJsonDocuments('[1] 2')).toThrow(/after the end/)
  })
})
