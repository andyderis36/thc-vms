'use client'

import { Suspense, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Clock,
  Inbox,
  MapPin,
  Plus,
} from 'lucide-react'
import { AdminBranchShell } from '@/components/layouts/AdminBranchShell'
import { VendorMobileShell } from '@/components/layouts/VendorMobileShell'
import { SuperadminShell } from '@/components/layouts/SuperadminShell'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { FilterResetButton } from '@/components/ui/FilterResetButton'
import { Pagination } from '@/components/ui/Pagination'
import { Input } from '@/components/ui/Input'
import { SearchInput } from '@/components/ui/SearchInput'
import { Select, type SelectOption } from '@/components/ui/Select'
import { Spinner } from '@/components/ui/Spinner'
import { Tabs, type TabItem } from '@/components/ui/Tabs'
import { VendorIdentityCard } from '@/features/dashboard/components/VendorIdentityCard'
import { ApproveModal, apiErrorMessage } from '@/features/visits/components/ApproveModal'
import { RejectModal } from '@/features/visits/components/RejectModal'
import { VisitCards } from '@/features/visits/components/VisitCards'
import { VisitTable } from '@/features/visits/components/VisitTable'
import { useLocationsQuery, usePendingApprovalCount, useVisitsQuery } from '@/lib/api/hooks'
import type { VisitDetail, VisitListParams, VisitOrder, VisitSortField, VisitStatus } from '@/lib/api/types'
import { can } from '@/lib/auth/capabilities'
import { RequireAuth } from '@/lib/auth/guards'
import { useSession } from '@/lib/auth/session'
import { SEARCH_QUERY_MAX_LENGTH } from '@/lib/limits'
import { DEFAULT_PAGE_SIZE } from '@/lib/pagination'
import { VISIT_STATUS_META } from '@/lib/visits/status-badge'
import { mergeUpcomingQueue } from '@/lib/visits/upcoming-queue'

/** Kombinasi filter SCR-02 yang dipetakan ke query params `GET /visits`. */
export interface VisitListFilter {
  facilityId: string
  q: string
  dateFrom: string
  dateTo: string
  page: number
  sortBy: VisitSortField
  order: VisitOrder
  pageSize: number
}

function visitCoreParams(filter: VisitListFilter): VisitListParams {
  return {
    ...(filter.facilityId !== 'all' ? { location_id: filter.facilityId } : {}),
    ...(filter.q !== '' ? { q: filter.q } : {}),
    ...(filter.dateFrom !== '' ? { date_from: filter.dateFrom } : {}),
    ...(filter.dateTo !== '' ? { date_to: filter.dateTo } : {}),
  }
}

export function toVisitListParams(filter: VisitListFilter, status?: VisitStatus): VisitListParams {
  const params: VisitListParams = {
    ...visitCoreParams(filter),
    ...(status !== undefined ? { status } : {}),
    page: filter.page,
    limit: filter.pageSize,
    sort_by: filter.sortBy,
    order: filter.order,
  }
  return params
}

/** Params metrik kartu/tab: hanya `total` server yang dipakai (`limit:1`), tanpa `page`/`sort`. */
export function toVisitMetricsParams(filter: VisitListFilter, status?: VisitStatus): VisitListParams {
  const params: VisitListParams = {
    ...visitCoreParams(filter),
    ...(status !== undefined ? { status } : {}),
    limit: 1,
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
 * SCR-02 — Dashboard Kunjungan & Antrean.
 *
 * Halaman ini SENGAJA tanpa SessionProvider/Providers sendiri: satu-satunya
 * SessionProvider + QueryClient + Toaster adalah milik root layout
 * (`MswProvider > Providers > SessionProvider`), sehingga `useSession` dan
 * `useQuery` memakai konteks root dan navigasi dashboard↔gate tidak blank/loop.
 *
 * Dua kunci query disengaja:
 * 1. Tanpa `status` → metrik 4 kartu dan hitung tab (tidak berubah saat
 *    pengguna ganti tab); `pendingCount` sendiri kini dari
 *    usePendingApprovalCount — total server, konsisten dengan halaman lain.
 * 2. Dengan `status` → baris tabel/kartu. Saat `status` undefined, kedua
 *    objek params identik sehingga cache React Query menyatukannya.
 *
 * Kunci ketiga (opsional): tab "Menunggu Approval" (`status: requested`)
 * juga menampilkan kunjungan `rescheduled` — keduanya menunggu keputusan —
 * digabung client-side oleh `mergeUpcomingQueue`. Query-nya hanya aktif di
 * tab tersebut (pola sama dengan antrean "Akan Hadir" gerbang).
 */
export default function DashboardPage() {
  // Tanpa provider ganda: pakai SessionProvider + QueryClient + Toaster milik root layout.
  // Suspense wajib: DashboardScreen memakai useSearchParams (?focus= dari menu sidebar),
  // dan Next menolak prerender halaman tanpa batas Suspense.
  return (
    <RequireAuth>
      <Suspense
        fallback={
          <div className="flex min-h-[40vh] items-center justify-center">
            <Spinner size="lg" label="Memuat dashboard…" />
          </div>
        }
      >
        <DashboardScreen />
      </Suspense>
    </RequireAuth>
  )
}

function DashboardScreen() {
  const { user } = useSession()
  const router = useRouter()

  // Filter fasilitas bersatu: sentinel 'all' berarti semua cabang/POP.
  // DIKENDALIKAN select "Fasilitas" di filter bar bawah — satu-satunya
  // kontrol cabang di layar ini (topbar shell tak lagi punya switcher).
  // ATURAN default diekstrak menjadi satu konstanta → dipakai useState (nilai
  // awal), handleResetFilters, DAN isFiltered, sehingga ketiganya mustahil
  // menyimpang satu sama lain. (RequireAuth hanya me-mount layar ini saat sesi
  // sudah ter-autentikasi, jadi `user` sudah terisi pada render pertama.)
  const defaultFacilityFilter =
    user !== null && user.role !== 'super_admin' && user.role !== 'vendor'
      ? (user.location_id ?? 'all')
      : 'all'
  const [facilityFilter, setFacilityFilter] = useState<string>(defaultFacilityFilter)
  // Satu state status dipakai BERSAMAAN oleh Tabs dan Select status.
  const [statusFilter, setStatusFilter] = useState<VisitStatus | undefined>(undefined)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [sortBy, setSortBy] = useState<VisitSortField>('created_at')
  const [order, setSortOrder] = useState<VisitOrder>('desc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)
  const handlePageSizeChange = (next: number): void => { setPageSize(next); setPage(1) }
  const [approveTarget, setApproveTarget] = useState<VisitDetail | null>(null)
  const [rejectTarget, setRejectTarget] = useState<VisitDetail | null>(null)

  // Deep-link menu sidebar (?focus=): Tab "Menunggu Approval" untuk
  // approvals. Berjalan SETIAP fokus berubah (bukan sekali saat mount)
  // supaya klik menu saat sudah di dashboard tetap beralih — navigasi SPA
  // tidak me-remount halaman. URL tanpa focus tidak mereset pilihan
  // pengguna yang sedang aktif.
  const focus = useSearchParams().get('focus')
  // `lastFocus` sengaja diinisialisasi `null`, bukan `focus`: dengan begitu
  // blok tetap berjalan saat mount (menutup `?focus=approvals`) sekaligus tiap
  // kali focus berubah. Penyesuaian saat render mengikuti pola "adjusting state
  // when a prop changes" React, bukan effect, agar tak memicu render berantai.
  const [lastFocus, setLastFocus] = useState<string | null>(null)
  if (lastFocus !== focus) {
    setLastFocus(focus)
    if (focus === 'approvals') {
      setStatusFilter('requested')
    }
  }

  // Debounce pencarian 300ms supaya setiap ketikan tidak memicu request.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  // Filter/urutan berubah → kembali ke halaman 1 (baris halaman N tidak
  // relevan untuk kombinasi filter baru). Penyesuaian saat render mengikuti
  // pola "adjusting state when a prop changes" React, bukan effect, agar tak
  // memicu render berantai.
  const filterSignature = JSON.stringify([
    facilityFilter,
    statusFilter,
    search,
    dateFrom,
    dateTo,
    sortBy,
    order,
  ])
  const [lastFilterSignature, setLastFilterSignature] = useState(filterSignature)
  if (lastFilterSignature !== filterSignature) {
    setLastFilterSignature(filterSignature)
    setPage(1)
  }

  // Status "ada filter aktif" untuk `disabled` tombol Reset Filter — HANYA
  // kontrol bar filter yang dihitung; paginasi (page/pageSize) bukan filter
  // dan punya kontrolnya sendiri, jadi tidak menyalakan tombol ini.
  const isFiltered =
    facilityFilter !== defaultFacilityFilter ||
    statusFilter !== undefined ||
    searchInput !== '' ||
    search !== '' ||
    dateFrom !== '' ||
    dateTo !== '' ||
    sortBy !== 'created_at' ||
    order !== 'desc'

  // Reset Filter: kembalikan SEMUA state bar + paginasi ke nilai defaultnya.
  // - `searchInput` (draft) dan `search` (debounced 300ms) direset BERSAMAAN
  //   agar sisa ketikan tidak "hidup lagi" lewat effect debounce.
  // - KONSISTENSI TAB: `statusFilter` adalah SATU-satunya sumber kebenaran
  //   bagi Tabs (lihat `tabValue` yang diturunkan darinya) MAUPUN Select
  //   "Status" — tidak ada state tab terpisah. Mereset ke `undefined` otomatis
  //   mematikan sorotan tab (kembali "Semua Kunjungan") dan Select (kembali
  //   "Semua Status") sekaligus, sehingga keduanya mustahil bertentangan.
  // - Paginasi ikut reset (page 1, ukuran halaman default) karena baris
  //   halaman N tidak relevan untuk kombinasi filter yang sudah bersih.
  const handleResetFilters = (): void => {
    setFacilityFilter(defaultFacilityFilter)
    setStatusFilter(undefined)
    setSearchInput('')
    setSearch('')
    setDateFrom('')
    setDateTo('')
    setSortBy('created_at')
    setSortOrder('desc')
    setPage(1)
    setPageSize(DEFAULT_PAGE_SIZE)
  }

  const locationsQuery = useLocationsQuery()

  const filter: VisitListFilter = {
    facilityId: facilityFilter,
    q: search,
    dateFrom,
    dateTo,
    page,
    sortBy,
    order,
    pageSize,
  }

  // Metrik kartu + tab: total SERVER per status (`limit:1` — hanya `total`
  // yang dipakai), tanpa paginasi/urutan supaya kunci tidak ikut berubah
  // saat user ganti halaman atau sortir.
  const totalCountQuery = useVisitsQuery(toVisitMetricsParams(filter))
  const visitingQuery = useVisitsQuery(toVisitMetricsParams(filter, 'visiting'))
  const completedQuery = useVisitsQuery(toVisitMetricsParams(filter, 'completed'))
  const listQuery = useVisitsQuery(toVisitListParams(filter, statusFilter))
  // Tab "Menunggu Approval" (status requested) juga menampilkan kunjungan
  // `rescheduled` — keduanya menunggu keputusan admin. Query kedua HANYA
  // aktif di tab tersebut agar tab lain tetap single-query; hasilnya digabung
  // client-side oleh mergeUpcomingQueue (dedupe by id, urut kronologis) —
  // persis pola antrean "Akan Hadir" gerbang.
  const menungguRescheduledQuery = useVisitsQuery(
    toVisitListParams(filter, 'rescheduled'),
    statusFilter === 'requested',
  )
  // `pendingCount` mencakup `requested` + `rescheduled` (keduanya menunggu
  // keputusan) → tab, kartu metrik, dan badge shell selalu satu angka;
  // sumbernya total server (usePendingApprovalCount), konsisten dengan badge
  // di halaman lain. (Harus dipanggil sebelum early-return `user === null`
  // agar urutan hook stabil.)
  const { pendingCount } = usePendingApprovalCount()
  // Galat HANYA dari query utama: kegagalan query rescheduled menghasilkan
  // items `[]` sehingga daftar requested yang valid tidak pernah dikosongkan.
  const rows: VisitDetail[] = useMemo(() => {
    const primary = listQuery.data?.items ?? []
    if (statusFilter !== 'requested') return primary
    return mergeUpcomingQueue(primary, menungguRescheduledQuery.data?.items ?? [])
  }, [statusFilter, listQuery.data, menungguRescheduledQuery.data])
  const rowsLoading =
    listQuery.isPending || (statusFilter === 'requested' && menungguRescheduledQuery.isPending)

  if (user === null) return null

  const role = user.role
  const allowApproval = can(role, 'approveVisit')
  const canSubmit = can(role, 'submitVisit')

  const totalCount = totalCountQuery.data?.total ?? 0
  const visitingCount = visitingQuery.data?.total ?? 0
  const completedCount = completedQuery.data?.total ?? 0
  const listTotal = listQuery.data?.total ?? 0
  const rescheduledTotal =
    statusFilter === 'requested' ? (menungguRescheduledQuery.data?.total ?? 0) : 0
  const total = listTotal + rescheduledTotal
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const rangeStart = total > 0 ? (page - 1) * pageSize + 1 : 0
  const rangeEnd = rows.length > 0 ? rangeStart + rows.length - 1 : 0

  const tabs: TabItem[] = [
    { id: 'semua', label: 'Semua Kunjungan', count: totalCount },
    { id: 'menunggu', label: 'Menunggu Approval', count: pendingCount },
    { id: 'lokasi', label: 'Sedang di Lokasi', count: visitingCount },
    { id: 'selesai', label: 'Selesai', count: completedCount },
  ]

  // Status di luar keempat tab (mis. 'rejected') → tidak ada tab tersorot.
  const tabValue =
    statusFilter === undefined
      ? 'semua'
      : statusFilter === 'requested'
        ? 'menunggu'
        : statusFilter === 'visiting'
          ? 'lokasi'
          : statusFilter === 'completed'
            ? 'selesai'
            : 'luar-tab'

  const handleTabChange = (id: string): void => {
    if (id === 'menunggu') setStatusFilter('requested')
    else if (id === 'lokasi') setStatusFilter('visiting')
    else if (id === 'selesai') setStatusFilter('completed')
    else setStatusFilter(undefined)
  }

  const statusOptions: SelectOption[] = [
    { value: '', label: 'Semua Status' },
    ...Object.entries(VISIT_STATUS_META).map(([value, meta]) => ({ value, label: meta.label })),
  ]

  const facilityOptions: SelectOption[] =
    role === 'super_admin'
      ? [
          { value: 'all', label: 'Semua Cabang / POP' },
          ...(locationsQuery.data ?? []).map((location) => ({
            value: location.id,
            label: location.name,
          })),
        ]
      : [
          {
            value: user.location_id ?? 'all',
            label: user.location_name ?? 'Cabang (terkunci)',
          },
        ]

  const metrics: Array<{ label: string; value: number; icon: ReactNode; chip: string }> = [
    {
      label: 'Total Kunjungan Cabang',
      value: totalCount,
      icon: <CalendarDays className="size-5" />,
      chip: 'bg-brand-soft text-brand',
    },
    {
      label: 'Menunggu Approval',
      value: pendingCount,
      icon: <Clock className="size-5" />,
      chip: 'bg-warning-bg text-warning-text',
    },
    {
      label: 'Sedang di Lokasi',
      value: visitingCount,
      icon: <MapPin className="size-5" />,
      chip: 'bg-info-bg text-info-text',
    },
    {
      label: 'Selesai',
      value: completedCount,
      icon: <CheckCircle2 className="size-5" />,
      chip: 'bg-success-bg text-success-text',
    },
  ]

  const emptyTitle =
    search !== ''
      ? 'Tidak ada kunjungan yang cocok'
      : statusFilter !== undefined
        ? 'Belum ada kunjungan pada status ini'
        : 'Belum ada kunjungan'
  const emptyDescription =
    search !== ''
      ? 'Coba ubah kata kunci pencarian Anda.'
      : 'Kunjungan yang diajukan akan muncul di sini.'

  const goCreateVisit = (): void => router.push('/visits/new')

  const content = (
    <>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-ink">Dashboard Kunjungan</h1>
            {pendingCount > 0 ? <Badge tone="warning">{pendingCount} menunggu</Badge> : null}
          </div>
          <p className="mt-1.5 text-sm text-ink-secondary">
            Pantau izin akses & antrean persetujuan fasilitas THC.
          </p>
        </div>
      </div>

      {/* Entry "Buat Kunjungan" mobile (<768px): inline full-width di atas
          konten — pelengkap `hidden md:block` pada filter bar. Berada di alur
          dokumen (bukan fixed) sehingga tidak pernah menutupi kartu/aksi
          approve-reject, langsung above-the-fold di 375px (1 ketukan), dan
          bebas berebut z-index/offset dengan BottomNav (z-30, 64px).
          Vendor/Mitra dikecualikan: punya aksi sendiri di VendorMobileShell. */}
      {canSubmit && role !== 'vendor' ? (
        <div className="mb-5 md:hidden">
          <Button
            fullWidth
            className="min-h-touch"
            aria-label="Buat kunjungan baru"
            onClick={goCreateVisit}
          >
            <Plus className="size-4" aria-hidden="true" />
            Buat Kunjungan Baru
          </Button>
        </div>
      ) : null}

      {/* Kartu identitas Vendor/Mitra — di atas metrik, ikut VendorMobileShell. */}
      {role === 'vendor' ? <VendorIdentityCard user={user} /> : null}

      {/* Baris metrik — grid 2x2 di mobile, 4 kolom di desktop (larangan scroll). */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        {metrics.map((metric) => (
          <div key={metric.label} className="card flex items-center gap-3 p-4">
            <span
              aria-hidden="true"
              className={`flex size-10 shrink-0 items-center justify-center rounded-control ${metric.chip}`}
            >
              {metric.icon}
            </span>
            <div className="min-w-0">
              <p className="text-badge leading-tight text-ink-secondary">{metric.label}</p>
              <p className="text-xl font-bold text-ink">{metric.value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Filter bar: Fasilitas (super_admin aktif, admin terkunci, Vendor/Mitra sembunyi). */}
      <div className="card mt-5 flex flex-wrap items-end gap-3 border-brand/20 bg-brand-soft/40 p-4">
        {role !== 'vendor' ? (
          <div className="min-w-40 flex-1 sm:w-56 sm:flex-none">
            <Select
              label="Fasilitas"
              options={facilityOptions}
              value={facilityFilter}
              disabled={role !== 'super_admin'}
              onChange={(event) => setFacilityFilter(event.target.value)}
            />
          </div>
        ) : null}
        <div className="min-w-40 flex-1 sm:w-52 sm:flex-none">
          <Select
            label="Status"
            options={statusOptions}
            value={statusFilter ?? ''}
            onChange={(event) => {
              const next = event.target.value
              setStatusFilter(next === '' ? undefined : (next as VisitStatus))
            }}
          />
        </div>
        {/* SearchBox bersama (components/ui/SearchInput): ikon dipusatkan
            otomatis terhadap tinggi field (h-10/h-12) — tanpa offset rem
            hardcode — dan pl-9 menjaga teks placeholder tidak tertimpa ikon. */}
        <div className="min-w-48 flex-1">
          <SearchInput
            aria-label="Cari kunjungan"
            placeholder="Cari Visit ID, Vendor/Mitra, atau lokasi…"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            maxLength={SEARCH_QUERY_MAX_LENGTH}
          />
        </div>
        <div className="min-w-36 flex-1 sm:w-44 sm:flex-none">
          <Input
            label="Dari Tanggal"
            type="date"
            value={dateFrom}
            max={dateTo === '' ? undefined : dateTo}
            onChange={(event) => setDateFrom(event.target.value)}
          />
        </div>
        <div className="min-w-36 flex-1 sm:w-44 sm:flex-none">
          <Input
            label="Sampai Tanggal"
            type="date"
            value={dateTo}
            min={dateFrom === '' ? undefined : dateFrom}
            onChange={(event) => setDateTo(event.target.value)}
          />
        </div>
        <div className="min-w-44 flex-1 sm:w-52 sm:flex-none">
          <Select
            label="Urutkan"
            options={VISIT_SORT_OPTIONS}
            value={`${sortBy}:${order}`}
            onChange={(event) => {
              const next = parseVisitSort(event.target.value)
              setSortBy(next.sortBy)
              setSortOrder(next.order)
            }}
          />
        </div>
        {canSubmit && role !== 'vendor' ? (
          <div className="hidden md:block">
            <Button className="min-h-touch" onClick={goCreateVisit}>
              <Plus className="size-4" aria-hidden="true" />
              Buat Kunjungan Baru
            </Button>
          </div>
        ) : null}
        {/* Reset Filter — anak TERAKHIR bar (flex-wrap menempelkan ke ujung
            baris); mengembalikan seluruh kontrol bar termasuk filter
            "Fasilitas" di atas. */}
        <FilterResetButton onReset={handleResetFilters} disabled={!isFiltered} />
      </div>

      <Tabs className="mt-5" tabs={tabs} value={tabValue} onChange={handleTabChange} />

      <div className="mt-4">
        {rows.length > 0 ? (
          <p className="mb-3 text-label tabular-nums text-ink-secondary">
            Menampilkan {rangeStart}–{rangeEnd} dari {total} kunjungan
          </p>
        ) : null}
        {rowsLoading ? (
          <div className="card flex items-center justify-center gap-3 py-12 text-sm text-ink-secondary">
            <Spinner size="sm" />
            Memuat kunjungan…
          </div>
        ) : listQuery.isError ? (
          <div className="card p-6">
            <p className="flex items-center gap-2.5 text-sm font-semibold text-danger-text">
              <span
                aria-hidden="true"
                className="flex size-7 shrink-0 items-center justify-center rounded-control bg-danger-bg"
              >
                <AlertTriangle className="size-4" />
              </span>
              Gagal memuat daftar kunjungan
            </p>
            <p className="mt-2 text-sm text-ink-secondary">{apiErrorMessage(listQuery.error)}</p>
            <Button
              variant="secondary"
              className="mt-4 min-h-touch"
              onClick={() => {
                void listQuery.refetch()
                if (statusFilter === 'requested') void menungguRescheduledQuery.refetch()
              }}
            >
              Coba Lagi
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="card">
            <EmptyState
              icon={<Inbox className="size-8" />}
              title={emptyTitle}
              description={emptyDescription}
            />
          </div>
        ) : (
          <>
            <VisitTable
              visits={rows}
              role={role}
              onApprove={setApproveTarget}
              onReject={setRejectTarget}
              sortBy={sortBy}
              order={order}
              onSortChange={(field, nextOrder) => {
                setSortBy(field)
                setSortOrder(nextOrder)
              }}
            />
            <VisitCards
              visits={rows}
              role={role}
              onApprove={setApproveTarget}
              onReject={setRejectTarget}
            />
          </>
        )}
      </div>

      {rows.length > 0 ? (
        <Pagination
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          pageSize={pageSize}
          onPageSizeChange={handlePageSizeChange}
          className="mt-4"
        />
      ) : null}

      {/* Aksi Buat Kunjungan mobile kini entry inline di atas (lihat komentar
          pada tombol `md:hidden` di awal konten) — FAB fixed dihapus agar tidak
          menumpuk dua pola dan tidak menutupi kartu yang men-scroll di bawahnya. */}

      {allowApproval && approveTarget !== null ? (
        <ApproveModal open visit={approveTarget} onClose={() => setApproveTarget(null)} />
      ) : null}
      {allowApproval && rejectTarget !== null ? (
        <RejectModal open visit={rejectTarget} onClose={() => setRejectTarget(null)} />
      ) : null}
    </>
  )

  if (role === 'vendor') {
    return <VendorMobileShell activeHref="/dashboard">{content}</VendorMobileShell>
  }

  if (role === 'super_admin') {
    return (
      <SuperadminShell
        pendingCount={pendingCount}
        allLocations={locationsQuery.data ?? []}
        activeHref="/dashboard"
      >
        {content}
      </SuperadminShell>
    )
  }

  return (
    <AdminBranchShell pendingCount={pendingCount} activeHref="/dashboard">
      {content}
    </AdminBranchShell>
  )
}
