import { describe, expect, it } from 'vitest'
import { CONNECTION_COLORS, connectionColor, parseConnectionOptions, safeRunEnabled } from './connection-options'

describe('connection options', () => {
  it('uses the picked color, else the environment default, else none', () => {
    expect(connectionColor({ environment: 'production' })).toBe(CONNECTION_COLORS.red)
    expect(connectionColor({ environment: 'production', color: 'purple' })).toBe(CONNECTION_COLORS.purple)
    expect(connectionColor({ color: 'teal' })).toBe(CONNECTION_COLORS.teal)
    expect(connectionColor({})).toBeNull()
    expect(connectionColor(undefined)).toBeNull()
  })

  it('turns Safe Run on for production unless set otherwise', () => {
    expect(safeRunEnabled({ environment: 'production' })).toBe(true)
    expect(safeRunEnabled({ environment: 'production', safeRun: 'never' })).toBe(false)
    expect(safeRunEnabled({ environment: 'development' })).toBe(false)
    expect(safeRunEnabled({ safeRun: 'always' })).toBe(true)
    expect(safeRunEnabled(undefined)).toBe(false)
  })

  it('reads saved options defensively', () => {
    expect(parseConnectionOptions('{"environment":"production","color":"red","safeRun":"always"}')).toEqual({ environment: 'production', color: 'red', safeRun: 'always' })
    expect(parseConnectionOptions({ environment: 'prod', color: '#fff', safeRun: 1 })).toEqual({})
    expect(parseConnectionOptions('not json')).toEqual({})
    expect(parseConnectionOptions(null)).toEqual({})
    expect(parseConnectionOptions({ ssh: { enabled: true, host: 'h', port: 99999, auth: 'weird' } }).ssh).toEqual({ enabled: true, host: 'h', port: 22, user: '', auth: 'password' })
  })
})
