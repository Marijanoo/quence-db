import { describe, it, expect, vi, afterEach } from 'vitest'
import { cn, generateId } from './utils'

describe('cn', () => {
  it('merges class names', () => {
    expect(cn('a', 'b')).toBe('a b')
  })

  it('resolves conflicting tailwind classes to the last one', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4')
  })

  it('drops falsy values', () => {
    expect(cn('a', false, null, undefined, 'b')).toBe('a b')
  })
})

describe('generateId', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns a UUID-shaped string via crypto.randomUUID', () => {
    const id = generateId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  })

  it('returns unique values across calls', () => {
    const a = generateId()
    const b = generateId()
    expect(a).not.toBe(b)
  })

  it('falls back to a manual UUID when crypto.randomUUID is unavailable', () => {
    vi.stubGlobal('crypto', {})
    const id = generateId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })
})
