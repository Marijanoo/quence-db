import { describe, it, expect } from 'vitest'
import { cellHighlightKind, highlightStore, kindFromColumnType, kindFromValue } from './type-highlight'

describe('kindFromColumnType', () => {
  it('classifies PostgreSQL udt names and format_type output', () => {
    expect(['int4', 'int8', 'numeric', 'float8', 'money'].map(kindFromColumnType)).toEqual(Array(5).fill('number'))
    expect(['text', 'varchar', 'bpchar', 'character varying(100)', 'citext'].map(kindFromColumnType)).toEqual(Array(5).fill('string'))
    expect(['timestamptz', 'date', 'interval', 'timestamp with time zone', 'time without time zone'].map(kindFromColumnType)).toEqual(Array(5).fill('datetime'))
    expect(kindFromColumnType('bool')).toBe('boolean')
    expect(kindFromColumnType('jsonb')).toBe('json')
    expect(kindFromColumnType('_int4')).toBe('json')
    expect(kindFromColumnType('text[]')).toBe('json')
    expect(kindFromColumnType('uuid')).toBe('uuid')
    expect(kindFromColumnType('bytea')).toBe('binary')
    expect(kindFromColumnType('my_enum')).toBeNull()
  })

  it('classifies MySQL types', () => {
    expect(kindFromColumnType('int unsigned')).toBe('number')
    expect(kindFromColumnType('decimal(10,2)')).toBe('number')
    expect(kindFromColumnType('datetime')).toBe('datetime')
    expect(kindFromColumnType('longtext')).toBe('string')
    expect(kindFromColumnType("enum('a','b')")).toBe('string')
    expect(kindFromColumnType('varbinary(16)')).toBe('binary')
  })
})

describe('kindFromValue', () => {
  it('classifies runtime values', () => {
    expect(kindFromValue(42)).toBe('number')
    expect(kindFromValue(true)).toBe('boolean')
    expect(kindFromValue(new Date())).toBe('datetime')
    expect(kindFromValue('hello')).toBe('string')
    expect(kindFromValue('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')).toBe('uuid')
    expect(kindFromValue({ a: 1 })).toBe('json')
    expect(kindFromValue([1, 2])).toBe('json')
    expect(kindFromValue({ _bsontype: 'ObjectId' })).toBe('uuid')
    expect(kindFromValue(null)).toBeNull()
  })
})

describe('cellHighlightKind', () => {
  it('prefers the column type (PostgreSQL numerics arrive as strings) and never tints NULL', () => {
    expect(cellHighlightKind('numeric', '12.50')).toBe('number')
    expect(cellHighlightKind('int8', '9007199254740993')).toBe('number')
    expect(cellHighlightKind(undefined, 'x')).toBe('string')
    expect(cellHighlightKind('my_enum', 'active')).toBe('string')
    expect(cellHighlightKind('text', null)).toBeNull()
  })
})

describe('highlightStore', () => {
  it('toggles kinds and notifies subscribers', () => {
    let calls = 0
    const unsubscribe = highlightStore.subscribe(() => { calls++ })
    highlightStore.set([])
    highlightStore.toggle('string', true)
    highlightStore.toggle('number', true)
    highlightStore.toggle('string', false)
    expect([...highlightStore.get()]).toEqual(['number'])
    expect(calls).toBe(4)
    unsubscribe()
    highlightStore.set([])
  })
})
