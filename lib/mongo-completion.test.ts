import { describe, expect, it } from 'vitest'
import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import { memberTarget, mongoCompletionSource, mongoEditorLanguage, mongoTokenRanges } from './mongo-completion'

function complete(doc: string, collections = ['users', 'order-items']) {
  const state = EditorState.create({ doc, extensions: mongoEditorLanguage(collections) })
  const result = mongoCompletionSource(collections)(new CompletionContext(state, doc.length, false))
  return result ? result.options.map(o => o.label) : null
}

describe('memberTarget', () => {
  it.each([
    ['db', 'db'],
    ['  db', 'db'],
    ['db.users', 'collection'],
    ['db["order-items"]', 'collection'],
    ['db.getCollection("order-items")', 'collection'],
    ['db.users.find({ a: 1 })', 'cursor'],
    ['db.users.find().sort({ a: 1 })', 'cursor'],
    ['mydb', null],
    ['foo.db', null],
  ] as const)('%s → %s', (before, expected) => expect(memberTarget(before)).toBe(expected))
})

describe('mongoCompletionSource', () => {
  it('suggests collections and db methods after db.', () => {
    const labels = complete('db.')!
    expect(labels).toEqual(expect.arrayContaining(['users', 'order-items', 'getCollection', 'getCollectionNames']))
    expect(labels).not.toContain('SELECT')
  })

  it('suggests collection methods after db.<collection>.', () => {
    expect(complete('db.users.')).toEqual(expect.arrayContaining(['find', 'findOne', 'insertOne', 'aggregate', 'countDocuments']))
  })

  it('suggests cursor methods after a call', () => {
    const labels = complete('db.users.find({}).')!
    expect(labels).toEqual(expect.arrayContaining(['sort', 'limit', 'skip', 'toArray']))
    expect(labels).not.toContain('insertOne')
  })

  it('suggests operators after $, also inside quotes', () => {
    expect(complete('db.users.find({ age: { $g')).toEqual(expect.arrayContaining(['$gt', '$gte']))
    expect(complete('db.users.updateOne({}, { "$s')).toEqual(expect.arrayContaining(['$set']))
  })

  it('suggests shell commands and helpers at the top level, not SQL', () => {
    const labels = complete('s')!
    expect(labels).toEqual(expect.arrayContaining(['db', 'use', 'show dbs', 'show collections', 'ObjectId']))
    expect(labels).not.toContain('SELECT')
  })

  it('stays quiet in plain strings and comments', () => {
    expect(complete('db.users.find({ name: "an')).toBeNull()
    expect(complete('// find the us')).toBeNull()
  })

  it('inserts getCollection for collection names that are not identifiers', () => {
    const state = EditorState.create({ doc: 'db.', extensions: mongoEditorLanguage(['order-items']) })
    const res = mongoCompletionSource(['order-items'])(new CompletionContext(state, 3, false))!
    expect(res.options.find(o => o.label === 'order-items')?.apply).toBe('getCollection("order-items")')
  })
})

describe('mongoTokenRanges', () => {
  function tokens(doc: string) {
    const state = EditorState.create({ doc, extensions: mongoEditorLanguage([]) })
    ensureSyntaxTree(state, doc.length, 10_000)
    return mongoTokenRanges(state, 0, doc.length).map(r => [doc.slice(r.from, r.to), r.kind])
  }

  it('marks db, collections, methods and operators', () => {
    expect(tokens('db.users.find({ age: { $gt: 18 }, "$or": [] }).sort({ age: -1 })')).toEqual([
      ['db', 'keyword'],
      ['users', 'type'],
      ['find', 'keyword'],
      ['$gt', 'operator'],
      ['"$or"', 'operator'],
      ['sort', 'keyword'],
    ])
  })

  it('marks getCollection as a method and helpers as types', () => {
    expect(tokens('db.getCollection("x").insertOne({ _id: ObjectId("a"), at: ISODate() })')).toEqual([
      ['db', 'keyword'],
      ['getCollection', 'keyword'],
      ['insertOne', 'keyword'],
      ['ObjectId', 'type'],
      ['ISODate', 'type'],
    ])
  })

  it('marks use and show commands but not field names or plain strings', () => {
    expect(tokens('use shop\nshow collections\nconst find = { name: "$age" }')).toEqual([
      ['use', 'keyword'],
      ['show', 'keyword'],
    ])
  })
})
