import { Client, type ConnectConfig } from 'ssh2'
import * as net from 'net'
import * as fs from 'fs'
import { createHash } from 'crypto'

// SSH tunnels for database connections: a local port on 127.0.0.1 whose connections are
// forwarded through the SSH server to the database. The database driver connects to the local
// port. The database host is as the SSH server sees it ("localhost" when the database runs on the
// SSH server itself).
//
// Host keys: the server's key is remembered the first time (trust on first use); a different key
// later means the connection is refused, since that's what a man-in-the-middle looks like.

export interface SshConfig {
  host: string
  port: number
  user: string
  auth: 'password' | 'key' | 'agent'
  password?: string
  keyPath?: string
  passphrase?: string
}

export type HostKeyCheck = (hostId: string, fingerprint: string) => 'known' | 'new' | 'changed'

const tunnels = new Map<string, { server: net.Server; client: Client }>()

export function sshFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

function defaultAgent(): string | undefined {
  return process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined)
}

export function closeTunnel(id: string) {
  const t = tunnels.get(id)
  tunnels.delete(id)
  if (!t) return
  t.server.close()
  t.client.end()
}

export function closeAllTunnels() {
  for (const id of [...tunnels.keys()]) closeTunnel(id)
}

export async function openTunnel(id: string, ssh: SshConfig, target: { host: string; port: number }, checkHostKey: HostKeyCheck): Promise<{ host: string; port: number }> {
  closeTunnel(id)
  if (!ssh.host) throw new Error('SSH: enter the SSH server')
  if (!ssh.user) throw new Error('SSH: enter the SSH user')

  const hostId = `${ssh.host}:${ssh.port || 22}`
  let keyProblem: string | null = null
  const config: ConnectConfig = {
    host: ssh.host,
    port: ssh.port || 22,
    username: ssh.user,
    readyTimeout: 20_000,
    keepaliveInterval: 15_000,
    hostVerifier: (key: Buffer) => {
      const fingerprint = sshFingerprint(key)
      const result = checkHostKey(hostId, fingerprint)
      if (result === 'changed') {
        keyProblem = `SSH: the host key of ${hostId} has changed (now ${fingerprint}). This can mean someone is intercepting the connection. If the server was reinstalled, remove it from the known SSH hosts and connect again.`
        return false
      }
      return true
    },
  }
  if (ssh.auth === 'password') {
    config.password = ssh.password ?? ''
  } else if (ssh.auth === 'key') {
    if (!ssh.keyPath) throw new Error('SSH: choose the private key file')
    try {
      config.privateKey = fs.readFileSync(ssh.keyPath)
    } catch (err) {
      throw new Error(`SSH: could not read the private key ${ssh.keyPath}: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (ssh.passphrase) config.passphrase = ssh.passphrase
  } else {
    const agent = defaultAgent()
    if (!agent) throw new Error('SSH: no SSH agent found (SSH_AUTH_SOCK is not set)')
    config.agent = agent
  }

  const client = new Client()
  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve())
    client.once('error', err => reject(new Error(keyProblem ?? `SSH: ${err.message}`)))
    try {
      client.connect(config)
    } catch (err) {
      reject(new Error(`SSH: ${err instanceof Error ? err.message : String(err)}`))
    }
  })

  const server = net.createServer(socket => {
    client.forwardOut('127.0.0.1', socket.remotePort ?? 0, target.host, target.port, (err, stream) => {
      if (err) { socket.destroy(); return }
      socket.pipe(stream).pipe(socket)
      socket.on('error', () => stream.close())
      stream.on('error', () => socket.destroy())
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  client.on('close', () => { if (tunnels.get(id)?.client === client) { tunnels.delete(id); server.close() } })
  client.on('error', () => { /* the database driver reports the failed connection */ })
  tunnels.set(id, { server, client })
  return { host: '127.0.0.1', port: (server.address() as net.AddressInfo).port }
}

// ── Pointing connection URLs at a tunnel ──────────────────────────────────────

// mongodb://user:pass@db.internal:27017,db2:27017/app?x=1 → the first host, as the tunnel target,
// and the URL rewritten to the local end (a single host, so directConnection)
export function mongoTunnelTarget(uri: string): { host: string; port: number; rewrite: (local: { host: string; port: number }) => string } {
  if (/^mongodb\+srv:/i.test(uri)) throw new Error('SSH tunnels don’t work with mongodb+srv:// addresses: use the mongodb:// address of one server')
  const m = /^(mongodb:\/\/)([^@/?]*@)?([^/?]+)(\/[^?]*)?(\?.*)?$/i.exec(uri.trim())
  if (!m) throw new Error('Could not read the MongoDB address')
  const first = m[3].split(',')[0]
  const [host, port] = first.startsWith('[') ? [first.slice(1, first.indexOf(']')), first.split(']:')[1]] : first.split(':')
  return {
    host,
    port: Number(port) || 27017,
    rewrite: local => {
      const query = new URLSearchParams((m[5] ?? '').replace(/^\?/, ''))
      query.set('directConnection', 'true')
      return `${m[1]}${m[2] ?? ''}${local.host}:${local.port}${m[4] ?? '/'}?${query.toString()}`
    },
  }
}

// redis://user:pass@cache.internal:6379/2 → the same with the tunnel's local host and port
export function redisTunnelTarget(hostOrUrl: string, port: number | undefined): { host: string; port: number; rewrite: (local: { host: string; port: number }) => { host: string; port: number } } {
  if (/^rediss?:\/\//i.test(hostOrUrl)) {
    const url = new URL(hostOrUrl)
    return {
      host: url.hostname,
      port: Number(url.port) || 6379,
      rewrite: local => { url.hostname = local.host; url.port = String(local.port); return { host: url.toString(), port: local.port } },
    }
  }
  return { host: hostOrUrl || 'localhost', port: port || 6379, rewrite: local => local }
}
