'use client'

import { useState, type ReactNode } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ArrowLeft, LogOut, MapPin } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { NotificationsMenu } from '@/components/ui/NotificationsMenu'
import { Tabs, type TabItem } from '@/components/ui/Tabs'
import { useSession } from '@/lib/auth/session'
import type { NotificationItem } from '@/lib/api/types'
import { LiveClock } from './LiveClock'
import { SkipToContentLink } from './SkipToContentLink'

/** Id tab antrean gerbang. Kunci `tabCounts` memakai nilai yang sama. */
export type KioskTabId = 'upcoming' | 'on-site' | 'completed'

interface KioskTabDefinition {
  id: KioskTabId
  /** Label penuh untuk sub-bar desktop / tablet landscape. */
  label: string
  /** Label ringkas untuk bottom bar ponsel agar muat tanpa scroll. */
  shortLabel: string
}

const KIOSK_TABS: KioskTabDefinition[] = [
  { id: 'upcoming', label: 'Akan Hadir', shortLabel: 'Akan Hadir' },
  { id: 'on-site', label: 'Sedang di Lokasi', shortLabel: 'Di Lokasi' },
  { id: 'completed', label: 'Selesai', shortLabel: 'Selesai' },
]

const DEFAULT_TAB: KioskTabId = 'upcoming'

export interface SecurityKioskShellProps {
  children: ReactNode
  /** Jumlah teknisi yang sedang berada di lokasi (dihitung layar pemilik data). */
  onSiteCount?: number
  /** Label shift petugas. Default `Shift Pagi`. */
  shiftLabel?: string
  /**
   * Tab aktif. Bila diisi, shell murni terkontrol dari layar pemilik data
   * kunjungan; bila absen, shell memakai state internalnya sendiri.
   */
  activeTab?: string
  /** Dipanggil saat petugas menekan salah satu tab gerbang. */
  onTabChange?: (id: string) => void
  /** Angka pada tiap tab; absen = tab tanpa badge angka. */
  tabCounts?: Partial<Record<KioskTabId, number>>
  /**
   * Bila disediakan, klik notifikasi diteruskan ke layar ini (modal detail
   * kunjungan di tempat) alih-alih navigasi ke `/visits/{id}`. Layar tanpa
   * handler ini (mis. detail kunjungan) mempertahankan navigasi default.
   */
  onNotificationSelect?: (item: NotificationItem) => void
}

/**
 * SHELL-03 — Security Kiosk Shell (Zero Sidebar).
 *
 * Aturan mutlak: shell ini TIDAK memiliki sidebar, menu, drawer, hamburger,
 * atau tautan pengaturan apa pun. Petugas pos jaga harus fokus pada
 * verifikasi tamu dan tidak boleh tersesat ke layar admin. Navigasi
 * satu-satunya adalah 3 tab antrean gerbang (56px di ponsel sebagai bottom
 * bar tetap < 768px, 52px di md+ sebagai sub-bar di bawah topbar) — plus
 * tautan kembali "Kembali ke Pos Check-in" ke `/gate` yang hanya muncul ketika
 * pathname BUKAN `/gate` (mis. halaman detail `/visits/{id}`), agar petugas
 * selalu punya jalan kembali ke pos tanpa mengubah topbar di `/gate`.
 */
export function SecurityKioskShell({
  children,
  onSiteCount = 0,
  shiftLabel = 'Shift Pagi',
  activeTab,
  onTabChange,
  tabCounts,
  onNotificationSelect,
}: SecurityKioskShellProps) {
  const { user, signOut } = useSession()
  const pathname = usePathname()
  const [internalTab, setInternalTab] = useState<string>(DEFAULT_TAB)

  const showBackToGate = pathname !== '/gate'

  // Layar pemilik data mengendalikan tab bila activeTab/onTabChange diberikan.
  const selectedTab = activeTab ?? internalTab
  const handleTabChange = (id: string): void => {
    setInternalTab(id)
    onTabChange?.(id)
  }

  const handleSignOut = (): void => {
    void signOut()
  }

  const guardName = user?.name ?? 'Petugas Jaga'
  const locationName = user?.location_name ?? 'Lokasi Terkunci'

  const desktopTabs: TabItem[] = KIOSK_TABS.map((tab) => ({
    id: tab.id,
    label: tab.label,
    count: tabCounts?.[tab.id],
  }))
  const mobileTabs: TabItem[] = KIOSK_TABS.map((tab) => ({
    id: tab.id,
    label: tab.shortLabel,
  }))

  return (
    <div className="flex min-h-dvh flex-col bg-page">
      {/* Pintas keyboard pertama: lompat langsung ke konten utama. */}
      <SkipToContentLink />

      {/* Topbar kios (SHELL-03): full width, tanpa sidebar, kontras tinggi.
          SATU baris di semua breakpoint:
          - kiri: logo THC; badge lokasi `md:inline-flex` (di ponsel pindah
            ke `KioskStatusStrip` di body `/gate`);
          - tengah: jam live WIB dengan counter "X Teknisi On-Site" TEPAT
            di bawahnya (ponsel: kolom bertumpuk di antara logo dan lonceng;
            md+: jam + counter sebaris);
          - kanan: tautan kembali (ikon di ponsel), lonceng notifikasi,
            nama petugas (lg+), dan tombol logout ringkas.
          Tinggi bar: 56px di ponsel (`h-bar-mobile`), 70px mulai md
          (`md:h-topbar-kiosk`). Grid 3 kolom hanya mulai xl (1280px); di
          768-1023px baris tetap flex + justify-between (§5.1). */}
      <header className="sticky top-0 z-30 bg-brand text-brand-contrast shadow-dropdown">
        <div className="flex h-bar-mobile items-center justify-between gap-2 px-3 md:h-topbar-kiosk md:gap-3 md:px-4 lg:gap-4 lg:px-6 xl:grid xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          {/* Kiri: logo THC + nama pos + badge lokasi terkunci (bukan switcher).
              Di ponsel badge lokasi disembunyikan (pindah ke pita body).
              TANPA `flex-1` di ponsel: ruang bebas diserap kolom tengah agar
              jam benar-benar berada di antara logo dan lonceng. */}
          <div className="flex min-w-0 items-center gap-2 md:gap-3">
            {/* Logo `h-10` (40px) TETAP di semua breakpoint: 40px masih muat
                di bar ponsel 56px (sisa 8px atas/bawah) dan sama dengan
                navbar role lain. */}
            <Image src="/thcw.png" alt="THC" width={500} height={235} className="h-10 w-auto shrink-0" />
            <span className="hidden shrink-0 whitespace-nowrap text-sm font-black uppercase tracking-wide xl:block">
              Gate Access Control
            </span>
            {/* Ponsel: tanpa cap 112px - badge lokasi pindah ke pita body
                `KioskStatusStrip`, jadi di baris-1 tersedia tempat untuk jam +
                counter on-site. Teks penuh SELALU ada di DOM; pemotongan murni
                CSS `truncate` sehingga screen reader tetap membacanya. `title`
                menyimpan nilai utuh. */}
            <Badge tone="info" className="hidden min-w-0 max-w-full gap-1.5 md:inline-flex md:max-w-56 xl:max-w-48">
              <MapPin aria-hidden="true" className="size-3 shrink-0" />
              <span className="truncate" title={locationName}>{locationName}</span>
            </Badge>
          </div>

          {/* Tengah: jam live WIB + counter teknisi on-site.
              Ponsel: `flex-col` - jam di atas, counter TEPAT di bawahnya,
              seluruh kolom di tengah ruang antara logo dan lonceng.
              md+: kembali `flex-row` selebar isi (setara `shrink-0` lama).
              Counter memakai pasangan BAHAYA repo (`bg-danger-bg` +
              `text-danger-text`, lihat `TONE_CLASSES` di `ui/Badge.tsx`)
              supaya jadi badge peringatan MERAH - dan tetap terbaca di atas
              navbar biru (`--color-brand` #422ad5). */}
          <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 md:flex-none md:flex-row md:gap-3">
            <LiveClock className="whitespace-nowrap text-sm md:text-lg lg:text-xl xl:text-2xl" />
            {onSiteCount > 0 ? (
              <span className="status-badge gap-1.5 whitespace-nowrap bg-danger-bg text-danger-text text-badge md:text-sm">
                <span aria-hidden="true" className="size-1.5 shrink-0 rounded-badge bg-danger-text md:size-2" />
                {onSiteCount} Teknisi On-Site
              </span>
            ) : (
              <span className="status-badge whitespace-nowrap bg-danger-bg text-danger-text text-badge md:text-sm">
                0 Teknisi On-Site
              </span>
            )}
            {/* Tautan kembali teks penuh: DESKTOP SAJA (`hidden md:inline-flex`)
                - ponsel memakai varian ikon di cluster kanan. */}
            {showBackToGate ? (
              <Link
                href="/gate"
                className="hidden min-h-touch shrink-0 items-center gap-2 rounded-control border border-brand-contrast/50 px-3 text-label font-bold text-brand-contrast transition-colors hover:bg-brand-dark md:inline-flex lg:px-4"
              >
                <ArrowLeft aria-hidden="true" className="size-4 shrink-0" />
                <span className="whitespace-nowrap">Kembali ke Pos Check-in</span>
              </Link>
            ) : null}
          </div>

          {/* Kanan: tautan kembali ikon (ponsel), lonceng notifikasi, nama
              petugas (lg+), tombol logout ringkas. */}
          <div className="flex min-w-0 items-center justify-end gap-2 md:gap-3">
            {showBackToGate ? (
              <Link
                href="/gate"
                aria-label="Kembali ke Pos Check-in"
                title="Kembali ke Pos Check-in"
                className="inline-flex size-11 shrink-0 items-center justify-center rounded-control border border-brand-contrast/50 text-brand-contrast transition-colors hover:bg-brand-dark md:hidden"
              >
                <ArrowLeft aria-hidden="true" className="size-4 shrink-0" />
              </Link>
            ) : null}
            <NotificationsMenu tone="brand" onSelect={onNotificationSelect} />
            <div className="hidden min-w-0 text-right lg:block">
              <p className="truncate text-sm font-bold leading-tight">{guardName}</p>
              <p className="truncate text-badge text-brand-contrast">{shiftLabel}</p>
            </div>
            {/* Logout ringkas ala vendor (SHELL-04): ikon 44x44 tanpa label
                teks dan tanpa border, supaya tidak menyisakan ruang baris
                ponsel. Label penuh pindah ke `aria-label` + `title`. */}
            <button
              type="button"
              onClick={handleSignOut}
              aria-label="Ganti Shift / Logout"
              title="Ganti Shift / Logout"
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-control text-brand-contrast transition-colors hover:bg-brand-dark"
            >
              <LogOut aria-hidden="true" className="size-4 shrink-0" />
            </button>
          </div>
        </div>
        {/* TIER 2 DIHAPUS TOTAL: dulu blok `md:hidden` berisi jam + counter.
            Jam + counter kini hidup di kolom tengah tier-1 di atas. */}
      </header>

      {/* Sub-bar tab sentuh 52px (desktop / tablet landscape). Di ponsel bar
          yang sama jadi bottom bar 56px (`min-h-bar-mobile`). */}
      <div className="hidden bg-surface md:block">
        <Tabs
          tabs={desktopTabs}
          value={selectedTab}
          onChange={handleTabChange}
          size="gate"
          className="px-4 lg:px-6"
        />
      </div>

      {/* Konten layar; overflow-x-clip mengunci scroll horizontal TANPA membuat
          scroll container (clip ≠ hidden) sehingga elemen sticky di dalamnya tetap
          bekerja. min-w-0 = min-inline-size:0; id+tabIndex = sasan skip-to-content. */}
      <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 overflow-x-clip p-4 pb-24 md:p-6 lg:p-8">
        {children}
      </main>

      {/* Ponsel (< 768px): 3 tab yang sama sebagai bottom bar tetap 56px
          (`min-h-bar-mobile`), sama seperti navbar ponsel 56px.
          `px-4` = gutter yang sama dengan sub-bar desktop (tanpa gutter,
          pil tab aktif menempel di x≈0 dan terbaca terpotong). */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border-light bg-surface shadow-dropdown md:hidden">
        <Tabs
          tabs={mobileTabs}
          value={selectedTab}
          onChange={handleTabChange}
          size="gate"
          className="px-4"
        />
      </div>
    </div>
  )
}
