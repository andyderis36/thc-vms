'use client'

import type { ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import {
  Bell,
  Clock,
  DoorOpen,
  LayoutDashboard,
  Lock,
  LogOut,
  MapPin,
  Plus,
  Shield,
  UserPlus,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { BottomNav, SidebarNav, type SidebarNavItem } from '@/components/layouts/SidebarNav'
import { getLoginRedirect } from '@/lib/auth/capabilities'
import { useSession } from '@/lib/auth/session'

export interface AdminBranchShellProps {
  children: ReactNode
  /** Jumlah kunjungan menunggu persetujuan di cabang ini — milik layar pemilik datanya. */
  pendingCount?: number
  /** Rute aktif; default '/dashboard' (layar pemilik meneruskannya). */
  activeHref?: string
  /** Pintas topbar ke SCR-03 — wire oleh layar bila tersedia. */
  onQuickCreateVisit?: () => void
  /** Pintas topbar ke modal kelola satpam — wire oleh layar bila tersedia. */
  onQuickAddSecurity?: () => void
}

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
 * SHELL-02 — Base layout Admin Cabang / POP.
 * PERBEDAAN KRITIS dari SHELL-01: shell ini TERKUNCI pada satu cabang.
 * Lencana cabang bersifat STATIS (bukan `<select>`) — admin tidak pernah
 * boleh menggeser fokus ke cabang lain dari UI.
 */
export function AdminBranchShell({
  children,
  pendingCount,
  activeHref = '/dashboard',
  onQuickCreateVisit,
  onQuickAddSecurity,
}: AdminBranchShellProps) {
  const { user, status, signOut } = useSession()
  const router = useRouter()

  // Fallback netral bila `location_name` null — tidak pernah menghasilkan kontrol editabel.
  const locationName = user !== null && user.location_name !== null ? user.location_name : null
  const branchLabel = locationName !== null ? `Cabang ${locationName}` : 'Cabang'
  const displayName = user !== null ? user.name : 'Pengguna'
  const initials = initialsOf(displayName)
  const hasPending = typeof pendingCount === 'number' && pendingCount > 0

  const handleSignOut = async (): Promise<void> => {
    const role = user !== null ? user.role : null
    await signOut()
    router.push(role !== null ? getLoginRedirect(role) : '/')
  }

  const navItems: SidebarNavItem[] = [
    { href: '/dashboard', label: 'Dashboard Kunjungan', icon: <LayoutDashboard className="size-5" /> },
    {
      href: '/approvals',
      label: 'Persetujuan Kunjungan',
      icon: <Clock className="size-5" />,
      badge: pendingCount ?? 0,
    },
    { href: '/gate', label: 'Pos Check-in Gerbang', icon: <DoorOpen className="size-5" /> },
    { href: '/security', label: 'Satpam Cabang', icon: <Shield className="size-5" /> },
    { href: '/visits/new', label: 'Buat Kunjungan Baru', icon: <Plus className="size-5" /> },
  ]

  const mobileBottomItems: SidebarNavItem[] = [
    { href: '/dashboard', label: 'Dashboard', icon: <LayoutDashboard className="size-5" /> },
    {
      href: '/approvals',
      label: 'Approval',
      icon: <Clock className="size-5" />,
      badge: pendingCount ?? 0,
    },
    { href: '/gate', label: 'Check-in', icon: <DoorOpen className="size-5" /> },
    { href: '/security', label: 'Satpam', icon: <Shield className="size-5" /> },
  ]

  const avatar = (
    <span
      role="img"
      aria-label={`Akun ${displayName}`}
      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand text-label font-bold text-brand-contrast"
    >
      {initials}
    </span>
  )

  const logoMark = (
    <span
      aria-hidden="true"
      className="flex size-9 shrink-0 items-center justify-center rounded-control bg-brand text-label font-bold text-brand-contrast"
    >
      THC
    </span>
  )

  const sidebarHeader = (
    <div className="flex items-center gap-3 border-b border-border-light px-5 py-4">
      {logoMark}
      <div className="min-w-0">
        <p className="truncate text-sm font-bold text-ink">THC VMS</p>
        <p className="flex items-center gap-1 truncate text-badge text-ink-secondary">
          <MapPin className="size-3 shrink-0" aria-hidden="true" />
          {branchLabel}
        </p>
      </div>
    </div>
  )

  const sidebarFooter = (
    <div className="border-t border-border-light px-5 py-4">
      {/* Penugasan terkunci: ikon + TEKS selalu berpasangan (tanpa emoji sebagai satu-satunya penanda). */}
      <p className="flex items-start gap-1.5 text-badge font-semibold text-ink-secondary">
        <Lock className="mt-px size-3 shrink-0" aria-hidden="true" />
        <span>
          Penugasan: {locationName ?? 'Cabang'} (Read-Only)
        </span>
      </p>
      {status === 'loading' ? (
        <div className="mt-3 flex items-center gap-2 text-label text-ink-muted">
          <Spinner size="sm" />
          Memuat…
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-3">
          {avatar}
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{displayName}</p>
        </div>
      )}
      <Button variant="secondary" size="sm" fullWidth className="mt-4" onClick={handleSignOut}>
        <LogOut className="size-4" aria-hidden="true" />
        Keluar
      </Button>
    </div>
  )

  const sidebarInner = (
    <>
      {sidebarHeader}
      <div className="flex-1 overflow-y-auto py-4">
        <SidebarNav items={navItems} activeHref={activeHref} variant="light" />
      </div>
      {sidebarFooter}
    </>
  )

  return (
    <div className="min-h-screen bg-page">
      {/* Sidebar desktop (>= 1024px) — putih, 250px, border kanan */}
      <aside
        aria-label="Menu utama"
        className="fixed inset-y-0 left-0 z-40 hidden w-sidebar flex-col border-r border-border-light bg-surface lg:flex"
      >
        {sidebarInner}
      </aside>

      <div className="lg:pl-sidebar">
        {/* Topbar desktop */}
        <header className="sticky top-0 z-30 hidden h-topbar items-center gap-3 border-b border-border-light bg-surface px-6 lg:flex">
          {/* Lencana cabang TERKUNCI: <span> statis, bukan kontrol. */}
          <span
            aria-disabled="true"
            title="Penugasan cabang terkunci — tidak dapat diubah"
            className="inline-flex max-w-72 cursor-not-allowed items-center gap-1.5 rounded-control border border-border-light bg-neutral-bg px-3 py-2 text-label font-semibold text-ink-secondary"
          >
            <MapPin className="size-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{locationName !== null ? locationName : 'Cabang'}</span>
            <Lock className="size-3 shrink-0" aria-hidden="true" />
            <span className="sr-only">(terkunci, tidak dapat diubah)</span>
          </span>

          <div className="ml-auto flex items-center gap-3">
            <Button size="sm" onClick={onQuickCreateVisit}>
              <Plus className="size-4" aria-hidden="true" />
              Buat Kunjungan
            </Button>
            <Button variant="secondary" size="sm" onClick={onQuickAddSecurity}>
              <UserPlus className="size-4" aria-hidden="true" />
              Tambah Satpam
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={hasPending ? `Notifikasi, ${pendingCount ?? 0} persetujuan tertunda` : 'Notifikasi'}
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
        <header className="sticky top-0 z-30 flex h-topbar items-center gap-3 border-b border-border-light bg-surface px-4 lg:hidden">
          {logoMark}
          <span className="truncate text-sm font-bold text-ink">THC VMS</span>
          {/* Chip cabang terkunci di mobile — tetap statis, tidak interaktif. */}
          <span
            aria-disabled="true"
            className="inline-flex min-w-0 items-center gap-1 rounded-full bg-brand-soft px-2.5 py-1 text-badge font-bold text-brand"
          >
            <MapPin className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{locationName !== null ? locationName : 'Cabang'}</span>
            <span className="sr-only">(terkunci)</span>
          </span>
          <span className="ml-auto shrink-0">{avatar}</span>
        </header>

        {/* Konten utama */}
        <main className="min-w-0 overflow-x-clip p-6 pb-bottomnav lg:pb-6">
          <div className="mx-auto w-full max-w-7xl">{children}</div>
        </main>

        {/* Bottom navigation mobile (< 768px) — sengaja berlaku sampai lg agar tablet tetap punya navigasi. */}
        <BottomNav items={mobileBottomItems} activeHref={activeHref} className="lg:hidden" />
      </div>
    </div>
  )
}
