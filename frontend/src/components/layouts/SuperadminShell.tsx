'use client'

import { useEffect, useState, type ChangeEvent, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import {
  Bell,
  Clock,
  LayoutDashboard,
  Lock,
  LogOut,
  MapPin,
  Menu,
  Search,
  Shield,
  Users,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { FIELD_BASE_CLASS } from '@/components/ui/Input'
import { BottomNav, SidebarNav, type SidebarNavItem } from '@/components/layouts/SidebarNav'
import { getLoginRedirect } from '@/lib/auth/capabilities'
import { useSession } from '@/lib/auth/session'
import type { Location } from '@/lib/api/types'

export interface SuperadminShellProps {
  children: ReactNode
  /** Jumlah antrean approval lintas cabang — milik layar yang memilik datanya. */
  pendingCount?: number
  /** Daftar cabang/POP untuk switcher; kosong = hanya "Semua Cabang / POP". */
  allLocations?: Location[]
  /** Rute aktif; default '/dashboard' (layar pemilik meneruskannya). */
  activeHref?: string
  /** Dipanggil saat superadmin mengganti fokus cabang pada switcher. */
  onBranchChange?: (locationId: string) => void
}

const SELECT_CLASS =
  'h-10 cursor-pointer rounded-control border border-border-mid bg-surface px-3 text-label text-ink'

const MOBILE_SELECT_CLASS =
  'h-9 min-w-0 max-w-36 cursor-pointer rounded-control border border-border-mid bg-surface px-2 text-label text-ink'

/** Avatar bulat berisi inisial — dipakai sidebar footer & topbar. */
const AVATAR_CLASS =
  'flex size-9 shrink-0 items-center justify-center rounded-full bg-brand text-label font-bold text-brand-contrast'

/** Logo mark THC (kotak merah) — dipakai header sidebar & topbar mobile. */
const LOGO_CLASS =
  'flex size-9 shrink-0 items-center justify-center rounded-control bg-brand text-label font-bold text-brand-contrast'

/** Tombol tutup laci: diposisikan absolut di atas header panel slide-over. */
const DRAWER_CLOSE_CLASS =
  'absolute right-2 top-4 z-10 text-ink-muted hover:bg-sidebar-dark-active hover:text-brand-contrast'

/** Inisial untuk avatar (maksimal 2 huruf), aman terhadap nama kosong. */
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
 * SHELL-01 — Base layout Superadmin (Kantor Pusat).
 * Sidebar gelap 260px + switcher cabang INTERAKTIF (super_admin boleh
 * memfilter lintas cabang — lawan dari shell admin yang terkunci).
 */
export function SuperadminShell({
  children,
  pendingCount,
  allLocations,
  activeHref = '/dashboard',
  onBranchChange,
}: SuperadminShellProps) {
  const { user, status, signOut } = useSession()
  const router = useRouter()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [branchId, setBranchId] = useState('all')

  const locations = allLocations ?? []
  const displayName = user !== null ? user.name : 'Pengguna'
  const initials = initialsOf(displayName)
  const hasPending = typeof pendingCount === 'number' && pendingCount > 0
  const closeDrawer = (): void => setDrawerOpen(false)

  const avatar = (
    <span role="img" aria-label={`Akun ${displayName}`} className={AVATAR_CLASS}>
      {initials}
    </span>
  )

  // Tutup laci dengan Escape (aksesibilitas WCAG — dialog modal harus bisa ditinggalkan).
  useEffect(() => {
    if (!drawerOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setDrawerOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return (): void => window.removeEventListener('keydown', onKeyDown)
  }, [drawerOpen])

  const handleBranchChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    const next = event.target.value
    setBranchId(next)
    onBranchChange?.(next)
  }

  const handleSignOut = async (): Promise<void> => {
    const role = user !== null ? user.role : null
    await signOut()
    router.push(role !== null ? getLoginRedirect(role) : '/')
  }

  const navItems: SidebarNavItem[] = [
    { href: '/dashboard', label: 'Dashboard Global', icon: <LayoutDashboard className="size-5" /> },
    { href: '/approvals', label: 'Antrean Approval', icon: <Clock className="size-5" />, badge: pendingCount ?? 0 },
    { href: '/facilities', label: 'Fasilitas & Cabang', icon: <MapPin className="size-5" /> },
    { href: '/security', label: 'Manajemen Security', icon: <Shield className="size-5" /> },
    { href: '/users', label: 'Manajemen User & Vendor', icon: <Users className="size-5" /> },
  ]

  const mobileBottomItems: SidebarNavItem[] = [
    { href: '/dashboard', label: 'Dashboard', icon: <LayoutDashboard className="size-5" /> },
    { href: '/approvals', label: 'Approval', icon: <Clock className="size-5" />, badge: pendingCount ?? 0 },
    { href: '/facilities', label: 'Fasilitas', icon: <MapPin className="size-5" /> },
    { href: '/security', label: 'Security', icon: <Shield className="size-5" /> },
  ]

  const branchOptions = locations.map((location) => (
    <option key={location.id} value={location.id}>{location.name}</option>
  ))

  const logoMark = (
    <span aria-hidden="true" className={LOGO_CLASS}>
      THC
    </span>
  )

  const sidebarHeader = (
    <div className="flex items-center gap-3 border-b border-sidebar-dark-active px-5 py-4">
      {logoMark}
      <div className="min-w-0">
        <p className="truncate text-sm font-bold text-brand-contrast">THC VMS PUSAT</p>
        <p className="truncate text-badge text-ink-muted">Kantor Pusat Surabaya</p>
      </div>
    </div>
  )

  const sidebarFooter = (
    <div className="border-t border-sidebar-dark-active px-5 py-4">
      <Badge tone="info" className="gap-1">
        <Lock className="size-3" aria-hidden="true" />
        KANTOR PUSAT
      </Badge>
      {status === 'loading' ? (
        <div className="mt-3 flex items-center gap-2 text-label text-ink-muted">
          <Spinner size="sm" />
          Memuat…
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-3">
          {avatar}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-brand-contrast">{displayName}</p>
            <Badge tone="danger" className="mt-1">
              SUPERADMIN
            </Badge>
          </div>
        </div>
      )}
      <Button variant="primary" size="sm" fullWidth className="mt-4" onClick={handleSignOut}>
        <LogOut className="size-4" aria-hidden="true" />
        Keluar
      </Button>
    </div>
  )

  const sidebarInner = (
    <>
      {sidebarHeader}
      <div className="flex-1 overflow-y-auto py-4">
        <SidebarNav items={navItems} activeHref={activeHref} variant="dark" />
      </div>
      {sidebarFooter}
    </>
  )

  /** Switcher cabang interaktif — satu render, dua ukuran (desktop & mobile). */
  const renderBranchSelect = (className: string) => (
    <select value={branchId} onChange={handleBranchChange} aria-label="Pilih cabang atau POP" className={className}>
      <option value="all">Semua Cabang / POP</option>
      {branchOptions}
    </select>
  )

  return (
    <div className="min-h-screen bg-page">
      {/* Sidebar desktop (>= 1024px) — fixed, gelap, 260px */}
      <aside aria-label="Menu utama" className="fixed inset-y-0 left-0 z-40 hidden w-sidebar-wide flex-col bg-sidebar-dark lg:flex">
        {sidebarInner}
      </aside>

      <div className="lg:pl-sidebar-wide">
        {/* Topbar desktop */}
        <header className="sticky top-0 z-30 hidden h-topbar items-center gap-4 border-b border-border-light bg-surface px-6 lg:flex">
          <div className="relative w-full max-w-md">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-muted" />
            <input
              type="search"
              aria-label="Pencarian global"
              placeholder="Cari kunjungan, tamu, atau vendor…"
              className={`${FIELD_BASE_CLASS} pl-9`}
            />
          </div>
          <div className="ml-auto flex items-center gap-3">
            {renderBranchSelect(SELECT_CLASS)}
            <Button
              variant="ghost"
              size="sm"
              aria-label={hasPending ? `Notifikasi, ${pendingCount ?? 0} antrean approval` : 'Notifikasi'}
              className="relative"
            >
              <Bell className="size-5" aria-hidden="true" />
              {hasPending && (
                <span aria-hidden="true" className="absolute right-1.5 top-1.5 size-2 rounded-full bg-brand" />
              )}
            </Button>
            {avatar}
          </div>
        </header>

        {/* Topbar mobile / tablet (< 1024px) */}
        <header className="sticky top-0 z-30 flex h-topbar items-center gap-2 border-b border-border-light bg-surface px-4 lg:hidden">
          {logoMark}
          <span className="truncate text-sm font-bold text-ink">THC VMS PUSAT</span>
          {renderBranchSelect(`${MOBILE_SELECT_CLASS} ml-auto`)}
          <Button
            variant="ghost"
            size="sm"
            aria-label="Buka menu navigasi"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
          >
            <Menu className="size-5" aria-hidden="true" />
          </Button>
        </header>

        {/* Konten utama */}
        <main className="min-w-0 overflow-x-clip p-6 pb-bottomnav lg:pb-6">
          <div className="mx-auto w-full max-w-7xl">{children}</div>
        </main>

        {/* Bottom navigation mobile (< 768px) */}
        <BottomNav items={mobileBottomItems} activeHref={activeHref} className="md:hidden" />
      </div>

      {/* Laci slide-over mobile / tablet — isi yang sama dengan sidebar desktop */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu navigasi">
          <button type="button" aria-label="Tutup menu navigasi" className="absolute inset-0 bg-ink/40" onClick={closeDrawer} />
          <div className="absolute inset-y-0 left-0 flex w-sidebar-wide max-w-[85vw] flex-col bg-sidebar-dark shadow-modal">
            <Button variant="ghost" size="sm" aria-label="Tutup menu navigasi" className={DRAWER_CLOSE_CLASS} onClick={closeDrawer}>
              <X className="size-5" aria-hidden="true" />
            </Button>
            {sidebarInner}
          </div>
        </div>
      )}
    </div>
  )
}
