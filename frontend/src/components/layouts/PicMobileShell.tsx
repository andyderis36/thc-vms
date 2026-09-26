'use client'

import Link from 'next/link'
import { House, LogOut, Plus, QrCode, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useSession } from '@/lib/auth/session'

interface PicNavDestination {
  id: string
  /** Label penuh untuk top navigation desktop (>= 1024px). */
  label: string
  /** Label ringkas untuk bottom navigation ponsel/tablet. */
  mobileLabel: string
  href: string
  Icon: LucideIcon
}

/**
 * Tiga tujuan SHELL-04. Rute mengikuti peta rute aplikasi
 * (`/dashboard`, `/visits/new` — lihat `lib/auth/guards.tsx`); `/qr` adalah
 * layar tiket QR aktif milik PIC (SCR-04). Layar pemilik rute boleh
 * menyesuaikan konstanta ini bila peta rute berubah.
 */
const PIC_NAV: PicNavDestination[] = [
  {
    id: 'visits',
    label: 'Kunjungan Saya',
    mobileLabel: 'Kunjungan Saya',
    href: '/dashboard',
    Icon: House,
  },
  {
    id: 'new-visit',
    label: 'Ajukan Kunjungan Baru',
    mobileLabel: 'Ajukan',
    href: '/visits/new',
    Icon: Plus,
  },
  {
    id: 'qr-ticket',
    label: 'Tiket QR',
    mobileLabel: 'Tiket QR',
    href: '/qr',
    Icon: QrCode,
  },
]

/** Item tengah bottom bar = tombol bundar raised merah (+ Ajukan). */
const CENTRE_NAV_ID = 'new-visit'

export interface PicMobileShellProps {
  children: ReactNode
  /** Bandingkan dengan `href` tujuan untuk menandai `aria-current="page"`. */
  activeHref?: string
}

/**
 * SHELL-04 — PIC Mobile Shell.
 *
 * Hanya untuk peran `pic` (customer / teknisi vendor). Tanpa sidebar:
 * ponsel/tablet (< 1024px) memakai bottom navigation tetap berisi 3 tujuan
 * (Kunjungan Saya, tombol bundar raised + Ajukan, Tiket QR); desktop
 * (>= 1024px) menggantinya dengan top navigation horizontal di dalam header.
 */
export function PicMobileShell({ children, activeHref }: PicMobileShellProps) {
  const { user, signOut } = useSession()
  const vendorLabel = user?.vendor_name ?? 'PIC'

  const handleSignOut = (): void => {
    void signOut()
  }

  return (
    <div className="flex min-h-dvh flex-col bg-page">
      {/* Header sticky: logo + nama produk, nav desktop, vendor + logout. */}
      <header className="sticky top-0 z-30 h-14 border-b border-border-light bg-surface lg:h-topbar">
        <div className="flex h-full items-center justify-between gap-3 px-4">
          <div className="flex shrink-0 items-center gap-2">
            <span
              aria-hidden="true"
              className="flex size-8 shrink-0 items-center justify-center rounded-badge bg-brand text-badge font-black text-brand-contrast"
            >
              THC
            </span>
            <span className="whitespace-nowrap text-sm font-bold text-ink">Visitor Portal</span>
          </div>

          <nav aria-label="Navigasi utama" className="hidden items-center gap-1 lg:flex">
            {PIC_NAV.map((item) => {
              const active = activeHref === item.href
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={[
                    'inline-flex min-h-touch items-center gap-2 rounded-control px-3 text-label font-semibold transition-colors',
                    active ? 'text-brand' : 'text-ink-secondary hover:bg-neutral-bg hover:text-ink',
                  ].join(' ')}
                >
                  <item.Icon aria-hidden="true" className="size-4" />
                  {item.label}
                </Link>
              )
            })}
          </nav>

          <div className="flex min-w-0 shrink-0 items-center gap-1">
            <span className="min-w-0 truncate text-label font-semibold text-ink-secondary lg:max-w-40">
              {vendorLabel}
            </span>
            <button
              type="button"
              onClick={handleSignOut}
              aria-label="Keluar dari akun"
              title="Keluar dari akun"
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-control text-ink-secondary transition-colors hover:bg-neutral-bg hover:text-brand"
            >
              <LogOut aria-hidden="true" className="size-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Konten: p-4; pb-24 memberi ruang bottom nav 64px + tonjolan tombol bundar. */}
      <main className="flex-1 overflow-x-hidden p-4 pb-24 lg:pb-8">
        {children}
      </main>

      {/* Bottom navigation tetap (ponsel/tablet), diganti top nav di >= 1024px. */}
      <nav
        aria-label="Navigasi utama"
        className="fixed inset-x-0 bottom-0 z-30 h-bottomnav border-t border-border-light bg-surface shadow-dropdown lg:hidden"
      >
        <div className="flex h-full items-stretch">
          {PIC_NAV.map((item) => {
            const active = activeHref === item.href

            if (item.id === CENTRE_NAV_ID) {
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  aria-label="Ajukan kunjungan baru"
                  className="relative flex flex-1 items-start justify-center"
                >
                  <span className="flex size-14 -translate-y-6 flex-col items-center justify-center gap-0.5 rounded-full bg-brand text-brand-contrast shadow-dropdown ring-4 ring-surface">
                    <item.Icon aria-hidden="true" className="size-5" />
                    <span className="text-badge font-bold leading-none">{item.mobileLabel}</span>
                  </span>
                </Link>
              )
            }

            return (
              <Link
                key={item.id}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={[
                  'flex flex-1 flex-col items-center justify-center gap-1 text-badge font-bold transition-colors',
                  active ? 'text-brand' : 'text-ink-secondary',
                ].join(' ')}
              >
                <item.Icon aria-hidden="true" className="size-5" />
                {item.mobileLabel}
              </Link>
            )
          })}
        </div>
      </nav>
    </div>
  )
}
