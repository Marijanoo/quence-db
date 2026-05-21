'use client'

import { useEffect } from 'react'

const STORAGE_KEY = 'quence-zoom'

function getZoom(): number {
  try {
    const v = parseFloat(localStorage.getItem(STORAGE_KEY) ?? '')
    if (!isNaN(v)) return v
  } catch {}
  return 1
}

function applyZoom(z: number) {
  document.documentElement.style.fontSize = `${z * 16}px`
}

export function ZoomHandler() {
  useEffect(() => {
    applyZoom(getZoom())

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const api = (window as any).electronAPI
      if (e.deltaY < 0) {
        api?.zoomIn()
      } else {
        api?.zoomOut()
      }
    }

    const clearSelection = () => window.getSelection()?.removeAllRanges()

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        clearSelection()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        // If focus is in a native input/textarea, let the browser handle it
        const active = document.activeElement
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return
        e.preventDefault()
        // Find nearest selectable ancestor from the focused element, or fall back to body
        const root = active?.closest('pre, code, [contenteditable="true"], [contenteditable=""], .selectable') ?? document.body
        const selection = window.getSelection()
        if (!selection) return
        const range = document.createRange()
        range.selectNodeContents(root)
        selection.removeAllRanges()
        selection.addRange(range)
      }
    }

    window.addEventListener('wheel', onWheel, { passive: false })
    document.addEventListener('mousedown', clearSelection, { capture: true })
    document.addEventListener('keydown', onKeyDown, { capture: true })
    window.addEventListener('blur', clearSelection)
    return () => {
      window.removeEventListener('wheel', onWheel)
      document.removeEventListener('mousedown', clearSelection, { capture: true })
      document.removeEventListener('keydown', onKeyDown, { capture: true })
      window.removeEventListener('blur', clearSelection)
    }
  }, [])

  return null
}
