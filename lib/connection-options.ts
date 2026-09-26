// Per-connection settings beyond host/port/credentials, saved as one JSON object: an environment
// tag and color (so a production connection is unmistakable), whether queries that change data
// run in Safe Run mode, and the SSH tunnel to connect through.

export type ConnectionEnvironment = 'production' | 'staging' | 'testing' | 'development'
export type ConnectionColorKey = 'red' | 'orange' | 'yellow' | 'green' | 'teal' | 'blue' | 'purple' | 'pink' | 'gray'
// auto: on for production connections; always / never: regardless of the environment
export type SafeRunMode = 'auto' | 'always' | 'never'

export interface SshOptions {
  enabled: boolean
  host: string
  port: number
  user: string
  auth: 'password' | 'key' | 'agent'
  keyPath?: string
}

export interface ConnectionOptions {
  environment?: ConnectionEnvironment
  color?: ConnectionColorKey
  safeRun?: SafeRunMode
  ssh?: SshOptions
}

export const CONNECTION_COLORS: Record<ConnectionColorKey, string> = {
  red: 'oklch(0.64 0.22 25)',
  orange: 'oklch(0.72 0.17 55)',
  yellow: 'oklch(0.83 0.16 92)',
  green: 'oklch(0.72 0.17 150)',
  teal: 'oklch(0.72 0.12 190)',
  blue: 'oklch(0.66 0.17 252)',
  purple: 'oklch(0.63 0.2 300)',
  pink: 'oklch(0.71 0.19 350)',
  gray: 'oklch(0.62 0.02 260)',
}

export const ENVIRONMENTS: { key: ConnectionEnvironment; label: string; short: string; color: ConnectionColorKey }[] = [
  { key: 'production', label: 'Production', short: 'PROD', color: 'red' },
  { key: 'staging', label: 'Staging', short: 'STAGE', color: 'orange' },
  { key: 'testing', label: 'Testing', short: 'TEST', color: 'blue' },
  { key: 'development', label: 'Development', short: 'DEV', color: 'green' },
]

export function environmentInfo(env: ConnectionEnvironment | undefined) {
  return env ? ENVIRONMENTS.find(e => e.key === env) : undefined
}

// The connection's color: the one picked, else its environment's; null for an untagged connection
export function connectionColor(o: ConnectionOptions | undefined): string | null {
  const key = o?.color ?? environmentInfo(o?.environment)?.color
  return key ? CONNECTION_COLORS[key] : null
}

export function safeRunEnabled(o: ConnectionOptions | undefined): boolean {
  const mode = o?.safeRun ?? 'auto'
  return mode === 'always' || (mode === 'auto' && o?.environment === 'production')
}

const oneOf = <T extends string>(v: unknown, values: readonly T[]): T | undefined => values.includes(v as T) ? v as T : undefined

// Reads saved options defensively: unknown or malformed values are dropped
export function parseConnectionOptions(raw: unknown): ConnectionOptions {
  let o: Record<string, unknown> = {}
  try {
    o = typeof raw === 'string' ? JSON.parse(raw) : (raw && typeof raw === 'object' ? raw as Record<string, unknown> : {})
  } catch { return {} }
  if (!o || typeof o !== 'object') return {}
  const out: ConnectionOptions = {}
  const env = oneOf(o.environment, ENVIRONMENTS.map(e => e.key))
  if (env) out.environment = env
  const color = oneOf(o.color, Object.keys(CONNECTION_COLORS) as ConnectionColorKey[])
  if (color) out.color = color
  const safeRun = oneOf(o.safeRun, ['auto', 'always', 'never'] as const)
  if (safeRun) out.safeRun = safeRun
  const ssh = o.ssh as Record<string, unknown> | undefined
  if (ssh && typeof ssh === 'object' && typeof ssh.host === 'string') {
    out.ssh = {
      enabled: ssh.enabled === true,
      host: ssh.host,
      port: Number.isInteger(ssh.port) && (ssh.port as number) > 0 && (ssh.port as number) < 65536 ? ssh.port as number : 22,
      user: typeof ssh.user === 'string' ? ssh.user : '',
      auth: oneOf(ssh.auth, ['password', 'key', 'agent'] as const) ?? 'password',
      ...(typeof ssh.keyPath === 'string' && ssh.keyPath ? { keyPath: ssh.keyPath } : {}),
    }
  }
  return out
}
