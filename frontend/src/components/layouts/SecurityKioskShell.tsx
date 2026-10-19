'use client'

import { useState, type ReactNode } from 'react'
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
 * satu-satunya adalah 3 tab antrean gerbang (52px) di bawah topbar
 * (desktop) atau sebagai bottom bar tetap (ponsel < 768px) — plus tautan
 * kembali "Kembali ke Pos Check-in" ke `/gate` yang hanya muncul ketika
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

      {/* Topbar kiosk dua tingkat (SHELL-03): full width, tanpa sidebar,
          kontras tinggi. Ponsel (< 768px) memakai DUA tingkat supaya tidak
          ada info yang hilang: baris-1 = aksi (logo + badge lokasi yang kini
          bebas tumbuh + lonceng + logout, tinggi tetap 70px), baris-2 =
          status (jam live, counter on-site, identitas petugas). Sebelumnya
          baris tunggal membuat badge lokasi makin mepet (320px → "K")
          sementara nama/shift/counter disembunyikan. >= 768px: SATU baris
          identik dengan tampilan lama. Grid 3 kolom hanya mulai xl (1280px);
          di 768-1023px topbar tetap flex + justify-between (§5.1). */}
      <header className="sticky top-0 z-30 bg-kiosk-topbar text-brand-contrast shadow-dropdown">
        {/* TIER 1 — baris aksi. Kelas baris (termasuk grid xl) ada DI SINI,
            bukan di <header>, supaya tier 2 bisa menumpuk di bawahnya di
            ponsel tanpa mengubah geometri desktop. */}
        <div className="flex h-topbar-kiosk items-center justify-between gap-2 px-3 md:gap-3 md:px-4 lg:gap-4 lg:px-6 xl:grid xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          {/* Kiri: logo THC + nama pos + badge lokasi terkunci (bukan switcher).
              `flex-1` hanya di ponsel agar sisa lebar baris-1 dikuasai badge
              lokasi (tanpa cap max-w-28). Di md+ kembali `flex-initial`
              (flex: 0 1 auto = default) — JANGAN `flex-none`: `flex-none`
              (shrink:0) membuat cluster kiri tak bisa menyusut di 768-1279px
              sehingga topbar meluber (klaster kanan `shrink-0` berisi nama
              `whitespace-nowrap` + label logout), padahal default lama bisa
              menyusut. Di xl tetap aman karena baris memakai grid, bukan flex. */}
          <div className="flex min-w-0 flex-1 items-center gap-2 md:flex-initial md:gap-3">
            <span
              aria-hidden="true"
              className="flex size-9 shrink-0 items-center justify-center rounded-control bg-brand text-label font-black tracking-tight text-brand-contrast"
            >
              THC
            </span>
            {/* Label tegas "GATE ACCESS CONTROL" (§6.3) hanya di xl — di bawah
                xl ia memaksa badge lokasi menyusut dan topbar collapse. */}
            <span className="hidden shrink-0 whitespace-nowrap text-sm font-black uppercase tracking-wide xl:block">
              Gate Access Control
            </span>
            {/* Ponsel: tanpa cap 112px — badge mengisi ruang yang tadinya
                dipakai jam/counter (kini pindah ke tier 2), jadi nama lokasi
                penuh tetap terbaca. Teks penuh SELALU ada di DOM; pemotongan
                murni CSS `truncate` sehingga screen reader tetap membacanya. */}
            <Badge tone="info" className="min-w-0 max-w-full gap-1.5 md:max-w-56 xl:max-w-48">
              <MapPin aria-hidden="true" className="size-3 shrink-0" />
              <span className="truncate">{locationName}</span>
            </Badge>
          </div>

          {/* Tengah: jam digital live WIB + counter teknisi on-site.
              Di ponsel cluster ini pindah ke tier 2 (`hidden md:flex`). */}
          <div className="hidden shrink-0 items-center gap-3 md:flex">
            <LiveClock className="text-sm md:text-lg lg:text-xl xl:text-2xl" />
            {onSiteCount > 0 ? (
              <span className="status-badge hidden gap-1.5 bg-checkin text-ink md:inline-flex">
                <span aria-hidden="true" className="size-2 shrink-0 rounded-badge bg-brand-contrast" />
                {onSiteCount} Teknisi On-Site
              </span>
            ) : (
              <span className="status-badge hidden bg-sidebar-dark-active text-brand-contrast md:inline-flex">
                0 Teknisi On-Site
              </span>
            )}
            {/* Kembali ke antrean gerbang — hanya di luar /gate. Teks penuh
                hanya di tier ini (ruang center auto di xl, flex di md-lg);
                ponsel memakai varian ikon di tier 1 agar badge lokasi tidak
                kehilangan lebar. */}
            {showBackToGate ? (
              <Link
                href="/gate"
                className="inline-flex min-h-touch shrink-0 items-center gap-2 rounded-control border border-brand px-3 text-label font-bold text-brand-contrast transition-colors hover:bg-brand lg:px-4"
              >
                <ArrowLeft aria-hidden="true" className="size-4 shrink-0" />
                <span className="whitespace-nowrap">Kembali ke Pos Check-in</span>
              </Link>
            ) : null}
          </div>

          {/* Kanan: lonceng notifikasi (kebacaan check-in/out),
              nama petugas dari sesi + shift + tombol logout bergaris merah. */}
          <div className="flex shrink-0 items-center justify-end gap-2 md:gap-3">
            {/* Ponsel: varian ikon tautan kembali (tier 2 tidak menampung
                teks tanpa menekan nama petugas; badge menyerap sisa lebar). */}
            {showBackToGate ? (
              <Link
                href="/gate"
                aria-label="Kembali ke Pos Check-in"
                title="Kembali ke Pos Check-in"
                className="inline-flex size-11 shrink-0 items-center justify-center rounded-control border border-brand text-brand-contrast transition-colors hover:bg-brand md:hidden"
              >
                <ArrowLeft aria-hidden="true" className="size-4 shrink-0" />
              </Link>
            ) : null}
            {/* `tone="dark"`: topbar kios gelap, jadi pemicu lonceng memakai
                tinta brand-contrast, bukan abu netral yang tak terbaca di
                atas #18181b. Panel dropdown tetap kartu terang (wajar: kartu
                mengambang di atas permukaan gelap). */}
            <NotificationsMenu tone="dark" onSelect={onNotificationSelect} />
            {/* Nama + shift tampil di tier 2 pada ponsel; di >= lg tampil di sini. */}
            <div className="hidden whitespace-nowrap text-right lg:block">
              <p className="text-sm font-bold leading-tight">{guardName}</p>
              <p className="text-badge text-brand-contrast">{shiftLabel}</p>
            </div>
            <button
              type="button"
              onClick={handleSignOut}
              aria-label="Ganti Shift / Logout"
              title="Ganti Shift / Logout"
              className="inline-flex min-h-touch shrink-0 items-center justify-center gap-2 rounded-control border border-brand px-2.5 text-label font-bold text-brand-contrast transition-colors hover:bg-brand lg:px-4"
            >
              <LogOut aria-hidden="true" className="size-4 shrink-0" />
              <span className="hidden whitespace-nowrap lg:inline">Ganti Shift / Logout</span>
            </button>
          </div>
        </div>

        {/* TIER 2 — pita status ponsel saja (`md:hidden`), di bawah tier 1.
          Garis pemisah `border-sidebar-dark-active` (#27272a): satu baris
          lebih terang dari topbar #18181b — subtle, bukan kontras penuh.
          Isi: jam WIB, counter on-site ringkas, identitas petugas di kanan
          (`ml-auto`, nama di-truncate bila sempit agar tak meluber).
          Chip counter PAKAI PILL TOKEN eksplisit (bukan `.status-badge`):
          `.status-badge` tanpa `shrink-0` membuat label "0 On-Site" melipat
          dua baris di 320px sehingga pita membengkak — pill ini
          `shrink-0 whitespace-nowrap` + `text-badge` (11px), satu baris ~20px.
          Tinta chip/label sekunder `text-brand-contrast` (bukan `text-ink-muted`):
          `--color-ink-muted` (#71717a) hanya 3.08-3.67:1 di atas topbar gelap
          (#18181b/#27272a) -> gagal WCAG AA; token ini memberi ~12-14:1.
          Hierarki label shift tetap dijaga lewat ukuran (11px) & bobot, bukan
          dengan menurunkan kontras di bawah ambang AA. */}
        <div className="flex items-center gap-2 border-t border-sidebar-dark-active px-3 py-1.5 md:hidden">
          <LiveClock className="shrink-0 text-sm" />
          {onSiteCount > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-badge bg-checkin px-2 py-0.5 text-badge font-bold text-ink">
              <span aria-hidden="true" className="size-1.5 shrink-0 rounded-badge bg-brand-contrast" />
              {onSiteCount} On-Site
            </span>
          ) : (
            <span className="inline-flex shrink-0 items-center whitespace-nowrap rounded-badge bg-sidebar-dark-active px-2 py-0.5 text-badge font-bold text-brand-contrast">
              0 On-Site
            </span>
          )}
          <div className="ml-auto min-w-0 text-right">
            <p className="truncate text-label font-bold leading-tight">{guardName}</p>
            <p className="truncate text-badge text-brand-contrast leading-tight">{shiftLabel}</p>
          </div>
        </div>
      </header>

      {/* Sub-bar tab sentuh 52px (desktop / tablet landscape). */}
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

      {/* Ponsel (< 768px): 3 tab yang sama sebagai bottom bar tetap 52px. */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border-light bg-surface shadow-dropdown md:hidden">
        <Tabs
          tabs={mobileTabs}
          value={selectedTab}
          onChange={handleTabChange}
          size="gate"
        />
      </div>
    </div>
  )
}
