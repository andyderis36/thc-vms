'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, LogOut } from 'lucide-react'

export interface ProfileMenuUser {
  name: string
  /** Label peran opsional (mis. "Admin Cabang") — ditampilkan di bawah nama. */
  role?: string
  /** URL foto profil opsional; bila kosong dipakai inisial nama. */
  avatarUrl?: string
}

export interface ProfileMenuProps {
  user: ProfileMenuUser
  onLogout: () => void
}

const TRIGGER_CLASS =
  'flex min-h-touch items-center gap-2 rounded-control px-2 text-left transition hover:bg-neutral-bg cursor-pointer'

const AVATAR_CLASS =
  'flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand text-label font-bold text-brand-contrast'

const PANEL_CLASS =
  'absolute right-0 top-full z-40 mt-1 w-56 rounded-control border border-border-mid bg-surface p-1 shadow-dropdown'

const ITEM_CLASS =
  'flex min-h-touch w-full items-center gap-2 rounded-control px-3 text-sm text-ink transition hover:bg-neutral-bg cursor-pointer'

/** Inisial maksimal 2 huruf — aman terhadap nama kosong. */
function initialsOf(name: string): string {
  const initials = name
    .split(/\s+/)
    .filter((part) => part !== '')
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('')
  return initials === '' ? '?' : initials
}

/**
 * Dropdown profil shared untuk semua shell (SHELL-01..04).
 * Pemicu avatar + panel menu berisi item "Keluar" (tanpa link settings —
 * route belum ada). Interaksi meniru pola `PurposeDropdown` (klik-luar +
 * Escape + refocus pemicu) tanpa dependensi eksternal.
 */
export function ProfileMenu({ user, onLogout }: ProfileMenuProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const generatedId = useId()
  const buttonId = `${generatedId}-button`
  const menuId = `${generatedId}-menu`

  // Tutup saat klik/tap di luar, atau Escape → refocus pemicu (pola PurposeDropdown/Modal).
  useEffect(() => {
    if (!open) return

    function handlePointerDown(event: PointerEvent) {
      const target = event.target
      if (target instanceof Node && !containerRef.current?.contains(target)) {
        setOpen(false)
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((previous) => !previous)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
          }
        }}
        className={TRIGGER_CLASS}
      >
        <span role="img" aria-label={`Akun ${user.name}`} className={AVATAR_CLASS}>
          {user.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- avatar 36px dari host dinamis (avatarUrl), di luar images.remotePatterns yang hanya memuat localhost:9000; next/image akan 400 untuk host lain, dan avatar ini belum pernah diisi di produksi.
            <img
              src={user.avatarUrl}
              alt=""
              className="size-full object-cover"
              aria-hidden="true"
            />
          ) : (
            initialsOf(user.name)
          )}
        </span>
        <span className="hidden flex-col items-start sm:flex">
          <span className="text-sm font-semibold text-ink">{user.name}</span>
          {user.role ? (
            <span className="text-xs text-ink-muted">{user.role}</span>
          ) : null}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={`size-4 shrink-0 text-ink-muted transition-transform ${open ? 'rotate-180' : ''}`.trim()}
        />
      </button>

      {open ? (
        <div id={menuId} role="menu" aria-labelledby={buttonId} className={PANEL_CLASS}>
          <div className="border-b border-border-mid px-3 py-2">
            <p className="text-sm font-semibold text-ink">{user.name}</p>
            {user.role ? <p className="text-xs text-ink-muted">{user.role}</p> : null}
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onLogout()
            }}
            className={ITEM_CLASS}
          >
            <LogOut aria-hidden="true" className="size-4 shrink-0" />
            Keluar
          </button>
        </div>
      ) : null}
    </div>
  )
}
