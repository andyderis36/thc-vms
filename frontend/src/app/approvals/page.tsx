'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Inbox } from 'lucide-react'
import { AdminBranchShell } from '@/components/layouts/AdminBranchShell'
import { SuperadminShell } from '@/components/layouts/SuperadminShell'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { FilterResetButton } from '@/components/ui/FilterResetButton'
import { Input } from '@/components/ui/Input'
import { Pagination } from '@/components/ui/Pagination'
import { SearchInput } from '@/components/ui/SearchInput'
import { Select, type SelectOption } from '@/components/ui/Select'
import { Spinner } from '@/components/ui/Spinner'
import { ApproveModal, apiErrorMessage } from '@/features/visits/components/ApproveModal'
import { RejectModal } from '@/features/visits/components/RejectModal'
import { VisitCards } from '@/features/visits/components/VisitCards'
import { VisitTable } from '@/features/visits/components/VisitTable'
import { useLocationsQuery, usePendingApprovalCount, useVisitsQuery } from '@/lib/api/hooks'
import type { Role, VisitDetail, VisitListParams, VisitOrder, VisitSortField } from '@/lib/api/types'
import { RequireRole } from '@/lib/auth/guards'
import { isSuperAdminRole } from '@/lib/auth/capabilities'
import { useSession } from '@/lib/auth/session'
import { SEARCH_QUERY_MAX_LENGTH } from '@/lib/limits'
import { DEFAULT_PAGE_SIZE } from '@/lib/pagination'
import { branchFilterOptions } from '@/lib/visits/location-scope'
import { mergeUpcomingQueue } from '@/lib/visits/upcoming-queue'

/** Kombinasi filter antrean approval yang dipetakan ke query params `GET /visits`. */
export interface ApprovalListFilter {
  q: string
  locationId: string
  dateFrom: string
  dateTo: string
  page: number
  pageSize: number
  sortBy: VisitSortField
  order: VisitOrder
}

export function toApprovalListParams(filter: ApprovalListFilter): VisitListParams {
  const params: VisitListParams = {
    page: filter.page,
    limit: filter.pageSize,
    sort_by: filter.sortBy,
    order: filter.order,
    ...(filter.q !== '' ? { q: filter.q } : {}),
    ...(filter.locationId !== 'all' ? { location_id: filter.locationId } : {}),
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
 * Halaman mandiri Antrean Approval — irisan fokus SCR-02 untuk
 * `super_admin` dan `admin`: kunjungan `requested` + `rescheduled` (keduanya
 * menunggu keputusan; `rescheduled→approved` legal di backend — milik cabang
 * untuk admin — backend memfilter otomatis) + aksi Setujui/Tolak.
 * Tabel desktop (>= 1024px) + kartu responsif (ponsel 1 kolom, tablet 2
 * kolom) dipakai ulang dari dashboard (DRY).
 */
export default function ApprovalsPage() {
  return (
    <RequireRole allow={['super_admin', 'admin']}>
      <ApprovalsScreen />
    </RequireRole>
  )
}

function RoleShell({ role, pendingCount, children }: { role: Role; pendingCount: number; children: React.ReactNode }) {
  if (isSuperAdminRole(role)) {
    return (
      <SuperadminShell pendingCount={pendingCount} activeHref="/approvals">
        {children}
      </SuperadminShell>
    )
  }
  return (
    <AdminBranchShell pendingCount={pendingCount} activeHref="/approvals">
      {children}
    </AdminBranchShell>
  )
}

function ApprovalsScreen() {
  const { user } = useSession()
  const role = user !== null ? user.role : null
  const isSuperAdmin = role !== null && isSuperAdminRole(role)

  const [approveTarget, setApproveTarget] = useState<VisitDetail | null>(null)
  const [rejectTarget, setRejectTarget] = useState<VisitDetail | null>(null)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [locationId, setLocationId] = useState('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [sortBy, setSortBy] = useState<VisitSortField>('created_at')
  const [order, setSortOrder] = useState<VisitOrder>('desc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)

  const handlePageSizeChange = (next: number): void => {
    setPageSize(next)
    setPage(1)
  }

  // Kembalikan SEMUA state filter ke default (termasuk `search` hasil debounce,
  // bukan hanya input teksnya — kalau `search` tidak direset, query lama tetap
  // terkirim sampai ketikan berikutnya). Halaman ikut ke 1 karena baris halaman
  // N tidak relevan untuk kombinasi filter bersih.
  const handleResetFilters = (): void => {
    setSearchInput('')
    setSearch('')
    setLocationId('all')
    setDateFrom('')
    setDateTo('')
    setSortBy('created_at')
    setSortOrder('desc')
    setPage(1)
  }

  // Debounce pencarian 300ms supaya setiap ketikan tidak memicu request
  // (pola identik halaman users benchmark).
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  // Filter/urutan berubah → kembali ke halaman 1 (baris halaman N tidak
  // relevan untuk kombinasi filter baru). Penyesuaian dilakukan saat render
  // mengikuti pola "adjusting state when a prop changes" React, bukan di dalam
  // effect, agar tidak memicu render berantai.
  const filterSignature = JSON.stringify([search, locationId, dateFrom, dateTo, sortBy, order])
  const [lastFilterSignature, setLastFilterSignature] = useState(filterSignature)
  if (lastFilterSignature !== filterSignature) {
    setLastFilterSignature(filterSignature)
    setPage(1)
  }

  const locationsQuery = useLocationsQuery()
  // Badge antrean shell + subtitle: total requested + rescheduled TANPA filter
  // pencarian (server-total, limit 1 — hanya total yang dipakai), persis pola
  // halaman users — lihat usePendingApprovalCount.
  const { pendingCount } = usePendingApprovalCount(true, locationId)

  // `q` & `location_id` adalah query param kontrak GET /visits
  // (openapi §/visits) — tersambung langsung ke server, bukan filter mati.
  // Params yang SAMA dipakai oleh kedua query status agar filter pencarian/
  // cabang berlaku identik pada sisi `requested` dan `rescheduled`.
  const filter: ApprovalListFilter = {
    q: search,
    locationId,
    dateFrom,
    dateTo,
    page,
    pageSize,
    sortBy,
    order,
  }
  const baseListParams = toApprovalListParams(filter)
  const listQuery = useVisitsQuery({ ...baseListParams, status: 'requested' })
  const rescheduledQuery = useVisitsQuery({ ...baseListParams, status: 'rescheduled' })
  // Gabung client-side: dedupe by id + urut kronologis `start_date` ASC —
  // pola yang sama dengan antrean "Akan Hadir" gerbang (mergeUpcomingQueue).
  const rows = useMemo(
    () => mergeUpcomingQueue(listQuery.data?.items ?? [], rescheduledQuery.data?.items ?? []),
    [listQuery.data, rescheduledQuery.data],
  )
  const listTotal = listQuery.data?.total ?? 0
  const rescheduledTotal = rescheduledQuery.data?.total ?? 0
  const total = listTotal + rescheduledTotal
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const rangeStart = total > 0 ? (page - 1) * pageSize + 1 : 0
  const rangeEnd = rows.length > 0 ? rangeStart + rows.length - 1 : 0

  const locations = useMemo(() => locationsQuery.data ?? [], [locationsQuery.data])
  const locationOptions: SelectOption[] = useMemo(
    () =>
      user !== null
        ? branchFilterOptions(
            locations,
            user,
            isSuperAdmin ? 'Semua Cabang / POP' : 'Semua Cabang Saya',
          )
        : [],
    [locations, user, isSuperAdmin],
  )

  if (role === null) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Spinner size="lg" label="Memuat antrean…" />
      </div>
    )
  }

  const isFiltered =
    search !== '' || locationId !== 'all' || dateFrom !== '' || dateTo !== ''

  return (
    <RoleShell role={role} pendingCount={pendingCount}>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-ink">Antrean Approval</h1>
            {pendingCount > 0 ? <Badge tone="warning">{pendingCount} menunggu</Badge> : null}
          </div>
          <p className="mt-1.5 text-sm text-ink-secondary">
            {pendingCount} permohonan menunggu keputusan.
          </p>
        </div>
      </div>

      {/* Toolbar filter irisan SCR-02 — pola users benchmark: select berlabel
          + search ber-aria-label, wrap rapi di 375/768/1280 tanpa scroll. */}
      <div className="card flex flex-wrap items-end gap-3 border-brand/20 bg-brand-soft/40 p-4">
        <div className="min-w-40 flex-1 sm:w-56 sm:flex-none">
          <Select
            label="Cabang"
            options={locationOptions}
            value={locationId}
            disabled={locationOptions.length <= 1}
            onChange={(event) => setLocationId(event.target.value)}
          />
        </div>
        <div className="min-w-48 flex-1">
          <span aria-hidden="true" className="mb-2 block text-label font-semibold text-ink">
            Pencarian
          </span>
          <SearchInput
            aria-label="Cari permohonan"
            placeholder="Cari nama Vendor/Mitra atau Visit ID…"
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
        {/* Tombol reset selalu tampil (independen dari select Cabang superadmin);
            nonaktif saat tidak ada filter aktif — pola halaman users. */}
        <div className="flex items-end gap-3">
          <FilterResetButton onReset={handleResetFilters} disabled={!isFiltered} />
        </div>
      </div>

      {/* Galat HANYA dari query utama — kegagalan query rescheduled tidak
          boleh mengosongkan daftar requested yang valid (pola gerbang). */}
      <div className="mt-4">
        {rows.length > 0 ? (
          <p className="mb-3 text-label tabular-nums text-ink-secondary">
            Menampilkan {rangeStart}–{rangeEnd} dari {total} permohonan
          </p>
        ) : null}
        {listQuery.isPending || rescheduledQuery.isPending ? (
          <div className="card flex items-center justify-center gap-3 py-12 text-sm text-ink-secondary">
            <Spinner size="sm" />
            Memuat antrean…
          </div>
        ) : listQuery.isError ? (
          <div className="card p-6">
            <p className="flex items-center gap-2.5 text-sm font-semibold text-danger-text">
              <span
                aria-hidden="true"
                className="flex size-7 shrink-0 items-center justify-center rounded-control bg-danger-bg"
              >
                <AlertTriangle className="size-4 shrink-0" />
              </span>
              Gagal memuat antrean approval
            </p>
            <p className="mt-2 text-sm text-ink-secondary">{apiErrorMessage(listQuery.error)}</p>
            <Button
              variant="secondary"
              className="mt-4 min-h-touch"
              onClick={() => {
                void listQuery.refetch()
                void rescheduledQuery.refetch()
              }}
            >
              Coba Lagi
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="card">
            <EmptyState
              icon={<Inbox aria-hidden="true" className="size-8" />}
              title={isFiltered ? 'Tidak ada permohonan yang cocok' : 'Antrean kosong'}
              description={
                isFiltered
                  ? 'Coba ubah kata kunci pencarian atau filter cabang Anda.'
                  : 'Semua permohonan sudah diputuskan. Kerja bagus.'
              }
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
              page={page}
              pageSize={pageSize}
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
          pageSize={pageSize}
          onPageSizeChange={handlePageSizeChange}
          onPageChange={setPage}
          ariaLabel="Paginasi antrean approval"
          className="mt-4"
        />
      ) : null}

      {approveTarget !== null ? (
        <ApproveModal open visit={approveTarget} onClose={() => setApproveTarget(null)} />
      ) : null}
      {rejectTarget !== null ? (
        <RejectModal open visit={rejectTarget} onClose={() => setRejectTarget(null)} />
      ) : null}
    </RoleShell>
  )
}
