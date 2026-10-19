'use client'

import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import {
  Clock,
  LayoutDashboard,
  Lock,
  MapPin,
  Menu,
  ScrollText,
  Shield,
  Users,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { NotificationsMenu } from '@/components/ui/NotificationsMenu'
import { ProfileMenu } from '@/components/ui/ProfileMenu'
import { Spinner } from '@/components/ui/Spinner'
import { BottomNav, SidebarNav, type SidebarNavItem } from '@/components/layouts/SidebarNav'
import { SkipToContentLink } from '@/components/layouts/SkipToContentLink'
import { getLoginRedirect } from '@/lib/auth/capabilities'
import { useSession } from '@/lib/auth/session'
import { NAV_LABELS } from '@/lib/nav/labels'
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
  /**
   * Nilai TERKENDALI (*controlled*) switcher cabang. Bila prop ini diberikan,
   * nilai inilah yang tampil (menang atas state internal shell) sehingga
   * halaman induk — mis. filter bar `/users` — bisa menyimpan & menyinkronkan
   * `location_id`-nya sendiri. Bila TIDAK diberikan, shell memakai state
   * internal (`'all'` saat render awal) → perilaku lama 100% dipertahankan.
   */
  branchId?: string
  /**
   * Sembunyikan switcher cabang PADA KEDUA header (desktop ~baris 336 dan
   * mobile ~baris 364). Dipakai halaman yang filter cabangnya tidak relevan
   * untuk konteks yang sedang aktif (mis. Peran ≠ Koordinator Wilayah di
   * `/users`). Default `false` → switcher tampil seperti biasa (lazimnya
   * pemanggilan lama yang tidak mengirim prop ini sama sekali).
   */
  hideBranchSwitcher?: boolean
}

const SELECT_CLASS =
  'h-10 cursor-pointer rounded-control border border-border-mid bg-surface px-3 text-label text-ink focus-visible:ring-2 focus-visible:ring-brand focus-visible:border-brand'

/** Select cabang mobile: tinggi 44px (target sentuh minimum §5.2). */
const MOBILE_SELECT_CLASS =
  'h-11 min-w-0 max-w-36 cursor-pointer rounded-control border border-border-mid bg-surface px-2 text-label text-ink focus-visible:ring-2 focus-visible:ring-brand focus-visible:border-brand'

/**
 * Penyesuaian `ProfileMenu` untuk footer sidebar gelap (bawaan komponen untuk
 * permukaan terang): (1) teks pemicu dibalik ke `brand-contrast` + hover wash
 * `sidebar-dark-active`; (2) panel dibalik ke atas (`bottom-full`) karena
 * footer menempel di dasar viewport — `top-full` akan mengirim "Keluar" ke
 * luar layar; `mt-1` bawaan tetap jadi celah panel. Selector hanya menyasar
 * `button:first-child` (pemicu) dan `button:first-child + div` (panel);
 * panel terang sengaja tidak diubah.
 */
const PROFILE_MENU_DARK_CLASS = [
  '[&_button:first-child_span]:text-brand-contrast',
  '[&_button:first-child:hover]:bg-sidebar-dark-active',
  '[&_button:first-child+div]:top-auto',
  '[&_button:first-child+div]:bottom-full',
].join(' ')

/** Logo mark THC (kotak merah) — dipakai header sidebar & topbar mobile. */
const LOGO_CLASS =
  'flex size-9 shrink-0 items-center justify-center rounded-control bg-brand text-label font-bold text-brand-contrast'

/**
 * Tombol tutup laci: diposisikan absolut di atas header panel slide-over.
 * `min-h-touch` menaikkan target sentuh 36px → 44px (design system §5.2.1);
 * lebar bawaan `Button` (px-4 + ikon 20px = 52px) sudah ≥ 44px.
 */
const DRAWER_CLOSE_CLASS =
  'absolute right-2 top-4 z-10 min-h-touch text-ink-muted hover:bg-brand/15 hover:text-brand-contrast'

/**
 * Kandidat fokus keyboard di dalam laci — dipakai untuk penjaga fokus (Tab
 * berputar hanya di antara elemen ini) dan untuk fokus awal ke tombol X.
 */
const DRAWER_FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

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
  branchId,
  hideBranchSwitcher = false,
}: SuperadminShellProps) {
  const { user, status, signOut } = useSession()
  const router = useRouter()
  const [drawerOpen, setDrawerOpen] = useState(false)
  // State internal hanya menjadi sumber nilai bila prop `branchId` tidak
  // dikirim (pemanggilan lama) — lihat `branchValue` di bawah.
  const [internalBranchId, setInternalBranchId] = useState('all')

  // Penjaga aksesibilitas laci: elemen dialog, latar yang dinonaktifkan, dan
  // fokus sebelum laci dibuka (dikembalikan ke tombol hamburger saat tutup).
  const drawerDialogRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  const locations = allLocations ?? []
  // Label kantor pusat dinamis dari daftar lokasi (BE Kalbar);
  // fallback Pontianak saat daftar belum terisi (render awal / tanpa props).
  const pusatCity = locations.find((location) => location.type === 'pusat')?.city ?? 'Pontianak'
  const displayName = user !== null ? user.name : 'Pengguna'
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

  const branchValue = branchId ?? internalBranchId

  const handleBranchChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    const next = event.target.value
    setInternalBranchId(next)
    onBranchChange?.(next)
  }

  const handleSignOut = async (): Promise<void> => {
    const role = user !== null ? user.role : null
    await signOut()
    router.push(role !== null ? getLoginRedirect(role) : '/')
  }

  /**
   * Rute TANPA item mandiri pada menu 5-item §6.1 — dipetakan sebagai alias
   * (subordinat) item Dashboard, bukan item baru, sehingga jumlah & urutan
   * menu utama tetap sesuai SSOT:
   * - `/visits/new` (SCR-03) dibuka dari aksi "Buat Kunjungan" di dashboard
   *   (batal kembali ke `/dashboard`) dan `/visits/[id]` adalah rute detail
   *   turunannya — keduanya bernaung di "Semua kunjungan" Dashboard Global.
   * - `/gate` (konsol SCR-05) ditransisikan dari dashboard (lihat gate/page)
   *   dan tak punya slot tersendiri di 4 tab / 5 item §6.1.
   * Pemetaan prefix: `'/visits'` juga menangkap `/visits/new` & `/visits/<id>`.
   */
  const DASHBOARD_ALIAS_ROUTES: string[] = ['/visits', '/gate']

  /**
   * Menu superadmin setia desain §6.1: item desktop, semua halaman mandiri.
   * Antrean = `/approvals` (irisan requested + aksi); Security = `/security`
   * (panel kelola pengawas); Fasilitas & Users halaman penuh; `/audit` jejak
   * audit lintas cabang (desktop saja — drawer ikut memakai `navItems`).
   * Badge approval dipertahankan. `?focus=` dashboard tetap sebagai
   * entry-point kompatibel.
   * Label menu SEMUA diambil dari `NAV_LABELS` — sumber kebenaran tunggal
   * yang dibagikan dengan SHELL-02 (tujuan sama = label sama antar role).
   */
  // Semua ikon nav dekoratif: `aria-hidden="true"` (label teks yang dibaca
  // screen reader) + `shrink-0` agar tak gepeng di dalam bungkus flex item.
  const navItems: SidebarNavItem[] = [
    { href: '/dashboard', label: NAV_LABELS.dashboard.desktop, icon: <LayoutDashboard aria-hidden="true" className="size-5 shrink-0" />, match: DASHBOARD_ALIAS_ROUTES },
    { href: '/approvals', label: NAV_LABELS.approvals.desktop, icon: <Clock aria-hidden="true" className="size-5 shrink-0" />, badge: pendingCount ?? 0 },
    { href: '/facilities', label: NAV_LABELS.facilities.desktop, icon: <MapPin aria-hidden="true" className="size-5 shrink-0" /> },
    { href: '/security', label: NAV_LABELS.security.desktop, icon: <Shield aria-hidden="true" className="size-5 shrink-0" /> },
    { href: '/users', label: NAV_LABELS.users.desktop, icon: <Users aria-hidden="true" className="size-5 shrink-0" /> },
    { href: '/audit', label: NAV_LABELS.auditLogs.desktop, icon: <ScrollText aria-hidden="true" className="size-5 shrink-0" /> },
  ]

  /** Mobile 4 tab sesuai desain §6.1: Dashboard, Approval, Fasilitas, Security. */
  const mobileBottomItems: SidebarNavItem[] = [
    { href: '/dashboard', label: NAV_LABELS.dashboard.mobile, icon: <LayoutDashboard aria-hidden="true" className="size-5 shrink-0" />, match: DASHBOARD_ALIAS_ROUTES },
    { href: '/approvals', label: NAV_LABELS.approvals.mobile, icon: <Clock aria-hidden="true" className="size-5 shrink-0" />, badge: pendingCount ?? 0 },
    { href: '/facilities', label: NAV_LABELS.facilities.mobile, icon: <MapPin aria-hidden="true" className="size-5 shrink-0" /> },
    { href: '/security', label: NAV_LABELS.security.mobile, icon: <Shield aria-hidden="true" className="size-5 shrink-0" /> },
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
    // `pr-16 lg:pr-5`: pada laci slide-over (< lg) ruang kanan disisakan untuk
    // tombol X agar tidak menimpa judul; di sidebar desktop kembali sempit.
    <div className="flex items-center gap-3 border-b border-sidebar-dark-active py-4 pl-5 pr-16 lg:pr-5">
      {logoMark}
      <div className="min-w-0">
        <p className="truncate text-sm font-bold text-brand-contrast">THC VMS PUSAT</p>
        <p className="truncate text-badge text-ink-muted">Kantor Pusat {pusatCity}</p>
      </div>
    </div>
  )

  const sidebarFooter = (
    <div className="border-t border-sidebar-dark-active px-5 py-4">
      <Badge tone="info" className="gap-1">
        <Lock className="size-3 shrink-0" aria-hidden="true" />
        KANTOR PUSAT
      </Badge>
      {status === 'loading' ? (
        <div className="mt-3 flex items-center gap-2 text-label text-ink-muted">
          <Spinner size="sm" />
          Memuat…
        </div>
      ) : (
        <div className="mt-3">
          {/* Pemicu menu akun — SATU per breakpoint: footer ini dipakai
              bersama `aside` desktop dan laci drawer, jadi menu akun langsung
              berlaku di keduanya; logout pindah ke dalam panel
              (`onLogout` = `handleSignOut`). */}
          <div className={PROFILE_MENU_DARK_CLASS}>
            <ProfileMenu user={{ name: displayName }} onLogout={handleSignOut} />
          </div>
          <Badge tone="danger" className="mt-1.5 ml-2">
            SUPERADMIN
          </Badge>
        </div>
      )}
    </div>
  )

  const sidebarInner = (
    <>
      {sidebarHeader}
      {/* min-h-0: copot automatic minimum size agar area menu benar-benar
          meng-scroll sendiri di dalam sidebar yang tingginya terpasang tetap. */}
      <div className="min-h-0 flex-1 overflow-y-auto py-4">
        <SidebarNav items={navItems} activeHref={activeHref} variant="dark" />
      </div>
      {sidebarFooter}
    </>
  )

  /** Switcher cabang interaktif — satu render, dua ukuran (desktop & mobile). */
  const renderBranchSelect = (className: string) => (
    <select value={branchValue} onChange={handleBranchChange} aria-label="Pilih cabang atau POP" className={className}>
      <option value="all">Semua Cabang / POP</option>
      {branchOptions}
    </select>
  )

  return (
    <div className="min-h-dvh bg-page">
      {/* Pintas keyboard pertama: lompat langsung ke konten utama. */}
      <SkipToContentLink />

      {/* Sidebar desktop (>= 1024px) — fixed, gelap, 260px; layar lebih kecil memakai laci drawer. */}
      <aside
        ref={sidebarRef}
        aria-label="Menu utama"
        className="fixed inset-y-0 left-0 z-40 hidden w-sidebar-wide flex-col bg-sidebar-dark lg:flex"
      >
        {sidebarInner}
      </aside>

      <div ref={contentRef} className="lg:pl-sidebar-wide">
        {/* Topbar desktop — slot & urutan mengikuti SHELL-02: identitas/konteks
            → aksi → notifikasi (tinggi `h-topbar`, padding `px-6` — sama
            persis dengan AdminBranchShell). Slot 4 (akun) DIHAPUS: menu akun
            pindah ke footer sidebar (`ProfileMenu`) supaya tiap breakpoint
            hanya punya SATU pemicu akun — Bell tetap koeksisten tanpa tumpang
            tindih (sidebar 260px, topbar mulai sesudahnya). */}
        <header className="sticky top-0 z-30 hidden h-topbar items-center gap-4 border-b border-border-light bg-surface px-6 lg:flex">
          {/* Slot 1 — identitas/konteks: switcher cabang lintas pusat.
              Ditiadakan bila halaman mengirim `hideBranchSwitcher`; Slot 2/3
              di kanan tidak terpengaruh karena `ml-auto` miliknya sendiri. */}
          {hideBranchSwitcher ? null : renderBranchSelect(SELECT_CLASS)}
          {/* Slot 2 — aksi cepat: kosong (superadmin tanpa pintas aksi topbar). */}
          <div className="ml-auto flex items-center gap-3">
            {/* Slot 3 — notifikasi: dropdown feed (bukan lompat ke /approvals).
                Badge lonceng bersumber dari `unread_count` notifikasi sendiri;
                `pendingCount` tetap menggerakkan badge `/approvals` di sidebar. */}
            <NotificationsMenu />
          </div>
        </header>

        {/* Topbar mobile / tablet (< 1024px) */}
        <header className="sticky top-0 z-30 flex h-topbar items-center gap-2 border-b border-border-light bg-surface px-4 lg:hidden">
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
          <span className="truncate text-sm font-bold text-ink">THC VMS PUSAT</span>
          {/* `ml-auto` tetap di sini: mendorong sisa konten (switcher cabang)
              ke tepi kanan setelah tombol menu dipindah ke depan. Bila
              switcher disembunyikan, `ml-auto` ikut hilang — tidak ada celah
              yang bergantung padanya: ketiga anak tersisa (tombol menu, logo,
              judul) semuanya tanpa `ml-auto` dan memang seharusnya menempel
              rapi ke kiri. */}
          {hideBranchSwitcher ? null : renderBranchSelect(`${MOBILE_SELECT_CLASS} ml-auto`)}
        </header>

        {/* Konten utama — min-w-0 (min-inline-size:0) menjamin tidak ada scroll
            horizontal; id+tabIndex menjadi sasan skip-to-content.
            `pb-bottomnav lg:pb-6`: padding bawah ikut rentang BottomNav (lg),
            selaras dengan AdminBranchShell. */}
        <main id="main-content" tabIndex={-1} className="min-w-0 overflow-x-clip p-6 pb-bottomnav lg:pb-6">
          <div className="mx-auto w-full max-w-7xl">{children}</div>
        </main>

        {/* Bottom navigation (s/d < 1024px) — sengaja berlaku sampai lg agar
            tablet 768-1023px tetap punya navigasi (sidebar baru muncul di lg). */}
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
          <div className="absolute inset-y-0 left-0 flex w-sidebar-wide max-w-[85vw] flex-col rounded-card bg-sidebar-dark shadow-modal">
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
