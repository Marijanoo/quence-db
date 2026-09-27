// The server monitor against a real PostgreSQL server. Opt-in: set QUENCE_PG_TEST_URL.
// Makes a real lock wait between two connections, then cancels and terminates them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { monitorTiles, pgMonitor } from './server-monitor'

const url = process.env.QUENCE_PG_TEST_URL
const T = `qmon_${Math.random().toString(36).slice(2, 8)}`

describe.skipIf(!url)('server monitor on PostgreSQL', () => {
  let monitor: Client, holder: Client, waiter: Client
  const mon = () => pgMonitor(async (sql, params) => (await monitor.query(sql, params)).rows)

  beforeAll(async () => {
    monitor = new Client({ connectionString: url, application_name: 'qmon-monitor' })
    holder = new Client({ connectionString: url, application_name: 'qmon-holder' })
    waiter = new Client({ connectionString: url, application_name: 'qmon-waiter' })
    for (const c of [monitor, holder, waiter]) { await c.connect(); c.on('error', () => {}) }
    await monitor.query(`CREATE TABLE public.${T} (id int PRIMARY KEY, v int); INSERT INTO public.${T} VALUES (1, 0)`)
  })

  afterAll(async () => {
    await monitor.query(`DROP TABLE IF EXISTS public.${T}`)
    for (const c of [monitor, holder, waiter]) await c.end().catch(() => {})
  })

  it('shows sessions, a lock wait with its blocker, and the figures', async () => {
    const holderPid = (await holder.query('SELECT pg_backend_pid() AS p')).rows[0].p
    await holder.query(`BEGIN; UPDATE public.${T} SET v = 1 WHERE id = 1`)
    const waiting = waiter.query(`UPDATE public.${T} SET v = 2 WHERE id = 1`).then(() => 'done', (e: Error) => e.message)

    // Wait until the monitor sees the waiter blocked
    let snap = await mon().load()
    for (let i = 0; i < 50 && !snap.sessions.some(s => s.app === 'qmon-waiter' && s.state === 'blocked'); i++) {
      await new Promise(r => setTimeout(r, 100))
      snap = await mon().load()
    }
    const by = (app: string) => snap.sessions.find(s => s.app === app)!
    expect(by('qmon-waiter')).toMatchObject({ state: 'blocked', blockedBy: [String(holderPid)], system: false })
    expect(by('qmon-waiter').query).toContain(`UPDATE public.${T} SET v = 2`)
    expect(by('qmon-holder')).toMatchObject({ id: String(holderPid), state: 'idle-tx', stateLabel: 'idle in transaction' })
    expect(by('qmon-monitor').self).toBe(true)
    expect(snap.sessions.some(s => s.system)).toBe(true)
    expect(snap.version).toMatch(/^PostgreSQL \d+/)
    expect(snap.gauges.blocked).toBeGreaterThanOrEqual(1)
    expect(snap.gauges.max_connections).toBeGreaterThan(0)

    const later = await mon().load()
    const tiles = Object.fromEntries(monitorTiles('postgres', snap, later).map(t => [t.label, t.value]))
    expect(tiles['Transactions/s']).toMatch(/^\d/)
    expect(tiles['Cache hit']).toMatch(/%$|–/)

    // Cancelling the waiter's statement ends it with an error but keeps the connection
    await mon().cancel!(by('qmon-waiter').id)
    expect(await waiting).toMatch(/canceling statement/)
    expect((await waiter.query('SELECT 1 AS one')).rows[0].one).toBe(1)

    // Terminating the holder closes its connection and rolls back its update
    await mon().kill(String(holderPid))
    await expect(holder.query('SELECT 1')).rejects.toThrow()
    expect((await monitor.query(`SELECT v FROM public.${T} WHERE id = 1`)).rows[0].v).toBe(0)
    await expect(mon().kill(String(holderPid))).rejects.toThrow(/no longer there/)
  })
})
