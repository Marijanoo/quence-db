// A local MCP server (Streamable HTTP, stateless) exposing the read-only tools in mcp-tools.ts.
// It listens on 127.0.0.1 only and every request needs the bearer token from the MCP panel.
// Requests from web pages are refused (Origin header, unexpected Host), so a site open in a
// browser can't reach it through the loopback address or DNS rebinding.

import * as http from 'http'
import { timingSafeEqual } from 'crypto'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  describeTable, listConnections, listDatabases, listTables, McpToolError, mongoAggregate, mongoFind, runQueryResult,
  type McpBackend,
} from './mcp-tools'
import { registerUiTools, UI_INSTRUCTIONS, type UiBridge } from './mcp-ui-tools'

export interface McpLogEntry {
  at: number
  tool: string
  connection?: string
  detail?: string
  ok: boolean
  error?: string
  ms: number
}

export interface McpHttpServer {
  port: number
  url: string
  close(): Promise<void>
}

const INSTRUCTIONS = `Tools for the databases open in QuenceDB, a desktop database client. Everything is read-only.
Start with list_connections, then list_databases / list_tables / describe_table to learn the schema before querying.
Use run_query for PostgreSQL and MySQL (one SELECT-like statement), mongo_find / mongo_aggregate for MongoDB.
Results are capped (max_rows, default 100); ask for aggregates or add filters rather than reading whole tables.`

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })
const json = (v: unknown) => text(JSON.stringify(v, null, 1))
const short = (s: string | undefined, n = 300) => s && s.length > n ? s.slice(0, n) + '…' : s

export function buildMcpServer(backend: McpBackend, log: (e: McpLogEntry) => void, version: string, ui?: UiBridge): McpServer {
  const server = new McpServer({ name: 'quence-db', version }, { instructions: ui ? `${INSTRUCTIONS}

${UI_INSTRUCTIONS}` : INSTRUCTIONS })
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }

  // registerTool's generic zod inference is too deep for the compiler here; tools are registered
  // through this plainly typed signature, and each tool states its argument type itself
  type ToolResult = ReturnType<typeof text> & { isError?: boolean }
  const register = server.registerTool.bind(server) as unknown as (name: string, config: {
    title: string; description: string; inputSchema?: Record<string, z.ZodTypeAny>; annotations: typeof readOnly
  }, cb: (args: any) => Promise<ToolResult>) => void

  // Wraps a tool: logs the call and turns errors into tool errors the model can read
  const tool = <A>(name: string, describe: (a: A) => { connection?: string; detail?: string }, fn: (a: A) => Promise<ToolResult>) =>
    async (args: A): Promise<ToolResult> => {
      const started = Date.now()
      const info = describe(args)
      try {
        const res = await fn(args)
        log({ at: started, tool: name, ...info, ok: true, ms: Date.now() - started })
        return res
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log({ at: started, tool: name, ...info, ok: false, error: short(message), ms: Date.now() - started })
        return { ...text(err instanceof McpToolError ? message : `Error: ${message}`), isError: true }
      }
    }

  const connection = z.string().describe('Connection name, as shown by list_connections')
  const database = z.string().optional().describe("Database name; defaults to the connection's own database")
  const maxRows = z.number().int().min(1).max(1000).optional().describe('Rows to return (default 100, max 1000)')

  register('list_connections', {
    title: 'List connections',
    description: 'The database connections shared from QuenceDB, with their type and whether they are connected.',
    annotations: readOnly,
  }, tool('list_connections', () => ({}), async () => json(listConnections(backend))))

  register('list_databases', {
    title: 'List databases',
    description: 'Databases on a connection.',
    inputSchema: { connection },
    annotations: readOnly,
  }, tool('list_databases', (a: { connection: string }) => ({ connection: a.connection }), async a => json(await listDatabases(backend, a.connection))))

  register('list_tables', {
    title: 'List tables',
    description: 'Tables and views (PostgreSQL: across schemas unless one is given; MySQL: of the database) or MongoDB collections, with estimated row counts.',
    inputSchema: { connection, database, schema: z.string().optional().describe('PostgreSQL schema to list (default: all)') },
    annotations: readOnly,
  }, tool('list_tables', (a: { connection: string; database?: string; schema?: string }) => ({ connection: a.connection, detail: [a.database, a.schema].filter(Boolean).join('.') || undefined }),
    async a => json(await listTables(backend, a.connection, a.database, a.schema))))

  register('describe_table', {
    title: 'Describe table',
    description: 'Columns with types, nullability and defaults, keys, foreign keys and indexes of a table. For a MongoDB collection: the fields and types found in a sample of documents, and its indexes.',
    inputSchema: { connection, table: z.string().describe('Table or collection name'), database, schema: z.string().optional().describe('PostgreSQL schema (default public)') },
    annotations: readOnly,
  }, tool('describe_table', (a: { connection: string; table: string; database?: string; schema?: string }) => ({ connection: a.connection, detail: [a.schema, a.table].filter(Boolean).join('.') }),
    async a => json(await describeTable(backend, a.connection, a.table, a.database, a.schema))))

  register('run_query', {
    title: 'Run read-only SQL',
    description: 'Runs one read-only SQL statement (SELECT, WITH, EXPLAIN, SHOW, …) on a PostgreSQL or MySQL connection, inside a read-only transaction that is rolled back. Returns the rows as JSON.',
    inputSchema: {
      connection, sql: z.string().describe('One SQL statement'), database, max_rows: maxRows,
      ...(ui ? { show_in_app: z.boolean().optional().describe('Also show the query and its result in a tab of the QuenceDB window') } : {}),
    },
    annotations: readOnly,
  }, tool('run_query', (a: { connection: string; sql: string; database?: string; max_rows?: number; show_in_app?: boolean }) => ({ connection: a.connection, detail: short(a.sql, 500) }),
    async a => {
      const res = await runQueryResult(backend, a.connection, a.sql, a.database, a.max_rows)
      if (a.show_in_app && ui) {
        const shown = await ui.request('showResult', { connectionId: res.connection.id, database: res.database, code: a.sql, rows: res.rows }).catch(() => null) as { tab?: string } | null
        return text(shown?.tab ? res.text.replace(/^\{/, `{\n "shown_in_tab": ${JSON.stringify(shown.tab)},`) : res.text)
      }
      return text(res.text)
    }))

  register('mongo_find', {
    title: 'Find MongoDB documents',
    description: 'Finds documents in a MongoDB collection. filter, projection and sort are JSON objects; Extended JSON such as {"$oid": "…"} or {"$date": "…"} is understood.',
    inputSchema: {
      connection, collection: z.string(), database,
      filter: z.string().optional().describe('JSON query filter, e.g. {"age": {"$gt": 30}}'),
      projection: z.string().optional().describe('JSON projection, e.g. {"name": 1}'),
      sort: z.string().optional().describe('JSON sort, e.g. {"createdAt": -1}'),
      limit: maxRows,
    },
    annotations: readOnly,
  }, tool('mongo_find', (a: { connection: string; collection: string; database?: string; filter?: string; projection?: string; sort?: string; limit?: number }) => ({ connection: a.connection, detail: `${a.collection} ${short(a.filter ?? '{}', 400)}` }),
    async a => text(await mongoFind(backend, a.connection, a.collection, a))))

  register('mongo_aggregate', {
    title: 'Aggregate MongoDB documents',
    description: 'Runs a read-only aggregation pipeline (JSON array of stages) on a MongoDB collection. $out, $merge and server-side JavaScript are not allowed.',
    inputSchema: { connection, collection: z.string(), pipeline: z.string().describe('JSON array of pipeline stages'), database, limit: maxRows },
    annotations: readOnly,
  }, tool('mongo_aggregate', (a: { connection: string; collection: string; pipeline: string; database?: string; limit?: number }) => ({ connection: a.connection, detail: `${a.collection} ${short(a.pipeline, 400)}` }),
    async a => text(await mongoAggregate(backend, a.connection, a.collection, a.pipeline, a))))

  if (ui) registerUiTools(server, register, tool, backend, ui)
  return server
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '')
  if (!m) return false
  const a = Buffer.from(m[1].trim())
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

function reject(res: http.ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}

async function readBody(req: http.IncomingMessage, limit = 1 << 20): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new Error('Request too large')
    chunks.push(chunk as Buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function startMcpHttpServer(opts: {
  port: number
  token: string
  backend: McpBackend
  log: (e: McpLogEntry) => void
  version: string
  ui?: UiBridge
}): Promise<McpHttpServer> {
  const allowedHosts = (port: number) => new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  let hosts = allowedHosts(opts.port)

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/mcp') return reject(res, 404, 'Not found. The MCP endpoint is /mcp')
      if (!hosts.has((req.headers.host ?? '').toLowerCase())) return reject(res, 403, 'Forbidden host')
      if (req.headers.origin) return reject(res, 403, 'Requests from web pages are not allowed')
      if (!tokenMatches(req.headers.authorization, opts.token)) {
        res.setHeader('WWW-Authenticate', 'Bearer')
        return reject(res, 401, 'Missing or wrong access token (see QuenceDB → MCP)')
      }
      if (req.method !== 'POST') return reject(res, 405, 'Method not allowed')

      const body = await readBody(req)
      // Stateless: a fresh server and transport per request
      const mcp = buildMcpServer(opts.backend, opts.log, opts.version, opts.ui)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.on('close', () => { void transport.close(); void mcp.close() })
      await mcp.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (err) {
      if (!res.headersSent) reject(res, 400, err instanceof Error ? err.message : String(err))
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, '127.0.0.1', () => {
      server.off('error', reject)
      const port = (server.address() as { port: number }).port
      hosts = allowedHosts(port)
      resolve({
        port,
        url: `http://127.0.0.1:${port}/mcp`,
        close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()) }),
      })
    })
  })
}
