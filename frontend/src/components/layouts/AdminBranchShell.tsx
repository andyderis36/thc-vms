'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import {
  Clock,
  DoorOpen,
  LayoutDashboard,
  Lock,
  MapPin,
  Menu,
  Plus,
  Shield,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { NotificationsMenu } from '@/components/ui/NotificationsMenu'
import { ProfileMenu } from '@/components/ui/ProfileMenu'
import { Spinner } from '@/components/ui/Spinner'
import { BottomNav, SidebarNav, type SidebarNavItem } from '@/components/layouts/SidebarNav'
import { SkipToContentLink } from '@/components/layouts/SkipToContentLink'
import { getLoginRedirect, getRoleLabel } from '@/lib/auth/capabilities'
import { useSession } from '@/lib/auth/session'
import { NAV_LABELS } from '@/lib/nav/labels'

export interface AdminBranchShellProps {
  children: ReactNode
  /** Jumlah kunjungan menunggu persetujuan di cabang ini — milik layar pemilik datanya. */
  pendingCount?: number
  /** Rute aktif; default '/dashboard' (layar pemilik meneruskannya). */
  activeHref?: string
}

/**
 * Tombol tutup laci: diposisikan absolut di atas header panel slide-over (varian terang).
 * Ukuran sisi WAJIB eksplisit (`size-11` = 44×44, target sentuh §5.2.1): sebagai anak
 * langsung `flex flex-col`, `align-self: stretch` bawaan meregangkan LEBAR tombol
 * hingga selebar panel (250px), sehingga `right-2` mendorong tepi kirinya keluar layar
 * (terukur x:-8). Elemen `<button>` polos dipakai agar padding bawaan atom `Button`
 * (`px-4`) — utilitas numerik yang selalu menang atas padding lain di kelas yang sama —
 * tidak ikut terbawa.
 */
const DRAWER_CLOSE_CLASS =
  'absolute right-2 top-2 z-10 flex size-11 items-center justify-center rounded-control text-ink-muted hover:bg-brand/15 hover:text-brand-contrast'

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
  const displayName = user !== null ? user.name : 'Pengguna'
  const roleLabel = user !== null ? getRoleLabel(user.role) : undefined
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
   * kelola pengawas cabangnya). Rute nyata: dashboard, approvals, gerbang
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

  // Aset brand asli `public/thcw.png` adalah wordmark PUTIH transparan. Header
  // sidebar/laci berlatar `bg-sidebar-dark` (#09090b) jadi gambar berdiri
  // sendiri tanpa alas chip. Logo dirender `h-10 w-auto`: tinggi TETAP 40px
  // agar TIDAK PERNAH melebihi tinggi navbar (64px desktop / 56px ponsel).
  const logoMark = (
    <span className="flex items-center">
      <Image src="/thcw.png" alt="THC" width={500} height={235} className="h-10 w-auto" />
    </span>
  )

  const sidebarHeader = (
    // `pr-16 lg:pr-5`: pada laci slide-over (< lg) ruang kanan disisakan untuk
    // tombol X agar tidak menimpa logo; di sidebar desktop kembali sempit.
    // `lg:h-topbar` + `lg:items-center` menjaga tinggi pita sidebar = tinggi
    // navbar (64px), dengan logo 40px di tengahnya. Identitas teks ("THC VMS"
    // + "Cabang ...") DIHAPUS karena selalu tampil di topbar (desktop & mobile).
    <div className="flex flex-col border-b border-sidebar-dark-active bg-sidebar-dark py-4 pl-5 pr-16 lg:h-topbar lg:shrink-0 lg:flex-row lg:items-center lg:py-0 lg:pr-5">
      {logoMark}
    </div>
  )

  const sidebarFooter = (
    <div className="border-t border-border-light px-5 py-4">
      {/* Penugasan terkunci: ikon + TEKS selalu berpasangan (tanpa emoji sebagai
          satu-satunya penanda). Satu baris kecil redup di atas blok akun —
          konteks tak boleh bersaing dengan profil. Teks panjang dipotong
          `truncate` dan disimpan utuh di `title` supaya tak pernah meluber
          dari sidebar 250px. Sifat hanya-baca dinyatakan lewat ikon gembok
          dan awalan "Penugasan:", tanpa anotasi akses tambahan yang dicetak. */}
      <p
        className="flex items-center gap-1.5 text-badge font-semibold text-ink-muted"
        title={`Penugasan: ${locationName ?? 'Cabang'}`}
      >
        <Lock className="mt-px size-3 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">Penugasan: {locationName ?? 'Cabang'}</span>
      </p>
      {status === 'loading' ? (
        <div className="mt-3 flex items-center gap-2 text-label text-ink-muted">
          <Spinner size="sm" />
          Memuat…
        </div>
      ) : (
        /*
         * Pemicu akun SATU untuk seluruh shell (sidebar desktop & laci mobile
         * memakai `sidebarInner` yang sama) — avatar topbar/mobile dihapus agar
         * tepat satu avatar per breakpoint; logout kini di dalam menu.
         * Varian `[&_[role=menu]]` membalik panel `top-full` bawaan ProfileMenu
         * menjadi terbuka ke atas: pemicu menempel di tepi bawah viewport,
         * sehingga panel ke bawah akan terpotong layar.
         * `roleSlot` menaruh lencana peran DI DALAM kolom nama ProfileMenu,
         * jadi lencana berdiri sejajar dengan nama, bukan baris terpisah.
         */
        <div className="mt-2 [&_[role=menu]]:top-auto [&_[role=menu]]:bottom-full [&_[role=menu]]:mt-0 [&_[role=menu]]:mb-1">
          <ProfileMenu
            user={{
              name: displayName,
              role: roleLabel,
              avatarUrl: user !== null ? (user.avatar_url ?? undefined) : undefined,
            }}
            onLogout={handleSignOut}
            alwaysShowName
            roleSlot={
              roleLabel !== undefined ? (
                <Badge tone="info" className="text-badge font-semibold">
                  {roleLabel}
                </Badge>
              ) : undefined
            }
          />
        </div>
      )}
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
            identitas/konteks → aksi → notifikasi (tinggi `h-topbar`,
            padding `px-6` — sama persis dengan SuperadminShell).
            Slot avatar DIHAPUS: pemicu akun kini `ProfileMenu` di
            `sidebarFooter` — Bell & menu profil koeksis, tanpa dobel. */}
        <header className="sticky top-0 z-30 hidden h-topbar items-center gap-4 border-b border-border-light bg-surface px-6 lg:flex">
          {/* Slot 1 — identitas/konteks: lencana cabang TERKUNCI (<span> statis, bukan kontrol). */}
          <span
            aria-disabled="true"
            title="Penugasan cabang terkunci — tidak dapat diubah"
            className="inline-flex max-w-72 cursor-not-allowed items-center gap-1.5 rounded-control border border-border-light bg-neutral-bg px-3 py-2 text-label font-semibold text-ink-secondary"
          >
            <MapPin className="size-4 shrink-0" aria-hidden="true" />
            <span className="truncate" title={locationName !== null ? locationName : 'Cabang'}>
              {locationName !== null ? locationName : 'Cabang'}
            </span>
            <Lock className="size-3 shrink-0" aria-hidden="true" />
            <span className="sr-only">(terkunci, tidak dapat diubah)</span>
          </span>

          {/* Slot 2 — aksi cepat: DIHAPUS (tombol Buat Kunjungan & Tambah
              Pengawas; keduanya tersedia dari konten halaman & menu sidebar). */}
          <div className="ml-auto flex items-center gap-3">
            {/* Slot 3 — notifikasi: dropdown feed (bukan lompat ke /approvals).
                Badge lonceng bersumber dari `unread_count` notifikasi sendiri;
                `pendingCount` tetap menggerakkan badge `/approvals` di sidebar. */}
            <NotificationsMenu />
          </div>
        </header>

        {/* Topbar mobile / tablet (< 1024px) */}
        <header className="sticky top-0 z-30 flex h-bar-mobile items-center gap-2 border-b border-border-light bg-surface px-3 lg:hidden">
          {/* Tombol hamburger di urutan PERTAMA (paling kiri)
              agar searah dengan laci drawer yang meluncur dari kiri. Dipakai
              `<button>` polos + `size-11` (44×44) agar target sentuh penuh dan
              padding atom `Button` (`px-4`) tidak menambah lebar. */}
          <button
            type="button"
            aria-label="Buka menu navigasi"
            aria-expanded={drawerOpen}
            className="flex size-11 shrink-0 items-center justify-center rounded-control text-ink-secondary hover:bg-neutral-bg"
            onClick={() => setDrawerOpen(true)}
          >
            <Menu className="size-5" aria-hidden="true" />
          </button>
          {/* Chip cabang terkunci di mobile — tetap statis, tidak interaktif.
              Berbatas `max-w-40` + `shrink-0` agar nama cabang panjang TIDAK memakan
              bar (leluhur masalah yang sama dengan <select> bawaan); sisa ruang
              diserap `ml-auto` pada chip sehingga lonceng terdorong ke tepi kanan.
              Avatar header sengaja TIDAK dirender: satu-satunya avatar di
              breakpoint mobile ada di footer laci (ProfileMenu). */}
          <span
            aria-disabled="true"
            className="ml-auto inline-flex min-w-0 max-w-40 shrink-0 items-center gap-1 rounded-badge bg-brand-soft px-2.5 py-1 text-badge font-bold text-brand"
          >
            <MapPin className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate" title={locationName !== null ? locationName : 'Cabang'}>
              {locationName !== null ? locationName : 'Cabang'}
            </span>
            <span className="sr-only">(terkunci)</span>
          </span>
          {/* Lonceng notifikasi DI AKHIR bar (paling kanan) — aksi global
              aplikasi; tersedia di mobile DAN desktop agar fitur ini tidak
              hanya terjangkau saat layar lebar. */}
          <NotificationsMenu className="shrink-0" />
        </header>

        {/* Konten utama — min-w-0 (min-inline-size:0) menjamin tidak ada scroll
            horizontal; id+tabIndex menjadi sasan skip-to-content.
            Padding bawah `pb-bottomnav` + inset safe area iOS: bar bawah
            tumbuh sebesar `env(safe-area-inset-bottom)`, jadi ruang kosong
            konten ikut tumbuh sama besar (home indicator tak pernah menutupi
            isi). */}
        <main
          id="main-content"
          tabIndex={-1}
          className="min-w-0 overflow-x-clip p-6 pb-[calc(var(--spacing-bottomnav)_+_env(safe-area-inset-bottom))] lg:pb-6"
        >
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
            <button type="button" aria-label="Tutup menu navigasi" className={DRAWER_CLOSE_CLASS} onClick={closeDrawer}>
              <X className="size-5" aria-hidden="true" />
            </button>
            {sidebarInner}
          </div>
        </div>
      )}
    </div>
  )
}
