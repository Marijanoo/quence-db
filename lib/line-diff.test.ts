import { describe, it, expect } from 'vitest'
import { sideBySideDiff } from './line-diff'

describe('sideBySideDiff', () => {
  it('aligns equal lines and pairs replaced lines as changed', () => {
    expect(sideBySideDiff('a\nb\nc', 'a\nB\nc')).toEqual([
      { left: 0, right: 0, kind: 'same' },
      { left: 1, right: 1, kind: 'changed' },
      { left: 2, right: 2, kind: 'same' },
    ])
  })

  it('shows lines only on one side', () => {
    expect(sideBySideDiff('a\nc', 'a\nb\nc')).toEqual([
      { left: 0, right: 0, kind: 'same' },
      { left: null, right: 1, kind: 'right' },
      { left: 1, right: 2, kind: 'same' },
    ])
    expect(sideBySideDiff('x', '')).toEqual([{ left: 0, right: null, kind: 'left' }])
  })
})
