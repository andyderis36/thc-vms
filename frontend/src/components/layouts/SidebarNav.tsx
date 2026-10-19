import Link from 'next/link'
import type { ReactNode } from 'react'

export interface SidebarNavItem {
  href: string
  label: string
  icon?: ReactNode
  /** Tampil sebagai pill; nilai 0 (atau kurang) disembunyikan. */
  badge?: number
  /**
   * Rute alias/subordinat yang IKUT menyalakan item ini (pemetaan aktif).
   * Dipakai shell untuk rute yang sengaja tidak punya item mandiri pada
   * menu SSOT — mis. `/gate` & `/visits/*` di bawah Superadmin (§6.1) —
   * tanpa menambah/mengubah item utama. Kocokan: persis atau prefix
   * (`<alias>/…`). Opsional; pemanggil lama tanpa field ini tetap aman.
   */
  match?: string[]
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
    active: 'bg-brand/10 border-brand text-brand-contrast',
    inactive:
      'border-transparent text-ink-muted hover:bg-brand/10 hover:text-brand-contrast',
  },
  light: {
    active: 'bg-brand-soft border-brand text-brand',
    inactive: 'border-transparent text-ink-secondary hover:bg-neutral-bg hover:text-ink',
  },
}

/**
 * Item dianggap aktif bila `activeHref` cocok persis dengan `href`-nya,
 * merupakan rute turunan (`<href>/…`), atau jatuh pada salah satu alias
 * `match` (persis/prefix). Murni perbandingan string terhadap `activeHref`
 * yang diteruskan pemilik layar — komponen tetap tidak membaca `usePathname`,
 * sehingga bebas dependensi router & mudah diuji.
 */
function isNavItemActive(item: SidebarNavItem, activeHref: string): boolean {
  const bases = item.match !== undefined ? [item.href, ...item.match] : [item.href]
  return bases.some(
    (base) => activeHref === base || activeHref.startsWith(`${base}/`),
  )
}

/**
 * Navigasi daftar vertikal untuk sidebar shell. Memakai `next/link` agar
 * klik menu menjadi navigasi SPA (client routing + prefetch default Link)
 * alih-alih reload penuh halaman; penanda aktif/tidak tetap ditentukan
 * `activeHref` dari pemilik layar (bukan `usePathname`), sehingga komponen
 * ini tetap bodoh & teruji.
 */
export function SidebarNav({ items, activeHref, variant }: SidebarNavProps) {
  const state = STATE_CLASSES[variant]

  return (
    <nav aria-label="Navigasi utama">
      <ul className="flex flex-col gap-1">
        {items.map((item) => {
          const isActive = isNavItemActive(item, activeHref)
          const count = item.badge
          const showBadge = typeof count === 'number' && count > 0

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={isActive ? 'page' : undefined}
                className={[
                  // `py-3` (12px×2 + baris teks 20px = 44px): target sentuh
                  // minimum §5.2.1 — sebelumnya `py-2.5` hanya 40px.
                  'flex w-full items-center gap-3 border-l-[3px] rounded-control px-4 py-3 text-sm font-medium transition-colors',
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
                  <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-badge bg-brand px-1.5 text-badge font-bold tabular-nums text-brand-contrast">
                    {count}
                  </span>
                )}
              </Link>
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
 * `aria-current="page"`, label memakai skala `text-badge`. Link memakai
 * `next/link` (navigasi SPA + prefetch default) dan jumlah kolom grid
 * mengikuti `items.length` secara dinamis sehingga tidak hardcode
 * `grid-cols-4` (§6.1/§6.2 kini 4 tab; kolom tetap benar bila berubah).
 */
export function BottomNav({ items, activeHref, className }: BottomNavProps) {
  const classes = [
    'fixed inset-x-0 bottom-0 z-30 grid h-bottomnav border-t border-border-light bg-surface',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  // Minimal 1 kolom agar `repeat(0, …)` (CSS tidak valid) tak pernah terjadi.
  const columns = Math.max(items.length, 1)

  return (
    <nav
      aria-label="Navigasi bawah"
      className={classes}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {items.map((item) => {
        const isActive = isNavItemActive(item, activeHref)
        const count = item.badge
        const showBadge = typeof count === 'number' && count > 0

        return (
          <Link
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
              <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
                {item.icon}
              </span>
            )}
            <span className="text-badge font-semibold">{item.label}</span>
            {showBadge && (
              <span className="absolute right-3 top-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-badge bg-brand px-1 text-badge font-bold tabular-nums text-brand-contrast">
                {count}
              </span>
            )}
          </Link>
        )
      })}
    </nav>
  )
}
