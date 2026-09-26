'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Clock,
  Inbox,
  MapPin,
  Plus,
  Search,
  Shield,
} from 'lucide-react'
import { AdminBranchShell } from '@/components/layouts/AdminBranchShell'
import { PicMobileShell } from '@/components/layouts/PicMobileShell'
import { SuperadminShell } from '@/components/layouts/SuperadminShell'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Input } from '@/components/ui/Input'
import { Select, type SelectOption } from '@/components/ui/Select'
import { Spinner } from '@/components/ui/Spinner'
import { Tabs, type TabItem } from '@/components/ui/Tabs'
import { SecurityUserModal } from '@/features/security/components/SecurityUserModal'
import { ApproveModal, apiErrorMessage } from '@/features/visits/components/ApproveModal'
import { RejectModal } from '@/features/visits/components/RejectModal'
import { VisitCards } from '@/features/visits/components/VisitCards'
import { VisitTable } from '@/features/visits/components/VisitTable'
import { useLocationsQuery, useVisitsQuery } from '@/lib/api/hooks'
import type { VisitDetail, VisitListParams, VisitStatus } from '@/lib/api/types'
import { can } from '@/lib/auth/capabilities'
import { RequireAuth } from '@/lib/auth/guards'
import { useSession } from '@/lib/auth/session'
import { VISIT_STATUS_META } from '@/lib/visits/status-badge'

/**
 * SCR-02 — Dashboard Kunjungan & Antrean.
 *
 * Halaman ini SENGAJA tanpa SessionProvider/Providers sendiri: satu-satunya
 * SessionProvider + QueryClient + Toaster adalah milik root layout
 * (`MswProvider > Providers > SessionProvider`), sehingga `useSession` dan
 * `useQuery` memakai konteks root dan navigasi dashboard↔gate tidak blank/loop.
 *
 * Dua kunci query disengaja:
 * 1. Tanpa `status` → metrik 4 kartu, hitung tab, dan `pendingCount` shell
 *    (tidak berubah saat pengguna ganti tab).
 * 2. Dengan `status` → baris tabel/kartu. Saat `status` undefined, kedua
 *    objek params identik sehingga cache React Query menyatukannya.
 */
export default function DashboardPage() {
  // Tanpa provider ganda: pakai SessionProvider + QueryClient + Toaster milik root layout.
  return (
    <RequireAuth>
      <DashboardScreen />
    </RequireAuth>
  )
}

function DashboardScreen() {
  const { user } = useSession()
  const router = useRouter()

  // Filter fasilitas bersatu: sentinel 'all' sama dengan switcher SuperadminShell.
  const [facilityFilter, setFacilityFilter] = useState<string>(
    user !== null && user.role !== 'super_admin' && user.role !== 'pic'
      ? (user.location_id ?? 'all')
      : 'all',
  )
  // Satu state status dipakai BERSAMAAN oleh Tabs dan Select status.
  const [statusFilter, setStatusFilter] = useState<VisitStatus | undefined>(undefined)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [approveTarget, setApproveTarget] = useState<VisitDetail | null>(null)
  const [rejectTarget, setRejectTarget] = useState<VisitDetail | null>(null)
  const [securityOpen, setSecurityOpen] = useState(false)

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

  if (user === null) return null

  const role = user.role
  const allowApproval = can(role, 'approveVisit')
  const canManageSecurity = can(role, 'manageSecurity')
  const canSubmit = can(role, 'submitVisit')

  const rows: VisitDetail[] = listQuery.data?.items ?? []
  const baseItems: VisitDetail[] = baseQuery.data?.items ?? []
  const totalCount = baseQuery.data?.total ?? 0
  const pendingCount = baseItems.filter((visit) => visit.status === 'requested').length
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
        {canManageSecurity && role === 'super_admin' ? (
          <Button variant="secondary" className="min-h-touch" onClick={() => setSecurityOpen(true)}>
            <Shield className="size-4" aria-hidden="true" />
            Kelola Satpam Cabang
          </Button>
        ) : null}
      </div>

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

      {/* Filter bar: Fasilitas (super_admin aktif, admin terkunci, PIC sembunyi). */}
      <div className="card mt-5 flex flex-wrap items-end gap-3 p-4">
        {role !== 'pic' ? (
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
        <div className="relative min-w-48 flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-[2.1rem] size-4 -translate-y-1/2 text-ink-muted"
          />
          <Input
            aria-label="Cari kunjungan"
            placeholder="Cari Visit ID, PIC, atau vendor…"
            className="pl-9"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </div>
        {canSubmit && role !== 'pic' ? (
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
        {listQuery.isPending ? (
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
            <Button variant="secondary" className="mt-4" onClick={() => void listQuery.refetch()}>
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

      {/* FAB penciptaan kunjungan khusus mobile (PIC sudah punya tombol + di shell). */}
      {canSubmit && role !== 'pic' ? (
        <Button
          className="fixed bottom-20 right-4 z-40 min-h-touch shadow-modal md:hidden"
          aria-label="Buat kunjungan baru"
          onClick={goCreateVisit}
        >
          <Plus className="size-5" aria-hidden="true" />
          Buat Kunjungan
        </Button>
      ) : null}

      {allowApproval && approveTarget !== null ? (
        <ApproveModal open visit={approveTarget} onClose={() => setApproveTarget(null)} />
      ) : null}
      {allowApproval && rejectTarget !== null ? (
        <RejectModal open visit={rejectTarget} onClose={() => setRejectTarget(null)} />
      ) : null}
      {canManageSecurity ? (
        <SecurityUserModal open={securityOpen} onClose={() => setSecurityOpen(false)} />
      ) : null}
    </>
  )

  if (role === 'pic') {
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
    <AdminBranchShell
      pendingCount={pendingCount}
      activeHref="/dashboard"
      onQuickCreateVisit={canSubmit ? goCreateVisit : undefined}
      onQuickAddSecurity={canManageSecurity ? () => setSecurityOpen(true) : undefined}
    >
      {content}
    </AdminBranchShell>
  )
}
