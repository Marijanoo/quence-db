'use client'

// The SSH tunnel section of the connection dialogs. Non-secret settings live in the connection's
// options (options.ssh); the password and key passphrase are stored encrypted, apart.
import React from 'react'
import { Check, KeySquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SshOptions } from '@/lib/connection-options'

const inputCls = 'w-full bg-background border border-border rounded px-2 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary'

export const DEFAULT_SSH: SshOptions = { enabled: false, host: '', port: 22, user: '', auth: 'password' }

export function SshTunnelFields({ value, onChange, password, onPassword, passphrase, onPassphrase }: {
  value: SshOptions | undefined
  onChange: (v: SshOptions) => void
  password: string
  onPassword: (v: string) => void
  passphrase: string
  onPassphrase: (v: string) => void
}) {
  const ssh = value ?? DEFAULT_SSH
  const set = (patch: Partial<SshOptions>) => onChange({ ...ssh, ...patch })
  const pickKey = async () => {
    const picked = await window.electronAPI?.files?.openDialog?.({ title: 'Choose an SSH private key', filters: [{ name: 'All Files', extensions: ['*'] }] })
    if (picked?.[0]) set({ keyPath: picked[0] })
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button" onClick={() => set({ enabled: !ssh.enabled })}
          className={cn('h-4 w-4 rounded flex items-center justify-center transition-all border shadow-sm', ssh.enabled ? 'bg-primary border-primary text-primary-foreground' : 'border-border/85 bg-background hover:border-border')}
        >
          {ssh.enabled && <Check className="h-3 w-3 stroke-[3.5]" />}
        </button>
        <span className="text-xs text-muted-foreground select-none cursor-pointer flex items-center gap-1" onClick={() => set({ enabled: !ssh.enabled })}>
          <KeySquare className="h-3 w-3" /> Connect through an SSH tunnel
        </span>
      </div>
      {ssh.enabled && (
        <div className="space-y-2 pl-6">
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2 space-y-1">
              <label className="text-xs text-muted-foreground">SSH server</label>
              <input value={ssh.host} onChange={e => set({ host: e.target.value })} placeholder="bastion.example.com" className={inputCls} />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Port</label>
              <input value={String(ssh.port || '')} onChange={e => set({ port: Number(e.target.value.replace(/\D/g, '')) || 22 })} placeholder="22" className={inputCls} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">SSH user</label>
              <input value={ssh.user} onChange={e => set({ user: e.target.value })} placeholder="ubuntu" className={inputCls} />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Sign in with</label>
              <select value={ssh.auth} onChange={e => set({ auth: e.target.value as SshOptions['auth'] })} className={inputCls}>
                <option value="password">Password</option>
                <option value="key">Private key</option>
                <option value="agent">SSH agent</option>
              </select>
            </div>
          </div>
          {ssh.auth === 'password' && (
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">SSH password</label>
              <input type="password" value={password} onChange={e => onPassword(e.target.value)} placeholder="••••••••" className={inputCls} />
            </div>
          )}
          {ssh.auth === 'key' && (
            <>
              <div className="flex items-center gap-2">
                <div className="flex-1 bg-background border border-border rounded px-2 py-1.5 text-xs text-muted-foreground truncate font-mono" title={ssh.keyPath}>
                  {ssh.keyPath || 'No key file chosen (e.g. ~/.ssh/id_ed25519)'}
                </div>
                <button type="button" onClick={() => void pickKey()}
                  className="px-2.5 py-1.5 rounded text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-accent/20 transition-colors shrink-0">
                  Browse
                </button>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Key passphrase <span className="text-muted-foreground/50">(if the key has one)</span></label>
                <input type="password" value={passphrase} onChange={e => onPassphrase(e.target.value)} placeholder="••••••••" className={inputCls} />
              </div>
            </>
          )}
          {ssh.auth === 'agent' && (
            <p className="text-[11px] text-muted-foreground/70">Uses the keys loaded in your SSH agent (ssh-agent, or the Windows OpenSSH agent).</p>
          )}
          <p className="text-[11px] text-muted-foreground/70">
            The database host and port above are as the SSH server sees them: use <span className="font-mono">localhost</span> if the database runs on that server.
            The server’s host key is remembered the first time; if it ever changes, the connection is refused.
          </p>
        </div>
      )}
    </div>
  )
}
