import { describe, expect, it } from 'vitest'
import {
  buildAlterDatabase, buildCreateDatabase, buildCreateSchema, buildDropDatabase, buildDropExtension, buildInstallExtension,
  buildUpdateExtension, maintenanceSql, parseExtensions, type DatabaseSettings,
} from './database-admin'

const base: DatabaseSettings = { name: 'shop', owner: '', encoding: '', template: '', connectionLimit: -1, comment: '' }

describe('buildCreateDatabase', () => {
  it('creates with only the options that were set', () => {
    expect(buildCreateDatabase(base)).toEqual(['CREATE DATABASE "shop"'])
    expect(buildCreateDatabase({ ...base, name: 'My "Shop"', owner: 'app', template: 'template0', encoding: 'UTF8', connectionLimit: 20, comment: "Bob's" })).toEqual([
      `CREATE DATABASE "My ""Shop""" OWNER = "app" TEMPLATE = "template0" ENCODING = 'UTF8' CONNECTION LIMIT = 20`,
      `COMMENT ON DATABASE "My ""Shop""" IS 'Bob''s'`,
    ])
  })

  it('needs a name', () => {
    expect(() => buildCreateDatabase({ ...base, name: '  ' })).toThrow(/name/)
  })
})

describe('buildAlterDatabase', () => {
  it('renames first, then changes the rest under the new name', () => {
    const before = { ...base, owner: 'postgres', comment: 'old' }
    expect(buildAlterDatabase(before, { ...before, name: 'store', owner: 'app', connectionLimit: 5, comment: '' })).toEqual([
      'ALTER DATABASE "shop" RENAME TO "store"',
      'ALTER DATABASE "store" OWNER TO "app"',
      'ALTER DATABASE "store" WITH CONNECTION LIMIT 5',
      'COMMENT ON DATABASE "store" IS NULL',
    ])
  })

  it('is empty when nothing changed', () => {
    expect(buildAlterDatabase(base, { ...base })).toEqual([])
  })
})

describe('other statements', () => {
  it('drops, optionally forcing other sessions off', () => {
    expect(buildDropDatabase('shop', false)).toBe('DROP DATABASE "shop"')
    expect(buildDropDatabase('shop', true)).toBe('DROP DATABASE "shop" WITH (FORCE)')
  })

  it('creates schemas', () => {
    expect(buildCreateSchema('sales', '')).toBe('CREATE SCHEMA "sales"')
    expect(buildCreateSchema('sales', 'app')).toBe('CREATE SCHEMA "sales" AUTHORIZATION "app"')
  })

  it('manages extensions', () => {
    expect(buildInstallExtension('uuid-ossp', '', false)).toBe('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')
    expect(buildInstallExtension('postgis_topology', 'gis', true)).toBe('CREATE EXTENSION IF NOT EXISTS "postgis_topology" SCHEMA "gis" CASCADE')
    expect(buildDropExtension('pg_trgm', true)).toBe('DROP EXTENSION "pg_trgm" CASCADE')
    expect(buildUpdateExtension('pg_trgm')).toBe('ALTER EXTENSION "pg_trgm" UPDATE')
    expect(parseExtensions([{ name: 'plpgsql', default_version: '1.0', installed_version: '1.0', schema: 'pg_catalog', comment: null }]))
      .toEqual([{ name: 'plpgsql', defaultVersion: '1.0', installedVersion: '1.0', schema: 'pg_catalog', comment: '' }])
  })

  it('runs maintenance on the database', () => {
    expect(maintenanceSql('vacuumAnalyze', 'shop')).toBe('VACUUM (ANALYZE)')
    expect(maintenanceSql('reindex', 'my db')).toBe('REINDEX DATABASE "my db"')
  })
})
