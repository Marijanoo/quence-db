// PostgreSQL structure synchronization: snapshot a schema, diff a source against a target and
// generate the DDL that brings the target in line with the source.
//
// Snapshots are read with search_path set to "<schema>, public" (see snapshotSearchPath), so the
// pg_get_*def() functions leave same-schema names unqualified. That makes definitions from two
// different schemas directly comparable, and the deploy script sets the same search_path on the
// target so those unqualified names resolve there.

// ── Snapshot model ────────────────────────────────────────────────────────────

export interface PgColumn {
  name: string
  type: string            // format_type() output, e.g. "character varying(100)"
  notNull: boolean
  default: string | null
  generated: string | null // expression of a GENERATED ALWAYS AS (...) STORED column
  identity: '' | 'a' | 'd' // '', ALWAYS, BY DEFAULT
  serial: boolean          // integer column whose default comes from a sequence it owns
}

export interface PgConstraint {
  name: string
  type: 'p' | 'u' | 'f' | 'c' | 'x'
  definition: string       // pg_get_constraintdef(), e.g. "FOREIGN KEY (user_id) REFERENCES users(id)"
  refTable?: string        // referenced table, when it is in the same schema (foreign keys only)
}

export interface PgIndex {
  name: string
  unique: boolean
  only: boolean
  body: string             // everything after "ON <table>", e.g. "USING btree (email) WHERE (active)"
}

export interface PgTable { name: string; columns: PgColumn[]; constraints: PgConstraint[]; indexes: PgIndex[] }
export interface PgView { name: string; definition: string; dependsOn: string[] }
export interface PgEnum { name: string; values: string[] }
// Extensions are database-wide; `inSchema` is true when installed in the snapshotted schema itself
export interface PgExtension { name: string; schema: string; inSchema: boolean }
export interface SchemaSnapshot { tables: PgTable[]; views: PgView[]; enums: PgEnum[]; extensions: PgExtension[] }

// ── Introspection ─────────────────────────────────────────────────────────────

export function quoteIdent(name: string) {
  return '"' + name.replace(/"/g, '""') + '"'
}

function qualified(schema: string | null, name: string) {
  return schema === null ? quoteIdent(name) : `${quoteIdent(schema)}.${quoteIdent(name)}`
}

function quoteLiteral(value: string) {
  return "'" + value.replace(/'/g, "''") + "'"
}

export function snapshotSearchPath(schema: string) {
  return `${quoteIdent(schema)}, public`
}

// Regular, non-partition tables only; partitioned tables need PARTITION BY handling (not supported yet)
const TABLE_FILTER = `n.nspname = $1 AND c.relkind = 'r' AND NOT c.relispartition`

export const SNAPSHOT_QUERIES = {
  tables: `
    SELECT c.relname AS table_name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE ${TABLE_FILTER}
    ORDER BY 1`,
  columns: `
    SELECT c.relname AS table_name, a.attname AS name,
      format_type(a.atttypid, a.atttypmod) AS type,
      a.attnotnull AS not_null,
      CASE WHEN a.attgenerated = '' THEN pg_get_expr(d.adbin, d.adrelid) END AS default_expr,
      CASE WHEN a.attgenerated <> '' THEN pg_get_expr(d.adbin, d.adrelid) END AS generated_expr,
      a.attidentity::text AS identity,
      pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) IS NOT NULL AS owns_sequence
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE ${TABLE_FILTER} AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum`,
  constraints: `
    SELECT c.relname AS table_name, con.conname AS name, con.contype::text AS type,
      pg_get_constraintdef(con.oid, true) AS definition,
      CASE WHEN fn.nspname = n.nspname THEN ft.relname END AS ref_table
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_class ft ON ft.oid = con.confrelid
    LEFT JOIN pg_namespace fn ON fn.oid = ft.relnamespace
    WHERE ${TABLE_FILTER} AND con.contype IN ('p', 'u', 'f', 'c', 'x')
    ORDER BY c.relname, con.conname`,
  indexes: `
    SELECT c.relname AS table_name, i.relname AS name, pg_get_indexdef(ix.indexrelid) AS definition,
      quote_ident(n.nspname) || '.' || quote_ident(c.relname) AS qualified_table,
      quote_ident(c.relname) AS quoted_table
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class c ON c.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE ${TABLE_FILTER}
      AND NOT EXISTS (
        SELECT 1 FROM pg_constraint con
        WHERE con.conindid = ix.indexrelid AND con.conrelid = ix.indrelid AND con.contype IN ('p', 'u', 'x'))
    ORDER BY c.relname, i.relname`,
  views: `
    SELECT c.relname AS name, pg_get_viewdef(c.oid, true) AS definition
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relkind = 'v'
    ORDER BY 1`,
  viewDeps: `
    SELECT DISTINCT v.relname AS view_name, r.relname AS depends_on
    FROM pg_depend d
    JOIN pg_rewrite rw ON rw.oid = d.objid
    JOIN pg_class v ON v.oid = rw.ev_class
    JOIN pg_class r ON r.oid = d.refobjid
    JOIN pg_namespace n ON n.oid = v.relnamespace
    WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass
      AND n.nspname = $1 AND v.relkind = 'v' AND r.relnamespace = v.relnamespace AND r.oid <> v.oid`,
  enums: `
    SELECT t.typname AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS values
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE n.nspname = $1
    GROUP BY t.typname
    ORDER BY 1`,
  extensions: `
    SELECT e.extname AS name, n.nspname AS schema, n.nspname = $1 AS in_schema
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname <> 'plpgsql'
    ORDER BY 1`,
} as const

export type SnapshotRows = { [K in keyof typeof SNAPSHOT_QUERIES]: Record<string, any>[] }

export async function fetchSchemaSnapshot(
  query: (sql: string, params: unknown[]) => Promise<Record<string, any>[]>,
  schema: string,
): Promise<SchemaSnapshot> {
  const keys = Object.keys(SNAPSHOT_QUERIES) as (keyof typeof SNAPSHOT_QUERIES)[]
  const results = await Promise.all(keys.map(k => query(SNAPSHOT_QUERIES[k], [schema])))
  const rows = Object.fromEntries(keys.map((k, i) => [k, results[i]])) as SnapshotRows
  return buildSnapshot(rows)
}

function parseIndexDefinition(definition: string, qualifiedTable: string, quotedTable: string): Omit<PgIndex, 'name'> {
  // "CREATE [UNIQUE] INDEX name ON [ONLY] <table> <body>"; newer servers always schema-qualify <table>
  for (const table of [qualifiedTable, quotedTable]) {
    for (const only of [false, true]) {
      const marker = ` ON ${only ? 'ONLY ' : ''}${table} `
      const at = definition.indexOf(marker)
      if (at >= 0) {
        return { unique: definition.startsWith('CREATE UNIQUE INDEX'), only, body: definition.slice(at + marker.length).trim() }
      }
    }
  }
  return { unique: definition.startsWith('CREATE UNIQUE INDEX'), only: false, body: definition }
}

const stripTrailingSemicolon = (sql: string) => sql.trim().replace(/;\s*$/, '')

export function buildSnapshot(rows: SnapshotRows): SchemaSnapshot {
  const tables = new Map<string, PgTable>(
    rows.tables.map(r => [r.table_name, { name: r.table_name, columns: [], constraints: [], indexes: [] }]))

  for (const r of rows.columns) {
    const identity = (r.identity ?? '') as PgColumn['identity']
    tables.get(r.table_name)?.columns.push({
      name: r.name,
      type: r.type,
      notNull: !!r.not_null,
      default: r.default_expr ?? null,
      generated: r.generated_expr ?? null,
      identity,
      serial: !!r.owns_sequence && identity === '' && /^nextval\(/.test(r.default_expr ?? ''),
    })
  }
  for (const r of rows.constraints) {
    tables.get(r.table_name)?.constraints.push({
      name: r.name, type: r.type, definition: r.definition, ...(r.ref_table ? { refTable: r.ref_table } : {}),
    })
  }
  for (const r of rows.indexes) {
    tables.get(r.table_name)?.indexes.push({ name: r.name, ...parseIndexDefinition(r.definition, r.qualified_table, r.quoted_table) })
  }

  const deps = new Map<string, string[]>()
  for (const r of rows.viewDeps) deps.set(r.view_name, [...(deps.get(r.view_name) ?? []), r.depends_on])

  return {
    tables: [...tables.values()],
    views: rows.views.map(r => ({ name: r.name, definition: stripTrailingSemicolon(r.definition), dependsOn: deps.get(r.name) ?? [] })),
    enums: rows.enums.map(r => ({ name: r.name, values: r.values ?? [] })),
    extensions: rows.extensions.map(r => ({ name: r.name, schema: r.schema, inSchema: !!r.in_schema })),
  }
}

// ── DDL generation ────────────────────────────────────────────────────────────

const SERIAL_TYPES: Record<string, string> = { integer: 'serial', bigint: 'bigserial', smallint: 'smallserial' }

export function columnDefinition(c: PgColumn): string {
  const serialType = c.serial ? SERIAL_TYPES[c.type] : undefined
  const parts = [quoteIdent(c.name), serialType ?? c.type]
  if (c.generated) parts.push(`GENERATED ALWAYS AS (${c.generated}) STORED`)
  else if (c.identity) parts.push(`GENERATED ${c.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`)
  else if (c.default !== null && !serialType) parts.push(`DEFAULT ${c.default}`)
  // serial and identity columns are implicitly NOT NULL
  if (c.notNull && !serialType && !c.identity) parts.push('NOT NULL')
  return parts.join(' ')
}

function createTableSql(schema: string | null, t: PgTable): string {
  const lines = [
    ...t.columns.map(columnDefinition),
    ...t.constraints.filter(c => c.type !== 'f').map(c => `CONSTRAINT ${quoteIdent(c.name)} ${c.definition}`),
  ]
  return `CREATE TABLE ${qualified(schema, t.name)} (\n  ${lines.join(',\n  ')}\n)`
}

function addConstraintSql(schema: string | null, table: string, c: PgConstraint) {
  return `ALTER TABLE ${qualified(schema, table)} ADD CONSTRAINT ${quoteIdent(c.name)} ${c.definition}`
}

function dropConstraintSql(schema: string, table: string, name: string) {
  return `ALTER TABLE ${qualified(schema, table)} DROP CONSTRAINT IF EXISTS ${quoteIdent(name)}`
}

function createIndexSql(schema: string | null, table: string, i: PgIndex) {
  return `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(i.name)} ON ${i.only ? 'ONLY ' : ''}${qualified(schema, table)} ${i.body}`
}

function createViewSql(schema: string | null, v: PgView, orReplace = false) {
  return `CREATE ${orReplace ? 'OR REPLACE ' : ''}VIEW ${qualified(schema, v.name)} AS\n${v.definition}`
}

function createEnumSql(schema: string | null, e: PgEnum) {
  return `CREATE TYPE ${qualified(schema, e.name)} AS ENUM (${e.values.map(quoteLiteral).join(', ')})`
}

// Full, schema-less DDL of an object, used for the side-by-side comparison view
export function tableDisplayDdl(t: PgTable): string {
  return [
    createTableSql(null, t) + ';',
    ...t.constraints.filter(c => c.type === 'f').map(c => addConstraintSql(null, t.name, c) + ';'),
    ...t.indexes.map(i => createIndexSql(null, t.name, i) + ';'),
  ].join('\n\n')
}

// ── Diff ──────────────────────────────────────────────────────────────────────

// Statements are grouped into phases so the combined script runs in a valid order no matter
// which objects are selected (e.g. every foreign key is added only after all tables exist).
export enum Phase {
  // Deployed in its own, earlier transaction: PostgreSQL rejects using an enum value in the
  // transaction that added it ("unsafe use of new value")
  EnumValues,
  Extensions,
  DropViews,
  DropForeignKeys,
  Enums,
  CreateTables,
  AlterDrop,
  AlterColumns,
  AddConstraintsAndIndexes,
  AddForeignKeys,
  DropTables,
  DropEnums,
  CreateViews,
}

export interface SyncStatement { phase: Phase; order: number; sql: string }
export type SyncKind = 'extension' | 'table' | 'view' | 'enum'
export type SyncAction = 'create' | 'modify' | 'drop' | 'same'

export interface SyncItem {
  key: string
  kind: SyncKind
  name: string
  action: SyncAction
  changes: string[]   // differences that produce SQL
  notes: string[]     // differences deliberately left alone
  warnings: string[]  // statements that may fail or lose data
  unsupported: boolean // some differences can't be synced automatically (see warnings)
  statements: SyncStatement[]
  sourceDdl: string
  targetDdl: string
}

export interface SyncOptions {
  tables: boolean
  views: boolean
  enums: boolean
  dropColumns: boolean // drop target columns that don't exist in the source (loses their data)
}

export const DEFAULT_SYNC_OPTIONS: SyncOptions = { tables: true, views: true, enums: true, dropColumns: false }

const normalizeSql = (sql: string) => sql.replace(/\s+/g, ' ').trim()

// Matches items by name, then pairs remaining ones whose definitions are identical (the same
// constraint/index under a different auto-generated name is not a real difference).
function matchByNameThenDefinition<T extends { name: string }>(source: T[], target: T[], sameDefinition: (a: T, b: T) => boolean) {
  const pairs: [T, T][] = []
  const sourceOnly: T[] = []
  const targetLeft = new Map(target.map(t => [t.name, t]))
  const unnamed: T[] = []
  for (const s of source) {
    const t = targetLeft.get(s.name)
    if (t) { pairs.push([s, t]); targetLeft.delete(s.name) } else unnamed.push(s)
  }
  for (const s of unnamed) {
    const t = [...targetLeft.values()].find(t => sameDefinition(s, t))
    if (t) { pairs.push([s, t]); targetLeft.delete(t.name) } else sourceOnly.push(s)
  }
  return { pairs, sourceOnly, targetOnly: [...targetLeft.values()] }
}

const constraintsEqual = (a: PgConstraint, b: PgConstraint) => a.type === b.type && normalizeSql(a.definition) === normalizeSql(b.definition)
const indexesEqual = (a: PgIndex, b: PgIndex) => a.unique === b.unique && a.only === b.only && normalizeSql(a.body) === normalizeSql(b.body)

function topoOrder(views: PgView[]): Map<string, number> {
  const byName = new Map(views.map(v => [v.name, v]))
  const order = new Map<string, number>()
  const visiting = new Set<string>()
  const visit = (name: string) => {
    if (order.has(name) || visiting.has(name)) return
    visiting.add(name)
    for (const dep of byName.get(name)?.dependsOn ?? []) if (byName.has(dep)) visit(dep)
    visiting.delete(name)
    order.set(name, order.size)
  }
  for (const v of views) visit(v.name)
  return order
}

function emptyItem(kind: SyncKind, name: string, action: SyncAction): SyncItem {
  return { key: `${kind}:${name}`, kind, name, action, changes: [], notes: [], warnings: [], unsupported: false, statements: [], sourceDdl: '', targetDdl: '' }
}

function diffColumns(schema: string, table: string, source: PgColumn[], target: PgColumn[], options: SyncOptions, item: SyncItem) {
  const add = (phase: Phase, sql: string) => item.statements.push({ phase, order: 0, sql })
  const tq = qualified(schema, table)
  const targetByName = new Map(target.map(c => [c.name, c]))
  const sourceNames = new Set(source.map(c => c.name))

  for (const t of target) {
    if (sourceNames.has(t.name)) continue
    if (options.dropColumns) {
      item.changes.push(`Drop column ${t.name}`)
      item.warnings.push(`Dropping column ${t.name} deletes its data`)
      add(Phase.AlterDrop, `ALTER TABLE ${tq} DROP COLUMN ${quoteIdent(t.name)}`)
    } else {
      item.notes.push(`Column ${t.name} exists only in the target and is kept`)
    }
  }

  for (const s of source) {
    const t = targetByName.get(s.name)
    const col = quoteIdent(s.name)
    if (!t) {
      item.changes.push(`Add column ${s.name} ${s.type}`)
      if (s.notNull && s.default === null && !s.serial && !s.identity && !s.generated) {
        item.warnings.push(`Adding NOT NULL column ${s.name} without a default fails if the target table has rows`)
      }
      add(Phase.AlterColumns, `ALTER TABLE ${tq} ADD COLUMN ${columnDefinition(s)}`)
      continue
    }

    if (s.serial !== t.serial || (s.generated ?? '') !== (t.generated ?? '')) {
      item.unsupported = true
      item.warnings.push(s.serial !== t.serial
        ? `Column ${s.name}: serial/sequence default differs; change it manually`
        : `Column ${s.name}: generated expression differs; change it manually`)
      continue
    }
    if (s.type !== t.type) {
      item.changes.push(`Column ${s.name}: type ${t.type} → ${s.type}`)
      item.warnings.push(`Changing the type of ${s.name} can fail or lose data if existing values don't convert`)
      add(Phase.AlterColumns, `ALTER TABLE ${tq} ALTER COLUMN ${col} TYPE ${s.type} USING ${col}::${s.type}`)
    }
    if (!s.serial && !s.generated && (s.default ?? '') !== (t.default ?? '')) {
      item.changes.push(s.default === null ? `Column ${s.name}: drop default` : `Column ${s.name}: default → ${s.default}`)
      add(Phase.AlterColumns, s.default === null
        ? `ALTER TABLE ${tq} ALTER COLUMN ${col} DROP DEFAULT`
        : `ALTER TABLE ${tq} ALTER COLUMN ${col} SET DEFAULT ${s.default}`)
    }
    if (s.notNull !== t.notNull) {
      item.changes.push(`Column ${s.name}: ${s.notNull ? 'set' : 'drop'} NOT NULL`)
      if (s.notNull) item.warnings.push(`SET NOT NULL on ${s.name} fails if the target has NULL values in it`)
      add(Phase.AlterColumns, `ALTER TABLE ${tq} ALTER COLUMN ${col} ${s.notNull ? 'SET' : 'DROP'} NOT NULL`)
    }
    if (s.identity !== t.identity) {
      const kind = (id: 'a' | 'd') => id === 'a' ? 'ALWAYS' : 'BY DEFAULT'
      item.changes.push(`Column ${s.name}: identity ${t.identity ? kind(t.identity) : 'none'} → ${s.identity ? kind(s.identity) : 'none'}`)
      add(Phase.AlterColumns,
        !s.identity ? `ALTER TABLE ${tq} ALTER COLUMN ${col} DROP IDENTITY`
          : !t.identity ? `ALTER TABLE ${tq} ALTER COLUMN ${col} ADD GENERATED ${kind(s.identity)} AS IDENTITY`
            : `ALTER TABLE ${tq} ALTER COLUMN ${col} SET GENERATED ${kind(s.identity)}`)
    }
  }
}

function diffTable(schema: string, s: PgTable, t: PgTable, options: SyncOptions, targetViews: PgView[]): SyncItem {
  const item = emptyItem('table', s.name, 'modify')
  const add = (phase: Phase, sql: string) => item.statements.push({ phase, order: 0, sql })
  diffColumns(schema, s.name, s.columns, t.columns, options, item)

  const cons = matchByNameThenDefinition(s.constraints, t.constraints, constraintsEqual)
  const dropConstraint = (c: PgConstraint) => add(c.type === 'f' ? Phase.DropForeignKeys : Phase.AlterDrop, dropConstraintSql(schema, s.name, c.name))
  const addConstraint = (c: PgConstraint) => add(c.type === 'f' ? Phase.AddForeignKeys : Phase.AddConstraintsAndIndexes, addConstraintSql(schema, s.name, c))
  for (const [sc, tc] of cons.pairs) {
    if (constraintsEqual(sc, tc)) continue
    item.changes.push(`Constraint ${sc.name}: ${tc.definition} → ${sc.definition}`)
    dropConstraint(tc)
    addConstraint(sc)
  }
  for (const c of cons.sourceOnly) { item.changes.push(`Add constraint ${c.name}`); addConstraint(c) }
  for (const c of cons.targetOnly) { item.changes.push(`Drop constraint ${c.name}`); dropConstraint(c) }

  const idx = matchByNameThenDefinition(s.indexes, t.indexes, indexesEqual)
  const dropIndex = (i: PgIndex) => add(Phase.AlterDrop, `DROP INDEX IF EXISTS ${qualified(schema, i.name)}`)
  const createIndex = (i: PgIndex) => add(Phase.AddConstraintsAndIndexes, createIndexSql(schema, s.name, i))
  for (const [si, ti] of idx.pairs) {
    if (indexesEqual(si, ti)) continue
    item.changes.push(`Index ${si.name} changed`)
    dropIndex(ti)
    createIndex(si)
  }
  for (const i of idx.sourceOnly) { item.changes.push(`Add index ${i.name}`); createIndex(i) }
  for (const i of idx.targetOnly) { item.changes.push(`Drop index ${i.name}`); dropIndex(i) }

  const dependentViews = targetViews.filter(v => v.dependsOn.includes(s.name)).map(v => v.name)
  if (dependentViews.length > 0 && item.statements.some(st => /ALTER COLUMN .* TYPE |DROP COLUMN /.test(st.sql))) {
    item.warnings.push(`Views depending on this table (${dependentViews.join(', ')}) may block column type changes or drops`)
  }

  if (item.statements.length === 0 && !item.unsupported) item.action = 'same'
  return item
}

function diffEnum(schema: string, s: PgEnum, t: PgEnum, item: SyncItem) {
  if (s.values.join('\u0000') === t.values.join('\u0000')) { item.action = 'same'; return }
  // New values can be added in place; removing or reordering values needs a type rebuild
  let ti = 0
  for (const v of s.values) if (ti < t.values.length && v === t.values[ti]) ti++
  if (ti < t.values.length) {
    item.unsupported = true
    item.warnings.push('Values were removed or reordered; PostgreSQL can only add enum values, so change this type manually')
    return
  }
  const existing = new Set(t.values)
  s.values.forEach((v, i) => {
    if (existing.has(v)) return
    const next = s.values.slice(i + 1).find(n => existing.has(n))
    const position = next !== undefined ? ` BEFORE ${quoteLiteral(next)}` : ''
    item.changes.push(`Add value '${v}'`)
    item.statements.push({ phase: Phase.EnumValues, order: 0, sql: `ALTER TYPE ${qualified(schema, s.name)} ADD VALUE ${quoteLiteral(v)}${position}` })
  })
  item.notes.push('New enum values are committed in a separate first step of the deploy, so they stay even if a later statement fails')
}

// Objects reference extension functions/types (e.g. uuid_generate_v4()) unqualified when the
// extension lives on the snapshot search_path, i.e. in the compared schema or in public.
const onSearchPath = (e: PgExtension) => e.inSchema || e.schema === 'public'

function diffExtensions(source: SchemaSnapshot, target: SchemaSnapshot, targetSchema: string): SyncItem[] {
  const items: SyncItem[] = []
  const targetByName = new Map(target.extensions.map(e => [e.name, e]))
  const show = (e: PgExtension) => `CREATE EXTENSION ${quoteIdent(e.name)} SCHEMA ${quoteIdent(e.schema)};`

  for (const s of source.extensions) {
    const t = targetByName.get(s.name)
    // Install where the target resolves names the same way the source does
    const wantedSchema = s.inSchema ? targetSchema : s.schema
    if (!t) {
      const item = emptyItem('extension', s.name, 'create')
      item.sourceDdl = show(s)
      item.changes.push(`Install extension in schema ${wantedSchema}`)
      item.notes.push('Installing an extension needs the right privileges (superuser, or database owner for trusted extensions)')
      if (wantedSchema !== targetSchema && wantedSchema !== 'public') {
        item.warnings.push(`Schema ${wantedSchema} must already exist in the target database`)
      }
      item.statements.push({ phase: Phase.Extensions, order: 0, sql: `CREATE EXTENSION IF NOT EXISTS ${quoteIdent(s.name)} SCHEMA ${quoteIdent(wantedSchema)}` })
      items.push(item)
    } else if ((onSearchPath(s) && !onSearchPath(t)) || (!onSearchPath(s) && s.schema !== t.schema)) {
      const item = emptyItem('extension', s.name, 'modify')
      item.sourceDdl = show(s)
      item.targetDdl = show(t)
      item.unsupported = true
      item.warnings.push(`Installed in schema ${t.schema} in the target, where objects synced into ${targetSchema} can't find it. Move it first, e.g. ALTER EXTENSION ${quoteIdent(s.name)} SET SCHEMA ${quoteIdent(wantedSchema)}`)
      items.push(item)
    }
  }
  return items
}

export function compareSchemas(source: SchemaSnapshot, target: SchemaSnapshot, targetSchema: string, options: SyncOptions = DEFAULT_SYNC_OPTIONS): SyncItem[] {
  const items: SyncItem[] = diffExtensions(source, target, targetSchema)
  const schema = targetSchema

  if (options.enums) {
    const targetEnums = new Map(target.enums.map(e => [e.name, e]))
    for (const s of source.enums) {
      const t = targetEnums.get(s.name)
      const item = emptyItem('enum', s.name, t ? 'modify' : 'create')
      item.sourceDdl = createEnumSql(null, s) + ';'
      if (t) {
        item.targetDdl = createEnumSql(null, t) + ';'
        diffEnum(schema, s, t, item)
      } else {
        item.changes.push('Create enum type')
        item.statements.push({ phase: Phase.Enums, order: 0, sql: createEnumSql(schema, s) })
      }
      items.push(item)
    }
    const sourceEnums = new Set(source.enums.map(e => e.name))
    for (const t of target.enums.filter(e => !sourceEnums.has(e.name))) {
      const item = emptyItem('enum', t.name, 'drop')
      item.targetDdl = createEnumSql(null, t) + ';'
      item.changes.push('Drop enum type')
      item.statements.push({ phase: Phase.DropEnums, order: 0, sql: `DROP TYPE ${qualified(schema, t.name)}` })
      items.push(item)
    }
  }

  if (options.tables) {
    const targetTables = new Map(target.tables.map(t => [t.name, t]))
    for (const s of source.tables) {
      const t = targetTables.get(s.name)
      const item = t ? diffTable(schema, s, t, options, target.views) : emptyItem('table', s.name, 'create')
      item.sourceDdl = tableDisplayDdl(s)
      if (t) {
        item.targetDdl = tableDisplayDdl(t)
      } else {
        item.changes.push(`Create table with ${s.columns.length} columns`)
        item.statements.push({ phase: Phase.CreateTables, order: 0, sql: createTableSql(schema, s) })
        for (const c of s.constraints.filter(c => c.type === 'f')) {
          item.statements.push({ phase: Phase.AddForeignKeys, order: 0, sql: addConstraintSql(schema, s.name, c) })
        }
        for (const i of s.indexes) item.statements.push({ phase: Phase.AddConstraintsAndIndexes, order: 0, sql: createIndexSql(schema, s.name, i) })
      }
      items.push(item)
    }
    const sourceTables = new Set(source.tables.map(t => t.name))
    for (const t of target.tables.filter(t => !sourceTables.has(t.name))) {
      const item = emptyItem('table', t.name, 'drop')
      item.targetDdl = tableDisplayDdl(t)
      item.changes.push('Drop table')
      item.warnings.push(`Dropping table ${t.name} deletes all of its data`)
      // Foreign keys in other tables that point at this table would block the drop
      for (const other of target.tables) {
        for (const c of other.constraints) {
          if (c.type === 'f' && c.refTable === t.name && other.name !== t.name) {
            item.statements.push({ phase: Phase.DropForeignKeys, order: 0, sql: dropConstraintSql(schema, other.name, c.name) })
          }
        }
      }
      item.statements.push({ phase: Phase.DropTables, order: 0, sql: `DROP TABLE ${qualified(schema, t.name)}` })
      items.push(item)
    }
  }

  if (options.views) {
    const sourceOrder = topoOrder(source.views)
    const targetOrder = topoOrder(target.views)
    const targetViews = new Map(target.views.map(v => [v.name, v]))
    for (const s of source.views) {
      const t = targetViews.get(s.name)
      const item = emptyItem('view', s.name, t ? 'modify' : 'create')
      item.sourceDdl = createViewSql(null, s) + ';'
      const order = sourceOrder.get(s.name) ?? 0
      if (t) {
        item.targetDdl = createViewSql(null, t) + ';'
        const dependents = target.views.filter(v => v.dependsOn.includes(s.name)).map(v => v.name)
        if (normalizeSql(s.definition) === normalizeSql(t.definition)) {
          item.action = 'same'
        } else if (dependents.length === 0) {
          // Drop + create always works (CREATE OR REPLACE rejects column changes), and dropping
          // early also unblocks type changes on the tables the view reads
          item.changes.push('View definition changed (drop and recreate)')
          item.statements.push({ phase: Phase.DropViews, order: -(targetOrder.get(t.name) ?? 0), sql: `DROP VIEW ${qualified(schema, t.name)}` })
          item.statements.push({ phase: Phase.CreateViews, order, sql: createViewSql(schema, s) })
        } else {
          item.changes.push('View definition changed (replace in place)')
          item.warnings.push(`Other views depend on this one (${dependents.join(', ')}), so it is replaced in place; that fails if existing columns were renamed, removed or changed type`)
          item.statements.push({ phase: Phase.CreateViews, order, sql: createViewSql(schema, s, true) })
        }
      } else {
        item.changes.push('Create view')
        item.statements.push({ phase: Phase.CreateViews, order, sql: createViewSql(schema, s) })
      }
      items.push(item)
    }
    const sourceViews = new Set(source.views.map(v => v.name))
    for (const t of target.views.filter(v => !sourceViews.has(v.name))) {
      const item = emptyItem('view', t.name, 'drop')
      item.targetDdl = createViewSql(null, t) + ';'
      item.changes.push('Drop view')
      // Dependents first: reverse of the creation order
      item.statements.push({ phase: Phase.DropViews, order: -(targetOrder.get(t.name) ?? 0), sql: `DROP VIEW ${qualified(schema, t.name)}` })
      items.push(item)
    }
  }

  return items
}

// ── Script ────────────────────────────────────────────────────────────────────

// An item with only manual (unsupported) differences has no statements and can't be deployed
export function isSelectable(item: SyncItem) {
  return item.action !== 'same' && item.statements.length > 0
}

export function defaultSelection(items: SyncItem[]): string[] {
  return items.filter(i => isSelectable(i) && i.action !== 'drop').map(i => i.key)
}

export function orderedStatements(items: SyncItem[]): SyncStatement[] {
  const all = items.flatMap(item => item.statements)
    .map((s, seq) => ({ ...s, seq }))
    .sort((a, b) => a.phase - b.phase || a.order - b.order || a.seq - b.seq)
  const seen = new Set<string>()
  return all.filter(s => !seen.has(s.sql) && !!seen.add(s.sql))
}

// The script carries its own BEGIN/COMMIT blocks (one per part) and is executed as-is
export function buildSyncScript(items: SyncItem[], selectedKeys: Iterable<string>, targetSchema: string): string {
  const selected = new Set(selectedKeys)
  const statements = orderedStatements(items.filter(i => selected.has(i.key) && isSelectable(i)))
  if (statements.length === 0) return ''

  const parts = [
    { title: 'new enum values. PostgreSQL only allows using a new enum value after it is committed', statements: statements.filter(s => s.phase === Phase.EnumValues) },
    { title: 'structure changes', statements: statements.filter(s => s.phase !== Phase.EnumValues) },
  ].filter(p => p.statements.length > 0)

  const blocks = parts.map((part, i) => [
    ...(parts.length > 1 ? [`-- Part ${i + 1} of ${parts.length}: ${part.title}`] : []),
    'BEGIN;',
    `SET LOCAL search_path TO ${snapshotSearchPath(targetSchema)};`,
    '',
    ...part.statements.map(s => s.sql + ';\n'),
    'COMMIT;',
  ].join('\n'))

  return ['-- Structure sync script generated by QuenceDB', ...blocks].join('\n\n') + '\n'
}
