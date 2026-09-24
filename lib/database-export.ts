// Full database dumps as SQL files, for PostgreSQL (one or more schemas) and MySQL.
//
// PostgreSQL: the structure comes from the Structure Sync snapshot (tables, keys, indexes, enums,
// views, extensions) plus what it doesn't cover: domains, composite types, standalone sequences,
// functions and procedures, triggers, materialized views and comments. The file is ordered so it
// loads into an empty database: types → sequences → functions → tables → data → sequence values
// → indexes and constraints → foreign keys → views → table-typed functions → triggers → comments.
// Foreign keys come after the data, so rows load in any order.
//
// MySQL: SHOW CREATE gives the exact DDL. Foreign key checks are off while loading; views,
// routines and triggers follow the data (triggers must not fire on restored rows).
//
// All rows are read from one snapshot, so the dump is consistent even while the database changes.

import {
  EXPORT_COLUMNS_SQL, EXPORT_PRIMARY_KEY_SQL, exportSelectSql, insertStatements, parseExportColumns,
  resetSequenceStatements, streamRows, type ExportSnapshot, ExportCancelled,
} from './table-export'
import {
  compareSchemas, fetchSchemaSnapshot, orderedStatements, Phase, quoteIdent, snapshotSearchPath, type SchemaSnapshot,
} from './structure-sync'

export type DumpDbType = 'postgres' | 'mysql'
type Row = Record<string, unknown>

export interface DatabaseExportIO {
  // Metadata. searchPath (PostgreSQL) makes pg_get_*def() leave that schema's names unqualified.
  query(sql: string, params?: unknown[], searchPath?: string): Promise<Row[]>
  openSnapshot(): Promise<ExportSnapshot>
  write(text: string): Promise<void>
}

export interface DatabaseExportJob {
  dbType: DumpDbType
  database: string
  schemas: string[]        // PostgreSQL; ignored for MySQL (the database is the schema)
  structure: boolean
  data: boolean
  dropObjects: boolean     // DROP … IF EXISTS before creating
  transaction: boolean     // PostgreSQL: load all or nothing
  rowsPerStatement: number
  batchSize?: number
}

export interface DatabaseExportProgress {
  table: string
  tablesDone: number
  tablesTotal: number
  rows: number             // rows written so far, all tables
}

const EMPTY_SNAPSHOT: SchemaSnapshot = { tables: [], views: [], enums: [], extensions: [] }
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`
const qm = (s: string) => '`' + s.replace(/`/g, '``') + '`'
const end = (sql: string) => { const t = sql.trim(); return t.endsWith(';') ? t : t + ';' }
const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 't'

// ── PostgreSQL metadata the Structure Sync snapshot doesn't cover ──────────────

export const PG_DUMP_QUERIES = {
  domains: `
    SELECT t.typname AS name, format_type(t.typbasetype, t.typtypmod) AS base, t.typnotnull AS not_null, t.typdefault AS default_expr,
      (SELECT string_agg('CONSTRAINT ' || quote_ident(c.conname) || ' ' || pg_get_constraintdef(c.oid), ' ' ORDER BY c.conname)
         FROM pg_constraint c WHERE c.contypid = t.oid) AS constraints
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = $1 AND t.typtype = 'd'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
    ORDER BY t.typname`,
  composites: `
    SELECT t.typname AS name,
      string_agg(quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod), ', ' ORDER BY a.attnum) AS attributes
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    JOIN pg_class c ON c.oid = t.typrelid AND c.relkind = 'c'
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = $1 AND t.typtype = 'c'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
    GROUP BY t.typname ORDER BY t.typname`,
  // Sequences not owned by a serial/identity column (those come with their table)
  sequences: `
    SELECT s.sequencename AS name, s.data_type::text AS type, s.start_value::text AS start_value, s.min_value::text AS min_value,
      s.max_value::text AS max_value, s.increment_by::text AS increment_by, s.cycle, s.cache_size::text AS cache_size,
      s.last_value::text AS last_value
    FROM pg_sequences s
    JOIN pg_namespace n ON n.nspname = s.schemaname
    JOIN pg_class c ON c.relname = s.sequencename AND c.relnamespace = n.oid
    WHERE s.schemaname = $1
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a', 'i', 'e'))
    ORDER BY 1`,
  functions: `
    SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS identity_args, p.prokind AS kind,
      pg_get_functiondef(p.oid) AS definition,
      EXISTS (SELECT 1 FROM pg_type t JOIN pg_class c ON c.oid = t.typrelid AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
              WHERE t.oid = p.prorettype OR t.oid = ANY (p.proargtypes)) AS uses_table_type
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
    ORDER BY p.proname, 2`,
  triggers: `
    SELECT t.tgname AS name, c.relname AS table_name, pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND NOT t.tgisinternal
    ORDER BY c.relname, t.tgname`,
  matviews: `
    SELECT c.relname AS name, pg_get_viewdef(c.oid) AS definition,
      (SELECT string_agg(pg_get_indexdef(i.indexrelid), E'\\n' ORDER BY i.indexrelid) FROM pg_index i WHERE i.indrelid = c.oid) AS indexes
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relkind = 'm'
    ORDER BY c.relname`,
  comments: `
    SELECT c.relname AS object_name, c.relkind AS kind, a.attname AS column_name, d.description AS comment
    FROM pg_description d
    JOIN pg_class c ON c.oid = d.objoid AND d.classoid = 'pg_class'::regclass
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.objsubid
    WHERE n.nspname = $1 AND c.relkind IN ('r', 'v', 'm') AND (d.objsubid = 0 OR a.attname IS NOT NULL)
    ORDER BY c.relname, d.objsubid`,
  // Left out by the snapshot; listed in the dump so nothing goes missing silently
  skipped: `
    SELECT c.relname AS name, CASE c.relkind WHEN 'p' THEN 'partitioned table' WHEN 'f' THEN 'foreign table' ELSE 'partition' END AS what
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND (c.relkind IN ('p', 'f') OR (c.relkind = 'r' AND c.relispartition))
    ORDER BY 1`,
} as const

// A function written with a SQL-standard body (BEGIN ATOMIC / RETURN …) is checked when it is
// created, so it has to come after the tables it uses, like functions over table row types.
export function isLateFunction(row: Row): boolean {
  if (truthy(row.uses_table_type)) return true
  const def = String(row.definition ?? '')
  return !/\bAS\s+(\$[\w]*\$|')/i.test(def)
}

interface PgSchemaDump {
  schema: string
  snapshot: SchemaSnapshot
  extra: Record<keyof typeof PG_DUMP_QUERIES, Row[]>
}

async function loadPgSchema(io: DatabaseExportIO, schema: string): Promise<PgSchemaDump> {
  const searchPath = snapshotSearchPath(schema)
  const snapshot = await fetchSchemaSnapshot((sql, params) => io.query(sql, params, searchPath) as Promise<Record<string, any>[]>, schema)
  const extra = {} as PgSchemaDump['extra']
  for (const key of Object.keys(PG_DUMP_QUERIES) as (keyof typeof PG_DUMP_QUERIES)[]) {
    extra[key] = await io.query(PG_DUMP_QUERIES[key], [schema], searchPath)
  }
  return { schema, snapshot, extra }
}

// The structure statements of a schema, grouped by the phase they belong to
function pgStructure(dump: PgSchemaDump) {
  const items = compareSchemas(dump.snapshot, EMPTY_SNAPSHOT, dump.schema, { tables: true, views: true, enums: true, dropColumns: false })
  const statements = orderedStatements(items.filter(i => i.kind !== 'extension'))
  const phase = (...phases: Phase[]) => statements.filter(s => phases.includes(s.phase)).map(s => end(s.sql))
  return {
    enums: phase(Phase.Enums),
    tables: phase(Phase.CreateTables),
    indexes: phase(Phase.AlterColumns, Phase.AddConstraintsAndIndexes),
    foreignKeys: phase(Phase.AddForeignKeys),
    views: phase(Phase.CreateViews),
  }
}

function pgSequenceSql(schema: string, r: Row): { create: string; setval: string | null } {
  const name = `${quoteIdent(schema)}.${quoteIdent(String(r.name))}`
  const create = `CREATE SEQUENCE ${name} AS ${r.type} INCREMENT BY ${r.increment_by} MINVALUE ${r.min_value} MAXVALUE ${r.max_value} START WITH ${r.start_value} CACHE ${r.cache_size}${truthy(r.cycle) ? ' CYCLE' : ''};`
  const setval = r.last_value === null || r.last_value === undefined ? null : `SELECT setval(${lit(name)}, ${r.last_value}, true);`
  return { create, setval }
}

async function pgDump(io: DatabaseExportIO, job: DatabaseExportJob, hooks: DumpHooks): Promise<{ tables: number; rows: number }> {
  const write = io.write
  const dumps: PgSchemaDump[] = []
  for (const schema of job.schemas) {
    hooks.check()
    dumps.push(await loadPgSchema(io, schema))
  }
  const setPath = (schema: string) => `SET search_path TO ${snapshotSearchPath(schema)};`
  const section = async (title: string, perSchema: (d: PgSchemaDump) => string[]) => {
    const blocks = dumps.map(d => ({ d, lines: perSchema(d) })).filter(b => b.lines.length > 0)
    if (blocks.length === 0) return
    let text = `\n-- ${title}\n`
    for (const b of blocks) text += `\n${setPath(b.d.schema)}\n${b.lines.join('\n\n')}\n`
    await write(text)
  }
  const structure = new Map(dumps.map(d => [d.schema, pgStructure(d)]))
  const tablesTotal = dumps.reduce((n, d) => n + d.snapshot.tables.length, 0)

  let head = `-- QuenceDB dump of database ${quoteIdent(job.database)}, schema${job.schemas.length === 1 ? '' : 's'} ${job.schemas.map(quoteIdent).join(', ')}\n`
  head += `-- ${job.structure ? (job.data ? 'Structure and data' : 'Structure only') : 'Data only'}, ${hooks.now.toISOString()}\n`
  const skipped = dumps.flatMap(d => d.extra.skipped.map(r => `--   ${d.schema}.${r.name} (${r.what})`))
  if (skipped.length) head += `--\n-- Not included (not supported yet):\n${skipped.join('\n')}\n`
  head += `
SET statement_timeout = 0;
SET lock_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET client_min_messages = warning;
`
  if (job.transaction) head += '\nBEGIN;\n'
  await write(head)

  if (job.structure) {
    // Schemas and extensions (extensions are database-wide; install each where it lives now)
    const schemaSql = job.schemas.map(s => `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(s)};`)
    const extensions = new Map<string, string>()
    for (const d of dumps) for (const e of d.snapshot.extensions) extensions.set(e.name, e.schema)
    for (const s of new Set(extensions.values())) if (!job.schemas.includes(s)) schemaSql.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(s)};`)
    let text = `\n-- Schemas\n${schemaSql.join('\n')}\n`
    if (extensions.size) text += `\n-- Extensions\n${[...extensions].map(([name, schema]) => `CREATE EXTENSION IF NOT EXISTS ${quoteIdent(name)} SCHEMA ${quoteIdent(schema)};`).join('\n')}\n`
    await write(text)

    if (job.dropObjects) {
      await section('Drop existing objects', d => [
        ...d.snapshot.views.map(v => `DROP VIEW IF EXISTS ${quoteIdent(v.name)} CASCADE;`),
        ...d.extra.matviews.map(m => `DROP MATERIALIZED VIEW IF EXISTS ${quoteIdent(String(m.name))} CASCADE;`),
        ...d.snapshot.tables.map(t => `DROP TABLE IF EXISTS ${quoteIdent(t.name)} CASCADE;`),
        ...d.extra.functions.map(f => `DROP ${f.kind === 'p' ? 'PROCEDURE' : 'FUNCTION'} IF EXISTS ${quoteIdent(String(f.name))}(${f.identity_args}) CASCADE;`),
        ...d.extra.sequences.map(s => `DROP SEQUENCE IF EXISTS ${quoteIdent(String(s.name))} CASCADE;`),
        ...[...d.extra.composites, ...d.extra.domains, ...d.snapshot.enums].map(t => `DROP TYPE IF EXISTS ${quoteIdent(String(t.name))} CASCADE;`),
      ])
    }

    await section('Types', d => [
      ...structure.get(d.schema)!.enums,
      ...d.extra.domains.map(r => `CREATE DOMAIN ${quoteIdent(String(r.name))} AS ${r.base}${r.default_expr ? ` DEFAULT ${r.default_expr}` : ''}${truthy(r.not_null) ? ' NOT NULL' : ''}${r.constraints ? ` ${r.constraints}` : ''};`),
      ...d.extra.composites.map(r => `CREATE TYPE ${quoteIdent(String(r.name))} AS (${r.attributes});`),
    ])
    await section('Sequences', d => d.extra.sequences.map(r => pgSequenceSql(d.schema, r).create))
    await section('Functions', d => d.extra.functions.filter(f => !isLateFunction(f)).map(f => end(String(f.definition))))
    await section('Tables', d => structure.get(d.schema)!.tables)
  }

  // ── Data ──
  let rows = 0
  let tablesDone = 0
  if (job.data) {
    const snapshot = await io.openSnapshot()
    try {
      for (const d of dumps) {
        for (const t of d.snapshot.tables) {
          hooks.check()
          hooks.onProgress({ table: `${d.schema}.${t.name}`, tablesDone, tablesTotal, rows })
          const columns = parseExportColumns('postgres', await io.query(EXPORT_COLUMNS_SQL.postgres, [d.schema, t.name]))
          const primaryKey = (await io.query(EXPORT_PRIMARY_KEY_SQL.postgres, [d.schema, t.name])).map(r => String(r.name))
          const select = exportSelectSql('postgres', d.schema, t.name, columns, primaryKey)
          let wroteHeader = false
          await streamRows(snapshot, 'postgres', select, job.batchSize ?? 2000, async batch => {
            const text = insertStatements('postgres', t.name, columns, batch, job.rowsPerStatement).join('\n') + '\n'
            await write((wroteHeader ? '' : `\n-- Data: ${d.schema}.${t.name}\n${setPath(d.schema)}\n`) + text)
            wroteHeader = true
            rows += batch.length
            hooks.onProgress({ table: `${d.schema}.${t.name}`, tablesDone, tablesTotal, rows })
          }, hooks.check)
          const resets = resetSequenceStatements('postgres', t.name, columns)
          if (resets.length) await write(`${wroteHeader ? '' : `\n${setPath(d.schema)}\n`}${resets.join('\n')}\n`)
          tablesDone++
        }
      }
    } finally {
      await snapshot.close()
    }
    await section('Sequence values', d => d.extra.sequences.map(r => pgSequenceSql(d.schema, r).setval).filter((s): s is string => !!s))
  }

  if (job.structure) {
    await section('Indexes and constraints', d => structure.get(d.schema)!.indexes)
    await section('Foreign keys', d => structure.get(d.schema)!.foreignKeys)
    await section('Views', d => structure.get(d.schema)!.views)
    await section('Materialized views', d => d.extra.matviews.flatMap(m => [
      `CREATE MATERIALIZED VIEW ${quoteIdent(String(m.name))} AS\n${String(m.definition).trim().replace(/;$/, '')}\nWITH ${job.data ? '' : 'NO '}DATA;`,
      ...String(m.indexes ?? '').split('\n').filter(Boolean).map(end),
    ]))
    await section('Functions using table types', d => d.extra.functions.filter(isLateFunction).map(f => end(String(f.definition))))
    await section('Triggers', d => d.extra.triggers.map(t => end(String(t.definition))))
    await section('Comments', d => d.extra.comments.map(c => {
      const kind = c.kind === 'v' ? 'VIEW' : c.kind === 'm' ? 'MATERIALIZED VIEW' : 'TABLE'
      return c.column_name
        ? `COMMENT ON COLUMN ${quoteIdent(String(c.object_name))}.${quoteIdent(String(c.column_name))} IS ${lit(String(c.comment))};`
        : `COMMENT ON ${kind} ${quoteIdent(String(c.object_name))} IS ${lit(String(c.comment))};`
    }))
  }

  if (job.transaction) await write('\nCOMMIT;\n')
  hooks.onProgress({ table: '', tablesDone, tablesTotal, rows })
  return { tables: tablesTotal, rows }
}

// ── MySQL ─────────────────────────────────────────────────────────────────────

export const MYSQL_DUMP_QUERIES = {
  tables: `SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
  viewUsage: `SELECT VIEW_NAME AS view_name, TABLE_NAME AS table_name FROM information_schema.VIEW_TABLE_USAGE WHERE VIEW_SCHEMA = ? AND TABLE_SCHEMA = ?`,
  routines: `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_TYPE, ROUTINE_NAME`,
  triggers: `SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY EVENT_OBJECT_TABLE, ACTION_ORDER`,
} as const

// DEFINER=`user`@`host` would fail wherever that user doesn't exist; without it the importing
// user becomes the definer
export function stripDefiner(sql: string): string {
  return sql.replace(/\s*DEFINER\s*=\s*(`[^`]*`|'[^']*'|[^\s@]+)@(`[^`]*`|'[^']*'|[^\s]+)/i, '')
}

// SHOW CREATE VIEW qualifies every name with the database; drop that so the view loads anywhere
export function unqualifyDatabase(sql: string, database: string): string {
  return sql.split(`${qm(database)}.`).join('')
}

// Views after the views they read from (information_schema.VIEW_TABLE_USAGE, MySQL 8.0.13+)
export function orderViews(views: string[], usage: { view_name: string; table_name: string }[]): string[] {
  const deps = new Map(views.map(v => [v, new Set<string>()]))
  for (const u of usage) if (deps.has(u.view_name) && deps.has(u.table_name) && u.view_name !== u.table_name) deps.get(u.view_name)!.add(u.table_name)
  const out: string[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (v: string) => {
    if (state.get(v)) return
    state.set(v, 'visiting')
    for (const d of deps.get(v) ?? []) visit(d)
    state.set(v, 'done')
    out.push(v)
  }
  views.forEach(visit)
  return out
}

async function mysqlDump(io: DatabaseExportIO, job: DatabaseExportJob, hooks: DumpHooks): Promise<{ tables: number; rows: number }> {
  const db = job.database
  const write = io.write
  const all = await io.query(MYSQL_DUMP_QUERIES.tables, [db])
  const tables = all.filter(r => r.type === 'BASE TABLE').map(r => String(r.name))
  const viewNames = all.filter(r => r.type === 'VIEW').map(r => String(r.name))
  const usage = await io.query(MYSQL_DUMP_QUERIES.viewUsage, [db, db]).catch(() => [] as Row[])
  const views = orderViews(viewNames, usage.map(u => ({ view_name: String(u.view_name), table_name: String(u.table_name) })))
  const routines = await io.query(MYSQL_DUMP_QUERIES.routines, [db])
  const triggers = await io.query(MYSQL_DUMP_QUERIES.triggers, [db])
  const showCreate = async (sql: string, column: string) => String((await io.query(sql))[0]?.[column] ?? '')

  await write(`-- QuenceDB dump of database ${qm(db)}
-- ${job.structure ? (job.data ? 'Structure and data' : 'Structure only') : 'Data only'}, ${hooks.now.toISOString()}

SET NAMES utf8mb4;
SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;
SET @OLD_UNIQUE_CHECKS = @@UNIQUE_CHECKS, UNIQUE_CHECKS = 0;
SET @OLD_SQL_MODE = @@SQL_MODE, SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';
SET @OLD_TIME_ZONE = @@TIME_ZONE, TIME_ZONE = '+00:00';
`)

  if (job.structure) {
    for (const t of tables) {
      hooks.check()
      const create = await showCreate(`SHOW CREATE TABLE ${qm(db)}.${qm(t)}`, 'Create Table')
      await write(`\n-- Table ${qm(t)}\n${job.dropObjects ? `DROP TABLE IF EXISTS ${qm(t)};\n` : ''}${end(create)}\n`)
    }
  }

  let rows = 0
  let tablesDone = 0
  if (job.data) {
    const snapshot = await io.openSnapshot()
    try {
      // Text values of dates and timestamps are read in the zone the dump is loaded in
      await snapshot.query(`SET time_zone = '+00:00'`)
      for (const t of tables) {
        hooks.check()
        hooks.onProgress({ table: t, tablesDone, tablesTotal: tables.length, rows })
        const columns = parseExportColumns('mysql', await io.query(EXPORT_COLUMNS_SQL.mysql, [db, t]))
        const primaryKey = (await io.query(EXPORT_PRIMARY_KEY_SQL.mysql, [db, t])).map(r => String(r.name))
        const select = exportSelectSql('mysql', db, t, columns, primaryKey)
        let wroteHeader = false
        await streamRows(snapshot, 'mysql', select, job.batchSize ?? 2000, async batch => {
          const text = insertStatements('mysql', t, columns, batch, job.rowsPerStatement).join('\n') + '\n'
          await write((wroteHeader ? '' : `\n-- Data: ${qm(t)}\n`) + text)
          wroteHeader = true
          rows += batch.length
          hooks.onProgress({ table: t, tablesDone, tablesTotal: tables.length, rows })
        }, hooks.check)
        tablesDone++
      }
    } finally {
      await snapshot.close()
    }
  }

  if (job.structure) {
    for (const v of views) {
      hooks.check()
      const create = unqualifyDatabase(stripDefiner(await showCreate(`SHOW CREATE VIEW ${qm(db)}.${qm(v)}`, 'Create View')), db)
      await write(`\n-- View ${qm(v)}\n${job.dropObjects ? `DROP VIEW IF EXISTS ${qm(v)};\n` : ''}${end(create)}\n`)
    }
    for (const r of routines) {
      hooks.check()
      const kind = r.type === 'FUNCTION' ? 'FUNCTION' : 'PROCEDURE'
      const create = stripDefiner(await showCreate(`SHOW CREATE ${kind} ${qm(db)}.${qm(String(r.name))}`, kind === 'FUNCTION' ? 'Create Function' : 'Create Procedure'))
      if (!create) continue // no privilege to see the body
      await write(`\n-- ${kind === 'FUNCTION' ? 'Function' : 'Procedure'} ${qm(String(r.name))}\n${job.dropObjects ? `DROP ${kind} IF EXISTS ${qm(String(r.name))};\n` : ''}DELIMITER ;;\n${create.trim()} ;;\nDELIMITER ;\n`)
    }
    for (const r of triggers) {
      hooks.check()
      const create = stripDefiner(await showCreate(`SHOW CREATE TRIGGER ${qm(db)}.${qm(String(r.name))}`, 'SQL Original Statement'))
      await write(`\n-- Trigger ${qm(String(r.name))}\n${job.dropObjects ? `DROP TRIGGER IF EXISTS ${qm(String(r.name))};\n` : ''}DELIMITER ;;\n${create.trim()} ;;\nDELIMITER ;\n`)
    }
  }

  await write(`
SET TIME_ZONE = @OLD_TIME_ZONE;
SET SQL_MODE = @OLD_SQL_MODE;
SET UNIQUE_CHECKS = @OLD_UNIQUE_CHECKS;
SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;
`)
  hooks.onProgress({ table: '', tablesDone, tablesTotal: tables.length, rows })
  return { tables: tables.length, rows }
}

// ── Entry point ───────────────────────────────────────────────────────────────

interface DumpHooks {
  onProgress: (p: DatabaseExportProgress) => void
  check: () => void
  now: Date
}

export async function runDatabaseExport(io: DatabaseExportIO, job: DatabaseExportJob, opts: {
  onProgress?: (p: DatabaseExportProgress) => void
  isCancelled?: () => boolean
  now?: Date
} = {}): Promise<{ tables: number; rows: number }> {
  if (!job.structure && !job.data) throw new Error('Choose structure, data or both')
  if (job.dbType === 'postgres' && job.schemas.length === 0) throw new Error('Choose at least one schema')
  const hooks: DumpHooks = {
    onProgress: opts.onProgress ?? (() => {}),
    check: () => { if (opts.isCancelled?.()) throw new ExportCancelled() },
    now: opts.now ?? new Date(),
  }
  return job.dbType === 'postgres' ? pgDump(io, job, hooks) : mysqlDump(io, job, hooks)
}

export function databaseDumpFileName(database: string, now = new Date()): string {
  const safe = database.replace(/[\\/:*?"<>|]/g, '_')
  const stamp = now.toISOString().slice(0, 10)
  return `${safe}_${stamp}.sql`
}
