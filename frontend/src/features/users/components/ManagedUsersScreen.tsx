'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Inbox, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { SuperadminShell } from '@/components/layouts/SuperadminShell'
import { Button } from '@/components/ui/Button'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { DetailModal } from '@/components/ui/DetailModal'
import { EmptyState } from '@/components/ui/EmptyState'
import { FilterResetButton } from '@/components/ui/FilterResetButton'
import { Input, FIELD_HEIGHT } from '@/components/ui/Input'
import { Pagination } from '@/components/ui/Pagination'
import { Select, type SelectOption } from '@/components/ui/Select'
import { Spinner } from '@/components/ui/Spinner'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { apiErrorMessage } from '@/features/visits/components/ApproveModal'
import { EditUserModal } from '@/features/users/components/EditUserModal'
import { ManagedRoleFilterSelect } from '@/features/users/components/ManagedRoleFilterSelect'
import { ManagedUserCreateModal } from '@/features/users/components/ManagedUserCreateModal'
import {
  ManagedUserCards,
  ManagedUserTable,
  managedUserDetailFields,
} from '@/features/users/components/ManagedUserTable'
import {
  VENDOR_FILTER_ALL,
  applyManagedUserFilters,
  deleteUserConfirmMessage,
  effectiveManagedRoles,
  filterManagedUsersByRoles,
  managedCreateRole,
  managedLocationFilterApplies,
  managedRoleFilterOptions,
  managedServerRoleParam,
  managedVendorOptions,
  parseManagedRoleFilter,
  ROLE_FILTER_ALL,
  shouldResetUserPage,
  toManagedUserListParams,
  type ManagedPageRole,
  type ManagedRoleFilter,
  type ManagedStatusFilter,
  type UserFilterSnapshot,
  userAffiliationLabel,
} from '@/features/users/managed-user-filters'
import {
  useDeleteManagedUserMutation,
  useLocationsQuery,
  useManagedUsersQuery,
  usePendingApprovalCount,
  useUpdateManagedUserMutation,
  useUpdateManagedUserStatusMutation,
} from '@/lib/api/hooks'
import type { User } from '@/lib/api/types'
import { getRoleLabel } from '@/lib/auth/capabilities'
import { useSession } from '@/lib/auth/session'
import { SEARCH_QUERY_MAX_LENGTH } from '@/lib/limits'
import { DEFAULT_PAGE_SIZE, paginate } from '@/lib/pagination'

export interface ManagedUsersScreenProps {
  /**
   * Peran yang DICAKUP layar ini — bisa lebih dari satu peran
   * (`/coordinators` = `admin` + `super_admin`). Peran dibedakan lewat filter
   * peran di kolom "Peran", bukan lewat halaman per-peran.
   */
  roles: readonly ManagedPageRole[]
  /** Rute aktif di shell (menyala item sidebar milik halaman ini). */
  activeHref: string
  /** Judul layar (h1). */
  title: string
  /** Subjudul layar. */
  subtitle: string
  /**
   * Tampilkan antrean "Menunggu persetujuan" (akun inactive) di atas daftar.
   * Dipakai layar `/vendor-registrations`: akun pendaftar mandiri harus
   * disetujui (status→active) atau ditolak (hapus) eksplisit oleh
   * superadmin — bukan lewat filter status biasa.
   */
  showPendingSection?: boolean
}

const STATUS_FILTER_OPTIONS: SelectOption[] = [
  { value: 'all', label: 'Semua Status' },
  { value: 'active', label: 'Aktif' },
  { value: 'pending', label: 'Menunggu' },
  { value: 'inactive', label: 'Nonaktif' },
  { value: 'blacklisted', label: 'Diblokir' },
]

/**
 * Layar "user terkelola" milik superadmin — SATU implementasi untuk kedua
 * halaman akun (`/coordinators` → `admin` + `super_admin`,
 * `/vendor-registrations` → `vendor`).
 *
 * Peran yang dicakup halaman datang lewat prop `roles`; superadmin menyaring
 * lewat kontrol filter di dalam kolom "Peran" (default "Semua Peran", jadi
 * semua peran halaman tampil berdampingan). Kontrol yang sama diduplikasi di
 * filter bar untuk layar < lg, karena di bawah `lg` tabel digantikan tumpukan
 * kartu.
 *
 * Backend hanya menerima `POST /users` untuk `admin|vendor`, jadi saat filter
 * peran `super_admin` dipilih tombol tambah sengaja disembunyikan.
 */
export function ManagedUsersScreen({
  roles,
  activeHref,
  title,
  subtitle,
  showPendingSection = false,
}: ManagedUsersScreenProps) {
  const [locationId, setLocationId] = useState('all')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<ManagedStatusFilter>('all')
  // Filter vendor (client-side, exact-match atas `vendor_name`).
  const [vendorFilter, setVendorFilter] = useState(VENDOR_FILTER_ALL)
  // Filter peran (client-side) — '' = "Semua Peran".
  const [roleFilter, setRoleFilter] = useState<ManagedRoleFilter>(ROLE_FILTER_ALL)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)
  const [createOpen, setCreateOpen] = useState(false)
  const [deleting, setDeleting] = useState<User | null>(null)
  const [editing, setEditing] = useState<User | null>(null)
  const [detail, setDetail] = useState<User | null>(null)
  const { user: currentUser, refresh: refreshSession } = useSession()
  const deleteMutation = useDeleteManagedUserMutation()
  const updateUser = useUpdateManagedUserMutation()
  const updateStatus = useUpdateManagedUserStatusMutation()
  const currentUserId = currentUser !== null ? currentUser.id : null
  const viewerRole = currentUser !== null ? currentUser.role : null

  // Debounce pencarian 300ms supaya setiap ketikan tidak memicu request.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  const locationsQuery = useLocationsQuery()
  // Badge antrean shell: total requested + rescheduled lintas cabang
  // (server-total, limit 1 — hanya total yang dipakai); lihat usePendingApprovalCount.
  const { pendingCount } = usePendingApprovalCount()

  // Peran efektif = peran halaman, atau satu peran bila superadmin memfilter.
  const effectiveRoles = effectiveManagedRoles(roles, roleFilter)
  // Halaman >1 peran meminta TANPA `?role=` (backend hanya menerima satu
  // peran dan menolak `super_admin`); barisnya disaring di klien.
  const serverRoleParam = managedServerRoleParam(roles)
  // Cabang hanya bermakna untuk peran `admin`; peran lain tak punya
  // penugasan cabang, jadi filter cabang tak dikirim ke server.
  const showLocationFilter = managedLocationFilterApplies(effectiveRoles)
  const effectiveLocationId = showLocationFilter ? locationId : 'all'
  // Filter vendor hanya relevan bila peran efektifnya `vendor`.
  const showVendorFilter = effectiveRoles.includes('vendor')
  // Backend `POST /users` hanya menerima `admin|vendor` — akun `super_admin`
  // dibuat di luar sistem, jadi tombol tambah disembunyikan saat filter
  // peran `super_admin` yang terpilih.
  const createRole = managedCreateRole(roles, roleFilter)
  // Kontrol filter peran tampil hanya bila halaman cakup >1 peran (filter
  // satu opsi cuma ribut).
  const showRoleFilter = roles.length > 1
  const roleFilterOptions = useMemo(() => managedRoleFilterOptions(roles), [roles])

  const params = useMemo(
    () =>
      toManagedUserListParams({
        role: serverRoleParam,
        search,
        locationId: effectiveLocationId,
      }),
    [serverRoleParam, search, effectiveLocationId],
  )
  const usersQuery = useManagedUsersQuery(params)

  const locations = useMemo(() => locationsQuery.data ?? [], [locationsQuery.data])

  // Opsi vendor dari data yang sudah dimuat; nilai terpilih di-union agar
  // <select> tidak kosong bila hasil server (ikut tersaring `search`) tak lagi
  // memuat vendor tersebut.
  const vendorOptions: SelectOption[] = useMemo(() => {
    const options = managedVendorOptions(usersQuery.data ?? [])
    if (vendorFilter !== VENDOR_FILTER_ALL && !options.some((option) => option.value === vendorFilter)) {
      return [...options, { value: vendorFilter, label: vendorFilter }]
    }
    return options
  }, [usersQuery.data, vendorFilter])

  // Antrean persetujuan: akun inactive pada peran halaman ini, dihitung dari
  // data server (hanya filter peran) supaya stabil walau filter status/tabel
  // diubah. dev-superadmin tetap dibuang oleh filter peran.
  const pendingRows: User[] = useMemo(
    () =>
      filterManagedUsersByRoles(usersQuery.data ?? [], effectiveRoles).filter(
        (user) => user.status === 'pending',
      ),
    [usersQuery.data, effectiveRoles],
  )

  // Rows: status & vendor difilter di KLIEN karena `GET /users` hanya
  // mendukung role/search/location_id; peran juga difilter di klien
  // (backend menolak `?role=super_admin`).
  const rows: User[] = useMemo(
    () =>
      filterManagedUsersByRoles(
        applyManagedUserFilters(usersQuery.data ?? [], {
          status: statusFilter,
          vendor: showVendorFilter ? vendorFilter : VENDOR_FILTER_ALL,
        }),
        effectiveRoles,
      ),
    [usersQuery.data, statusFilter, vendorFilter, showVendorFilter, effectiveRoles],
  )

  // Pagination client-side: potong `rows` (sudah terfilter) per halaman. `page`
  // hasil clamp WAJIB dirender sebagai `safePage`, bukan state mentah, agar
  // halaman basi pasca-refetch tak pernah menampilkan halaman kosong.
  const { items: pageRows, page: safePage, totalPages } = paginate(rows, page, pageSize)

  // Setiap filter atau ukuran halaman berubah ⇒ kembali ke halaman 1. Pola
  // "sesuaikan state saat render" (React: You Might Not Need an Effect) dipakai
  // karena `react-hooks/set-state-in-effect` melarang setState di dalam effect.
  const filterSnapshot: UserFilterSnapshot = {
    roleFilter,
    locationId: effectiveLocationId,
    search,
    statusFilter,
    vendorFilter,
    pageSize,
  }
  const [prevFilterSnapshot, setPrevFilterSnapshot] = useState(filterSnapshot)
  if (shouldResetUserPage(prevFilterSnapshot, filterSnapshot)) {
    setPrevFilterSnapshot(filterSnapshot)
    if (page !== 1) setPage(1)
  }

  const locationOptions: SelectOption[] = useMemo(
    () => [
      { value: 'all', label: 'Semua Cabang / POP' },
      ...locations.map((location) => ({ value: location.id, label: location.name })),
    ],
    [locations],
  )

  const isFiltered =
    roleFilter !== ROLE_FILTER_ALL ||
    effectiveLocationId !== 'all' ||
    search !== '' ||
    statusFilter !== 'all' ||
    vendorFilter !== VENDOR_FILTER_ALL

  /** Reset semua filter bar ke kondisi awal — dipakai tombol Reset Filter. */
  const handleResetFilters = (): void => {
    setRoleFilter(ROLE_FILTER_ALL)
    setLocationId('all')
    setSearchInput('')
    setSearch('')
    setStatusFilter('all')
    setVendorFilter(VENDOR_FILTER_ALL)
  }

  /** Setujui pendaftar: status inactive → active (audit user.status milik server). */
  const handleApprovePending = (target: User): void => {
    updateStatus.mutate(
      { userId: target.id, body: { status: 'active' } },
      {
        onSuccess: () => {
          toast.success(`${target.name} disetujui — akun kini aktif`)
        },
        onError: (error) => {
          toast.error(apiErrorMessage(error))
        },
      },
    )
  }

  return (
    <SuperadminShell
      pendingCount={pendingCount}
      allLocations={locations}
      activeHref={activeHref}
    >
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-ink">{title}</h1>
          <p className="mt-1 text-sm text-ink-secondary">{subtitle}</p>
        </div>
        {createRole !== null ? (
          <Button className="min-h-touch" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4 shrink-0" aria-hidden="true" />
            {`Tambah ${getRoleLabel(createRole)}`}
          </Button>
        ) : null}
      </div>

      {showPendingSection && pendingRows.length > 0 ? (
        <section aria-label="Menunggu persetujuan" className="card mb-4 p-4">
          <h2 className="text-sm font-bold text-ink">
            Menunggu persetujuan ({pendingRows.length})
          </h2>
          <p className="mt-1 text-xs text-ink-secondary">
            Akun pendaftar mandiri belum dapat masuk. Setujui untuk
            mengaktifkan, atau tolak untuk menghapus permanen.
          </p>
          <ul className="mt-3 flex flex-col gap-3">
            {pendingRows.map((target) => {
              const approving =
                updateStatus.isPending && updateStatus.variables?.userId === target.id
              return (
                <li
                  key={target.id}
                  className="flex flex-col gap-3 rounded-control border border-border-mid bg-surface p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink" title={target.name}>
                      {target.name}
                    </p>
                    <p className="truncate text-xs text-ink-muted" title={target.email}>
                      {target.email}
                      {target.nik !== null ? ` · NIK ${target.nik}` : null}
                    </p>
                    <p className="truncate text-xs text-ink-muted" title={userAffiliationLabel(target)}>
                      {userAffiliationLabel(target)}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      size="sm"
                      className="min-h-touch"
                      loading={approving}
                      onClick={() => handleApprovePending(target)}
                    >
                      Setujui
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="min-h-touch"
                      onClick={() => setDeleting(target)}
                    >
                      Tolak
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      <div className="card flex flex-wrap items-end gap-3 p-4">
        {/*
          Cermin kontrol filter peran untuk layar < lg: di bawah `lg` tabel
          digantikan tumpukan kartu, jadi filter peran tak punya kolom "Peran"
          dan harus tetap terjangkau dari filter bar.
        */}
        {showRoleFilter ? (
          <div className="min-w-48 flex-1 sm:w-56 sm:flex-none lg:hidden">
            <ManagedRoleFilterSelect
              label="Peran"
              className={FIELD_HEIGHT.default}
              options={roleFilterOptions}
              value={roleFilter}
              onChange={(value) => setRoleFilter(parseManagedRoleFilter(value))}
            />
          </div>
        ) : null}
        {showLocationFilter ? (
          <div className="min-w-40 flex-1 sm:w-56 sm:flex-none">
            <Select
              label="Cabang"
              options={locationOptions}
              value={effectiveLocationId}
              onChange={(event) => setLocationId(event.target.value)}
            />
          </div>
        ) : null}
        {/* Vendor: dropdown (exact-match) — opsi dari data vendor termuat. */}
        {showVendorFilter ? (
          <div className="min-w-48 flex-1 sm:w-56 sm:flex-none">
            <Select
              label="Vendor/Nama Perusahaan"
              options={vendorOptions}
              value={vendorFilter}
              onChange={(event) => setVendorFilter(event.target.value)}
            />
          </div>
        ) : null}
        {/* Status tampil di SEMUA mode peran. */}
        <div className="min-w-40 flex-1 sm:w-48 sm:flex-none">
          <Select
            label="Status"
            options={STATUS_FILTER_OPTIONS}
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as ManagedStatusFilter)}
          />
        </div>
        {/* Searchbox nama/email tampil di SEMUA mode peran. */}
        <div className="relative min-w-48 flex-1">
          <Input
            aria-label="Cari user"
            placeholder="Cari nama atau email…"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            maxLength={SEARCH_QUERY_MAX_LENGTH}
          />
        </div>
        {/* Selalu anak TERAKHIR: satu-satunya reset untuk semua kontrol di atas. */}
        <FilterResetButton onReset={handleResetFilters} disabled={!isFiltered} />
      </div>

      <div className="mt-4">
        {usersQuery.isPending ? (
          <div className="card flex items-center justify-center gap-3 py-12 text-sm text-ink-secondary">
            <Spinner size="sm" />
            Memuat daftar user…
          </div>
        ) : usersQuery.isError ? (
          <div className="card p-6">
            <p className="flex items-center gap-2 text-sm font-semibold text-danger-text">
              <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
              Gagal memuat daftar user
            </p>
            <p className="mt-2 text-sm text-ink-secondary">
              {apiErrorMessage(usersQuery.error)}
            </p>
            <Button variant="secondary" className="min-h-touch" onClick={() => void usersQuery.refetch()}>
              Coba Lagi
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="card">
            <EmptyState
              icon={<Inbox aria-hidden="true" className="size-8" />}
              title={isFiltered ? 'Tidak ada user yang cocok' : 'Belum ada user'}
              description={
                isFiltered
                  ? 'Coba ubah kata kunci pencarian atau filter Anda.'
                  : 'User yang didaftarkan akan muncul di sini.'
              }
            />
          </div>
        ) : (
          <>
            <ManagedUserTable
              users={pageRows}
              currentUserId={currentUserId}
              viewerRole={viewerRole}
              onDelete={setDeleting}
              onEdit={setEditing}
              onView={setDetail}
              roleFilter={
                showRoleFilter
                  ? {
                      options: roleFilterOptions,
                      value: roleFilter,
                      onChange: (value) => setRoleFilter(parseManagedRoleFilter(value)),
                    }
                  : undefined
              }
            />
            <ManagedUserCards
              users={pageRows}
              currentUserId={currentUserId}
              viewerRole={viewerRole}
              onDelete={setDeleting}
              onEdit={setEditing}
              onView={setDetail}
            />
            <Pagination
              page={safePage}
              totalPages={totalPages}
              onPageChange={setPage}
              pageSize={pageSize}
              onPageSizeChange={setPageSize}
              ariaLabel="Paginasi daftar user"
              className="mt-4"
            />
          </>
        )}
      </div>

      {deleting !== null ? (
        <ConfirmModal
          open
          title={`Hapus ${deleting.name}`}
          message={deleteUserConfirmMessage(deleting)}
          loading={deleteMutation.isPending}
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            deleteMutation.mutate(
              { userId: deleting.id },
              {
                onSuccess: () => {
                  toast.success(`${deleting.name} dihapus permanen`)
                  setDeleting(null)
                },
                // 403 (diri sendiri/super_admin) & 409 tampil apa adanya dari server.
                onError: (error) => {
                  toast.error(apiErrorMessage(error))
                },
              },
            )
          }}
        />
      ) : null}

      {createOpen && createRole !== null ? (
        <ManagedUserCreateModal
          role={createRole}
          locations={locations}
          onClose={() => setCreateOpen(false)}
        />
      ) : null}

      {detail !== null ? (
        <DetailModal
          title="Detail User"
          subtitle={detail.name}
          avatar={<UserAvatar name={detail.name} avatarUrl={detail.avatar_url} size="lg" />}
          fields={managedUserDetailFields(detail)}
          onClose={() => setDetail(null)}
        />
      ) : null}

      {editing !== null ? (
        <EditUserModal
          user={editing}
          locations={locations}
          saving={updateUser.isPending}
          locationMode={editing.role === 'admin' ? 'select' : 'hidden'}
          isSelf={currentUserId !== null && editing.id === currentUserId}
          onClose={() => setEditing(null)}
          onSubmit={(body) => {
            updateUser.mutate(
              { userId: editing.id, body },
              {
                onSuccess: () => {
                  toast.success(`Perubahan ${body.name ?? editing.name} tersimpan`)
                  setEditing(null)
                  if (currentUserId !== null && editing.id === currentUserId) {
                    void refreshSession()
                  }
                },
                onError: (error) => {
                  toast.error(apiErrorMessage(error))
                },
              },
            )
          }}
        />
      ) : null}
    </SuperadminShell>
  )
}
