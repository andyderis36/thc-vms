'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Inbox } from 'lucide-react'
import { AdminBranchShell } from '@/components/layouts/AdminBranchShell'
import { SuperadminShell } from '@/components/layouts/SuperadminShell'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Input } from '@/components/ui/Input'
import { Select, type SelectOption } from '@/components/ui/Select'
import { Spinner } from '@/components/ui/Spinner'
import { ApproveModal, apiErrorMessage } from '@/features/visits/components/ApproveModal'
import { RejectModal } from '@/features/visits/components/RejectModal'
import { VisitCards } from '@/features/visits/components/VisitCards'
import { VisitTable } from '@/features/visits/components/VisitTable'
import { useLocationsQuery, useVisitsQuery } from '@/lib/api/hooks'
import type { Role, VisitDetail, VisitListParams } from '@/lib/api/types'
import { RequireRole } from '@/lib/auth/guards'
import { useSession } from '@/lib/auth/session'

/**
 * Halaman mandiri Antrean Approval — irisan fokus SCR-02 untuk
 * `super_admin` dan `admin`: hanya kunjungan `requested` (milik cabang
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
  if (role === 'super_admin') {
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
  const isSuperAdmin = role === 'super_admin'

  const [approveTarget, setApproveTarget] = useState<VisitDetail | null>(null)
  const [rejectTarget, setRejectTarget] = useState<VisitDetail | null>(null)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [locationId, setLocationId] = useState('all')

  // Debounce pencarian 300ms supaya setiap ketikan tidak memicu request
  // (pola identik halaman users benchmark).
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  const locationsQuery = useLocationsQuery()
  // Badge antrean shell + subtitle: total requested TANPA filter pencarian
  // (limit 1 — hanya total yang dipakai), persis pola halaman users.
  const pendingQuery = useVisitsQuery({ status: 'requested', limit: 1 })

  // `search` & `location_id` adalah query param kontrak GET /visits
  // (openapi §/visits) — tersambung langsung ke server, bukan filter mati.
  const listParams: VisitListParams = useMemo(
    () => ({
      status: 'requested',
      limit: 100,
      ...(search !== '' ? { search } : {}),
      ...(isSuperAdmin && locationId !== 'all' ? { location_id: locationId } : {}),
    }),
    [search, locationId, isSuperAdmin],
  )
  const listQuery = useVisitsQuery(listParams)
  const rows = useMemo(() => listQuery.data?.items ?? [], [listQuery.data])

  const locations = useMemo(() => locationsQuery.data ?? [], [locationsQuery.data])
  const locationOptions: SelectOption[] = useMemo(
    () => [
      { value: 'all', label: 'Semua Cabang / POP' },
      ...locations.map((location) => ({ value: location.id, label: location.name })),
    ],
    [locations],
  )

  if (role === null) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Spinner size="lg" label="Memuat antrean…" />
      </div>
    )
  }

  const pendingCount = pendingQuery.data?.total ?? 0
  const isFiltered = search !== '' || locationId !== 'all'

  return (
    <RoleShell role={role} pendingCount={pendingCount}>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-ink">Antrean Approval</h1>
          <p className="mt-1 text-sm text-ink-secondary">
            {pendingCount} permohonan menunggu keputusan.
          </p>
        </div>
      </div>

      {/* Toolbar filter irisan SCR-02 — pola users benchmark: select berlabel
          + search ber-aria-label, wrap rapi di 375/768/1280 tanpa scroll. */}
      <div className="card flex flex-wrap items-end gap-3 p-4">
        {isSuperAdmin ? (
          <div className="min-w-40 flex-1 sm:w-56 sm:flex-none">
            <Select
              label="Cabang"
              options={locationOptions}
              value={locationId}
              onChange={(event) => setLocationId(event.target.value)}
            />
          </div>
        ) : null}
        <div className="relative min-w-48 flex-1">
          <Input
            aria-label="Cari permohonan"
            placeholder="Cari nama Vendor/Mitra atau Visit ID…"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </div>
      </div>

      <div className="mt-4">
        {listQuery.isPending ? (
          <div className="card flex items-center justify-center gap-3 py-12 text-sm text-ink-secondary">
            <Spinner size="sm" />
            Memuat antrean…
          </div>
        ) : listQuery.isError ? (
          <div className="card p-6">
            <p className="flex items-center gap-2 text-sm font-semibold text-danger-text">
              <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
              Gagal memuat antrean approval
            </p>
            <p className="mt-2 text-sm text-ink-secondary">{apiErrorMessage(listQuery.error)}</p>
            <Button variant="secondary" className="mt-4 min-h-touch" onClick={() => void listQuery.refetch()}>
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

      {approveTarget !== null ? (
        <ApproveModal open visit={approveTarget} onClose={() => setApproveTarget(null)} />
      ) : null}
      {rejectTarget !== null ? (
        <RejectModal open visit={rejectTarget} onClose={() => setRejectTarget(null)} />
      ) : null}
    </RoleShell>
  )
}
