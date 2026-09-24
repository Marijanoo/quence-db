// Runs a SQL file against a database: reads it in chunks, splits it (lib/sql-script) and executes
// each statement on one session, so SET search_path and friends carry over between statements.
//
// With `transaction` the whole file is one transaction the caller commits or rolls back; the
// script's own BEGIN/COMMIT are skipped then (they would end it early). `continueOnError` records
// failures and goes on; inside a PostgreSQL transaction that needs a savepoint per statement,
// because one error would otherwise abort everything after it.

import { copyToInsert, SqlScriptSplitter, type ScriptDialect, type ScriptItem } from './sql-script'

export interface ImportSession {
  execute(sql: string, params?: unknown[]): Promise<{ rowCount?: number | null }>
}

export interface SqlImportOptions {
  dialect: ScriptDialect
  transaction: boolean
  continueOnError: boolean
  maxRecordedErrors?: number
}

export interface ImportError { line: number; message: string; sql: string }

export interface ImportProgress {
  bytes: number
  statements: number   // executed successfully
  copyRows: number     // rows loaded from COPY blocks
  failed: number
  skipped: string[]    // psql commands and transaction statements that were not run
}

export interface ImportResult extends ImportProgress {
  errors: ImportError[]
  stoppedAt?: ImportError  // the error that stopped the import (when not continuing on errors)
}

export class ImportCancelled extends Error {
  constructor() { super('Import cancelled') }
}

export type ChunkReader = () => Promise<{ text: string; done: boolean; position: number }>

const TRANSACTION_CONTROL = /^(BEGIN(\s+(WORK|TRANSACTION))?|START\s+TRANSACTION\b[^;]*|COMMIT(\s+(WORK|TRANSACTION))?|END(\s+(WORK|TRANSACTION))?|ROLLBACK(\s+(WORK|TRANSACTION))?|ABORT)$/i

// PostgreSQL allows 65535 parameters per statement
const MAX_PARAMS = 60000

const preview = (sql: string) => sql.length > 300 ? sql.slice(0, 300) + '…' : sql
const messageOf = (err: unknown) => err instanceof Error ? err.message : String(err)

export async function runSqlImport(read: ChunkReader, session: ImportSession, opts: SqlImportOptions, hooks: {
  onProgress?: (p: ImportProgress) => void
  isCancelled?: () => boolean
} = {}): Promise<ImportResult> {
  const splitter = new SqlScriptSplitter(opts.dialect)
  const maxErrors = opts.maxRecordedErrors ?? 200
  const savepoints = opts.transaction && opts.continueOnError && opts.dialect === 'postgres'
  const result: ImportResult = { bytes: 0, statements: 0, copyRows: 0, failed: 0, skipped: [], errors: [] }

  const fail = (line: number, sql: string, err: unknown) => {
    const error = { line, message: messageOf(err), sql: preview(sql) }
    result.failed++
    if (result.errors.length < maxErrors) result.errors.push(error)
    if (!opts.continueOnError) {
      result.stoppedAt = error
      return true
    }
    return false
  }

  const run = async (sql: string, params?: unknown[]) => {
    if (!savepoints) return session.execute(sql, params)
    await session.execute('SAVEPOINT quence_import')
    try {
      const res = await session.execute(sql, params)
      await session.execute('RELEASE SAVEPOINT quence_import')
      return res
    } catch (err) {
      await session.execute('ROLLBACK TO SAVEPOINT quence_import')
      throw err
    }
  }

  // Returns true when the import has to stop
  const handle = async (item: ScriptItem): Promise<boolean> => {
    if (hooks.isCancelled?.()) throw new ImportCancelled()
    switch (item.kind) {
      case 'meta':
        result.skipped.push(`line ${item.line}: ${item.text}`)
        return false
      case 'error':
        return fail(item.line, '', new Error(item.message))
      case 'statement':
        if (opts.transaction && TRANSACTION_CONTROL.test(item.sql)) {
          result.skipped.push(`line ${item.line}: ${item.sql}`)
          return false
        }
        try {
          await run(item.sql)
          result.statements++
          return false
        } catch (err) {
          return fail(item.line, item.sql, err)
        }
      case 'copy': {
        const width = Math.max(1, item.columns?.length ?? item.rows[0]?.length ?? 1)
        const perStatement = Math.max(1, Math.floor(MAX_PARAMS / width))
        for (let i = 0; i < item.rows.length; i += perStatement) {
          const rows = item.rows.slice(i, i + perStatement)
          const { sql, params } = copyToInsert(item.table, item.columns, rows)
          try {
            await run(sql, params)
            result.copyRows += rows.length
          } catch (err) {
            if (fail(item.line, `COPY ${item.table} (${rows.length} rows)`, err)) return true
          }
        }
        return false
      }
    }
  }

  const report = () => hooks.onProgress?.({ bytes: result.bytes, statements: result.statements, copyRows: result.copyRows, failed: result.failed, skipped: result.skipped })

  for (;;) {
    if (hooks.isCancelled?.()) throw new ImportCancelled()
    const chunk = await read()
    const items = chunk.done ? [...splitter.push(chunk.text), ...splitter.end()] : splitter.push(chunk.text)
    result.bytes = chunk.position
    for (const item of items) {
      if (await handle(item)) { report(); return result }
    }
    report()
    if (chunk.done) return result
  }
}
