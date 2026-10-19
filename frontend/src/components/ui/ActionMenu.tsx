'use client'

import { createPortal } from 'react-dom'
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { EllipsisVertical } from 'lucide-react'

import { Spinner } from './Spinner'

export interface ActionMenuItem {
  /** Stable key. */
  id: string
  /** Visible + accessible text, e.g. 'Ubah'. */
  label: string
  /** Decorative lucide icon; the component sets aria-hidden on it. */
  icon?: ReactNode
  /** Called AFTER the menu closes. */
  onSelect: () => void
  /** 'danger' renders the destructive styling. */
  tone?: 'default' | 'danger'
  disabled?: boolean
}

export interface ActionMenuProps {
  /** Accessible name of the icon-only trigger, e.g. `Aksi untuk Budi Santoso`. */
  label: string
  items: ActionMenuItem[]
  /** Shows a spinner + disables the trigger while a row action is in flight. */
  busy?: boolean
  align?: 'start' | 'end'
  className?: string
}

const TRIGGER_CLASS =
  'inline-flex min-h-touch min-w-touch items-center justify-center rounded-control border border-border-light text-ink-secondary transition hover:bg-neutral-bg disabled:cursor-not-allowed disabled:opacity-60'

const PANEL_CLASS =
  'fixed z-[60] w-56 rounded-control border border-border-mid bg-surface p-1 shadow-dropdown'

const ITEM_CLASS =
  'flex min-h-touch w-full items-center gap-2 rounded-control px-3 text-sm transition hover:bg-neutral-bg cursor-pointer'

const DANGER_ITEM_CLASS = 'text-danger-text hover:bg-danger-bg'

const MENU_ITEM_HEIGHT = 44
const MENU_VERTICAL_PADDING = 10
const MENU_GAP = 4
const MENU_WIDTH = 224

export function ActionMenu({ label, items, busy = false, align = 'end', className }: ActionMenuProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const generatedId = useId()
  const triggerId = `${generatedId}-trigger`
  const menuId = `${generatedId}-menu`
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const focusIntentRef = useRef<'first' | 'last'>('first')

  function openMenu(intent: 'first' | 'last' = 'first') {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const menuHeight = items.length * MENU_ITEM_HEIGHT + MENU_VERTICAL_PADDING
    let top = rect.bottom + MENU_GAP
    if (top + menuHeight > window.innerHeight) {
      top = rect.top - menuHeight - MENU_GAP
    }
    let left = align === 'start' ? rect.left : rect.right - MENU_WIDTH
    left = Math.max(8, Math.min(left, window.innerWidth - MENU_WIDTH - 8))
    setPos({ top, left })
    focusIntentRef.current = intent
    setOpen(true)
  }

  function closeMenu(refocusTrigger: boolean) {
    setOpen(false)
    setPos(null)
    if (refocusTrigger) {
      triggerRef.current?.focus()
    }
  }

  function handleSelect(item: ActionMenuItem) {
    if (item.disabled) return
    setOpen(false)
    setPos(null)
    item.onSelect()
  }

  useEffect(() => {
    if (!open) return
    function handlePointerDown(event: PointerEvent) {
      const target = event.target
      if (!(target instanceof Node)) return
      if (triggerRef.current?.contains(target)) return
      if (panelRef.current?.contains(target)) return
      setOpen(false)
      setPos(null)
    }
    // Gulir/resize MEMUTUS menu, bukan mereposisi: panel di-portal dengan
    // `position: fixed`, jadi begitu halaman bergeser ia terlepas dari
    // trigger. `capture: true` menangkap gulir di kontainer scroll turunan.
    function handleViewportChange() {
      setOpen(false)
      setPos(null)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('scroll', handleViewportChange, true)
    window.addEventListener('resize', handleViewportChange)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('scroll', handleViewportChange, true)
      window.removeEventListener('resize', handleViewportChange)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    if (!panel) return
    const enabled = Array.from(
      panel.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'),
    ).filter((button) => !button.disabled)
    if (enabled.length === 0) return
    const target =
      focusIntentRef.current === 'last'
        ? enabled[enabled.length - 1]
        : enabled[0]
    if (!target) return
    target.focus()
  }, [open])

  // WAJIB berada SETELAH seluruh hook. Early return sebelum hook melompati
  // Rules of Hooks dan melempar React ("Rendered fewer hooks than expected")
  // tepat pada transisi `items` jadi kosong — mis. baris terakhir dihapus
  // atau filter tidak cocok.
  if (items.length === 0) {
    return null
  }

  function handleTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Escape') {
      // Hanya serap Escape saat menu TERBUKA. Saat tertutup, biarkan modal
      // induk (listener document-level-nya) tetap menutup seperti biasa.
      if (open) {
        event.stopPropagation()
        event.preventDefault()
        closeMenu(true)
      }
      return
    }
    if (busy) return
    if (!open) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        openMenu('first')
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        openMenu('last')
      }
    }
  }

  function handlePanelKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation()
      event.preventDefault()
      closeMenu(true)
      return
    }
    const panel = panelRef.current
    if (!panel) return
    const enabled = Array.from(
      panel.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'),
    ).filter((button) => !button.disabled)
    if (enabled.length === 0) return
    const active = document.activeElement as HTMLElement | null
    const currentIndex = enabled.indexOf(active as HTMLButtonElement)

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      const nextIndex =
        currentIndex < 0 ? 0 : (currentIndex + 1) % enabled.length
      enabled[nextIndex]?.focus()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      const prevIndex =
        currentIndex < 0
          ? enabled.length - 1
          : (currentIndex - 1 + enabled.length) % enabled.length
      enabled[prevIndex]?.focus()
    } else if (event.key === 'Home') {
      event.preventDefault()
      enabled[0]?.focus()
    } else if (event.key === 'End') {
      event.preventDefault()
      enabled[enabled.length - 1]?.focus()
    }
  }

  const triggerClasses = [TRIGGER_CLASS, className ?? ''].filter(Boolean).join(' ')

  return (
    <>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-busy={busy || undefined}
        disabled={busy}
        onClick={() => {
          if (busy) return
          if (open) {
            closeMenu(false)
          } else {
            openMenu('first')
          }
        }}
        onKeyDown={handleTriggerKeyDown}
        className={triggerClasses}
      >
        {busy ? (
          <Spinner size="sm" />
        ) : (
          <EllipsisVertical aria-hidden="true" className="size-4" />
        )}
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={panelRef}
              id={menuId}
              role="menu"
              aria-labelledby={triggerId}
              onKeyDown={handlePanelKeyDown}
              className={PANEL_CLASS}
              style={{ top: `${pos.top}px`, left: `${pos.left}px` }}
            >
              {items.map((item) => {
                const itemClasses = [
                  ITEM_CLASS,
                  item.tone === 'danger' ? DANGER_ITEM_CLASS : 'text-ink',
                  item.disabled ? 'opacity-50 cursor-not-allowed' : '',
                ]
                  .filter(Boolean)
                  .join(' ')
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    disabled={item.disabled}
                    onClick={() => handleSelect(item)}
                    className={itemClasses}
                  >
                    {item.icon ? (
                      <span aria-hidden="true" className="shrink-0">
                        {item.icon}
                      </span>
                    ) : null}
                    {item.label}
                  </button>
                )
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
