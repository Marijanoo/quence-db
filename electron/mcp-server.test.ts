// The MCP server over real HTTP, through the SDK's own client. Access control and the read-only
// rules run without databases; the database tests are opt-in: QUENCE_PG_TEST_URL,
// QUENCE_MYSQL_TEST_URL, QUENCE_MONGO_TEST_URL.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as http from 'http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Pool } from 'pg'
import * as mysql from 'mysql2/promise'
import { MongoClient, ObjectId } from 'mongodb'
import { startMcpHttpServer, type McpHttpServer, type McpLogEntry } from './mcp-server'
import { checkMongoReadOnly, checkReadOnlySql, formatRows, type McpBackend, type McpConnectionInfo } from './mcp-tools'
import { dataToolEnabled, type DataToolSettings } from './mcp-settings'

const TOKEN = 'test-token-0123456789abcdef'

async function connectClient(url: string, token = TOKEN) {
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  return client
}

type ToolText = { content: { type: string; text: string }[]; isError?: boolean }
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args }) as ToolText
  return { text: res.content[0]?.text ?? '', isError: !!res.isError }
}

describe('read-only rules', () => {
  it('accepts read statements and refuses writes and admin functions', () => {
    expect(checkReadOnlySql('pg', '-- hi\n  select 1;')).toBe('select 1')
    expect(() => checkReadOnlySql('pg', 'DELETE FROM t')).toThrow(/Only read queries/)
    expect(() => checkReadOnlySql('pg', 'SELECT pg_terminate_backend(123)')).toThrow(/pg_terminate_backend/)
    expect(() => checkReadOnlySql('mysql', 'DROP TABLE t')).toThrow(/Only read queries/)
    expect(() => checkReadOnlySql('mysql', "SELECT * FROM t INTO OUTFILE '/tmp/x'")).toThrow(/INTO OUTFILE/)
    expect(checkReadOnlySql('mysql', 'SHOW TABLES')).toBe('SHOW TABLES')
  })

  it('refuses MongoDB stages and operators that write or run JavaScript', () => {
    expect(() => checkMongoReadOnly([{ $match: {} }, { $out: 'x' }])).toThrow(/\$out/)
    expect(() => checkMongoReadOnly({ $where: 'this.a > 1' })).toThrow(/\$where/)
    expect(() => checkMongoReadOnly([{ $lookup: { from: 'x', pipeline: [{ $merge: 'y' }], as: 'z' } }])).toThrow(/\$merge/)
    expect(() => checkMongoReadOnly([{ $group: { _id: null, n: { $sum: 1 } } }])).not.toThrow()
  })

  it('caps large results', () => {
    const rows = Array.from({ length: 3000 }, (_, i) => ({ i, text: 'x'.repeat(200) }))
    const out = JSON.parse(formatRows(rows))
    expect(out.truncated).toBe(true)
    expect(out.rows.length).toBeLessThan(3000)
    expect(JSON.parse(formatRows([{ big: 'y'.repeat(5000) }])).rows[0].big).toMatch(/… \(5000 chars\)$/)
  })
})

describe('MCP server access', () => {
  let server: McpHttpServer
  const log: McpLogEntry[] = []
  const backend: McpBackend = {
    connections: () => [{ id: 'c1', name: 'Local PG', dbType: 'pg', database: 'app', connected: false }],
    pg: () => undefined, mysql: () => undefined, mongo: () => undefined,
    dataToolAllowed: () => true,
  }

  beforeAll(async () => { server = await startMcpHttpServer({ port: 0, token: TOKEN, backend, log: e => log.push(e), version: 'test' }) })
  afterAll(async () => { await server.close() })

  const post = (headers: Record<string, string>) => fetch(server.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })

  it('needs the right token, and refuses web pages and other host names', async () => {
    expect((await post({})).status).toBe(401)
    expect((await post({ Authorization: 'Bearer wrong' })).status).toBe(401)
    expect((await post({ Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.example' })).status).toBe(403)
    // fetch won't send a custom Host header; a DNS-rebinding page's requests carry its own host name
    const rebindingStatus = await new Promise<number>((resolve, reject) => {
      const req = http.request(server.url, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, Host: 'evil.example' } }, res => resolve(res.statusCode ?? 0))
      req.on('error', reject)
      req.end('{}')
    })
    expect(rebindingStatus).toBe(403)
  })

  it('lists the read-only tools and reports connections, logging each call', async () => {
    const client = await connectClient(server.url)
    try {
      const tools = (await client.listTools()).tools
      expect(tools.map(t => t.name).sort()).toEqual(['describe_table', 'list_connections', 'list_databases', 'list_tables', 'mongo_aggregate', 'mongo_find', 'run_query'])
      expect(tools.every(t => t.annotations?.readOnlyHint === true)).toBe(true)
      const res = await call(client, 'list_connections')
      expect(JSON.parse(res.text)).toEqual([{ name: 'Local PG', type: 'postgresql', connected: false, default_database: 'app' }])
      const notConnected = await call(client, 'list_tables', { connection: 'local pg' })
      expect(notConnected).toEqual({ isError: true, text: expect.stringMatching(/not connected/) })
      const unknown = await call(client, 'list_databases', { connection: 'nope' })
      expect(unknown.text).toMatch(/Available: Local PG/)
      expect(log.map(e => [e.tool, e.ok])).toEqual([['list_connections', true], ['list_tables', false], ['list_databases', false]])
    } finally {
      await client.close()
    }
  })
})

describe('data tool gating', () => {
  it('a per-connection override wins over the global switch', () => {
    const settings: DataToolSettings = {
      global: { run_query: false, mongo_find: true, mongo_aggregate: true, edit_cells: true, insert_rows: true, save_table_changes: true, delete_rows: true, execute: true },
      perConnection: { c1: { run_query: true } },
    }
    expect(dataToolEnabled(settings, 'run_query', 'c1')).toBe(true)   // overridden on for c1
    expect(dataToolEnabled(settings, 'run_query', 'c2')).toBe(false)  // c2 still follows the global switch
    expect(dataToolEnabled(settings, 'mongo_find', 'c1')).toBe(true)  // no override: follows global
  })

  it('run_query is refused for a connection it is turned off for', async () => {
    const allowed = { run_query: false } as Record<string, boolean>
    const backend: McpBackend = {
      connections: () => [{ id: 'c1', name: 'Local PG', dbType: 'pg', database: 'app', connected: true }],
      pg: () => undefined, mysql: () => undefined, mongo: () => undefined,
      dataToolAllowed: tool => allowed[tool] ?? true,
    }
    const server = await startMcpHttpServer({ port: 0, token: TOKEN, backend, log: () => {}, version: 'test' })
    try {
      const client = await connectClient(server.url)
      try {
        const res = await call(client, 'run_query', { connection: 'Local PG', sql: 'SELECT 1' })
        expect(res).toEqual({ isError: true, text: expect.stringMatching(/run_query is turned off/) })
      } finally {
        await client.close()
      }
    } finally {
      await server.close()
    }
  })
})

describe('MCP UI tools', () => {
  let server: McpHttpServer
  const requests: { command: string; args: Record<string, unknown> }[] = []
  let writeMode: 'off' | 'ask' | 'allow' = 'off'
  const backend: McpBackend = {
    connections: () => [{ id: 'c1', name: 'Shop', dbType: 'pg', database: 'shop', connected: false }],
    pg: () => undefined, mysql: () => undefined, mongo: () => undefined,
    dataToolAllowed: () => true,
  }

  beforeAll(async () => {
    server = await startMcpHttpServer({
      port: 0, token: TOKEN, backend, log: () => {}, version: 'test',
      ui: { writeMode: () => writeMode, request: async (command, args) => { requests.push({ command, args }); return { ok: command } } },
    })
  })
  afterAll(async () => { await server.close() })

  it('forwards UI commands, and applies the write mode before anything reaches the window', async () => {
    const client = await connectClient(server.url)
    try {
      const names = (await client.listTools()).tools.map(t => t.name)
      expect(names).toEqual(expect.arrayContaining(['app_state', 'open_table', 'select_cell', 'edit_cells', 'save_table_changes', 'delete_rows', 'execute']))
      expect((await client.listTools()).tools.find(t => t.name === 'run_query')?.inputSchema.properties).toHaveProperty('show_in_app')

      // connect finds a disconnected connection; open_table needs a connected one
      expect(JSON.parse((await call(client, 'connect', { connection: 'shop' })).text)).toEqual({ ok: 'connect' })
      expect(requests.at(-1)).toMatchObject({ command: 'connect', args: { connectionId: 'c1' } })
      expect((await call(client, 'open_table', { connection: 'Shop', table: 'items' })).text).toMatch(/not connected/)

      requests.length = 0
      const off = await call(client, 'edit_cells', { tab: 't1', edits: [{ row: 0, column: 'a', value: 1 }] })
      expect(off).toMatchObject({ isError: true, text: expect.stringMatching(/turned off/) })
      expect((await call(client, 'execute', { connection: 'Shop', code: 'DELETE FROM x' })).isError).toBe(true)
      expect(requests).toEqual([])

      writeMode = 'ask'
      await call(client, 'save_table_changes', { tab: 't1' })
      expect(requests.at(-1)).toEqual({ command: 'saveChanges', args: { tab: 't1', approval: 'ask' } })
      writeMode = 'allow'
      await call(client, 'delete_rows', { tab: 't1', rows: [0, 2] })
      expect(requests.at(-1)).toEqual({ command: 'deleteRows', args: { tab: 't1', rows: [0, 2], approval: 'allow' } })
    } finally {
      await client.close()
    }
  })
})

// ── Against real databases ─────────────────────────────────────────────────────

const pgUrl = process.env.QUENCE_PG_TEST_URL
const myUrl = process.env.QUENCE_MYSQL_TEST_URL
const mongoUrl = process.env.QUENCE_MONGO_TEST_URL
const suffix = Math.random().toString(36).slice(2, 8)

describe.skipIf(!pgUrl || !myUrl || !mongoUrl)('MCP tools against databases', () => {
  let server: McpHttpServer
  let client: Client
  let pg: Pool
  let my: mysql.Pool
  let mongo: MongoClient
  const S = `qmcp_${suffix}`

  beforeAll(async () => {
    pg = new Pool({ connectionString: pgUrl })
    await pg.query(`CREATE SCHEMA ${S}; CREATE TABLE ${S}.items (id serial PRIMARY KEY, name text NOT NULL, price numeric(8,2), raw bytea);
      CREATE SEQUENCE ${S}.s; INSERT INTO ${S}.items (name, price, raw) SELECT 'item ' || g, g * 1.5, '\\x00ff' FROM generate_series(1, 150) g;
      COMMENT ON TABLE ${S}.items IS 'Things'`)
    const admin = await mysql.createConnection({ uri: myUrl! })
    await admin.query(`CREATE DATABASE ${S}`)
    await admin.end()
    my = mysql.createPool({ uri: myUrl!, database: S })
    await my.query(`CREATE TABLE people (id int AUTO_INCREMENT PRIMARY KEY, name varchar(50))`)
    await my.query(`INSERT INTO people (name) VALUES ('Ann'), ('Bob')`)
    mongo = new MongoClient(mongoUrl!)
    await mongo.connect()
    await mongo.db(S).collection('docs').insertMany([
      { _id: new ObjectId('64b000000000000000000001'), name: 'a', at: new Date('2026-01-01T00:00:00Z'), n: 1 },
      { _id: new ObjectId('64b000000000000000000002'), name: 'b', n: 2 },
    ])

    const connections: McpConnectionInfo[] = [
      { id: 'pg', name: 'PG', dbType: 'pg', database: new URL(pgUrl!).pathname.slice(1) || 'postgres', connected: true },
      { id: 'my', name: 'My', dbType: 'mysql', database: S, connected: true },
      { id: 'mg', name: 'Mongo', dbType: 'mongodb', database: S, connected: true },
    ]
    server = await startMcpHttpServer({
      port: 0, token: TOKEN, version: 'test', log: () => {},
      backend: { connections: () => connections, pg: () => pg, mysql: () => my, mongo: () => mongo },
    })
    client = await connectClient(server.url)
  })

  afterAll(async () => {
    await client?.close()
    await server?.close()
    await pg.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`)
    await pg.end()
    await my.query(`DROP DATABASE IF EXISTS ${S}`)
    await my.end()
    await mongo.db(S).dropDatabase()
    await mongo.close()
  })

  it('lists and describes PostgreSQL tables and runs capped read queries', async () => {
    const tables = JSON.parse((await call(client, 'list_tables', { connection: 'PG', schema: S })).text)
    expect(tables).toEqual([{ schema: S, name: 'items', kind: 'table', estimated_rows: expect.anything(), comment: 'Things' }])
    const desc = JSON.parse((await call(client, 'describe_table', { connection: 'PG', schema: S, table: 'items' })).text)
    expect(desc.columns.map((c: { name: string }) => c.name)).toEqual(['id', 'name', 'price', 'raw'])
    expect(desc.constraints[0]).toMatchObject({ kind: 'primary key' })

    const res = JSON.parse((await call(client, 'run_query', { connection: 'PG', sql: `SELECT id, price, raw FROM ${S}.items ORDER BY id`, max_rows: 5 })).text)
    expect(res).toMatchObject({ total_rows: 150, row_count: 5, truncated: true })
    expect(res.rows[0]).toEqual({ id: 1, price: '1.50', raw: '\\x00ff' })
  })

  it.each([
    ['a plain write', `DELETE FROM ${suffix}`, /Only read queries/],
    ['a second statement', `SELECT 1; COMMIT; DROP TABLE ${'qmcp_' + suffix}.items`, /multiple commands|cannot insert multiple/],
    ['a writing CTE', `WITH d AS (DELETE FROM ${'qmcp_' + suffix}.items RETURNING 1) SELECT count(*) FROM d`, /read-only transaction/],
    ['nextval', `SELECT nextval('${'qmcp_' + suffix}.s')`, /read-only transaction/],
    ['set_config to escape', `SELECT set_config('transaction_read_only', 'off', true)`, /must be set before any query/],
  ])('refuses %s on PostgreSQL', async (_what, sql, message) => {
    const res = await call(client, 'run_query', { connection: 'PG', sql })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(message)
    expect((await pg.query(`SELECT count(*)::int AS n FROM ${S}.items`)).rows[0].n).toBe(150)
  })

  it('reads MySQL and refuses writes', async () => {
    const res = JSON.parse((await call(client, 'run_query', { connection: 'My', sql: 'SELECT name FROM people ORDER BY id' })).text)
    expect(res.rows).toEqual([{ name: 'Ann' }, { name: 'Bob' }])
    expect(JSON.parse((await call(client, 'describe_table', { connection: 'My', table: 'people' })).text).columns[0]).toMatchObject({ name: 'id', nullable: false })
    for (const sql of ['DROP TABLE people', "INSERT INTO people (name) VALUES ('x')", 'SELECT 1; DROP TABLE people', "SELECT * FROM people INTO OUTFILE '/tmp/x'"]) {
      expect((await call(client, 'run_query', { connection: 'My', sql })).isError).toBe(true)
    }
    const [[row]] = await my.query('SELECT count(*) AS n FROM people') as [Record<string, unknown>[], unknown]
    expect(Number(row.n)).toBe(2)
  })

  it('finds and aggregates MongoDB documents with Extended JSON, and refuses writes', async () => {
    const found = JSON.parse((await call(client, 'mongo_find', { connection: 'Mongo', collection: 'docs', filter: '{"_id": {"$oid": "64b000000000000000000001"}}' })).text)
    expect(found.rows).toEqual([{ _id: { $oid: '64b000000000000000000001' }, name: 'a', at: { $date: '2026-01-01T00:00:00Z' }, n: 1 }])
    const agg = JSON.parse((await call(client, 'mongo_aggregate', { connection: 'Mongo', collection: 'docs', pipeline: '[{"$group": {"_id": null, "total": {"$sum": "$n"}}}]' })).text)
    expect(agg.rows).toEqual([{ _id: null, total: 3 }])
    const out = await call(client, 'mongo_aggregate', { connection: 'Mongo', collection: 'docs', pipeline: '[{"$out": "stolen"}]' })
    expect(out).toMatchObject({ isError: true, text: expect.stringMatching(/\$out is not allowed/) })
    expect(await mongo.db(S).listCollections({ name: 'stolen' }).toArray()).toEqual([])
    const desc = JSON.parse((await call(client, 'describe_table', { connection: 'Mongo', table: 'docs' })).text)
    expect(desc.fields.find((f: { name: string }) => f.name === 'at')).toMatchObject({ types: ['date'], present_in: '1/2' })
  })

  it('points to the right tool for the connection type', async () => {
    expect((await call(client, 'run_query', { connection: 'Mongo', sql: 'SELECT 1' })).text).toMatch(/mongo_find/)
    expect((await call(client, 'mongo_find', { connection: 'PG', collection: 'x' })).text).toMatch(/run_query/)
  })
})
