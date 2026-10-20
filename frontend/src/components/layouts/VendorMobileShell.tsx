'use client'

import Link from 'next/link'
import Image from 'next/image'
import { House, LogOut, Plus, QrCode, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useSession } from '@/lib/auth/session'
import { getRoleLabel } from '@/lib/auth/capabilities'
import type { VisitStatus } from '@/lib/api/types'
import { NotificationsMenu } from '@/components/ui/NotificationsMenu'
import { SkipToContentLink } from './SkipToContentLink'

interface VendorNavDestination {
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
const VENDOR_NAV: VendorNavDestination[] = [
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
 * Rute detail SCR-04 (`/visits/[id]`) tidak punya pasangan di `VENDOR_NAV`,
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

export interface VendorMobileShellProps {
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
 * SHELL-04 — Vendor Mobile Shell (`VendorMobileShell`).
 *
 * Hanya untuk peran `vendor` (Vendor/Mitra — customer / teknisi vendor). Tanpa sidebar:
 * ponsel/tablet (< 1024px) memakai bottom navigation tetap berisi 3 tujuan
 * (Kunjungan Saya, tombol bundar raised + Ajukan, Tiket QR); desktop
 * (>= 1024px) menggantinya dengan top navigation horizontal di dalam header.
 */
export function VendorMobileShell({
  children,
  activeHref = '/dashboard',
  visitStatus,
}: VendorMobileShellProps) {
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

      {/* Header sticky: logo + nav desktop + lonceng notifikasi, vendor +
          logout. Wordmark "Visitor Portal" DIHAPUS dari navbar (instruksi
          pengguna) — logo THC 40px sudah menjadi penanda. Permukaan header
          BIRU (`bg-brand` #422ad5) sebagai penanda peran Vendor/Mitra, jadi
          seluruh isinya memakai tinta kontras `text-brand-contrast` (#e0e7ff) —
          bukan tinta netral gelap.
          `overflow-visible` WAJIB: panel notifikasi membuka ke bawah di luar
          kotak header, jadi ancestor `overflow-hidden` akan memotong
          dropdownnya. Overflow kini dicegah di dalam lewat `min-w-0` +
          `truncate` pada grup logo, bukan lewat clipping header. */}
      <header className="sticky top-0 z-30 h-bar-mobile overflow-visible border-b border-brand-dark bg-brand text-brand-contrast lg:h-topbar">
        <div className="flex h-full items-center justify-between gap-3 px-4">
          {/* Tanpa `shrink-0`: modifier itu menetralkan `min-w-0` sehingga label
              nowrap tak pernah menyusut dan header meluber di 375px. */}
          <div className="flex min-w-0 items-center gap-2">
            {/* Logo brand THC asli (wordmark-nya putih) berdiri SENDIRI di
                atas header biru: alas chip ungu `bg-brand` DIHAPUS karena
                warnanya identik dengan latar header sehingga chip tak
                terlihat. Aset logo TIDAK boleh dihapus (instruksi pengguna)
                — hanya alasnya yang dibuang; pola sama dipakai
                SecurityKioskShell & AdminBranchShell. */}
            <span className="flex shrink-0 items-center">
              <Image src="/thcw.png" alt="THC" width={500} height={235} className="h-10 w-auto shrink-0" />
            </span>
          </div>

          {/* Nav desktop di atas permukaan biru: item aktif memakai pil
              `bg-brand-dark` (lebih gelap dari header) + tinta kontras,
              item non-aktif memakai tinta 80% yang tetap AA (4.85:1). */}
          <nav aria-label="Navigasi utama" className="hidden items-center gap-1 lg:flex">
            {VENDOR_NAV.map((item) => {
              const active = currentHref === item.href
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={[
                    'inline-flex min-h-touch items-center gap-2 rounded-control px-3 text-label font-semibold transition-colors',
                    active
                      ? 'bg-brand-dark text-brand-contrast'
                      : 'text-brand-contrast/80 hover:bg-brand-dark hover:text-brand-contrast',
                  ].join(' ')}
                >
                  <item.Icon aria-hidden="true" className="size-4 shrink-0" />
                  {item.label}
                </Link>
              )
            })}
          </nav>

          {/* Nama vendor disembunyikan di bawah 640px (`hidden sm:block`):
              pada 320px header sudah penuh (logo + wordmark + lonceng +
              logout) sehingga nama vendor hanya jadi potongan sampah;
              dari 640px ruang cukup dan nama tampil lagi sebagai penanda
              akun. Halaman dashboard sudah memuat kartu identitas vendor,
              jadi nama tidak perlu diulang dua kali di sana. */}
          <div className="flex min-w-0 items-center gap-1">
            <span
              className="hidden min-w-0 max-w-72 truncate text-label font-semibold text-brand-contrast/80 sm:block lg:max-w-40"
              title={vendorLabel}
            >
              {vendorLabel}
            </span>
            {/* Lonceng notifikasi tersimpan milik vendor (approved/rejected/
                reminder/auto_cancelled) — shell ini satu-satunya entitlement
                vendor, jadi panelnya WAJIB tersedia di SHELL-04. `tone="brand"`
                karena loncengnya duduk di atas navbar biru. */}
            <NotificationsMenu tone="brand" className="shrink-0" />
            <button
              type="button"
              onClick={handleSignOut}
              aria-label="Keluar dari akun"
              title="Keluar dari akun"
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-control text-brand-contrast transition-colors hover:bg-brand-dark"
            >
              <LogOut aria-hidden="true" className="size-4 shrink-0" />
            </button>
          </div>
        </div>
      </header>

      {/* Konten: p-4; pb-24 memberi ruang bottom nav 56px + tonjolan tombol bundar
          (`size-14 -translate-y-6`). Padding ini sengaja tidak ikut menyusut.
          overflow-x-clip mengunci scroll horizontal tanpa mematikan elemen sticky
          (action bar SCR-03). min-w-0 = min-inline-size:0; id+tabIndex = skip-to-content. */}
      <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 overflow-x-clip p-4 pb-24 lg:pb-8">
        {children}
      </main>

      {/* Bottom navigation tetap (ponsel/tablet), diganti top nav di >= 1024px. */}
      <nav
        aria-label="Navigasi utama"
        className="fixed inset-x-0 bottom-0 z-30 h-bar-mobile border-t border-border-light bg-surface shadow-dropdown lg:hidden"
      >
        <div className="flex h-full items-stretch">
          {VENDOR_NAV.map((item) => {
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
                  <span className="flex size-14 -translate-y-6 flex-col items-center justify-center gap-0.5 rounded-badge bg-brand text-brand-contrast shadow-dropdown ring-4 ring-surface">
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
