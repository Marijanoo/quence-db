'use client'

import React from 'react'
import { Check } from 'lucide-react'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger, DropdownMenuLabel,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export type MenuEntry =
  | { kind: 'separator' }
  | { kind: 'label'; label: string }
  | {
      kind?: 'item'
      label: string
      icon?: React.ReactNode
      shortcut?: string
      // Shown dimmed after the label, e.g. why the item is disabled
      hint?: string
      disabled?: boolean
      checked?: boolean
      destructive?: boolean
      onSelect?: () => void
      submenu?: MenuEntry[]
    }

const itemClass = 'text-xs py-1 gap-2 min-h-6'

function MenuEntries({ entries }: { entries: MenuEntry[] }) {
  return (
    <>
      {entries.map((entry, i) => {
        if (entry.kind === 'separator') return <DropdownMenuSeparator key={i} />
        if (entry.kind === 'label') return <DropdownMenuLabel key={i} className="text-[11px] py-1 font-normal text-muted-foreground truncate max-w-72">{entry.label}</DropdownMenuLabel>
        const body = (
          <>
            <span className="w-3.5 flex items-center justify-center shrink-0">
              {entry.checked ? <Check className="h-3.5 w-3.5 text-primary" /> : entry.icon}
            </span>
            <span className="truncate">{entry.label}</span>
            {entry.hint && <span className="text-[10px] text-muted-foreground/70 shrink-0">{entry.hint}</span>}
          </>
        )
        if (entry.submenu) {
          return (
            <DropdownMenuSub key={i}>
              <DropdownMenuSubTrigger className={itemClass} disabled={entry.disabled}>{body}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-44">
                <MenuEntries entries={entry.submenu} />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )
        }
        return (
          <DropdownMenuItem
            key={i}
            className={itemClass}
            disabled={entry.disabled}
            variant={entry.destructive ? 'destructive' : 'default'}
            onSelect={() => entry.onSelect?.()}
          >
            {body}
            {entry.shortcut && <DropdownMenuShortcut className="pl-4 tracking-normal text-[10px]">{entry.shortcut}</DropdownMenuShortcut>}
          </DropdownMenuItem>
        )
      })}
    </>
  )
}

// A menu opened at a point, e.g. where the user right-clicked. Radix handles keyboard navigation,
// submenus, and keeping it on screen.
export function ContextMenuAt({ x, y, entries, onClose, className }: {
  x: number
  y: number
  entries: MenuEntry[]
  onClose: () => void
  className?: string
}) {
  return (
    <DropdownMenu open onOpenChange={open => { if (!open) onClose() }}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden style={{ position: 'fixed', left: x, top: y, width: 0, height: 0 }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" sideOffset={2} className={cn('min-w-52', className)} onCloseAutoFocus={e => e.preventDefault()}>
        <MenuEntries entries={entries} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
