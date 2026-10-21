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
 * Nada per varian: aktif = sorotan khas shell lewat PERMUKAAN BER-TINT
 * (gelap `bg-brand/10`, terang `bg-brand-soft`) + tinta brand; non-aktif =
 * teks redup milik varian.
 *
 * TIDAK ADA aksen garis tepi di status mana pun (checklist UI melarang
 * garis aksen samping pada item aktif). Karena tidak ada border di kedua
 * status, ikon & teks tidak pernah melompat saat item berpindah
 * aktif↔non-aktif — jarak ke tepi sidebar dijaga oleh `px-1` pada `<ul>`
 * (lihat `SidebarNav`), sehingga permukaan aktif berupa pil ber-tint yang
 * bersentuhan dengan tepi sidebar, bukan garis aksen.
 *
 * Varian gelap: label non-aktif memakai `text-brand-contrast/60`
 * (#e0e7ff 60% di atas #09090b = 6.1:1, WCAG AA) — `text-ink-muted`
 * (#71717a) hanya 4.12:1 di atas latar sidebar gelap. Label aktif
 * `#e0e7ff` di atas `brand/10` di atas #09090b = 15.6:1 (WCAG AAA).
 * Varian terang: label aktif `text-brand` #422ad5 di atas `brand-soft`
 * #e0e7ff = 6.8:1 (WCAG AA); non-aktif `text-ink-secondary` #52525b di
 * atas #ffffff = 7.7:1 (WCAG AA).
 */
const STATE_CLASSES: Record<SidebarNavVariant, { active: string; inactive: string }> = {
  dark: {
    active: 'bg-brand/10 text-brand-contrast',
    inactive: 'text-brand-contrast/60 hover:bg-brand/10 hover:text-brand-contrast',
  },
  light: {
    active: 'bg-brand-soft text-brand',
    inactive: 'text-ink-secondary hover:bg-neutral-bg hover:text-ink',
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
      {/* `px-1`: jarak 4px antara tepi sidebar dan item — ikon nav sejajar
          dengan logo/footer sidebar (keduanya di 20px) dan permukaan aktif
          (pil ber-tint) tak pernah menempel tepi sidebar sehingga tak
          terbaca sebagai garis aksen. */}
      <ul className="flex flex-col gap-1 px-1">
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
                  'flex w-full items-center gap-3 rounded-control px-4 py-3 text-sm font-medium transition-colors',
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
 * akses sidebar di layar kecil. Tinggi bar 56px (`h-bar-mobile`) agar
 * seragam dengan navbar ponsel seluruh shell. Item aktif ditandai warna
 * brand + `aria-current="page"`, label memakai skala `text-badge`. Link memakai
 * `next/link` (navigasi SPA + prefetch default) dan jumlah kolom grid
 * mengikuti `items.length` secara dinamis sehingga tidak hardcode
 * `grid-cols-4` (§6.1/§6.2 kini 4 tab; kolom tetap benar bila berubah).
 *
 * Safe area (iPhone home indicator): bar memakai `min-h-bar-mobile` +
 * `pb-[env(safe-area-inset-bottom)]` sehingga bar TUMBUH sebesar inset
 * tanpa terjepit — tinggi konten dikunci `h-bar-mobile` pada baris grid di
 * dalamnya, jadi ikon & label tetap setinggi & terpusat persis seperti
 * sebelumnya. Padding bawah shell (ruang kosong konten) MUSTIKIL bertambah
 * sebesar inset yang sama — lihat `pb-[calc(...)]` pada tiap shell.
 */
export function BottomNav({ items, activeHref, className }: BottomNavProps) {
  const classes = [
    'fixed inset-x-0 bottom-0 z-30 min-h-bar-mobile border-t border-border-light bg-surface pb-[env(safe-area-inset-bottom)]',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  // Minimal 1 kolom agar `repeat(0, …)` (CSS tidak valid) tak pernah terjadi.
  const columns = Math.max(items.length, 1)

  return (
    <nav aria-label="Navigasi bawah" className={classes}>
      <div
        className="grid h-bar-mobile"
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
      </div>
    </nav>
  )
}
