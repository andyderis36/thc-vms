import type { ReactNode } from 'react'

export interface SidebarNavItem {
  href: string
  label: string
  icon?: ReactNode
  /** Tampil sebagai pill; nilai 0 (atau kurang) disembunyikan. */
  badge?: number
}

export type SidebarNavVariant = 'dark' | 'light'

export interface SidebarNavProps {
  items: SidebarNavItem[]
  /** Rute aktif — shell meneruskannya sebagai prop agar komponen ini tetap bodoh & teruji. */
  activeHref: string
  variant: SidebarNavVariant
}

/**
 * Nada per varian: aktif = sorotan khas shell (gelap / brand-soft) + aksen
 * brand di tepi kiri; non-aktif = teks redup milik varian. Border kiri
 * selalu 3px (transparan saat non-aktif) supaya teks tidak melompat.
 */
const STATE_CLASSES: Record<SidebarNavVariant, { active: string; inactive: string }> = {
  dark: {
    active: 'bg-sidebar-dark-active border-brand text-brand-contrast',
    inactive:
      'border-transparent text-ink-muted hover:bg-sidebar-dark-active hover:text-brand-contrast',
  },
  light: {
    active: 'bg-brand-soft border-brand text-brand',
    inactive: 'border-transparent text-ink-secondary hover:bg-neutral-bg hover:text-ink',
  },
}

/**
 * Navigasi daftar vertikal untuk sidebar shell. Sengaja memakai `<a>` biasa
 * (bukan `next/link` + `usePathname`): aktif/tidak ditentukan `activeHref`
 * dari pemilik layar, sehingga komponen ini bebas dependensi router.
 */
export function SidebarNav({ items, activeHref, variant }: SidebarNavProps) {
  const state = STATE_CLASSES[variant]

  return (
    <nav aria-label="Navigasi utama">
      <ul className="flex flex-col gap-1">
        {items.map((item) => {
          const isActive = item.href === activeHref
          const count = item.badge
          const showBadge = typeof count === 'number' && count > 0

          return (
            <li key={item.href}>
              <a
                href={item.href}
                aria-current={isActive ? 'page' : undefined}
                className={[
                  'flex w-full items-center gap-3 border-l-[3px] px-4 py-2.5 text-sm font-medium transition-colors',
                  isActive ? state.active : state.inactive,
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {item.icon !== undefined && (
                  <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
                    {item.icon}
                  </span>
                )}
                <span className="truncate">{item.label}</span>
                {showBadge && (
                  <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1.5 text-badge font-bold tabular-nums text-brand-contrast">
                    {count}
                  </span>
                )}
              </a>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

export interface BottomNavProps {
  items: SidebarNavItem[]
  activeHref: string
  /** Kelas visibilitas breakpoint (mis. `md:hidden`) — pemilik shell yang menentukan. */
  className?: string
}

/**
 * Navigasi bawah mobile — pasangan dari `SidebarNav` untuk shell tanpa
 * akses sidebar di layar kecil. Item aktif ditandai warna brand +
 * `aria-current="page"`, label memakai skala `text-badge`.
 */
export function BottomNav({ items, activeHref, className }: BottomNavProps) {
  const classes = [
    'fixed inset-x-0 bottom-0 z-30 grid h-bottomnav grid-cols-4 border-t border-border-light bg-surface',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <nav aria-label="Navigasi bawah" className={classes}>
      {items.map((item) => {
        const isActive = item.href === activeHref
        const count = item.badge
        const showBadge = typeof count === 'number' && count > 0

        return (
          <a
            key={item.href}
            href={item.href}
            aria-current={isActive ? 'page' : undefined}
            className={[
              'relative flex flex-col items-center justify-center gap-0.5',
              isActive ? 'text-brand' : 'text-ink-secondary',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {item.icon !== undefined && (
              <span className="flex size-5 items-center justify-center" aria-hidden="true">
                {item.icon}
              </span>
            )}
            <span className="text-badge font-semibold">{item.label}</span>
            {showBadge && (
              <span className="absolute right-3 top-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-badge font-bold tabular-nums text-brand-contrast">
                {count}
              </span>
            )}
          </a>
        )
      })}
    </nav>
  )
}
