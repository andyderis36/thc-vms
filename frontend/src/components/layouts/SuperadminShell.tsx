'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import {
  Building2,
  Clock,
  LayoutDashboard,
  Lock,
  Mail,
  MapPin,
  MapPinned,
  Menu,
  ScrollText,
  Shield,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
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
  /**
   * Daftar lokasi (dipertahankan demi kompatibilitas pemanggil). Shell tidak
   * lagi merender label "Kantor Pusat {kota}" - identitas di header sidebar
   * kini cukup logo THC ukuran penuh.
   */
  allLocations?: Location[]
  /** Rute aktif; default '/dashboard' (layar pemilik meneruskannya). */
  activeHref?: string
}

/**
 * Penyesuaian `ProfileMenu` untuk footer sidebar gelap (bawaan komponen untuk
 * permukaan terang): (1) teks pemicu dibalik ke `brand-contrast` + hover wash
 * `sidebar-dark-active`; (2) panel dibalik ke atas (`bottom-full`) karena
 * footer menempel di dasar viewport — `top-full` akan mengirim "Keluar" ke
 * luar layar; `mt-1` bawaan tetap jadi celah panel. Selector hanya menyasar
 * `button:first-child` (pemicu) dan `button:first-child + div` (panel);
 * panel terang sengaja tidak diubah.
 * `:not(.status-badge)` mencegah lencana peran (pil) ikut dibalik — pil
 * memakai tinta sendiri (mis. `danger-text`) dan tak boleh jadi terang.
 */
const PROFILE_MENU_DARK_CLASS = [
  '[&_button:first-child_span:not(.status-badge)]:text-brand-contrast',
  '[&_button:first-child:hover]:bg-sidebar-dark-active',
  '[&_button:first-child+div]:top-auto',
  '[&_button:first-child+div]:bottom-full',
].join(' ')

/**
 * Logo merek asli `public/thcw.png` (wordmark PUTIH, latar transparan) -
 * dirender `h-10 w-auto`: tinggi TETAP 40px agar TIDAK PERNAH melebihi
 * tinggi navbar (64px desktop / 56px ponsel) di shell mana pun.
 */
const LOGO_CLASS = 'flex items-center'

/**
 * Tombol tutup laci: elemen `<button>` polos dengan lebar EKSPLISIT
 * `size-11` (44×44). Atom `Button` tak bisa dipakai di sini: ia anak flex
 * kolom `flex-col`, jadi `align-self: stretch` melebarkannya jadi 260px dan
 * `right-2` mendorong tepi kirinya ke -8px (8px di luar layar).
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
 * SHELL-01 — Base layout Superadmin (Kantor Pusat).
 * Sidebar gelap 260px. Filter cabang/fasilitas TIDAK lagi dirender di topbar:
 * setiap halaman pemilik sudah menyediakannya tepat SATU kali di filter bar
 * halamannya sendiri (mencegah kontrol filter ganda pada satu layar).
 */
export function SuperadminShell({
  children,
  pendingCount,
  activeHref = '/dashboard',
}: SuperadminShellProps) {
  const { user, status, signOut } = useSession()
  const router = useRouter()
  const [drawerOpen, setDrawerOpen] = useState(false)

  // Penjaga aksesibilitas laci: elemen dialog, latar yang dinonaktifkan, dan
  // fokus sebelum laci dibuka (dikembalikan ke tombol hamburger saat tutup).
  const drawerDialogRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

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
   * (panel kelola pengawas); Koordinator Wilayah (`/coordinators`) memuat
   * akun Koordinator Wilayah BERSAMA akun tingkat atas (Superadmin) —
   * dibedakan lewat filter peran di kolom "Peran"; Pendaftaran Vendor/Mitra
   * (`/vendor-registrations`) punya halaman sendiri; Fasilitas halaman penuh;
   * `/audit` jejak audit lintas cabang (desktop saja — drawer ikut memakai
   * `navItems`).
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
    { href: '/coordinators', label: NAV_LABELS.coordinators.desktop, icon: <MapPinned aria-hidden="true" className="size-5 shrink-0" /> },
    { href: '/vendor-registrations', label: NAV_LABELS.vendorRegistrations.desktop, icon: <Building2 aria-hidden="true" className="size-5 shrink-0" /> },
    { href: '/audit', label: NAV_LABELS.auditLogs.desktop, icon: <ScrollText aria-hidden="true" className="size-5 shrink-0" /> },
    { href: '/settings/mail-logs', label: NAV_LABELS.mailLogs.desktop, icon: <Mail aria-hidden="true" className="size-5 shrink-0" /> },
  ]

  /** Mobile 4 tab sesuai desain §6.1: Dashboard, Approval, Fasilitas, Security. */
  const mobileBottomItems: SidebarNavItem[] = [
    { href: '/dashboard', label: NAV_LABELS.dashboard.mobile, icon: <LayoutDashboard aria-hidden="true" className="size-5 shrink-0" />, match: DASHBOARD_ALIAS_ROUTES },
    { href: '/approvals', label: NAV_LABELS.approvals.mobile, icon: <Clock aria-hidden="true" className="size-5 shrink-0" />, badge: pendingCount ?? 0 },
    { href: '/facilities', label: NAV_LABELS.facilities.mobile, icon: <MapPin aria-hidden="true" className="size-5 shrink-0" /> },
    { href: '/security', label: NAV_LABELS.security.mobile, icon: <Shield aria-hidden="true" className="size-5 shrink-0" /> },
  ]

  // `unoptimized` WAJIB: `/_next/image?url=%2Fthcw.png&w=1080&q=75` dengan
  // `Accept: image/avif` menggantung tanpa respons (>45 s, terukur 2026-10-28)
  // dan ikut menahan permintaan Next lain di server yang sama. Aset ini hanya
  // 24 KB (500x235) - tidak ada yang perlu di-resize, sajikan apa adanya.
  const logoMark = (
    <span className={LOGO_CLASS}>
      <Image src="/thcw.png" alt="THC" width={500} height={235} unoptimized className="h-10 w-auto" />
    </span>
  )

  const sidebarHeader = (
    // `pr-16 lg:pr-5`: pada laci slide-over (< lg) ruang kanan disisakan untuk
    // tombol X agar tidak menimpa logo. `lg:h-topbar` + `lg:items-center`
    // menjaga tinggi pita sidebar = tinggi navbar (64px), dengan logo 40px
    // di tengahnya. Identitas teks ("THC VMS PUSAT" / "Kantor Pusat ...")
    // DIHAPUS.
    <div className="flex flex-col border-b border-sidebar-dark-active py-4 pl-5 pr-16 lg:h-topbar lg:shrink-0 lg:flex-row lg:items-center lg:py-0 lg:pr-5">
      {logoMark}
    </div>
  )

  const sidebarFooter = (
    <div className="border-t border-sidebar-dark-active px-5 py-4">
      {/* Konteks kantor — MATA SUBORDINAT: baris kecil redup yang menempel
          rapat di atas blok akun (bukan lencana penuh terpisah), supaya kaki
          sidebar terbaca sebagai SATU area akun, bukan tumpukan elemen
          yang saling lepas. Permukaan gelap: `text-brand-contrast/60`
          (6.1:1 di atas #09090b) — `text-ink-muted` hanya 4.12:1 di sini. */}
      <p className="flex items-center gap-1.5 text-badge font-semibold text-brand-contrast/60">
        <Lock className="size-3 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate" title="Kantor Pusat">Kantor Pusat</span>
      </p>
      {status === 'loading' ? (
        <div className="mt-3 flex items-center gap-2 text-label text-brand-contrast/60">
          <Spinner size="sm" />
          Memuat…
        </div>
      ) : (
        <div className="mt-2">
          {/* Pemicu menu akun — SATU per breakpoint: footer ini dipakai
              bersama `aside` desktop dan laci drawer, jadi menu akun langsung
              berlaku di keduanya; logout pindah ke dalam panel
              (`onLogout` = `handleSignOut).
              `roleSlot` menaruh lencana peran DI DALAM kolom nama
              ProfileMenu, jadi lencana berdiri sejajar dengan nama dan tak
              pernah melayang di baris sendiri. */}
          <div className={PROFILE_MENU_DARK_CLASS}>
            <ProfileMenu
              user={{
                name: displayName,
                role: 'SUPERADMIN',
                avatarUrl: user !== null ? (user.avatar_url ?? undefined) : undefined,
              }}
              onLogout={handleSignOut}
              settingsHref="/settings"
              alwaysShowName
              roleSlot={
                <Badge tone="danger" className="text-badge font-semibold">
                  SUPERADMIN
                </Badge>
              }
            />
          </div>
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
          {/* Slot 1 — aksi cepat: kosong (superadmin tanpa pintas aksi topbar).
              Filter cabang/fasilitas sengaja TIDAK di sini — halaman pemilik
              merendernya sendiri di filter bar agar tak ada kontrol ganda. */}
          <div className="ml-auto flex items-center gap-3">
            {/* Slot 3 — notifikasi: dropdown feed (bukan lompat ke /approvals).
                Badge lonceng bersumber dari `unread_count` notifikasi sendiri;
                `pendingCount` tetap menggerakkan badge `/approvals` di sidebar. */}
            <NotificationsMenu />
          </div>
        </header>

        {/* Topbar mobile / tablet (< 1024px) */}
        <header className="sticky top-0 z-30 flex h-bar-mobile items-center gap-2 border-b border-border-light bg-surface px-3 lg:hidden">
          {/* Tombol hamburger di urutan PERTAMA (paling kiri) agar searah
              dengan laci drawer yang meluncur dari kiri. Elemen polos 44px:
              atom `Button` membawa `px-4` yang tak bisa dipatah tanpa
              bentrok urutan utilitas padding Tailwind. */}
          <button
            type="button"
            aria-label="Buka menu navigasi"
            aria-expanded={drawerOpen}
            className="flex size-11 shrink-0 items-center justify-center rounded-control text-ink-secondary hover:bg-neutral-bg"
            onClick={() => setDrawerOpen(true)}
          >
            <Menu className="size-5" aria-hidden="true" />
          </button>
          {/* Lonceng notifikasi DI AKHIR bar (paling kanan) — aksi global
              aplikasi. Sebelumnya hanya ada di topbar desktop
              (`hidden ... lg:flex`) sehingga tak terjangkau sama sekali
              di HP; sekarang ada di kedua topbar. */}
          {/* Wordmark "THC VMS" DIHAPUS dari topbar mobile (permintaan
              pengguna). Lonceng digeser ke kanan dengan `ml-auto` karena
              span `flex-1` yang dulu menjadi pendorongnya sudah tidak ada. */}
          <NotificationsMenu className="ml-auto shrink-0" />
        </header>

        {/* Konten utama — min-w-0 (min-inline-size:0) menjamin tidak ada scroll
            horizontal; id+tabIndex menjadi sasan skip-to-content.
            Padding bawah menyisakan ruang BottomNav (56px + inset safe area
            iOS) — bar tumbuh sebesar `env(safe-area-inset-bottom)` jadi ruang
            kosong konten ikut tumbuh sama besar; `lg:pb-6` mengembalikan
            padding normal saat bar bawah disembunyikan. */}
        <main
          id="main-content"
          tabIndex={-1}
          className="min-w-0 overflow-x-clip p-6 pb-[calc(var(--spacing-bottomnav)_+_env(safe-area-inset-bottom))] lg:pb-6"
        >
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
