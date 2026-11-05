'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle,
  Bell,
  Check,
  CircleX,
  ClipboardList,
  LogIn,
  LogOut,
  RotateCcw,
  UserPlus,
  X,
  type LucideIcon,
} from 'lucide-react'

import { Button } from '@/components/ui/Button'
import {
  useMarkAllNotificationsReadMutation,
  useMarkNotificationReadMutation,
  useNotificationsFeed,
  usePendingRegistrationCount,
  usePendingRegistrationsFeed,
  useUnreadNotificationCount,
} from '@/lib/api/hooks'
import type { NotificationItem, NotificationType } from '@/lib/api/types'
import { isSuperAdminRole } from '@/lib/auth/capabilities'
import { useSession } from '@/lib/auth/session'

export interface NotificationsMenuProps {
  /**
   * Nada pemicu mengikuti permukaan shell-nya:
   * - `'light'` (default) — topbar terang SHELL-01/02.
   * - `'dark'` — topbar kios gelap SHELL-03, ikon perlu kontras terang.
   * - `'brand'` — navbar biru SHELL-04 (vendor), ikon perlu kontras terang.
   *
   * Nada `brand` memakai modifier `!` (important): varian `ghost` atom
   * `Button` sudah membawa `text-ink-secondary` + `hover:bg-neutral-bg`, dan
   * di Tailwind v4 yang menentukan pemenang adalah URUTAN STYLESHEET
   * (utility theme key), bukan urutan atribut `class`. Tanpa `!` lonceng
   * tampil abu-abu #52525b di atas navbar biru #422ad5 = 1.09:1 (gagal AA),
   * sedangkan #e0e7ff mencapai 6.74:1. Jangan buang `!` tanpa menguji
   * warna lonceng di permukaan biru.
   */
  tone?: 'light' | 'dark' | 'brand'
  /** Kelas tambahan pada pembungkus relatif (mis. `shrink-0` saat flex). */
  className?: string
  /**
   * Intercceptor pemilihan notifikasi. Bila disediakan, memilih baris tetap
   * menandai dibaca + menutup panel, lalu memanggil callback ini SEBALIKNYA
   * navigasi deep-link — dipakai kios pengawas `/gate` untuk membuka modal
   * detail kunjungan di tempat. Tanpa prop ini, perilaku navigasi ke
   * `/visits/{visit_request_id}` dipertahankan persis seperti sediakala
   * (admin / super_admin / vendor TIDAK meneruskannya).
   */
  onSelect?: (item: NotificationItem) => void
}

/** Lonceng selalu mengarahkan badge angka ke kanan-atas ikon. */
const COUNT_MAX = 99

const PANEL_CLASS =
  'absolute right-0 top-full z-40 mt-1 w-80 max-w-[calc(100vw-2rem)] rounded-card border border-border-mid bg-surface p-1 shadow-dropdown'

const ITEM_CLASS =
  'flex w-full items-start gap-3 rounded-control px-3 py-2 text-left transition cursor-pointer'

/**
 * Baris belum dibaca: wash tint lembut + ikon brand (bukan garis aksen samping).
 * State tekan satu langkah lebih pekat dari wash unread (kontrak tekan ada di
 * `Button.tsx`).
 */
const ITEM_UNREAD_CLASS = 'bg-brand-soft/60 active:bg-brand/20'
const ITEM_READ_CLASS = 'hover:bg-neutral-bg active:bg-ink/10'

/**
 * Ikon tipe pada topbar gelap perlu tinta terang, bukanabu netral.
 *
 * State tekan mengikuti nada yang sama: `light`/`dark` memakai lapisan tinta
 * yang lebih pekat dari wash hover-nya, `brand` memakai `!` karena `hover:`
 * pada nada ini sudah ber-`!important` (lihat catatan `tone` di atas).
 */
const TRIGGER_TONE_CLASS = {
  light: 'text-ink-secondary hover:bg-neutral-bg active:bg-ink/10',
  dark: 'text-brand-contrast hover:bg-sidebar-dark-active active:bg-sidebar-dark',
  brand: 'text-brand-contrast! hover:bg-brand-dark! active:bg-ink/25!',
} as const

/**
 * Sembilan jenis notifikasi tersimpan (kontrak openapi `Notification.type`).
 * `Record<NotificationType, …>` membuat jenis baru di backend gagal compile di
 * sini sampai ikonnya di peta di sini juga — tidak ada fallback senyap.
 */
const TYPE_META: Record<NotificationType, { Icon: LucideIcon }> = {
  visit_requested: { Icon: ClipboardList },
  visit_rescheduled: { Icon: RotateCcw },
  visit_check_in: { Icon: LogIn },
  visit_check_out: { Icon: LogOut },
  visit_approved: { Icon: Check },
  visit_rejected: { Icon: X },
  visit_reminder: { Icon: Bell },
  visit_auto_cancelled: { Icon: AlertTriangle },
  visit_cancelled: { Icon: CircleX },
}

/** Waktu relatif ringkas ala Indonesia; jatuh ke tanggal absolut bila > 30 hari. */
function formatOccurredAt(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const minutes = Math.round((Date.now() - then) / 60_000)
  if (minutes < 1) return 'Baru saja'
  if (minutes < 60) return `${minutes} menit lalu`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} jam lalu`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} hari lalu`
  return new Date(iso).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })
}

/** Badge angka tidak boleh melebar tanpa batas: 100+ tampil `99+`. */
function formatUnreadBadge(count: number): string {
  return count > COUNT_MAX ? `${COUNT_MAX}+` : String(count)
}

/**
 * Deep-link selalu mendarat di detail kunjungan `/visits/{visit_request_id}`
 * untuk SEMUA jenis peristiwa. Halaman detail menyediakan kontrol
 * approve/reject/reschedule bagi peran berwenang, sehingga admin tetap bisa
 * bertindak tanpa perlu mampir ke antrean `/approvals`.
 */
function targetHref(item: NotificationItem): string {
  return `/visits/${item.visit_request_id}`
}

interface PanelRowProps {
  Icon: LucideIcon
  /** Wash + ikon brand untuk baris butuh perhatian (unread / menunggu verifikasi). */
  emphasized: boolean
  title: string
  description: ReactNode
  meta: ReactNode
  statusLabel?: string
  onSelect: () => void
}

/** Baris daftar tunggal untuk kedua feed — kelas & token identik dengan baris notifikasi lama. */
function PanelRow({
  Icon,
  emphasized,
  title,
  description,
  meta,
  statusLabel,
  onSelect,
}: PanelRowProps) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={`${ITEM_CLASS} ${emphasized ? ITEM_UNREAD_CLASS : ITEM_READ_CLASS}`}
    >
      <span
        aria-hidden="true"
        className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-badge ${
          emphasized ? 'bg-brand text-brand-contrast' : 'bg-neutral-bg text-ink-muted'
        }`}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-ink">{title}</span>
        <span className="block break-words text-xs text-ink-secondary">{description}</span>
        <span className="mt-0.5 flex items-center gap-2 text-badge text-ink-muted">{meta}</span>
        {statusLabel ? (
          <span className="mt-1 inline-flex items-center gap-1 rounded-badge bg-brand-soft px-1.5 py-0.5 text-badge font-semibold text-brand-dark">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-brand" />
            {statusLabel}
          </span>
        ) : null}
      </span>
    </button>
  )
}

/**
 * Dropdown notifikasi untuk lonceng header (SHELL-01/02/03/04). Memakai ulang pola
 * interaksi `ProfileMenu` (klik-luar + Escape + refocus pemicu) tanpa
 * dependensi baru. Panel menampilkan notifikasi TERSIMPAN milik pemanggil
 * (semua peran termasuk vendor) dengan state belum-dibaca; badge lonceng
 * diambil dari `unread_count` lewat query terpisah ber-`limit: 1` supaya
 * angka tetap hidup meski feed belum pernah dibuka.
 */
export function NotificationsMenu({ tone = 'light', className, onSelect }: NotificationsMenuProps) {
  const router = useRouter()
  const { user } = useSession()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const generatedId = useId()
  const buttonId = `${generatedId}-button`
  const menuId = `${generatedId}-menu`

  // Baris pendaftaran vendor hanya untuk superadmin (hook mengunci peran:
  // role lain tidak pernah menembak API pending-registrations).
  const isSuperAdmin = user !== null && isSuperAdminRole(user.role)

  // Feed progresif hanya saat panel terbuka: halaman 1 dulu, halaman
  // berikutnya lewat "Muat lebih banyak" — tidak ada polling latar tertutup.
  const {
    data,
    isPending,
    isError,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useNotificationsFeed(open)
  // Badge harus tampil sebelum panel dibuka — query ringan yang selalu aktif.
  const unreadCount = useUnreadNotificationCount()
  // Pendaftaran menunggu: selalu ter-mount, hanya menyala untuk superadmin.
  const pendingCount = usePendingRegistrationCount()
  // Entri pendaftaran (dipin di atas daftar): hanya diambil saat panel terbuka
  // (superadmin saja).
  const pendingFeed = usePendingRegistrationsFeed(open)

  const markRead = useMarkNotificationReadMutation()
  const markAllRead = useMarkAllNotificationsReadMutation()

  const items = data?.pages.flatMap((page) => page.items) ?? []
  // `total` + `unread_count` diambil dari halaman pertama (nilai agregat server).
  const firstPage = data?.pages[0]
  const total = firstPage?.total ?? 0
  const unreadInFeed = firstPage?.unread_count ?? 0
  const pendingItems = pendingFeed.data?.items ?? []
  const hasUnread = unreadCount > 0
  // Badge lonceng superadmin = unread + pendaftaran menunggu (99+ tetap).
  const badgeCount = unreadCount + pendingCount
  const hasBadge = badgeCount > 0
  // Treatment daftar tunggal: muat/galat menyangkut seluruh panel, keadaan
  // kosong hanya bila KEDUA feed habis (tanpa pesan per-feed terpisah).
  const showPendingBadge = isSuperAdmin && pendingCount > 0
  const isPanelLoading = isPending || (isSuperAdmin && pendingFeed.isPending)
  const isPanelError = isError || (isSuperAdmin && pendingFeed.isError)
  const isPanelEmpty = items.length === 0 && pendingItems.length === 0

  useEffect(() => {
    if (!open) return

    function handlePointerDown(event: PointerEvent) {
      const target = event.target
      if (target instanceof Node && !containerRef.current?.contains(target)) {
        setOpen(false)
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      setOpen(false)
      containerRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const handleSelect = (item: NotificationItem): void => {
    if (!item.is_read) {
      void markRead.mutate(item.id)
    }
    setOpen(false)
    if (onSelect) {
      onSelect(item)
      return
    }
    router.push(targetHref(item))
  }

  // Pendaftaran menunggu tidak punya estado "dibaca": baris hanya menutup
  // panel lalu membuka antrean pengelolaan penuh; resolve lewat approve/reject.
  const handlePendingSelect = (): void => {
    setOpen(false)
    router.push('/vendor-registrations')
  }

  const handleMarkAllRead = (): void => {
    void markAllRead.mutate()
  }

  return (
    <div ref={containerRef} className={['relative', className ?? ''].filter(Boolean).join(' ')}>
      <Button
        id={buttonId}
        variant="ghost"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={hasBadge ? `Notifikasi, ${badgeCount} belum dibaca` : 'Notifikasi'}
        className={`relative shrink-0 ${TRIGGER_TONE_CLASS[tone]}`}
        onClick={() => setOpen((previous) => !previous)}
      >
        <Bell className="size-5" aria-hidden="true" />
        {hasBadge ? (
          /* Latar magenta `bg-secondary` (#f43098) tetap dipertahankan;
             angka memakai `text-ink` (#18181b) = 4.83:1 (WCAG AA untuk
             teks kecil 11px bold). `text-secondary-contrast` (#ffffff)
             hanya 3.67:1 — gagal AA. */
          <span
            aria-hidden="true"
            data-testid="notifications-unread-badge"
            className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-badge bg-secondary px-1 text-badge font-bold leading-none tabular-nums text-ink"
          >
            {formatUnreadBadge(badgeCount)}
          </span>
        ) : null}
      </Button>

      {open ? (
        <div id={menuId} role="menu" aria-labelledby={buttonId} className={PANEL_CLASS}>
          <div className="flex items-center justify-between gap-2 border-b border-border-mid px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">Notifikasi</p>
              {unreadInFeed > 0 ? (
                <p className="text-badge text-ink-muted">{unreadInFeed} belum dibaca</p>
              ) : null}
              {showPendingBadge ? (
                <p className="mt-0.5 flex items-center gap-1.5 text-badge text-ink-muted">
                  <span
                    data-testid="pending-registrations-badge"
                    className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-badge bg-secondary px-1 text-badge font-bold leading-none tabular-nums text-ink"
                  >
                    {formatUnreadBadge(pendingCount)}
                  </span>
                  <span>perlu tindakan</span>
                </p>
              ) : null}
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={markAllRead.isPending || !hasUnread}
              onClick={handleMarkAllRead}
              aria-label="Tandai semua dibaca"
            >
              Tandai semua dibaca
            </Button>
          </div>
          <div className="flex max-h-96 flex-col gap-1 overflow-y-auto px-1 py-1">
            {isSuperAdmin ? (
              <div
                data-testid="pending-registrations-section"
                className={pendingItems.length > 0 ? 'flex flex-col gap-1' : 'hidden'}
              >
                {pendingItems.map((item) => (
                  <PanelRow
                    key={item.vendor_user_id}
                    Icon={UserPlus}
                    emphasized
                    title="Pendaftaran vendor baru"
                    description={
                      <>
                        <span>{item.name}</span> • <span>{item.vendor_name}</span> menunggu
                        verifikasi.
                      </>
                    }
                    meta={
                      <span className="truncate">mendaftar {formatOccurredAt(item.created_at)}</span>
                    }
                    statusLabel="Perlu tindakan"
                    onSelect={handlePendingSelect}
                  />
                ))}
              </div>
            ) : null}
            {isPanelLoading ? (
              <p className="px-3 py-6 text-center text-sm text-ink-muted">Memuat notifikasi…</p>
            ) : isPanelError ? (
              <p className="px-3 py-6 text-center text-sm text-ink-muted">Gagal memuat notifikasi.</p>
            ) : isPanelEmpty ? (
              <p className="px-3 py-6 text-center text-sm text-ink-muted">Tidak ada notifikasi.</p>
            ) : (
              items.map((item) => {
                const { Icon } = TYPE_META[item.type]
                return (
                  <PanelRow
                    key={item.id}
                    Icon={Icon}
                    emphasized={!item.is_read}
                    title={item.title}
                    description={item.message}
                    meta={
                      <>
                        <span className="truncate">{item.location_name}</span>
                        <span aria-hidden="true">·</span>
                        <span className="shrink-0">{formatOccurredAt(item.occurred_at)}</span>
                      </>
                    }
                    statusLabel={item.is_read ? undefined : 'Belum dibaca'}
                    onSelect={() => handleSelect(item)}
                  />
                )
              })
            )}
            {items.length > 0 ? (
              <div className="px-3 pb-2 pt-1">
                {hasNextPage ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    fullWidth
                    disabled={isFetchingNextPage}
                    onClick={() => void fetchNextPage()}
                  >
                    {isFetchingNextPage ? 'Memuat…' : 'Muat lebih banyak'}
                  </Button>
                ) : null}
                <p className="mt-1 text-center text-badge text-ink-muted">
                  Menampilkan {items.length} dari {total} notifikasi
                </p>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}