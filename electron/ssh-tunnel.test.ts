// SSH tunnels. The live tests need an SSH server that allows TCP forwarding and can reach this
// machine: QUENCE_SSH_TEST_URL (ssh://user:password@host:port) and QUENCE_SSH_TEST_TARGET_HOST, the
// name of this machine as the SSH server sees it (host.docker.internal for a Docker container).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { closeAllTunnels, closeTunnel, mongoTunnelTarget, openTunnel, redisTunnelTarget, sshFingerprint } from './ssh-tunnel'
import { knownHostsStore } from './ssh-known-hosts'

describe('pointing connections at a tunnel', () => {
  it('rewrites MongoDB addresses to the first host, directly', () => {
    const t = mongoTunnelTarget('mongodb://me:pw@db1.internal:27018,db2.internal/app?replicaSet=rs0&tls=true')
    expect(t).toMatchObject({ host: 'db1.internal', port: 27018 })
    expect(t.rewrite({ host: '127.0.0.1', port: 5555 })).toBe('mongodb://me:pw@127.0.0.1:5555/app?replicaSet=rs0&tls=true&directConnection=true')
    expect(mongoTunnelTarget('mongodb://localhost').port).toBe(27017)
    expect(() => mongoTunnelTarget('mongodb+srv://cluster0.example.net')).toThrow(/mongodb\+srv/)
  })

  it('rewrites Redis URLs and plain hosts', () => {
    const url = redisTunnelTarget('rediss://u:p@cache.internal:6380/2', undefined)
    expect(url).toMatchObject({ host: 'cache.internal', port: 6380 })
    expect(url.rewrite({ host: '127.0.0.1', port: 7777 })).toEqual({ host: 'rediss://u:p@127.0.0.1:7777/2', port: 7777 })
    expect(redisTunnelTarget('cache.internal', 6379).rewrite({ host: '127.0.0.1', port: 1 })).toEqual({ host: '127.0.0.1', port: 1 })
  })
})

describe('known SSH hosts', () => {
  let dir: string
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })

  it('remembers a key the first time, accepts it again, and refuses a different one', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qdb-known-'))
    const store = knownHostsStore(dir)
    const a = sshFingerprint(Buffer.from('key-a'))
    expect(a).toMatch(/^SHA256:[A-Za-z0-9+/]+$/)
    expect(store.check('bastion:22', a)).toBe('new')
    expect(store.check('bastion:22', a)).toBe('known')
    expect(store.check('bastion:22', sshFingerprint(Buffer.from('key-b')))).toBe('changed')
    store.forget('bastion:22')
    expect(store.check('bastion:22', sshFingerprint(Buffer.from('key-b')))).toBe('new')
  })
})

const sshUrl = process.env.QUENCE_SSH_TEST_URL
const targetHost = process.env.QUENCE_SSH_TEST_TARGET_HOST

describe.skipIf(!sshUrl || !targetHost)('tunnels through a real SSH server', () => {
  let echo: net.Server
  let echoPort = 0
  const u = sshUrl ? new URL(sshUrl) : null
  const ssh = u ? { host: u.hostname, port: Number(u.port) || 22, user: decodeURIComponent(u.username), auth: 'password' as const, password: decodeURIComponent(u.password) } : null
  const trusting = () => 'known' as const

  beforeAll(async () => {
    // An echo server on this machine, reached back through the SSH server
    echo = net.createServer(s => s.pipe(s))
    await new Promise<void>(r => echo.listen(0, '0.0.0.0', () => r()))
    echoPort = (echo.address() as net.AddressInfo).port
  })
  afterAll(() => { closeAllTunnels(); echo.close() })

  const roundTrip = (port: number, text: string) => new Promise<string>((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(text))
    sock.once('data', d => { resolve(d.toString()); sock.end() })
    sock.once('error', reject)
  })

  it('forwards connections to the target, several at once', async () => {
    const local = await openTunnel('t1', ssh!, { host: targetHost!, port: echoPort }, trusting)
    expect(local.host).toBe('127.0.0.1')
    expect(await Promise.all([roundTrip(local.port, 'one'), roundTrip(local.port, 'two')])).toEqual(['one', 'two'])
    closeTunnel('t1')
    await expect(roundTrip(local.port, 'x')).rejects.toThrow()
  })

  it('reports a wrong password and a changed host key clearly', async () => {
    await expect(openTunnel('t2', { ...ssh!, password: 'wrong' }, { host: targetHost!, port: echoPort }, trusting)).rejects.toThrow(/^SSH: .*authentication/i)
    await expect(openTunnel('t3', ssh!, { host: targetHost!, port: echoPort }, () => 'changed')).rejects.toThrow(/host key .* has changed/)
  })
})
