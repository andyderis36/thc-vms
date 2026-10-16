'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import {
  Bell,
  Clock,
  DoorOpen,
  LayoutDashboard,
  Lock,
  LogOut,
  MapPin,
  Menu,
  Plus,
  Shield,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { BottomNav, SidebarNav, type SidebarNavItem } from '@/components/layouts/SidebarNav'
import { SkipToContentLink } from '@/components/layouts/SkipToContentLink'
import { getLoginRedirect } from '@/lib/auth/capabilities'
import { useSession } from '@/lib/auth/session'
import { NAV_LABELS } from '@/lib/nav/labels'

export interface AdminBranchShellProps {
  children: ReactNode
  /** Jumlah kunjungan menunggu persetujuan di cabang ini — milik layar pemilik datanya. */
  pendingCount?: number
  /** Rute aktif; default '/dashboard' (layar pemilik meneruskannya). */
  activeHref?: string
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
 * Tombol tutup laci: diposisikan absolut di atas header panel slide-over (varian terang).
 * `min-h-touch` menaikkan target sentuh 36px → 44px (design system §5.2.1);
 * lebar bawaan `Button` (px-4 + ikon 20px = 52px) sudah ≥ 44px.
 */
const DRAWER_CLOSE_CLASS =
  'absolute right-2 top-4 z-10 min-h-touch text-ink-muted hover:bg-neutral-bg hover:text-ink'

/**
 * Kandidat fokus keyboard di dalam laci — dipakai untuk penjaga fokus (Tab
 * berputar hanya di antara elemen ini) dan untuk fokus awal ke tombol X.
 */
const DRAWER_FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

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
}: AdminBranchShellProps) {
  const { user, status, signOut } = useSession()
  const router = useRouter()
  const [drawerOpen, setDrawerOpen] = useState(false)

  // Penjaga aksesibilitas laci: elemen dialog, latar yang dinonaktifkan, dan
  // fokus sebelum laci dibuka (dikembalikan ke tombol hamburger saat tutup).
  const drawerDialogRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  // Fallback netral bila `location_name` null — tidak pernah menghasilkan kontrol editabel.
  const locationName = user !== null && user.location_name !== null ? user.location_name : null
  const branchLabel = locationName !== null ? `Cabang ${locationName}` : 'Cabang'
  const displayName = user !== null ? user.name : 'Pengguna'
  const initials = initialsOf(displayName)
  const hasPending = typeof pendingCount === 'number' && pendingCount > 0
  const closeDrawer = (): void => setDrawerOpen(false)

  // Tutup laci dengan Escape + jebak fokus keyboard di dalam laci (WCAG 2.1):
  // fokus pindah ke tombol X saat dibuka, Tab berputar hanya di dalam dialog,
  // latar (sidebar & konten) dinonaktifkan via `inert`/`aria-hidden`, dan
  // fokus dikembalikan ke pemicu hamburger saat ditutup.
  useEffect(() => {
    if (!drawerOpen) return

    const active = document.activeElement
    restoreFocusRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null

    const setBackgroundHidden = (hidden: boolean): void => {
      for (const element of [sidebarRef.current, contentRef.current]) {
        if (element === null) continue
        if (hidden) {
          element.setAttribute('inert', '')
          element.setAttribute('aria-hidden', 'true')
        } else {
          element.removeAttribute('inert')
          element.removeAttribute('aria-hidden')
        }
      }
    }

    // Fokus awal = tombol X (elemen fokus pertama setelah backdrop menjadi div
    // non-fokus); latar dinonaktifkan sesudahnya agar tidak ada elemen fokus
    // yang tersembunyi di balik `aria-hidden`.
    drawerDialogRef.current?.querySelector<HTMLElement>(DRAWER_FOCUSABLE_SELECTOR)?.focus()
    setBackgroundHidden(true)

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setDrawerOpen(false)
        return
      }
      if (event.key !== 'Tab') return
      const dialog = drawerDialogRef.current
      if (dialog === null) return
      const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(DRAWER_FOCUSABLE_SELECTOR))
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (first === undefined || last === undefined) return
      const current = document.activeElement
      const insideDialog = current !== null && dialog.contains(current)
      if (event.shiftKey && (!insideDialog || current === first)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (!insideDialog || current === last)) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)

    // Laci hanya ditampilkan di bawah `lg`: tutup otomatis saat layar melewati
    // breakpoint agar penjaga fokus tidak menahan fokus di dialog tersembunyi.
    const mediaQuery = window.matchMedia('(min-width: 1024px)')
    const onMediaQueryChange = (): void => {
      if (mediaQuery.matches) setDrawerOpen(false)
    }
    mediaQuery.addEventListener('change', onMediaQueryChange)

    return (): void => {
      window.removeEventListener('keydown', onKeyDown)
      mediaQuery.removeEventListener('change', onMediaQueryChange)
      setBackgroundHidden(false)
      const restoreTarget = restoreFocusRef.current
      if (restoreTarget !== null && restoreTarget.isConnected) {
        restoreTarget.focus()
      } else {
        // Cadangan: pemicu hamburger bila pemicu asli sudah tidak tersambung.
        document.querySelector<HTMLElement>('button[aria-label="Buka menu navigasi"]')?.focus()
      }
    }
  }, [drawerOpen])

  const handleSignOut = async (): Promise<void> => {
    const role = user !== null ? user.role : null
    await signOut()
    router.push(role !== null ? getLoginRedirect(role) : '/')
  }

  /**
   * Sama seperti SHELL-01: setiap item punya halaman mandiri. Persetujuan =
   * `/approvals` (irisan requested + aksi); Pengawas = `/security` (panel
   * kelola satpam cabangnya). Rute nyata: dashboard, approvals, gerbang
   * (`/gate`), security, form (`/visits/new`). Tepat 4 tab mobile §6.2.
   * Label menu SEMUA diambil dari `NAV_LABELS` — sumber kebenaran tunggal
   * yang dibagikan dengan SHELL-01 (tujuan sama = label sama antar role).
   */
  // Semua ikon nav dekoratif: `aria-hidden="true"` + `shrink-0` agar tetap
  // sebaris dengan label dan tak menyusut di dalam bungkus flex item.
  const navItems: SidebarNavItem[] = [
    { href: '/dashboard', label: NAV_LABELS.dashboard.desktop, icon: <LayoutDashboard aria-hidden="true" className="size-5 shrink-0" /> },
    {
      href: '/approvals',
      label: NAV_LABELS.approvals.desktop,
      icon: <Clock aria-hidden="true" className="size-5 shrink-0" />,
      badge: pendingCount ?? 0,
    },
    { href: '/gate', label: NAV_LABELS.gate.desktop, icon: <DoorOpen aria-hidden="true" className="size-5 shrink-0" /> },
    { href: '/security', label: NAV_LABELS.security.desktop, icon: <Shield aria-hidden="true" className="size-5 shrink-0" /> },
    { href: '/visits/new', label: NAV_LABELS.createVisit.desktop, icon: <Plus aria-hidden="true" className="size-5 shrink-0" /> },
  ]

  const mobileBottomItems: SidebarNavItem[] = [
    { href: '/dashboard', label: NAV_LABELS.dashboard.mobile, icon: <LayoutDashboard aria-hidden="true" className="size-5 shrink-0" /> },
    {
      href: '/approvals',
      label: NAV_LABELS.approvals.mobile,
      icon: <Clock aria-hidden="true" className="size-5 shrink-0" />,
      badge: pendingCount ?? 0,
    },
    { href: '/gate', label: NAV_LABELS.gate.mobile, icon: <DoorOpen aria-hidden="true" className="size-5 shrink-0" /> },
    { href: '/security', label: NAV_LABELS.security.mobile, icon: <Shield aria-hidden="true" className="size-5 shrink-0" /> },
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
    // `pr-16 lg:pr-5`: pada laci slide-over (< lg) ruang kanan disisakan untuk
    // tombol X agar tidak menimpa judul cabang; di sidebar desktop kembali sempit.
    <div className="flex items-center gap-3 border-b border-border-light py-4 pl-5 pr-16 lg:pr-5">
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
      <Button variant="secondary" size="sm" fullWidth className="mt-4 min-h-touch" onClick={handleSignOut}>
        <LogOut className="size-4 shrink-0" aria-hidden="true" />
        Keluar
      </Button>
    </div>
  )

  const sidebarInner = (
    <>
      {sidebarHeader}
      {/* min-h-0: copot automatic minimum size agar area menu benar-benar
          meng-scroll sendiri di dalam sidebar/laci yang tingginya terpasang tetap. */}
      <div className="min-h-0 flex-1 overflow-y-auto py-4">
        <SidebarNav items={navItems} activeHref={activeHref} variant="light" />
      </div>
      {sidebarFooter}
    </>
  )

  return (
    <div className="min-h-dvh bg-page">
      {/* Pintas keyboard pertama: lompat langsung ke konten utama. */}
      <SkipToContentLink />

      {/* Sidebar desktop (>= 1024px) — putih, 250px, border kanan; < 1024px memakai laci drawer. */}
      <aside
        ref={sidebarRef}
        aria-label="Menu utama"
        className="fixed inset-y-0 left-0 z-40 hidden w-sidebar flex-col border-r border-border-light bg-surface lg:flex"
      >
        {sidebarInner}
      </aside>

      <div ref={contentRef} className="lg:pl-sidebar">
        {/* Topbar desktop — slot & urutan identik dengan SHELL-01:
            identitas/konteks → aksi → notifikasi → avatar (tinggi `h-topbar`,
            padding `px-6` — sama persis dengan SuperadminShell). */}
        <header className="sticky top-0 z-30 hidden h-topbar items-center gap-4 border-b border-border-light bg-surface px-6 lg:flex">
          {/* Slot 1 — identitas/konteks: lencana cabang TERKUNCI (<span> statis, bukan kontrol). */}
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

          {/* Slot 2 — aksi cepat: DIHAPUS (tombol Buat Kunjungan & Tambah
              Pengawas; keduanya tersedia dari konten halaman & menu sidebar). */}
          <div className="ml-auto flex items-center gap-3">
            {/* Slot 3 — notifikasi persetujuan. */}
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
            {/* Slot 4 — avatar akun. */}
            {avatar}
          </div>
        </header>

        {/* Topbar mobile / tablet (< 1024px) */}
        <header className="sticky top-0 z-30 flex h-topbar items-center gap-3 border-b border-border-light bg-surface px-4 lg:hidden">
          {/* Tombol hamburger di urutan PERTAMA (paling kiri, sebelum logo)
              agar searah dengan laci drawer yang meluncur dari kiri. */}
          <Button
            variant="ghost"
            size="sm"
            aria-label="Buka menu navigasi"
            aria-expanded={drawerOpen}
            className="min-h-touch shrink-0"
            onClick={() => setDrawerOpen(true)}
          >
            <Menu className="size-5" aria-hidden="true" />
          </Button>
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
          {/* `ml-auto` tetap di span avatar: mendorong sisa konten (avatar)
              ke tepi kanan setelah tombol menu dipindah ke depan. */}
          <span className="ml-auto shrink-0">{avatar}</span>
        </header>

        {/* Konten utama — min-w-0 (min-inline-size:0) menjamin tidak ada scroll
            horizontal; id+tabIndex menjadi sasan skip-to-content. */}
        <main id="main-content" tabIndex={-1} className="min-w-0 overflow-x-clip p-6 pb-bottomnav lg:pb-6">
          <div className="mx-auto w-full max-w-7xl">{children}</div>
        </main>

        {/* Bottom navigation mobile (< 768px) — sengaja berlaku sampai lg agar tablet tetap punya navigasi. */}
        <BottomNav items={mobileBottomItems} activeHref={activeHref} className="lg:hidden" />
      </div>

      {/* Laci slide-over mobile / tablet — isi yang sama dengan sidebar desktop */}
      {drawerOpen && (
        <div
          ref={drawerDialogRef}
          className="fixed inset-0 z-50 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Menu navigasi"
        >
          {/* Backdrop sengaja div non-fokus (bukan tombol): clik hanya penutup
              pointer, jalur keyboard memakai tombol X / Escape. */}
          <div aria-hidden="true" className="absolute inset-0 bg-ink/40" onClick={closeDrawer} />
          <div className="absolute inset-y-0 left-0 flex w-sidebar max-w-[85vw] flex-col border-r border-border-light bg-surface shadow-modal">
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
