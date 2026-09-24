'use client'

import React, { useEffect, useMemo, useRef } from 'react'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { sql, PostgreSQL } from '@codemirror/lang-sql'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting } from '@codemirror/language'
import { classHighlighter, highlightCode } from '@lezer/highlight'

// Single source of truth for SQL token colors: used by the query editor theme and by the static
// highlighter below, so SQL looks the same wherever it is shown.
export const SQL_TOKEN_STYLES: Record<string, React.CSSProperties> = {
  'tok-keyword': { color: 'var(--db-keyword)', fontWeight: 600 },
  'tok-string': { color: 'var(--db-string)' },
  'tok-string2': { color: 'var(--db-string)' },
  'tok-number': { color: 'var(--db-number)' },
  'tok-bool': { color: 'var(--db-number)' },
  'tok-operator': { color: 'var(--db-operator)' },
  'tok-comment': { color: 'var(--db-comment)', fontStyle: 'italic' },
  'tok-lineComment': { color: 'var(--db-comment)', fontStyle: 'italic' },
  'tok-blockComment': { color: 'var(--db-comment)', fontStyle: 'italic' },
  'tok-typeName': { color: 'var(--db-type)' },
  'tok-className': { color: 'var(--db-type)' },
  'tok-variableName': { color: 'var(--foreground)' },
  'tok-propertyName': { color: 'var(--foreground)' },
}

export const SQL_FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'

// Autocomplete popup styled like the app's popovers; each kind of suggestion gets a small tinted badge
const tint = (color: string, pct = 16) => `color-mix(in oklch, ${color} ${pct}%, transparent)`
const COMPLETION_BADGES: Record<string, { label: string; color: string }> = {
  keyword: { label: 'K', color: 'var(--db-keyword)' },
  function: { label: 'ƒ', color: 'oklch(0.72 0.16 305)' },
  method: { label: 'ƒ', color: 'oklch(0.72 0.16 305)' },
  type: { label: 'T', color: 'var(--db-type)' },
  class: { label: 'T', color: 'var(--db-type)' },
  property: { label: 'C', color: 'var(--db-string)' },
  namespace: { label: 'S', color: 'var(--db-number)' },
  variable: { label: 'V', color: 'var(--muted-foreground)' },
  constant: { label: 'V', color: 'var(--muted-foreground)' },
  text: { label: '·', color: 'var(--muted-foreground)' },
}

const popupTheme = {
  '.cm-tooltip': {
    background: 'var(--popover)',
    color: 'var(--popover-foreground)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    boxShadow: '0 12px 32px -12px rgb(0 0 0 / 0.55)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete': { padding: '4px', overflow: 'hidden' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: SQL_FONT_FAMILY,
    fontSize: '12px',
    maxHeight: '16em',
    minWidth: '260px',
    maxWidth: '520px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '3px 8px',
    borderRadius: '5px',
    lineHeight: '1.55',
    color: 'var(--popover-foreground)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    background: tint('var(--primary)', 24),
    color: 'var(--foreground)',
  },
  '.cm-completionLabel': { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis' },
  '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--primary)', fontWeight: 600 },
  '.cm-completionDetail': {
    marginLeft: 'auto',
    paddingLeft: '12px',
    fontStyle: 'normal',
    fontSize: '11px',
    color: 'var(--muted-foreground)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: '220px',
  },
  '.cm-completionIcon': {
    width: '16px',
    height: '16px',
    padding: '0',
    marginRight: '0',
    flex: '0 0 16px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '4px',
    fontFamily: 'ui-sans-serif, system-ui, sans-serif',
    fontSize: '10px',
    fontWeight: 700,
    opacity: '1',
    boxSizing: 'border-box',
  },
  ...Object.fromEntries(Object.entries(COMPLETION_BADGES).flatMap(([type, badge]) => [
    [`.cm-completionIcon-${type}`, { color: badge.color, background: tint(badge.color) }],
    [`.cm-completionIcon-${type}:after`, { content: `'${badge.label}'` }],
  ])),
  '.cm-tooltip.cm-completionInfo': {
    padding: '6px 10px',
    fontFamily: SQL_FONT_FAMILY,
    fontSize: '11px',
    color: 'var(--muted-foreground)',
    maxWidth: '360px',
  },
}

export const quenceTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    fontFamily: SQL_FONT_FAMILY,
    background: 'var(--background)',
    color: 'var(--foreground)',
  },
  '.cm-content': { padding: '12px', caretColor: 'var(--primary)' },
  '.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-line': { lineHeight: '1.6' },
  '.cm-cursor': { borderLeftColor: 'var(--primary)' },
  '.cm-selectionBackground, ::selection': { background: 'color-mix(in oklch, var(--primary) 20%, transparent)' },
  '.cm-activeLine': { background: 'oklch(1 0 0 / 0.03)' },
  ...Object.fromEntries(Object.entries(SQL_TOKEN_STYLES).map(([cls, style]) => [`.${cls}`, style as Record<string, string | number>])),
  ...popupTheme,
  // Schema-aware highlighting (see lib/sql-completion.ts): known tables look like types, known
  // columns like plain text, whatever the dialect's keyword list says. Covers the mark being
  // either inside or outside the syntax-highlighting span.
  '.cm-sql-table, .cm-sql-table [class*="tok-"]': { color: 'var(--db-type)', fontWeight: 'normal' },
  '.cm-sql-column, .cm-sql-column [class*="tok-"]': { color: 'var(--foreground)', fontWeight: 'normal' },
  // Ctrl+hover on a table or function name: it opens on click
  '.cm-sql-link, .cm-sql-link *': { textDecoration: 'underline', textUnderlineOffset: '2px', cursor: 'pointer' },
  // MongoDB shell tokens (see lib/mongo-completion.ts), in the same palette as SQL
  '.cm-mongo-keyword, .cm-mongo-keyword [class*="tok-"]': { color: 'var(--db-keyword)', fontWeight: 600 },
  '.cm-mongo-type, .cm-mongo-type [class*="tok-"]': { color: 'var(--db-type)', fontWeight: 'normal' },
  '.cm-mongo-operator, .cm-mongo-operator [class*="tok-"]': { color: 'var(--db-operator)', fontWeight: 600 },
}, { dark: true })

function tokenStyle(classes: string): React.CSSProperties | undefined {
  if (!classes) return undefined
  return classes.split(' ').reduce<React.CSSProperties>((acc, c) => ({ ...acc, ...SQL_TOKEN_STYLES[c] }), {})
}

// Highlights the whole text at once (so multi-line constructs parse correctly) and returns the
// rendered tokens grouped per line.
export function highlightSqlLines(text: string): React.ReactNode[][] {
  const lines: React.ReactNode[][] = [[]]
  const tree = PostgreSQL.language.parser.parse(text)
  let key = 0
  highlightCode(
    text,
    tree,
    classHighlighter,
    (chunk, classes) => {
      const style = tokenStyle(classes)
      lines[lines.length - 1].push(style ? <span key={key++} style={style}>{chunk}</span> : chunk)
    },
    () => lines.push([]),
  )
  return lines
}

export function SqlHighlight({ sql: text, className }: { sql: string; className?: string }) {
  const lines = useMemo(() => highlightSqlLines(text), [text])
  return (
    <pre className={className} style={{ fontFamily: SQL_FONT_FAMILY }}>
      {lines.map((tokens, i) => <React.Fragment key={i}>{tokens}{i < lines.length - 1 ? '\n' : null}</React.Fragment>)}
    </pre>
  )
}

// Editable SQL with the same highlighting and theme as the query editor
export function SqlCodeEditor({ value, onChange, readOnly = false }: { value: string; onChange?: (value: string) => void; readOnly?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange }, [onChange])

  useEffect(() => {
    if (!hostRef.current) return
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          sql({ dialect: PostgreSQL, upperCaseKeywords: true }),
          syntaxHighlighting(classHighlighter),
          quenceTheme,
          EditorView.lineWrapping,
          EditorState.readOnly.of(readOnly),
          EditorView.updateListener.of(u => { if (u.docChanged) onChangeRef.current?.(u.state.doc.toString()) }),
        ],
      }),
    })
    viewRef.current = view
    return () => { view.destroy(); viewRef.current = null }
    // The editor owns its document after mount; external value changes are synced below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly])

  useEffect(() => {
    const view = viewRef.current
    if (view && view.state.doc.toString() !== value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
    }
  }, [value])

  return <div ref={hostRef} className="h-full min-h-0 overflow-hidden" />
}
