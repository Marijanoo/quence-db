import { describe, expect, it } from 'vitest'
import { buildMongoCellScript, buildMongoSetScript, convertMongoValue, mongoIdFilter, typedLiteral, typedValueFromText } from './mongo-cell'

describe('convertMongoValue', () => {
  it.each([
    ['42', 'string', 'int', 'NumberInt(42)'],
    [42.9, 'double', 'int', 'NumberInt(42)'],
    ['9007199254740993', 'string', 'long', 'NumberLong("9007199254740993")'],
    [7, 'int', 'long', 'NumberLong("7")'],
    ['1.5', 'string', 'double', 'new Double(1.5)'],
    [3, 'int', 'double', 'new Double(3)'],
    ['1.50', 'string', 'decimal', 'NumberDecimal("1.50")'],
    [42, 'int', 'string', '"42"'],
    [true, 'bool', 'string', '"true"'],
    [{ a: 1 }, 'object', 'string', '"{\\"a\\":1}"'],
    [null, 'null', 'string', '""'],
    ['yes', 'string', 'bool', 'true'],
    ['0', 'string', 'bool', 'false'],
    [0, 'int', 'bool', 'false'],
    ['2024-01-02T03:04:05Z', 'string', 'date', 'ISODate("2024-01-02T03:04:05.000Z")'],
    [0, 'long', 'date', 'ISODate("1970-01-01T00:00:00.000Z")'],
    ['64B000000000000000000001', 'string', 'objectId', 'ObjectId("64b000000000000000000001")'],
    ['x', 'string', 'array', '["x"]'],
    ['64b000000000000000000001', 'objectId', 'array', '[ObjectId("64b000000000000000000001")]'],
    [null, 'null', 'array', '[]'],
    ['{"a":1}', 'string', 'object', '{"a":1}'],
    ['anything', 'string', 'null', 'null'],
  ] as const)('%j (%s) → %s', (value, from, to, expected) => {
    expect(convertMongoValue(value, from, to)).toBe(expected)
  })

  it('converts dates to epoch milliseconds for number types', () => {
    expect(convertMongoValue('1970-01-01T00:00:01.000Z', 'date', 'long')).toBe('NumberLong("1000")')
  })

  it.each([
    ['abc', 'string', 'int'],
    ['99999999999', 'string', 'int'],
    [null, 'null', 'int'],
    ['maybe', 'string', 'bool'],
    ['not a date', 'string', 'date'],
    ['123', 'string', 'objectId'],
    ['plain text', 'string', 'object'],
  ] as const)('refuses %j (%s) → %s', (value, from, to) => {
    expect(() => convertMongoValue(value, from, to)).toThrow(/Can't convert/)
  })
})

describe('mongoIdFilter / typedLiteral', () => {
  it('rebuilds _id values with their BSON type', () => {
    expect(mongoIdFilter('64b000000000000000000001', 'objectId')).toBe('{ _id: ObjectId("64b000000000000000000001") }')
    expect(mongoIdFilter('abc', 'string')).toBe('{ _id: "abc" }')
    expect(mongoIdFilter(5, 'int')).toBe('{ _id: NumberInt(5) }')
    expect(mongoIdFilter('0f8fad5b-d9cb-469f-a165-70867728950e', 'uuid')).toBe('{ _id: UUID("0f8fad5b-d9cb-469f-a165-70867728950e") }')
    expect(typedLiteral('2024-01-01T00:00:00.000Z', 'date')).toBe('ISODate("2024-01-01T00:00:00.000Z")')
  })

  it('refuses _ids it cannot rebuild', () => {
    expect(mongoIdFilter(undefined, undefined)).toBeNull()
    expect(mongoIdFilter('AAAA', 'binData')).toBeNull()
  })
})

describe('buildMongoCellScript', () => {
  const id = '64b000000000000000000001'
  it('builds $set, $unset and deleteOne scripts on the document', () => {
    expect(buildMongoCellScript('order-items', id, 'objectId', { kind: 'changeType', col: 'qty', to: 'int' }, '3', 'string'))
      .toBe('db.getCollection("order-items").updateOne({ _id: ObjectId("64b000000000000000000001") }, { $set: { "qty": NumberInt(3) } })')
    expect(buildMongoCellScript('c', id, 'objectId', { kind: 'emptyString', col: 'a.b' }))
      .toBe('db.getCollection("c").updateOne({ _id: ObjectId("64b000000000000000000001") }, { $set: { "a.b": "" } })')
    expect(buildMongoCellScript('c', id, 'objectId', { kind: 'unset', col: 'x' }))
      .toBe('db.getCollection("c").updateOne({ _id: ObjectId("64b000000000000000000001") }, { $unset: { "x": "" } })')
    expect(buildMongoCellScript('c', id, 'objectId', { kind: 'deleteDocument' }))
      .toBe('db.getCollection("c").deleteOne({ _id: ObjectId("64b000000000000000000001") })')
  })

  it('refuses documents whose _id cannot be matched', () => {
    expect(() => buildMongoCellScript('c', 'AAAA', 'binData', { kind: 'deleteDocument' })).toThrow(/_id type/)
  })
})

describe('typedValueFromText', () => {
  it("keeps the field's BSON type", () => {
    expect(typedValueFromText('hello', 'string')).toBe('"hello"')
    expect(typedValueFromText('42', 'int')).toBe('NumberInt(42)')
    expect(typedValueFromText('9007199254740993', 'long')).toBe('NumberLong("9007199254740993")')
    expect(typedValueFromText('1.5', 'double')).toBe('new Double(1.5)')
    expect(typedValueFromText('0.10', 'decimal')).toBe('NumberDecimal("0.10")')
    expect(typedValueFromText('yes', 'bool')).toBe('true')
    expect(typedValueFromText('2026-09-24T10:00:00Z', 'date')).toBe('ISODate("2026-09-24T10:00:00.000Z")')
    expect(typedValueFromText('64b7f0c2a1b2c3d4e5f60718', 'objectId')).toBe('ObjectId("64b7f0c2a1b2c3d4e5f60718")')
    expect(typedValueFromText('[1, "a"]', 'array')).toBe('[1,"a"]')
    expect(typedValueFromText('{"a": 1}', 'object')).toBe('{"a":1}')
    expect(typedValueFromText(null, 'int')).toBe('null')
  })

  it('stores text for missing or null fields', () => {
    expect(typedValueFromText('5', undefined)).toBe('"5"')
    expect(typedValueFromText('5', 'null')).toBe('"5"')
  })

  it('rejects text that does not fit the type', () => {
    expect(() => typedValueFromText('abc', 'int')).toThrow(/Can't convert abc to Int32/)
    expect(() => typedValueFromText('{"a":1}', 'array')).toThrow(/Array \(enter JSON\)/)
    expect(() => typedValueFromText('not-a-uuid', 'uuid')).toThrow(/UUID/)
    expect(() => typedValueFromText('x', 'binData')).toThrow(/Editing Binary values isn't supported/)
  })
})

describe('buildMongoSetScript', () => {
  it('sets every edited field of one document by its _id', () => {
    expect(buildMongoSetScript('posts', '64b7f0c2a1b2c3d4e5f60718', 'objectId', [
      { col: 'title', text: 'Hi', type: 'string' },
      { col: 'stats.views', text: '10', type: 'int' },
    ])).toBe('db.getCollection("posts").updateOne({ _id: ObjectId("64b7f0c2a1b2c3d4e5f60718") }, { $set: { "title": "Hi", "stats.views": NumberInt(10) } })')
  })

  it('refuses to change _id', () => {
    expect(() => buildMongoSetScript('posts', 1, 'int', [{ col: '_id', text: '2', type: 'int' }])).toThrow(/_id can't be changed/)
  })
})
