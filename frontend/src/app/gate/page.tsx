'use client'

import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { AdminBranchShell } from '@/components/layouts/AdminBranchShell'
import { KioskStatusStrip } from '@/components/layouts/KioskStatusStrip'
import { SecurityKioskShell, type KioskTabId } from '@/components/layouts/SecurityKioskShell'
import { SuperadminShell } from '@/components/layouts/SuperadminShell'
import { Button } from '@/components/ui/Button'
import { FilterResetButton } from '@/components/ui/FilterResetButton'
import { Input } from '@/components/ui/Input'
import { Pagination } from '@/components/ui/Pagination'
import { SearchInput } from '@/components/ui/SearchInput'
import { Select, type SelectOption } from '@/components/ui/Select'
import { RequireRole } from '@/lib/auth/guards'
import { useSession } from '@/lib/auth/session'
import { SEARCH_QUERY_MAX_LENGTH } from '@/lib/limits'
import {
  useCheckInVisitMutation,
  useCheckOutVisitMutation,
  usePendingApprovalCount,
  useVisitsQuery,
} from '@/lib/api/hooks'
import type {
  NotificationItem,
  Role,
  VisitDetail,
  VisitListParams,
  VisitOrder,
  VisitSortField,
  VisitStatus,
} from '@/lib/api/types'
import { DEFAULT_PAGE_SIZE } from '@/lib/pagination'
import { countOnSiteTechnicians, ON_SITE_COUNT_PARAMS } from '@/lib/visits/on-site-count'
import { isCheckinWindowOpen, mergeUpcomingQueue } from '@/lib/visits/upcoming-queue'
import { ScannerPanel, type ScanPhase } from '@/features/gate/ScannerPanel'
import { GateQueue } from '@/features/gate/GateQueue'
import { GuestSelectContext } from '@/features/gate/GuestCard'
import { ScanResultModal } from '@/features/gate/ScanResultModal'

/**
 * Peta tab gerbang -> status utama yang queried dari API.
 * Tab `upcoming` HANYA menyetor `approved` di sini; kunjungan `rescheduled`
 * (juga check-in-able) di-query terpisah lalu digabungkan client-side oleh
 * `mergeUpcomingQueue` — lihat `GateContent`.
 */
const TAB_STATUS: Record<KioskTabId, VisitStatus> = {
  upcoming: 'approved',
  'on-site': 'visiting',
  completed: 'completed',
}

const GATE_SEARCH_ID = 'thc-gate-visit-search'

/** Kombinasi filter antrean gerbang (pencarian + tanggal jadwal + urutan) — dipetakan ke query params `GET /visits`. */
export interface GateListFilter {
  q?: string
  dateFrom: string
  dateTo: string
  page: number
  pageSize: number
  sortBy: VisitSortField
  order: VisitOrder
}

export function toGateListParams(filter: GateListFilter, status: VisitStatus): VisitListParams {
  const params: VisitListParams = {
    status,
    page: filter.page,
    limit: filter.pageSize,
    sort_by: filter.sortBy,
    order: filter.order,
    ...(filter.q ? { q: filter.q } : {}),
    ...(filter.dateFrom !== '' ? { date_from: filter.dateFrom } : {}),
    ...(filter.dateTo !== '' ? { date_to: filter.dateTo } : {}),
  }
  return params
}

export const VISIT_SORT_OPTIONS: SelectOption[] = [
  { value: 'created_at:desc', label: 'Terbaru dibuat' },
  { value: 'created_at:asc', label: 'Terlama dibuat' },
  { value: 'start_date:asc', label: 'Jadwal mulai (terdekat)' },
  { value: 'start_date:desc', label: 'Jadwal mulai (terjauh)' },
  { value: 'end_date:desc', label: 'Jadwal selesai (terbaru)' },
  { value: 'end_date:asc', label: 'Jadwal selesai (terlama)' },
]

export function parseVisitSort(value: string): { sortBy: VisitSortField; order: VisitOrder } {
  const [field, direction] = value.split(':')
  return {
    sortBy: field === 'start_date' || field === 'end_date' ? field : 'created_at',
    order: direction === 'asc' ? 'asc' : 'desc',
  }
}

/**
 * SCR-05 - Security Gate / Site Check-in.
 *
 * PRD §4 + BE `GateOnly`: check-in/out boleh dieksekusi `security`, `admin`
 * (dual-role), DAN `super_admin` (bypass lintas cabang). `RequireRole` yang
 * menahan Vendor/Mitra, dan `security` tidak pernah melihat kontrol persetujuan.
 *
 * Shell mengikuti peran agar transisi dari dashboard tidak janggal: pengawas
 * tetap kios zero-sidebar (SHELL-03); admin/superadmin memakai shell
 * masing-masing dengan menu `Pos Check-in` aktif.
 */
export default function GatePage() {
  return (
    <RequireRole allow={['security', 'admin', 'super_admin']}>
      <GateContent />
    </RequireRole>
  )
}

/**
 * Isi gerbang dipisah agar hook data (useVisitsQuery) hanya jalan setelah
 * guard lolos — tidak menembak API saat sesi masih loading/unauthenticated.
 */
function GateContent() {
  const [tab, setTab] = useState<KioskTabId>('upcoming')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [sortBy, setSortBy] = useState<VisitSortField>('start_date')
  const [order, setSortOrder] = useState<VisitOrder>('asc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)
  const handlePageSizeChange = (next: number): void => { setPageSize(next); setPage(1) }
  // `searchInput` = nilai mentah dari field (responsif saat diketik);
  // `search` = nilai setelah debounce 300ms yang benar-benar dikirim ke `q`.
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [phase, setPhase] = useState<ScanPhase>({ phase: 'idle' })
  const [pendingVisitId, setPendingVisitId] = useState<string | null>(null)
  const [scanVisit, setScanVisit] = useState<VisitDetail | null>(null)
  const [scanOpen, setScanOpen] = useState(false)
  const [scanPending, setScanPending] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  // Dinaikkan tiap siklus pindai selesai (tutup modal / konfirmasi sukses)
  // untuk membuka kunci kamera ScannerPanel — lihat props `resetKey`.
  const [scanResetKey, setScanResetKey] = useState(0)
  const { user } = useSession()
  const role: Role | null = user !== null ? user.role : null

  const isUpcoming = tab === 'upcoming'

  // Filter/urutan/tab/pencarian berubah → kembali ke halaman 1 (baris halaman N
  // tidak relevan untuk kombinasi filter baru). Penyesuaian dilakukan saat
  // render mengikuti pola "adjusting state when a prop changes" React — sama
  // seperti halaman users & facilities — agar tidak memicu render berantai dan
  // `useVisitsQuery` tak pernah terpanggil dengan `page` basi.
  const filterSignature = JSON.stringify([tab, dateFrom, dateTo, sortBy, order, search])
  const [lastFilterSignature, setLastFilterSignature] = useState(filterSignature)
  if (lastFilterSignature !== filterSignature) {
    setLastFilterSignature(filterSignature)
    setPage(1)
  }

  // Debounce pencarian 300ms supaya setiap ketikan tidak memicu request —
  // pola identik halaman dashboard dan approvals.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  const filter: GateListFilter = { q: search, dateFrom, dateTo, page, pageSize, sortBy, order }
  const visitsQuery = useVisitsQuery(toGateListParams(filter, TAB_STATUS[tab]))
  // Tab "Akan Hadir" juga menampilkan kunjungan `rescheduled` (keduanya
  // check-in-able). Query kedua HANYA aktif di tab upcoming agar tab lain
  // tetap single-query; hasilnya digabung client-side oleh mergeUpcomingQueue.
  const rescheduledQuery = useVisitsQuery(
    toGateListParams(filter, 'rescheduled'),
    isUpcoming,
  )
  // Badge "X Teknisi On-Site": query KHUSUS (bukan query tab) supaya angka
  // teknisi di lokasi tetap tampil di tab mana pun. Hanya untuk role kios —
  // badge-nya hanya dirender di SecurityKioskShell.
  const onSiteQuery = useVisitsQuery(ON_SITE_COUNT_PARAMS, role === 'security')
  const onSiteCount = useMemo(
    () => countOnSiteTechnicians(onSiteQuery.data?.items ?? []),
    [onSiteQuery.data],
  )
  const checkIn = useCheckInVisitMutation()
  const checkOut = useCheckOutVisitMutation()
  // Badge antrean shell admin/superadmin (server-total, limit 1 — hanya total
  // yang dipakai): requested + rescheduled, keduanya menunggu keputusan.
  const { pendingCount } = usePendingApprovalCount()

  /**
   * Semantik gabungan (keputusan, terdokumentasi):
   * - `visits`: gabungan `approved` + `rescheduled` hanya di tab upcoming
   *   (dedupe by id, urut `start_date` ASC), lalu baris dengan jendela
   *   check-in sudah ditutup (`end_date + 2 jam <= now`) dibuang oleh
   *   `isCheckinWindowOpen`; tab lain tetap daftar utama apa adanya.
   * - Loading: menunggu query UTAMA ATAU query rescheduled (saat tab
   *   upcoming) — antrean baru dirender saat kedua daftar sudah settle.
   * - Error: HANYA dari query utama. Kegagalan query rescheduled tidak
   *   boleh mengosongkan daftar approved (items-nya jatuh ke `[]`, daftar
   *   tetap tampil) — jadi tidak pernah mem-blank antrean yang valid.
   * - Retry: refetch query utama, dan juga query rescheduled saat upcoming.
   */
  const visits = useMemo(() => {
    const primary = visitsQuery.data?.items ?? []
    if (!isUpcoming) return primary
    return mergeUpcomingQueue(primary, rescheduledQuery.data?.items ?? []).filter((visit) =>
      isCheckinWindowOpen(visit),
    )
  }, [isUpcoming, visitsQuery.data, rescheduledQuery.data])
  const queueLoading = visitsQuery.isPending || (isUpcoming && rescheduledQuery.isPending)
  const listTotal = visitsQuery.data?.total ?? 0
  const rescheduledTotal = isUpcoming ? (rescheduledQuery.data?.total ?? 0) : 0
  const total = listTotal + rescheduledTotal
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const rangeStart = total > 0 ? (page - 1) * pageSize + 1 : 0
  const rangeEnd = visits.length > 0 ? rangeStart + visits.length - 1 : 0

  /** Reset pencarian (clear affordance): kosongkan field dan nilai debounce. */
  function handleClearSearch(): void {
    setSearchInput('')
    setSearch('')
    document.getElementById(GATE_SEARCH_ID)?.focus()
  }

  /**
   * Reset SEMUA filter bar gerbang ke default: tab antrean, rentang tanggal
   * jadwal, urutan, pencarian (mentah + debounce), dan halaman paginasi.
   * Berbeda dari `handleClearSearch` yang HANYA mengosongkan field pencarian
   * (affordance terpisah di dalam SearchInput). Halaman ikut di-reset karena
   * baris halaman N tidak relevan untuk kombinasi filter default.
   */
  function handleResetFilters(): void {
    setTab('upcoming')
    setDateFrom('')
    setDateTo('')
    setSortBy('start_date')
    setSortOrder('asc')
    setSearchInput('')
    setSearch('')
    setPage(1)
  }

  // Tombol Reset Filter aktif hanya bila ada minimal satu filter yang
  // menyimpang dari default (nilai paginasi di luar default TIDAK dihitung —
  // paginasi bukan "filter", hanya efek samping dari filter lain).
  const isFiltered =
    searchInput !== '' ||
    search !== '' ||
    dateFrom !== '' ||
    dateTo !== '' ||
    sortBy !== 'start_date' ||
    order !== 'asc' ||
    tab !== 'upcoming'

  /**
   * Hasil pemindaian memuat kode QR mentah. Payload QR dari backend bersifat
   * opaque (bukan visit_id polos), jadi kita coba dulu dengan kode tersebut,
   * lalu fallback dengan visit_id.
   */
  async function handleScan(raw: string) {
    const code = raw.trim()
    if (code === '') return
    setPhase({ phase: 'processing' })

    try {
      const target = await resolveVisit(code)
      if (target === null) {
        setPhase({
          phase: 'feedback',
          tone: 'error',
          title: 'Tiket tidak ditemukan',
          message: `Kode "${code}" tidak terdaftar. Periksa kembali kode pada QR Code tamu.`,
        })
        return
      }
      if (target.status === 'approved' || target.status === 'visiting') {
        setScanVisit(target)
        setScanError(null)
        setScanOpen(true)
        setPhase({ phase: 'idle' })
        return
      }
      setPhase({
        phase: 'feedback',
        tone: 'error',
        title: 'Status tidak dapat diproses',
        message: `Status kunjungan ${target.visit_id} saat ini tidak dapat di-check-in/out.`,
      })
      return
    } catch (error) {
      setPhase({
        phase: 'feedback',
        tone: 'error',
        title: 'Gagal memproses tiket',
        message: error instanceof Error ? error.message : 'Terjadi kesalahan di pos jaga.',
      })
    }
  }

  /**
   * Klik Visit ID pada kartu antrean ATAU klik notifikasi kios pengawas: muat
   * ULANG data lewat `resolveVisit` (helper yang sama dengan alur pindai)
   * lalu buka `ScanResultModal`. Baris daftar / isi notifikasi bisa basi
   * (polling tertunda / status berubah), jadi konfirmasi tidak pernah
   * bertumpu pada data cache — identik dengan hasil scan. Galat muat ->
   * toast, tanpa navigasi.
   */
  async function openVisitModal(code: string, label: string): Promise<void> {
    // Naikkan resetKey seperti siklus pindai agar kunci kamera ScannerPanel
    // terlepas; siklus ditutup oleh handleScanClose/handleScanConfirm yang
    // sudah ada (tanpa perubahan perilaku scanner).
    setScanResetKey((key) => key + 1)
    const fresh = await resolveVisit(code)
    if (fresh === null) {
      toast.error(`Detail ${label} gagal dimuat. Coba lagi.`)
      return
    }
    setScanVisit(fresh)
    setScanError(null)
    setScanOpen(true)
  }

  async function handleSelectVisit(visit: VisitDetail) {
    await openVisitModal(visit.visit_id, visit.visit_id)
  }

  async function handleNotificationSelect(item: NotificationItem) {
    await openVisitModal(item.visit_request_id, item.visit_id || item.visit_request_id)
  }

  async function handleCheckIn(visit: VisitDetail) {
    setPendingVisitId(visit.id)
    try {
      await checkIn.mutateAsync({ visitId: visit.id })
      toast.success(`${visit.visit_id} berhasil Check-in MASUK.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Check-in gagal.')
    } finally {
      setPendingVisitId(null)
    }
  }

  async function handleCheckOut(visit: VisitDetail) {
    setPendingVisitId(visit.id)
    try {
      await checkOut.mutateAsync({ visitId: visit.id })
      toast.success(`${visit.visit_id} berhasil Check-out KELUAR.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Check-out gagal.')
    } finally {
      setPendingVisitId(null)
    }
  }

  /**
   * Konfirmasi check-in/out dari modal hasil pindai. Modal HANYA ditutup
   * setelah mutasi selesai sukses; kegagalan mempertahankan modal terbuka
   * dan menampilkan galat di dalamnya (`scanError`) agar petugas bisa
   * membaca penyebab tanpa kehilangan konteks hasil pindaian.
   */
  async function handleScanConfirm() {
    if (scanVisit === null || scanPending) return
    setScanPending(true)
    setScanError(null)
    try {
      if (scanVisit.status === 'approved') {
        await checkIn.mutateAsync({ visitId: scanVisit.id })
        toast.success(`${scanVisit.visit_id} berhasil Check-in MASUK.`)
      } else if (scanVisit.status === 'visiting') {
        await checkOut.mutateAsync({ visitId: scanVisit.id })
        toast.success(`${scanVisit.visit_id} berhasil Check-out KELUAR.`)
      }
      setScanOpen(false)
      setScanVisit(null)
      setScanError(null)
      // Siklus sukses: buka kunci panel pemindai agar QR yang sama bisa
      // langsung dipakai check-out (atau QR berikutnya) tanpa refresh.
      setScanResetKey((key) => key + 1)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Proses gerbang gagal.'
      setScanError(message)
      toast.error(message)
    } finally {
      setScanPending(false)
    }
  }

  function handleScanClose() {
    if (scanPending) return
    setScanOpen(false)
    setScanVisit(null)
    setScanError(null)
    // Menutup modal juga mengakhiri siklus — lepas kunci kamera agar
    // pemindaian berikutnya tidak tertelan sampai halaman di-refresh.
    setScanResetKey((key) => key + 1)
  }

  // Jumlah teknisi on-site dihitung dari query badge (lihat ON_SITE_COUNT_PARAMS),
  // bukan dari query tab — supaya navbar kios selalu bicara dengan angka yang
  // sama apa pun tab yang aktif.
  const gateContent = (
    <div className="flex flex-col gap-4 lg:flex-row">
      <div className="min-w-0 lg:w-[42%]">
        <ScannerPanel
          phase={phase}
          onScan={handleScan}
          onReset={() => setPhase({ phase: 'idle' })}
          resetKey={scanResetKey}
        />
      </div>
      <div className="min-w-0 lg:w-[58%]">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold text-ink">Antrean Kunjungan</h2>
          {visits.length > 0 ? (
            <p className="text-label tabular-nums text-ink-secondary">
              Menampilkan {rangeStart}–{rangeEnd} dari {total} kunjungan
            </p>
          ) : null}
        </div>
        <div className="card mb-4 flex flex-wrap items-end gap-3 border-brand/20 bg-brand-soft/40 p-4">
          <div className="relative min-w-48 flex-1 sm:w-64 sm:flex-none">
            <SearchInput
              id={GATE_SEARCH_ID}
              aria-label="Cari kunjungan"
              placeholder="Cari Visit ID atau Vendor/Mitra…"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              maxLength={SEARCH_QUERY_MAX_LENGTH}
              fieldSize="gate"
              className={searchInput !== '' ? 'pr-12' : ''}
            />
            {searchInput !== '' ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="absolute right-2 top-1/2 -translate-y-1/2"
                onClick={handleClearSearch}
                aria-label="Hapus pencarian"
              >
                <X className="size-4 shrink-0" aria-hidden="true" />
              </Button>
            ) : null}
          </div>
          <div className="min-w-36 flex-1 sm:w-44 sm:flex-none">
            <Input
              label="Dari Tanggal"
              type="date"
              fieldSize="gate"
              value={dateFrom}
              max={dateTo === '' ? undefined : dateTo}
              onChange={(event) => setDateFrom(event.target.value)}
            />
          </div>
          <div className="min-w-36 flex-1 sm:w-44 sm:flex-none">
            <Input
              label="Sampai Tanggal"
              type="date"
              fieldSize="gate"
              value={dateTo}
              min={dateFrom === '' ? undefined : dateFrom}
              onChange={(event) => setDateTo(event.target.value)}
            />
          </div>
          <div className="min-w-44 flex-1 sm:w-52 sm:flex-none">
            <Select
              label="Urutkan"
              fieldSize="gate"
              options={VISIT_SORT_OPTIONS}
              value={`${sortBy}:${order}`}
              onChange={(event) => {
                const next = parseVisitSort(event.target.value)
                setSortBy(next.sortBy)
                setSortOrder(next.order)
              }}
            />
          </div>
          <FilterResetButton onReset={handleResetFilters} disabled={!isFiltered} />
        </div>
        {/* Konteks pengganti prop-drilling: GateQueue tidak diubah, tetapi
            GuestCard tetap menerima handler klik kartu untuk popup detail. */}
        <GuestSelectContext.Provider value={handleSelectVisit}>
          <GateQueue
            tab={tab}
            visits={visits}
            isLoading={queueLoading}
            isError={visitsQuery.isError}
            onRetry={() => {
              void visitsQuery.refetch()
              if (isUpcoming) void rescheduledQuery.refetch()
            }}
            pendingVisitId={pendingVisitId}
            onCheckIn={(visit) => void handleCheckIn(visit)}
            onCheckOut={(visit) => void handleCheckOut(visit)}
          />
        </GuestSelectContext.Provider>
        {visits.length > 0 ? (
          <Pagination
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
            pageSize={pageSize}
            onPageSizeChange={handlePageSizeChange}
            className="mt-4"
          />
        ) : null}
      </div>
      <ScanResultModal
        visit={scanVisit}
        open={scanOpen}
        pending={scanPending}
        error={scanError}
        onClose={handleScanClose}
        onConfirm={() => void handleScanConfirm()}
      />
    </div>
  )

  // Shell mengikuti peran: pengawas tetap kios zero-sidebar; admin/superadmin
  // memakai shell masing-masing agar transisi dari dashboard tidak janggal.
  if (role === 'admin') {
    return (
      <AdminBranchShell activeHref="/gate" pendingCount={pendingCount}>
        {gateContent}
      </AdminBranchShell>
    )
  }
  if (role === 'super_admin') {
    return (
      <SuperadminShell activeHref="/gate" pendingCount={pendingCount}>
        {gateContent}
      </SuperadminShell>
    )
  }
  return (
    <SecurityKioskShell
      activeTab={tab}
      onTabChange={(id) => setTab(id as KioskTabId)}
      onSiteCount={onSiteCount}
      onNotificationSelect={handleNotificationSelect}
    >
      {/* Pita identitas ponsel: nama pengawas + shift dengan badge lokasi
          tepat di bawahnya. Badge lokasi tidak lagi di navbar ponsel (di
          320px ia terpangkas), sementara jam + counter on-site hidup di
          kolom tengah navbar. Pita ini HANYA memuat identitas petugas +
          lokasi. Hanya di /gate: shell kios juga dipakai
          /visits/[id] yang tidak butuh pita ini. */}
      <KioskStatusStrip
        className="mb-3"
        guardName={user?.name ?? 'Petugas Jaga'}
        locationName={user?.location_name ?? 'Lokasi Terkunci'}
      />
      {gateContent}
    </SecurityKioskShell>
  )
}

/**
 * Terjemahkan kode hasil pindai menjadi satu kunjungan.
 *
 * `getVisit` menerima UUID maupun kode `VST-...`, dan backend menolak
 * apa pun di luar cakupan cabang petugas (403) - jadi tidak ada
 * kebocoran data antar cabang lewat scanner ini.
 */
async function resolveVisit(code: string): Promise<VisitDetail | null> {
  try {
    const { getVisit } = await import('@/lib/api/client')
    return await getVisit(code)
  } catch {
    return null
  }
}
