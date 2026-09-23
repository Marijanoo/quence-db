'use client'

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, ExternalLink, Link2, Loader2, Search, Settings2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  KEY_ALIAS, LOOKUP_PAGE_SIZE, TABLE_COLUMN_NAMES_SQL, defaultDisplayColumns, displayConfigKey, lookupPageSql, lookupRowSql,
  type FkDbType, type FkRef,
} from '@/lib/fk-lookup'
import { SQL_FONT_FAMILY } from '@/components/sql-highlight'

export interface FkLookupTarget { dbType: FkDbType; connectionId: string; database: string }

interface LookupRow { key: string; values: Record<string, string | null> }

async function runQuery(target: FkLookupTarget, sql: string, params: unknown[]) {
  const api = target.dbType === 'mysql' ? window.electronAPI!.mysql : window.electronAPI!.pg
  const res = await api.query(target.connectionId, sql, target.database, params)
  if (!res.ok) throw new Error(res.error)
  return res.rows ?? []
}

const toRow = (r: Record<string, unknown>, columns: string[]): LookupRow => ({
  key: String(r[KEY_ALIAS]),
  values: Object.fromEntries(columns.map(c => [c, r[c] === null || r[c] === undefined ? null : String(r[c])])),
})

function loadDisplayConfig(key: string): string[] | null {
  try {
    const raw = localStorage.getItem(key)
    const parsed = raw ? JSON.parse(raw) : null
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : null
  } catch { return null }
}

function saveDisplayConfig(key: string, columns: string[] | null) {
  try {
    if (columns === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(columns))
  } catch { /* preference only */ }
}

const WIDTH = 460
const HEIGHT = 380

export function FkLookupPopover({ anchor, fk, target, currentValue, editable, onPick, onGoTo, onClose }: {
  anchor: DOMRect
  fk: FkRef
  target: FkLookupTarget
  currentValue: string | null
  editable: boolean
  onPick: (value: string) => void
  onGoTo: () => void
  onClose: () => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const configKey = displayConfigKey(target.connectionId, target.database, fk)

  const [allColumns, setAllColumns] = useState<string[] | null>(null)
  const [displayColumns, setDisplayColumns] = useState<string[] | null>(() => loadDisplayConfig(configKey))
  const [showConfig, setShowConfig] = useState(false)
  const [columnFilter, setColumnFilter] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState<LookupRow[]>([])
  const [hasMore, setHasMore] = useState(true)
  // The search + columns the list currently shows; the first page is loading while it differs
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [currentRow, setCurrentRow] = useState<{ value: string; row: LookupRow } | null>(null)
  const current = currentValue !== null && currentRow?.value === currentValue ? currentRow.row : null
  const [highlight, setHighlight] = useState(0)
  const requestRef = useRef(0)

  const columns = displayColumns ?? []

  // Referenced table's columns; also decides the default display columns when none are saved
  useEffect(() => {
    let cancelled = false
    runQuery(target, TABLE_COLUMN_NAMES_SQL[target.dbType], [fk.refSchema, fk.refTable])
      .then(rs => {
        if (cancelled) return
        const names = rs.map(r => String(r.name))
        setAllColumns(names)
        setDisplayColumns(prev => (prev ?? defaultDisplayColumns(names, fk.refColumn)).filter(c => names.includes(c) && c !== fk.refColumn))
      })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) })
    return () => { cancelled = true }
  }, [target, fk])

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 250)
    return () => clearTimeout(t)
  }, [searchInput])

  const pageKey = displayColumns === null ? null : JSON.stringify([displayColumns, search])
  const loading = (pageKey !== null && loadedFor !== pageKey) || loadingMore

  const fetchPage = useCallback(async (cursor: string | null) => {
    const q = lookupPageSql(target.dbType, fk, displayColumns ?? [], { cursor, search })
    return (await runQuery(target, q.sql, q.params)).map(r => toRow(r, displayColumns ?? []))
  }, [target, fk, displayColumns, search])

  // First page whenever the search or the shown columns change; it replaces the list when it arrives
  useEffect(() => {
    if (pageKey === null) return
    const request = ++requestRef.current
    listRef.current?.scrollTo({ top: 0 })
    fetchPage(null)
      .then(page => {
        if (request !== requestRef.current) return
        setRows(page)
        setHasMore(page.length === LOOKUP_PAGE_SIZE)
        setHighlight(0)
        setError(null)
      })
      .catch(err => { if (request === requestRef.current) setError(err instanceof Error ? err.message : String(err)) })
      .finally(() => { if (request === requestRef.current) setLoadedFor(pageKey) })
  }, [fetchPage, pageKey])

  const loadMore = () => {
    if (rows.length === 0) return
    const request = ++requestRef.current
    setLoadingMore(true)
    fetchPage(rows[rows.length - 1].key)
      .then(page => {
        if (request !== requestRef.current) return
        setRows(prev => [...prev, ...page])
        setHasMore(page.length === LOOKUP_PAGE_SIZE)
      })
      .catch(err => { if (request === requestRef.current) setError(err instanceof Error ? err.message : String(err)) })
      .finally(() => setLoadingMore(false))
  }

  useEffect(() => {
    if (currentValue === null || displayColumns === null) return
    let cancelled = false
    const q = lookupRowSql(target.dbType, fk, displayColumns, currentValue)
    runQuery(target, q.sql, q.params)
      .then(rs => { if (!cancelled) setCurrentRow({ value: currentValue, row: rs[0] ? toRow(rs[0], displayColumns) : { key: currentValue, values: {} } }) })
      .catch(() => { /* the current value is a convenience; the list still works */ })
    return () => { cancelled = true }
  }, [target, fk, displayColumns, currentValue])

  const onScroll = () => {
    const el = listRef.current
    if (!el || loading || !hasMore || rows.length === 0) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) loadMore()
  }

  // Close on outside click
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose() }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose])

  // Keep the highlighted row visible
  useLayoutEffect(() => {
    listRef.current?.querySelector(`[data-index="${highlight}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  const pick = (row: LookupRow | undefined) => {
    if (!row || !editable) return
    onPick(row.key)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    // The grid moves its selection on arrow keys at document level; keep these keys in the popup
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) e.stopPropagation()
    if (showConfig) {
      // The column filter handles its own Enter; Escape goes back to the rows
      if (e.key === 'Escape') { e.preventDefault(); setShowConfig(false) }
      return
    }
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(rows.length - 1, h + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(0, h - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); pick(rows[highlight]) }
  }

  const toggleColumn = (column: string, on: boolean) => {
    const next = (allColumns ?? []).filter(c => c !== fk.refColumn && (c === column ? on : columns.includes(c)))
    setDisplayColumns(next)
    saveDisplayConfig(configKey, next)
  }

  // Below the cell, or above it when there's no room
  const top = anchor.bottom + HEIGHT + 8 > window.innerHeight ? Math.max(8, anchor.top - HEIGHT - 4) : anchor.bottom + 4
  const left = Math.min(Math.max(8, anchor.left), window.innerWidth - WIDTH - 8)
  const selectableColumns = (allColumns ?? []).filter(c => c !== fk.refColumn)
  const needle = columnFilter.trim().toLowerCase()
  const filteredColumns = needle ? selectableColumns.filter(c => c.toLowerCase().includes(needle)) : selectableColumns

  const cell = 'px-2 py-1 border-b border-r border-border/60 whitespace-nowrap max-w-[220px] truncate'
  const renderValue = (v: string | null | undefined) =>
    v === null || v === undefined ? <span className="italic text-muted-foreground/50">NULL</span> : v

  return (
    <div
      ref={rootRef}
      onKeyDown={onKeyDown}
      className="fixed z-50 flex flex-col rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl overflow-hidden"
      style={{ top, left, width: WIDTH, height: HEIGHT }}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <Link2 className="h-3.5 w-3.5 text-primary shrink-0" />
        <span className="text-xs font-mono text-foreground truncate flex-1" title={`${fk.column} → ${fk.refSchema}.${fk.refTable}.${fk.refColumn}`}>
          {fk.refTable}.<span className="text-muted-foreground">{fk.refColumn}</span>
        </span>
        <button
          onClick={() => setShowConfig(v => !v)}
          title="Choose extra columns to show"
          className={cn('p-1 rounded hover:bg-accent/30', showConfig ? 'text-primary' : 'text-muted-foreground hover:text-foreground')}
        >
          <Settings2 className="h-3.5 w-3.5" />
        </button>
        <button onClick={onGoTo} title={`Open ${fk.refTable}`} className="flex items-center gap-1 px-1.5 h-6 rounded text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/30">
          <ExternalLink className="h-3 w-3" /> Open {fk.refTable}
        </button>
        <button onClick={onClose} className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/30"><X className="h-3.5 w-3.5" /></button>
      </div>

      {showConfig ? (
        <div className="flex flex-col flex-1 min-h-0">
          <div className="flex flex-col gap-2 px-3 py-2 border-b border-border">
            <span className="text-[11px] text-muted-foreground">
              Columns shown and searched next to <span className="font-mono">{fk.refColumn}</span>. Saved for every foreign key to {fk.refTable}.
            </span>
            {columns.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {columns.map(c => (
                  <span key={c} className="flex items-center gap-1 pl-2 pr-1 h-5 rounded bg-primary/15 text-primary text-[11px] font-mono">
                    {c}
                    <button onClick={() => toggleColumn(c, false)} title={`Remove ${c}`} className="rounded hover:bg-primary/25 p-0.5"><X className="h-2.5 w-2.5" /></button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2 h-7 px-2 rounded border border-border bg-background focus-within:border-primary">
              <Search className="h-3 w-3 text-muted-foreground/60 shrink-0" />
              <input
                autoFocus
                value={columnFilter}
                onChange={e => setColumnFilter(e.target.value)}
                onKeyDown={e => {
                  if (e.key !== 'Enter') return
                  e.preventDefault()
                  const next = filteredColumns.find(c => !columns.includes(c))
                  if (next) { toggleColumn(next, true); setColumnFilter('') }
                }}
                placeholder="Type a column name, Enter to add…"
                className="flex-1 bg-transparent text-xs font-mono outline-none placeholder:text-muted-foreground/40 placeholder:font-sans"
              />
            </div>
          </div>
          <div className="flex-1 overflow-auto py-1">
            {allColumns === null ? (
              <span className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Loading columns…</span>
            ) : filteredColumns.length === 0 ? (
              <span className="block px-3 py-2 text-xs text-muted-foreground">No column matches &ldquo;{columnFilter}&rdquo;</span>
            ) : filteredColumns.map(c => (
              <label key={c} className="flex items-center gap-2 px-3 py-1 text-xs cursor-pointer select-none hover:bg-accent/15">
                <input type="checkbox" className="accent-primary" checked={columns.includes(c)} onChange={e => toggleColumn(c, e.target.checked)} />
                <span className="font-mono">{c}</span>
              </label>
            ))}
          </div>
          <div className="flex justify-between items-center px-3 py-2 border-t border-border">
            <button
              onClick={() => { saveDisplayConfig(configKey, null); setDisplayColumns(defaultDisplayColumns(allColumns ?? [], fk.refColumn)) }}
              className="text-[11px] text-muted-foreground hover:text-foreground"
            >
              Reset to default
            </button>
            <button onClick={() => setShowConfig(false)} className="px-2 h-6 rounded text-[11px] bg-primary text-primary-foreground hover:bg-primary/90">Done</button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 px-3 h-8 border-b border-border">
            <Search className="h-3 w-3 text-muted-foreground/60 shrink-0" />
            <input
              autoFocus
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              placeholder={`Search ${[fk.refColumn, ...columns].join(', ')}…`}
              className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/40"
            />
            {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
          </div>

          <div ref={listRef} onScroll={onScroll} className="flex-1 overflow-auto" style={{ fontFamily: SQL_FONT_FAMILY }}>
            <table className="min-w-full border-collapse text-xs">
              <thead className="sticky top-0 z-10 bg-card">
                <tr>
                  <th className="w-6 border-b border-r border-border" />
                  {[fk.refColumn, ...columns].map(c => (
                    <th key={c} className="px-2 py-1 text-left text-[11px] font-medium font-sans text-muted-foreground border-b border-r border-border whitespace-nowrap">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {current && (
                  <tr className="bg-primary/5">
                    <td className="px-1 border-b-2 border-r border-border/60 text-center">
                      <span className="text-[9px] uppercase font-sans text-primary">now</span>
                    </td>
                    <td className={cn(cell, 'border-b-2 font-semibold text-foreground')}>{current.key}</td>
                    {columns.map(c => (
                      <td key={c} className={cn(cell, 'border-b-2 text-muted-foreground')}>
                        {Object.keys(current.values).length === 0 ? <span className="italic text-muted-foreground/50">not found</span> : renderValue(current.values[c])}
                      </td>
                    ))}
                  </tr>
                )}
                {rows.map((row, i) => (
                  <tr
                    key={row.key}
                    data-index={i}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => pick(row)}
                    className={cn(editable ? 'cursor-pointer' : 'cursor-default', i === highlight ? 'bg-primary/20 text-foreground' : 'text-popover-foreground')}
                  >
                    <td className="px-1 border-b border-r border-border/60 text-center">
                      {row.key === currentValue && <Check className="inline h-3 w-3 text-primary" />}
                    </td>
                    <td className={cn(cell, 'font-semibold')} title={row.key}>{row.key}</td>
                    {columns.map(c => (
                      <td key={c} className={cn(cell, 'text-muted-foreground')} title={row.values[c] ?? 'NULL'}>{renderValue(row.values[c])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {!loading && rows.length === 0 && !error && (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground font-sans">{search ? 'No matching rows' : 'The table is empty'}</div>
            )}
            {loading && (
              <div className="flex justify-center py-2"><Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /></div>
            )}
            {error && <div className="px-3 py-2 text-xs text-red-300 font-sans whitespace-pre-wrap">{error}</div>}
          </div>

          <div className="px-3 py-1.5 border-t border-border text-[10px] text-muted-foreground/70">
            {editable
              ? 'Click or press Enter to use a row. The change is saved with the table (Ctrl+S).'
              : 'Read-only: this table cannot be edited here.'}
          </div>
        </>
      )}
    </div>
  )
}
