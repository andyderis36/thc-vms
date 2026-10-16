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
import { PicMobileShell } from '@/components/layouts/PicMobileShell'
import { SuperadminShell } from '@/components/layouts/SuperadminShell'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { SearchInput } from '@/components/ui/SearchInput'
import { Select, type SelectOption } from '@/components/ui/Select'
import { Spinner } from '@/components/ui/Spinner'
import { Tabs, type TabItem } from '@/components/ui/Tabs'
import { ApproveModal, apiErrorMessage } from '@/features/visits/components/ApproveModal'
import { RejectModal } from '@/features/visits/components/RejectModal'
import { VisitCards } from '@/features/visits/components/VisitCards'
import { VisitTable } from '@/features/visits/components/VisitTable'
import { useLocationsQuery, usePendingApprovalCount, useVisitsQuery } from '@/lib/api/hooks'
import type { VisitDetail, VisitListParams, VisitStatus } from '@/lib/api/types'
import { can } from '@/lib/auth/capabilities'
import { RequireAuth } from '@/lib/auth/guards'
import { useSession } from '@/lib/auth/session'
import { VISIT_STATUS_META } from '@/lib/visits/status-badge'
import { mergeUpcomingQueue } from '@/lib/visits/upcoming-queue'

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

  // Filter fasilitas bersatu: sentinel 'all' sama dengan switcher SuperadminShell.
  const [facilityFilter, setFacilityFilter] = useState<string>(
    user !== null && user.role !== 'super_admin' && user.role !== 'vendor'
      ? (user.location_id ?? 'all')
      : 'all',
  )
  // Satu state status dipakai BERSAMAAN oleh Tabs dan Select status.
  const [statusFilter, setStatusFilter] = useState<VisitStatus | undefined>(undefined)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [approveTarget, setApproveTarget] = useState<VisitDetail | null>(null)
  const [rejectTarget, setRejectTarget] = useState<VisitDetail | null>(null)

  // Deep-link menu sidebar (?focus=): Tab "Menunggu Approval" untuk
  // approvals. Berjalan SETIAP fokus berubah (bukan sekali saat mount)
  // supaya klik menu saat sudah di dashboard tetap beralih — navigasi SPA
  // tidak me-remount halaman. URL tanpa focus tidak mereset pilihan
  // pengguna yang sedang aktif.
  const focus = useSearchParams().get('focus')
  useEffect(() => {
    if (focus === 'approvals') {
      setStatusFilter('requested')
    }
  }, [focus])

  // Debounce pencarian 300ms supaya setiap ketikan tidak memicu request.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  const locationsQuery = useLocationsQuery()

  const baseParams: VisitListParams = {
    limit: 100,
    ...(facilityFilter !== 'all' ? { location_id: facilityFilter } : {}),
    ...(search !== '' ? { search } : {}),
  }
  const listParams: VisitListParams = {
    ...baseParams,
    ...(statusFilter !== undefined ? { status: statusFilter } : {}),
  }

  const baseQuery = useVisitsQuery(baseParams)
  const listQuery = useVisitsQuery(listParams)
  // Tab "Menunggu Approval" (status requested) juga menampilkan kunjungan
  // `rescheduled` — keduanya menunggu keputusan admin. Query kedua HANYA
  // aktif di tab tersebut agar tab lain tetap single-query; hasilnya digabung
  // client-side oleh mergeUpcomingQueue (dedupe by id, urut kronologis) —
  // persis pola antrean "Akan Hadir" gerbang.
  const menungguRescheduledQuery = useVisitsQuery(
    { ...baseParams, status: 'rescheduled' },
    statusFilter === 'requested',
  )
  // `pendingCount` mencakup `requested` + `rescheduled` (keduanya menunggu
  // keputusan) → tab, kartu metrik, dan badge shell selalu satu angka.
  // PERUBAHAN SADAR (konsistensi): sumbernya kini total SERVER, bukan filter
  // client atas halaman `baseQuery` `limit:100` yang bisa undercount saat >100
  // item — sumber yang sama dengan badge di 6 halaman lain; scope cabang/peran
  // tetap ikut backend. (Harus dipanggil sebelum early-return `user === null`
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

  const baseItems: VisitDetail[] = baseQuery.data?.items ?? []
  const totalCount = baseQuery.data?.total ?? 0
  const visitingCount = baseItems.filter((visit) => visit.status === 'visiting').length
  const completedCount = baseItems.filter((visit) => visit.status === 'completed').length

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

  const metrics: Array<{ label: string; value: number; icon: ReactNode }> = [
    { label: 'Total Kunjungan Cabang', value: totalCount, icon: <CalendarDays className="size-5" /> },
    { label: 'Menunggu Approval', value: pendingCount, icon: <Clock className="size-5" /> },
    { label: 'Sedang di Lokasi', value: visitingCount, icon: <MapPin className="size-5" /> },
    { label: 'Selesai', value: completedCount, icon: <CheckCircle2 className="size-5" /> },
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
          <h1 className="text-xl font-bold text-ink">Dashboard Kunjungan</h1>
          <p className="mt-1 text-sm text-ink-secondary">
            Pantau izin akses & antrean persetujuan fasilitas THC.
          </p>
        </div>
      </div>

      {/* Entry "Buat Kunjungan" mobile (<768px): inline full-width di atas
          konten — pelengkap `hidden md:block` pada filter bar. Berada di alur
          dokumen (bukan fixed) sehingga tidak pernah menutupi kartu/aksi
          approve-reject, langsung above-the-fold di 375px (1 ketukan), dan
          bebas berebut z-index/offset dengan BottomNav (z-30, 64px).
          Vendor/Mitra dikecualikan: punya aksi sendiri di PicMobileShell. */}
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

      {/* Kartu identitas Vendor/Mitra — di atas metrik, ikut PicMobileShell. */}
      {role === 'vendor' ? (
        <section aria-label="Identitas Vendor/Mitra" className="card mb-5 flex items-center gap-4 p-4">
          <span
            aria-hidden="true"
            className="flex size-12 shrink-0 items-center justify-center rounded-full bg-brand text-lg font-bold text-brand-contrast"
          >
            {(user.name.charAt(0) || 'P').toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-bold text-ink">{user.name}</p>
            <p className="truncate text-xs text-ink-secondary">
              {user.vendor_name ?? 'Vendor'}
              {' · '}
              {user.email}
            </p>
            <p className="mt-0.5 truncate text-xs text-ink-muted">
              {user.nik !== null ? `NIK ${user.nik}` : 'NIK —'}
            </p>
          </div>
          <Badge tone={user.status === 'active' ? 'success' : 'neutral'}>
            {user.status === 'active' ? 'AKTIF' : 'NONAKTIF'}
          </Badge>
        </section>
      ) : null}

      {/* Baris metrik — grid 2x2 di mobile, 4 kolom di desktop (larangan scroll). */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        {metrics.map((metric) => (
          <div key={metric.label} className="card flex items-center gap-3 p-4">
            <span
              aria-hidden="true"
              className="flex size-10 shrink-0 items-center justify-center rounded-control bg-brand-soft text-brand"
            >
              {metric.icon}
            </span>
            <div className="min-w-0">
              <p className="truncate text-badge text-ink-secondary">{metric.label}</p>
              <p className="text-xl font-bold text-ink">{metric.value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Filter bar: Fasilitas (super_admin aktif, admin terkunci, Vendor/Mitra sembunyi). */}
      <div className="card mt-5 flex flex-wrap items-end gap-3 p-4">
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
            placeholder="Cari Visit ID, Vendor/Mitra, atau vendor…"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
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
      </div>

      <Tabs className="mt-5" tabs={tabs} value={tabValue} onChange={handleTabChange} />

      <div className="mt-4">
        {rowsLoading ? (
          <div className="card flex items-center justify-center gap-3 py-12 text-sm text-ink-secondary">
            <Spinner size="sm" />
            Memuat kunjungan…
          </div>
        ) : listQuery.isError ? (
          <div className="card p-6">
            <p className="flex items-center gap-2 text-sm font-semibold text-danger-text">
              <AlertTriangle className="size-4" aria-hidden="true" />
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
    return <PicMobileShell activeHref="/dashboard">{content}</PicMobileShell>
  }

  if (role === 'super_admin') {
    return (
      <SuperadminShell
        pendingCount={pendingCount}
        allLocations={locationsQuery.data ?? []}
        activeHref="/dashboard"
        onBranchChange={setFacilityFilter}
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
