import * as fs from 'fs'
import * as path from 'path'
import type { HostKeyCheck } from './ssh-tunnel'

// Host key fingerprints of the SSH servers connected to, by "host:port" (known_hosts.json in the
// app's data folder)

export function knownHostsStore(dir: string): { check: HostKeyCheck; forget: (hostId: string) => void; list: () => Record<string, string> } {
  const file = path.join(dir, 'ssh_known_hosts.json')
  const read = (): Record<string, string> => {
    try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v === 'object' ? v : {} } catch { return {} }
  }
  const write = (v: Record<string, string>) => fs.writeFileSync(file, JSON.stringify(v, null, 2), { mode: 0o600 })
  return {
    check: (hostId, fingerprint) => {
      const known = read()
      if (!known[hostId]) { write({ ...known, [hostId]: fingerprint }); return 'new' }
      return known[hostId] === fingerprint ? 'known' : 'changed'
    },
    forget: hostId => { const known = read(); delete known[hostId]; write(known) },
    list: read,
  }
}
