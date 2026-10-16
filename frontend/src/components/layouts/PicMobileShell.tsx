'use client'

import Link from 'next/link'
import { House, LogOut, Plus, QrCode, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useSession } from '@/lib/auth/session'
import { getRoleLabel } from '@/lib/auth/capabilities'
import type { VisitStatus } from '@/lib/api/types'
import { SkipToContentLink } from './SkipToContentLink'

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
 * Tiga tujuan SHELL-04. `/qr` adalah resolver tiket QR aktif milik Vendor/Mitra
 * (SCR-04): memilih kunjungan visiting/approved lalu mengganti ke
 * `/visits/[id]` (kartu QR above-the-fold); tanpa tiket menampilkan
 * empty state + ajakan mengajukan. Layar pemilik rute boleh
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

/** Status yang menampilkan kartu QR di SCR-04 (sama dengan `showQr` di halaman detail). */
const QR_VISIBLE_STATUSES: ReadonlySet<VisitStatus> = new Set<VisitStatus>([
  'approved',
  'visiting',
  // `rescheduled` SENGAJA tidak ada: kunjungan yang dijadwalkan ulang wajib
  // disetujui ulang sebelum check-in (backend menolak rescheduled->visiting),
  // jadi QR disembunyikan sampai status kembali `approved`.
])

/**
 * Predikat murni: status apa pun yang menampilkan kartu QR di SCR-04.
 * Satu-satunya sumber kebenaran untuk `showQr` halaman detail dan
 * `resolveActiveHref` di bawah — ubah di sini bila himpunannya berubah.
 */
export function isQrVisible(status: VisitStatus): boolean {
  return QR_VISIBLE_STATUSES.has(status)
}

/**
 * Rute detail SCR-04 (`/visits/[id]`) tidak punya pasangan di `PIC_NAV`,
 * jadi `aria-current` pernah kosong. Petakan: status yang menampilkan kartu
 * QR (approved/visiting) -> `/qr` (Tiket QR); selainnya -> `/dashboard`
 * (Kunjungan Saya). Rute lain diteruskan apa adanya.
 */
function resolveActiveHref(activeHref: string, visitStatus: VisitStatus | undefined): string {
  const isDetailRoute = activeHref.startsWith('/visits/') && activeHref !== '/visits/new'
  if (!isDetailRoute) return activeHref
  return visitStatus !== undefined && isQrVisible(visitStatus)
    ? '/qr'
    : '/dashboard'
}

export interface PicMobileShellProps {
  children: ReactNode
  /**
   * Bandingkan dengan `href` tujuan untuk menandai `aria-current="page"`.
   * Default `'/dashboard'` agar selalu ada satu tujuan aktif walau layar
   * pemilik datanya belum meneruskan rute.
   */
  activeHref?: string
  /**
   * Status kunjungan saat rute detail SCR-04 (`/visits/[id]`) terbuka —
   * dipakai `resolveActiveHref` agar kartu QR menyalakan tab yang benar.
   */
  visitStatus?: VisitStatus
}

/**
 * SHELL-04 — Vendor Mobile Shell (`PicMobileShell`).
 *
 * Hanya untuk peran `vendor` (Vendor/Mitra — customer / teknisi vendor). Tanpa sidebar:
 * ponsel/tablet (< 1024px) memakai bottom navigation tetap berisi 3 tujuan
 * (Kunjungan Saya, tombol bundar raised + Ajukan, Tiket QR); desktop
 * (>= 1024px) menggantinya dengan top navigation horizontal di dalam header.
 */
export function PicMobileShell({
  children,
  activeHref = '/dashboard',
  visitStatus,
}: PicMobileShellProps) {
  const { user, signOut } = useSession()
  const vendorLabel = user?.vendor_name ?? getRoleLabel('vendor')
  const currentHref = resolveActiveHref(activeHref, visitStatus)

  const handleSignOut = (): void => {
    void signOut()
  }

  return (
    <div className="flex min-h-dvh flex-col bg-page">
      {/* Pintas keyboard pertama: lompat langsung ke konten utama. */}
      <SkipToContentLink />

      {/* Header sticky: logo + nama produk, nav desktop, vendor + logout.
          overflow-hidden: potongan terakhir bila ada child nowrap (logo
          group) yang keberatan mengecil di 375px. */}
      <header className="sticky top-0 z-30 h-14 overflow-hidden border-b border-border-light bg-surface lg:h-topbar">
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
              const active = currentHref === item.href
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
                  <item.Icon aria-hidden="true" className="size-4 shrink-0" />
                  {item.label}
                </Link>
              )
            })}
          </nav>

          {/* Tanpa `shrink-0`: modifier itu menetralkan `min-w-0` sehingga
              label vendor tak pernah bisa menyusut dan header meluber di
              375px. `max-w-*` memberi batas atas; `truncate` memotongnya. */}
          <div className="flex min-w-0 items-center gap-1">
            <span className="min-w-0 max-w-28 truncate text-label font-semibold text-ink-secondary sm:max-w-72 lg:max-w-40">
              {vendorLabel}
            </span>
            <button
              type="button"
              onClick={handleSignOut}
              aria-label="Keluar dari akun"
              title="Keluar dari akun"
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-control text-ink-secondary transition-colors hover:bg-neutral-bg hover:text-brand"
            >
              <LogOut aria-hidden="true" className="size-4 shrink-0" />
            </button>
          </div>
        </div>
      </header>

      {/* Konten: p-4; pb-24 memberi ruang bottom nav 64px + tonjolan tombol bundar.
          overflow-x-clip mengunci scroll horizontal tanpa mematikan elemen sticky
          (action bar SCR-03). min-w-0 = min-inline-size:0; id+tabIndex = skip-to-content. */}
      <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 overflow-x-clip p-4 pb-24 lg:pb-8">
        {children}
      </main>

      {/* Bottom navigation tetap (ponsel/tablet), diganti top nav di >= 1024px. */}
      <nav
        aria-label="Navigasi utama"
        className="fixed inset-x-0 bottom-0 z-30 h-bottomnav border-t border-border-light bg-surface shadow-dropdown lg:hidden"
      >
        <div className="flex h-full items-stretch">
          {PIC_NAV.map((item) => {
            const active = currentHref === item.href

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
                    <item.Icon aria-hidden="true" className="size-5 shrink-0" />
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
                <item.Icon aria-hidden="true" className="size-5 shrink-0" />
                {item.mobileLabel}
              </Link>
            )
          })}
        </div>
      </nav>
    </div>
  )
}
