'use client'

import { useState, type ReactNode } from 'react'
import { LogOut, MapPin } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Tabs, type TabItem } from '@/components/ui/Tabs'
import { useSession } from '@/lib/auth/session'
import { LiveClock } from './LiveClock'

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
  { id: 'upcoming', label: 'Akan Hadir Hari Ini', shortLabel: 'Akan Hadir' },
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
}

/**
 * SHELL-03 — Security Kiosk Shell (Zero Sidebar).
 *
 * Aturan mutlak: shell ini TIDAK memiliki sidebar, menu, drawer, hamburger,
 * atau tautan pengaturan apa pun. Petugas pos jaga harus fokus pada
 * verifikasi tamu dan tidak boleh tersesat ke layar admin. Navigasi
 * satu-satunya adalah 3 tab antrean gerbang (52px) di bawah topbar
 * (desktop) atau sebagai bottom bar tetap (ponsel < 768px).
 */
export function SecurityKioskShell({
  children,
  onSiteCount = 0,
  shiftLabel = 'Shift Pagi',
  activeTab,
  onTabChange,
  tabCounts,
}: SecurityKioskShellProps) {
  const { user, signOut } = useSession()
  const [internalTab, setInternalTab] = useState<string>(DEFAULT_TAB)

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
      {/* Topbar kiosk: full width, tanpa sidebar, kontras tinggi. */}
      <header className="sticky top-0 z-30 flex h-topbar-kiosk items-center justify-between gap-2 bg-kiosk-topbar px-3 text-brand-contrast shadow-dropdown md:grid md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:gap-3 md:px-4 lg:gap-4 lg:px-6">
        {/* Kiri: logo THC + nama pos + badge lokasi terkunci (bukan switcher). */}
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden="true"
            className="flex size-9 shrink-0 items-center justify-center rounded-control bg-brand text-label font-black tracking-tight text-brand-contrast"
          >
            THC
          </span>
          <span className="hidden shrink-0 whitespace-nowrap text-sm font-black uppercase tracking-wide md:block">
            Gate Access Control
          </span>
          <Badge tone="info" className="min-w-0 max-w-28 gap-1.5 lg:max-w-48">
            <MapPin aria-hidden="true" className="size-3 shrink-0" />
            <span className="truncate">{locationName}</span>
          </Badge>
        </div>

        {/* Tengah: jam digital live WIB + counter teknisi on-site. */}
        <div className="flex shrink-0 items-center gap-3">
          <LiveClock className="text-sm md:text-lg lg:text-xl xl:text-2xl" />
          {onSiteCount > 0 ? (
            <span className="status-badge hidden gap-1.5 bg-checkin text-ink md:inline-flex">
              <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-brand-contrast" />
              {onSiteCount} Teknisi On-Site
            </span>
          ) : (
            <span className="status-badge hidden bg-sidebar-dark-active text-ink-muted md:inline-flex">
              0 Teknisi On-Site
            </span>
          )}
        </div>

        {/* Kanan: nama petugas dari sesi + shift + tombol logout bergaris merah. */}
        <div className="flex shrink-0 items-center justify-end gap-3">
          <div className="hidden whitespace-nowrap text-right lg:block">
            <p className="text-sm font-bold leading-tight">{guardName}</p>
            <p className="text-badge text-ink-muted">{shiftLabel}</p>
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

      {/* Konten layar; overflow-x dikunci agar layar tak pernah scroll horizontal. */}
      <main className="flex-1 overflow-x-hidden p-4 pb-24 md:p-6 lg:p-8">
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
