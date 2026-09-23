import { describe, it, expect } from 'vitest'
import React from 'react'
import { highlightSqlLines, SQL_TOKEN_STYLES } from './sql-highlight'

const styled = (node: React.ReactNode) => React.isValidElement<{ style: React.CSSProperties; children: string }>(node) ? node : null

describe('highlightSqlLines', () => {
  it('splits into lines and styles tokens with the query editor colors', () => {
    const lines = highlightSqlLines("SELECT 'x'::text\n-- note")
    expect(lines).toHaveLength(2)
    const keyword = lines[0].map(styled).find(n => n?.props.children === 'SELECT')
    expect(keyword?.props.style).toEqual(SQL_TOKEN_STYLES['tok-keyword'])
    const str = lines[0].map(styled).find(n => n?.props.children === "'x'")
    expect(str?.props.style).toEqual(SQL_TOKEN_STYLES['tok-string'])
    expect(styled(lines[1][0])?.props.style).toEqual(SQL_TOKEN_STYLES['tok-comment'])
  })
})
