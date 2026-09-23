import { describe, expect, it } from 'vitest'
import { looksLikeMongoShell, looksLikeSql, queryLanguageMismatch, stripLeadingComments } from './query-language'

describe('stripLeadingComments', () => {
  it('removes leading SQL, JS and block comments', () => {
    expect(stripLeadingComments('  -- note\n/* block */ // js\n# mysql\nSELECT 1')).toBe('SELECT 1')
    expect(stripLeadingComments('/* unterminated')).toBe('')
  })
})

describe('looksLikeSql', () => {
  it.each([
    'SELECT * FROM users',
    'select 1',
    '-- comment\ninsert into t values (1)',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'update users set a = 1',
    'DELETE FROM users',
    'create table t (id int)',
  ])('detects %s', q => expect(looksLikeSql(q)).toBe(true))

  it.each([
    'db.users.find({})',
    'use shop',
    'show collections',
    'const n = 1; db.users.find({ n })',
    'db.users.updateOne({}, { $set: { select: 1 } })',
  ])('ignores %s', q => expect(looksLikeSql(q)).toBe(false))
})

describe('looksLikeMongoShell', () => {
  it.each([
    'db.users.find({})',
    '  db["users"].findOne()',
    '// comment\ndb.users.countDocuments()',
    'show dbs',
    'show collections',
    'const min = 18\ndb.users.find({ age: { $gt: min } })',
  ])('detects %s', q => expect(looksLikeMongoShell(q)).toBe(true))

  it.each([
    'SELECT db.name FROM db',
    'SHOW TABLES',
    'show databases',
    'use shop',
    'select * from dbo.users',
  ])('ignores %s', q => expect(looksLikeMongoShell(q)).toBe(false))
})

describe('queryLanguageMismatch', () => {
  it('rejects SQL on MongoDB connections', () => {
    expect(queryLanguageMismatch('mongodb', 'SELECT * FROM users')).toMatch(/MongoDB connection/)
    expect(queryLanguageMismatch('mongodb', 'db.users.find()')).toBeNull()
  })

  it('rejects Mongo shell commands on SQL connections', () => {
    expect(queryLanguageMismatch('postgres', 'db.users.find()')).toMatch(/PostgreSQL connection/)
    expect(queryLanguageMismatch('mysql', 'db.users.find()')).toMatch(/MySQL connection/)
    expect(queryLanguageMismatch('mysql', 'SHOW TABLES')).toBeNull()
    expect(queryLanguageMismatch('postgres', 'SELECT 1')).toBeNull()
  })

  it('allows anything when the connection type is unknown', () => {
    expect(queryLanguageMismatch(undefined, 'db.users.find()')).toBeNull()
  })
})
