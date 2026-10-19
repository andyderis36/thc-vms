'use client'

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { AlertTriangle, Building2, Inbox, Pencil, Plus, Power, Trash2, UserRound } from 'lucide-react'
import { toast } from 'sonner'
import { SuperadminShell } from '@/components/layouts/SuperadminShell'
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { EmptyState } from '@/components/ui/EmptyState'
import { FilterResetButton } from '@/components/ui/FilterResetButton'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Pagination } from '@/components/ui/Pagination'
import { Select, type SelectOption } from '@/components/ui/Select'
import { Spinner } from '@/components/ui/Spinner'
import { apiErrorMessage } from '@/features/visits/components/ApproveModal'
import { EditUserModal } from '@/features/users/components/EditUserModal'
import {
  useCreateManagedUserMutation,
  useDeleteManagedUserMutation,
  useUpdateManagedUserMutation,
  useLocationsQuery,
  useManagedUsersQuery,
  usePendingApprovalCount,
  useUpdateManagedUserStatusMutation,
  useVendorsQuery,
} from '@/lib/api/hooks'
import type {
  CreateManagedUserRequest,
  ManagedUserListParams,
  ManagedUserRole,
  UpdateUserStatusRequest,
  User,
} from '@/lib/api/types'
import { DEFAULT_PAGE_SIZE, paginate } from '@/lib/pagination'
import {
  TABLE_CARD_LIST_CLASS,
  TABLE_CLASS,
  TABLE_TD_CLASS,
  TABLE_TH_CLASS,
  TABLE_WRAPPER_CLASS,
} from '@/lib/table-styles'
import { managedRoleTone } from '@/lib/visits/status-badge'
import {
  VENDOR_NAME_MAX_LENGTH,
  resolveVendorInput,
} from '@/lib/visits/vendor-input'
import { validateNik } from '@/lib/users/nik'
import { can, getRoleLabel, type Role } from '@/lib/auth/capabilities'
import { RequireRole } from '@/lib/auth/guards'
import { useSession } from '@/lib/auth/session'

// ---------------------------------------------------------------------------
// Helper murni (diekspor agar dapat diuji unit — lihat tests/superadmin-filters.test.ts)
// ---------------------------------------------------------------------------

/** Filter peran pada layar users: '' = Semua. Security DIKECUALIKAN — rumahnya di `/security`. */
export type ManagedRoleFilter = '' | 'admin' | 'vendor'

/** Lokasi penugasan wajib iff peran `admin`; disembunyikan iff `vendor` (kontrak §2). */
export function requiresManagedLocation(role: ManagedRoleFilter | ManagedUserRole): boolean {
  return role === 'admin'
}

/** Kolom Cabang/Vendor: nama cabang, atau nama vendor, atau strip. */
export function userAffiliationLabel(user: User): string {
  if (user.location_name !== null && user.location_name !== '') return user.location_name
  if (user.vendor_name !== null && user.vendor_name !== '') return user.vendor_name
  return '—'
}

export interface ManagedListFilter {
  role: ManagedRoleFilter
  search: string
  locationId: string
}

/**
 * Normalisasi filter UI menjadi query `GET /users` — string kosong
 * dihilangkan agar tidak terkirim sebagai param (kontrak §2).
 */
export function toManagedUserListParams(filter: ManagedListFilter): ManagedUserListParams {
  const params: ManagedUserListParams = {}
  if (filter.role !== '') params.role = filter.role
  if (filter.search.trim() !== '') params.search = filter.search.trim()
  if (filter.locationId !== 'all') params.location_id = filter.locationId
  return params
}

/** Filter status pada layar users; 'all' = semua status. */
export type ManagedStatusFilter = 'all' | 'active' | 'inactive' | 'blacklisted'

/** Sentinel "semua" untuk filter Vendor (selaras dengan filter Cabang). */
export const VENDOR_FILTER_ALL = 'all'

/**
 * Opsi dropdown Vendor = nama vendor unik dari user vendor yang SUDAH dimuat,
 * bukan dari katalog: user dengan vendor_name manual (di luar katalog) tetap
 * bisa difilter. Kolom yang dicocokkan persis kolom yang ditampilkan tabel.
 */
export function managedVendorOptions(users: User[]): SelectOption[] {
  const names = new Set<string>()
  for (const user of users) {
    if (user.role !== 'vendor') continue
    const name = (user.vendor_name ?? '').trim()
    if (name !== '') names.add(name)
  }
  const sorted = [...names].sort((a, b) => a.localeCompare(b, 'id'))
  return [
    { value: VENDOR_FILTER_ALL, label: 'Semua Vendor' },
    ...sorted.map((name) => ({ value: name, label: name })),
  ]
}

/**
 * Filter client-side daftar user: buang security, lalu terapkan status
 * ('all' = tanpa filter) dan vendor exact-match ('all' = tanpa filter).
 */
export function applyManagedUserFilters(
  users: User[],
  filter: { status: ManagedStatusFilter; vendor: string },
): User[] {
  return users.filter((user) => {
    if (user.role === 'security') return false
    if (filter.status !== 'all' && user.status !== filter.status) return false
    if (filter.vendor !== VENDOR_FILTER_ALL && (user.vendor_name ?? '') !== filter.vendor) return false
    return true
  })
}

/**
 * Baris user boleh menampilkan tombol hapus: bukan akun sendiri dan bukan
 * akun `super_admin` (kontrak DELETE /users/{id} → 403 untuk keduanya).
 * Guard peran (`can(role, 'deleteRecords')`) dicek terpisah di layar.
 */
export function isDeletableUser(target: User, currentUserId: string | null): boolean {
  if (currentUserId !== null && target.id === currentUserId) return false
  if (target.role === 'super_admin') return false
  return true
}

/** Tombol hapus tampil iff peran boleh hapus DAN baris boleh dihapus. */
export function canShowDeleteUser(role: Role, target: User, currentUserId: string | null): boolean {
  return can(role, 'deleteRecords') && isDeletableUser(target, currentUserId)
}

/** Pesan konfirmasi hapus user — menyebut nama agar tidak salah sasaran. */
export function deleteUserConfirmMessage(target: User): string {
  return `Hapus permanen akun "${target.name}" (${target.email})? Tindakan ini tidak dapat dibatalkan.`
}

// ---------------------------------------------------------------------------
// Pagination: kontrak reset halaman saat filter berubah
// ---------------------------------------------------------------------------

/** Snapshot nilai yang menentukan isi daftar user (filter bar + ukuran halaman). */
export interface UserFilterSnapshot {
  roleFilter: ManagedRoleFilter
  locationId: string
  search: string
  statusFilter: ManagedStatusFilter
  vendorFilter: string
  pageSize: number
}

/**
 * Nilai penentu halaman: perubahan salah satunya mengembalikan daftar ke
 * halaman 1 (kunci SAMA PERSIS dengan dependency effect reset di `UsersScreen`).
 */
export const USER_FILTER_DEP_KEYS = [
  'roleFilter',
  'locationId',
  'search',
  'statusFilter',
  'vendorFilter',
  'pageSize',
] as const satisfies readonly (keyof UserFilterSnapshot)[]

/** `true` bila ada satu nilai penentu halaman yang berubah (predikat murni, dapat diuji). */
export function shouldResetUserPage(
  prev: UserFilterSnapshot,
  next: UserFilterSnapshot,
): boolean {
  return USER_FILTER_DEP_KEYS.some((key) => prev[key] !== next[key])
}

// ---------------------------------------------------------------------------
// Opsi select
// ---------------------------------------------------------------------------

const ROLE_FILTER_OPTIONS: SelectOption[] = [
  { value: '', label: 'Semua Peran' },
  { value: 'admin', label: getRoleLabel('admin') },
  { value: 'vendor', label: getRoleLabel('vendor') },
]

const STATUS_FILTER_OPTIONS: SelectOption[] = [
  { value: 'all', label: 'Semua Status' },
  { value: 'active', label: 'Aktif' },
  { value: 'inactive', label: 'Nonaktif' },
  { value: 'blacklisted', label: 'Diblokir' },
]

const CREATE_ROLE_OPTIONS: SelectOption[] = [
  { value: 'admin', label: getRoleLabel('admin') },
  { value: 'vendor', label: getRoleLabel('vendor') },
]

/**
 * PRD §4 — Manajemen User & Vendor (super_admin).
 * Guard penuh `RequireRole allow=['super_admin']` + `SuperadminShell`.
 */
export default function UsersPage() {
  return (
    <RequireRole allow={['super_admin']}>
      <UsersScreen />
    </RequireRole>
  )
}

function UsersScreen() {
  const [roleFilter, setRoleFilter] = useState<ManagedRoleFilter>('')
  const [locationId, setLocationId] = useState('all')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<ManagedStatusFilter>('all')
  // Filter vendor (client-side, exact-match atas `vendor_name`).
  const [vendorFilter, setVendorFilter] = useState(VENDOR_FILTER_ALL)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)
  const [createOpen, setCreateOpen] = useState(false)
  const [deleting, setDeleting] = useState<User | null>(null)
  const [editing, setEditing] = useState<User | null>(null)
  const { user: currentUser } = useSession()
  const deleteMutation = useDeleteManagedUserMutation()
  const updateUser = useUpdateManagedUserMutation()
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

  const params = useMemo(
    () => toManagedUserListParams({ role: roleFilter, search, locationId }),
    [roleFilter, search, locationId],
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

  // Pengawas tak pernah tampil (rumahnya `/security`); status & vendor
  // difilter di KLIEN karena `GET /users` hanya mendukung role/search/
  // location_id. Vendor hanya aktif di mode vendor — lihat handler Peran.
  const rows: User[] = useMemo(
    () =>
      applyManagedUserFilters(usersQuery.data ?? [], {
        status: statusFilter,
        vendor: roleFilter === 'vendor' ? vendorFilter : VENDOR_FILTER_ALL,
      }),
    [usersQuery.data, statusFilter, roleFilter, vendorFilter],
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
    locationId,
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

  // `vendorFilter` hanya bisa non-'all' saat Peran = Vendor/Mitra (di-reset
  // otomatis saat keluar dari vendor), jadi cukup memeriksa nilainya saja.
  const isFiltered =
    roleFilter !== '' ||
    locationId !== 'all' ||
    search !== '' ||
    statusFilter !== 'all' ||
    vendorFilter !== VENDOR_FILTER_ALL

  /** Reset semua filter bar ke kondisi awal — dipakai tombol Reset Filter. */
  const handleResetFilters = (): void => {
    setRoleFilter('')
    setLocationId('all')
    setSearchInput('')
    setSearch('')
    setStatusFilter('all')
    setVendorFilter(VENDOR_FILTER_ALL)
  }

  return (
    <SuperadminShell
      pendingCount={pendingCount}
      allLocations={locations}
      activeHref="/users"
      onBranchChange={setLocationId}
      // Switcher shell mengikuti filter Cabang baris: nilainya DIKENDALIKAN
      // halaman (satu sumber kebenaran `locationId`) dan hanya tampil untuk
      // Peran = Koordinator Wilayah — peran lain tidak punya makna cabang.
      branchId={locationId}
      hideBranchSwitcher={roleFilter !== 'admin'}
    >
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-ink">Users & Vendor</h1>
          <p className="mt-1 text-sm text-ink-secondary">
            Kelola akun admin cabang dan Vendor/Mitra di seluruh nasional.
          </p>
        </div>
        <Button className="min-h-touch" onClick={() => setCreateOpen(true)}>
          <Plus className="size-4 shrink-0" aria-hidden="true" />
          Tambah User
        </Button>
      </div>

      <div className="card flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-40 flex-1 sm:w-48 sm:flex-none">
          <Select
            label="Peran"
            options={ROLE_FILTER_OPTIONS}
            value={roleFilter}
            onChange={(event) => {
              const next = event.target.value as ManagedRoleFilter
              setRoleFilter(next)
              // Cabang hanya bermakna untuk Koor. Wilayah; reset saat keluar.
              if (next !== 'admin') setLocationId('all')
              // Vendor hanya bermakna di mode vendor; reset saat keluar agar
              // tidak menyaring daftar peran lain secara senyap.
              if (next !== 'vendor') setVendorFilter(VENDOR_FILTER_ALL)
              // `search` & `status` sengaja tetap: keduanya tampil di semua peran.
            }}
          />
        </div>
        {/* Cabang tampil IFF Peran = Koordinator Wilayah — vendor tak punya
            penugasan cabang (kontrak `requiresManagedLocation`). */}
        {roleFilter === 'admin' ? (
          <div className="min-w-40 flex-1 sm:w-56 sm:flex-none">
            <Select
              label="Cabang"
              options={locationOptions}
              value={locationId}
              onChange={(event) => setLocationId(event.target.value)}
            />
          </div>
        ) : null}
        {/* Vendor: dropdown (exact-match) — opsi dari data vendor termuat. */}
        {roleFilter === 'vendor' ? (
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
            <Button variant="secondary" className="mt-4 min-h-touch" onClick={() => void usersQuery.refetch()}>
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
            <UserTable users={pageRows} currentUserId={currentUserId} viewerRole={viewerRole} onDelete={setDeleting} onEdit={setEditing} />
            <UserCards users={pageRows} currentUserId={currentUserId} viewerRole={viewerRole} onDelete={setDeleting} onEdit={setEditing} />
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

      {createOpen ? (
        <CreateUserModal locations={locations} onClose={() => setCreateOpen(false)} />
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
                  toast.success(`Perubahan ${editing.name} tersimpan`)
                  setEditing(null)
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

// ---------------------------------------------------------------------------
// Tabel desktop (>= 1024px) + kartu responsif: ponsel (< 768px) tumpukan
// vertikal 1 kolom, tablet (768px - 1023px) grid 2 kolom — tanpa scroll.
// ---------------------------------------------------------------------------

function useToggleManagedStatus() {
  const update = useUpdateManagedUserStatusMutation()
  const toggle = (user: User): void => {
    const next: UpdateUserStatusRequest['status'] = user.status === 'active' ? 'inactive' : 'active'
    update.mutate(
      { userId: user.id, body: { status: next } },
      {
        onSuccess: () => {
          toast.success(`Status ${user.name} diperbarui`)
        },
        // Larangan server (akun sendiri & super_admin) tampil apa adanya.
        onError: (error) => {
          toast.error(apiErrorMessage(error))
        },
      },
    )
  }
  return { toggle, isPending: update.isPending, activeId: update.variables?.userId }
}

function StatusCell({ status, className }: { status: User['status']; className?: string }) {
  if (status === 'active') return <Badge tone="success" className={className}>Aktif</Badge>
  if (status === 'blacklisted') return <Badge tone="danger" className={className}>Diblokir</Badge>
  return <Badge tone="neutral" className={className}>Nonaktif</Badge>
}

function UserTable({ users, currentUserId, viewerRole, onDelete, onEdit }: { users: User[]; currentUserId: string | null; viewerRole: Role | null; onDelete: (user: User) => void; onEdit: (user: User) => void }) {
  const { toggle, isPending, activeId } = useToggleManagedStatus()

  return (
    <div className={TABLE_WRAPPER_CLASS}>
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            {[
              { label: 'Nama', width: 'w-[20%]' },
              { label: 'Email', width: 'w-[22%]' },
              { label: 'Peran', width: 'w-[12%]' },
              { label: 'Cabang / Vendor', width: 'w-[20%]' },
              { label: 'Status', width: 'w-[11%]' },
              { label: 'Aksi', width: 'w-[7%]' },
            ].map((header) => (
              <th
                key={header.label}
                scope="col"
                className={`${header.width} ${TABLE_TH_CLASS}`}
              >
                {header.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border-light">
          {users.map((user) => {
            const toggleable = user.status === 'active' || user.status === 'inactive'
            const actions: ActionMenuItem[] = [
              {
                id: 'edit',
                label: 'Ubah',
                icon: <Pencil aria-hidden="true" className="size-4" />,
                onSelect: () => onEdit(user),
                tone: 'default',
              },
            ]
            if (toggleable) {
              actions.push({
                id: 'toggle',
                label: user.status === 'active' ? 'Nonaktifkan' : 'Aktifkan',
                icon: <Power aria-hidden="true" className="size-4" />,
                onSelect: () => toggle(user),
                tone: 'default',
              })
            }
            if (viewerRole !== null && canShowDeleteUser(viewerRole, user, currentUserId)) {
              actions.push({
                id: 'delete',
                label: 'Hapus',
                icon: <Trash2 aria-hidden="true" className="size-4" />,
                onSelect: () => onDelete(user),
                tone: 'danger',
              })
            }
            return (
              <tr
                key={user.id}
                className="transition-colors hover:bg-brand/5"
              >
                <td className={TABLE_TD_CLASS}>
                  <p className="truncate text-xs sm:text-sm font-semibold text-ink" title={user.name}>
                    {user.name}
                  </p>
                  <p
                    className="mt-0.5 truncate text-xs text-ink-muted"
                    title={user.nik ?? 'Tanpa NIK'}
                  >
                    {user.nik !== null ? `NIK ${user.nik}` : 'NIK —'}
                  </p>
                </td>
                <td className={`truncate ${TABLE_TD_CLASS} text-xs sm:text-sm text-ink-secondary`} title={user.email}>
                  {user.email}
                </td>
                <td className={TABLE_TD_CLASS}>
                  <Badge tone={managedRoleTone(user.role)}>{getRoleLabel(user.role)}</Badge>
                </td>
                <td className={`truncate ${TABLE_TD_CLASS} text-xs sm:text-sm text-ink-secondary`} title={userAffiliationLabel(user)}>
                  {userAffiliationLabel(user)}
                </td>
                <td className={TABLE_TD_CLASS}>
                  <StatusCell status={user.status} />
                </td>
                <td className={`${TABLE_TD_CLASS} text-right`}>
                  <ActionMenu
                    label={`Aksi untuk ${user.name}`}
                    busy={isPending && activeId === user.id}
                    items={actions}
                  />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function UserCards({ users, currentUserId, viewerRole, onDelete, onEdit }: { users: User[]; currentUserId: string | null; viewerRole: Role | null; onDelete: (user: User) => void; onEdit: (user: User) => void }) {
  const { toggle, isPending, activeId } = useToggleManagedStatus()

  return (
    <ul className={TABLE_CARD_LIST_CLASS}>
      {users.map((user) => {
        const toggleable = user.status === 'active' || user.status === 'inactive'
        const actions: ActionMenuItem[] = [
          {
            id: 'edit',
            label: 'Ubah',
            icon: <Pencil aria-hidden="true" className="size-4" />,
            onSelect: () => onEdit(user),
            tone: 'default',
          },
        ]
        if (toggleable) {
          actions.push({
            id: 'toggle',
            label: user.status === 'active' ? 'Nonaktifkan' : 'Aktifkan',
            icon: <Power aria-hidden="true" className="size-4" />,
            onSelect: () => toggle(user),
            tone: 'default',
          })
        }
        if (viewerRole !== null && canShowDeleteUser(viewerRole, user, currentUserId)) {
          actions.push({
            id: 'delete',
            label: 'Hapus',
            icon: <Trash2 aria-hidden="true" className="size-4" />,
            onSelect: () => onDelete(user),
            tone: 'danger',
          })
        }
        return (
          <li key={user.id} className="card flex flex-col p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink" title={user.name}>
                  {user.name}
                </p>
                <p className="truncate text-xs text-ink-muted" title={user.email}>
                  {user.email}
                </p>
                <p
                  className="mt-0.5 truncate text-xs text-ink-muted"
                  title={user.nik ?? 'Tanpa NIK'}
                >
                  {user.nik !== null ? `NIK ${user.nik}` : 'NIK —'}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <StatusCell status={user.status} />
                <ActionMenu
                  label={`Aksi untuk ${user.name}`}
                  busy={isPending && activeId === user.id}
                  items={actions}
                />
              </div>
            </div>
            <div className="mt-3 flex flex-1 flex-col gap-2 text-sm text-ink-secondary">
              <p className="flex items-start gap-2">
                <UserRound className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
                <Badge tone={managedRoleTone(user.role)}>{getRoleLabel(user.role)}</Badge>
              </p>
              <p className="flex items-start gap-2">
                <Building2 className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
                <span className="min-w-0 wrap-anywhere" title={userAffiliationLabel(user)}>
                  {userAffiliationLabel(user)}
                </span>
              </p>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Modal create (pola SecurityUserModal)
// ---------------------------------------------------------------------------

interface CreateUserModalProps {
  locations: Array<{ id: string; name: string }>
  onClose: () => void
}

function CreateUserModal({ locations, onClose }: CreateUserModalProps) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [phone, setPhone] = useState('')
  const [nik, setNik] = useState('')
  const [nikError, setNikError] = useState<string | undefined>(undefined)
  const [role, setRole] = useState<ManagedUserRole>('admin')
  const [locationId, setLocationId] = useState('')
  // Teks vendor bebas (bukan id): boleh pilih dari katalog via <datalist>
  // ATAU ketik manual; dipetakan saat submit lewat `resolveVendorInput`.
  const [vendorText, setVendorText] = useState('')

  const create = useCreateManagedUserMutation()
  const needsLocation = requiresManagedLocation(role)
  // Katalog vendor hanya untuk Vendor/Mitra; dimuat hanya saat dibutuhkan.
  const vendorsQuery = useVendorsQuery(role === 'vendor')
  const locationOptions: SelectOption[] = locations.map((location) => ({
    value: location.id,
    label: location.name,
  }))

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (name.trim() === '' || email.trim() === '' || password === '') return
    if (needsLocation && locationId === '') return

    // NIK wajib untuk admin & vendor (BE: 400 bila absen/format salah).
    const error = validateNik(nik, true)
    setNikError(error ?? undefined)
    if (error !== null) return

    // Vendor/Mitra: teks cocok katalog → vendor_id; selain itu vendor_name manual;
    // kosong → tanpa field apa pun (absen). Nama ketikan manual tidak
    // pernah ditambahkan ke katalog vendor.
    const resolvedVendor = needsLocation
      ? {}
      : resolveVendorInput(vendorText, vendorsQuery.data ?? [])

    const body: CreateManagedUserRequest = {
      name: name.trim(),
      email: email.trim(),
      password,
      ...(phone.trim() !== '' ? { phone: phone.trim() } : {}),
      nik: nik.trim(),
      role,
      ...(needsLocation ? { location_id: locationId } : {}),
      ...resolvedVendor,
    }
    create.mutate(
      { body },
      {
        onSuccess: () => {
          toast.success(`${name.trim()} berhasil ditambahkan`)
          onClose()
        },
        onError: (error) => {
          toast.error(apiErrorMessage(error))
        },
      },
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Tambah User"
      size="lg"
      footer={
        <>
          <Button variant="ghost" className="min-h-touch" onClick={onClose}>
            Batal
          </Button>
          <Button
            type="submit"
            form="managed-user-form"
            className="min-h-touch"
            loading={create.isPending}
          >
            Tambah User
          </Button>
        </>
      }
    >
      <form id="managed-user-form" onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Nama Lengkap"
            placeholder="Nama user"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="name"
            required
          />
          <Input
            label="Email"
            type="email"
            placeholder="nama@thc.id"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            required
          />
          <Input
            label="No. Telepon"
            type="tel"
            placeholder="08xxxxxxxxxx"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            autoComplete="tel"
          />
          <Input
            label="Kata Sandi"
            type="password"
            placeholder="Kata sandi awal"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            hint="Dibagikan ke user; dapat diubah setelah masuk."
            required
          />
        </div>
        <Select
          label="Peran"
          options={CREATE_ROLE_OPTIONS}
          value={role}
          onChange={(event) => {
            const next = event.target.value as ManagedUserRole
            setRole(next)
            if (!requiresManagedLocation(next)) setLocationId('')
            else setVendorText('')
          }}
          required
        />
          {/* NIK tampil iff admin|vendor (BE wajib untuk keduanya). */}
        <Input
          label="NIK"
          placeholder="16 digit Nomor Induk Kependudukan"
          value={nik}
          inputMode="numeric"
          maxLength={16}
          autoComplete="off"
          error={nikError}
          onChange={(event) => {
            setNik(event.target.value)
            if (nikError !== undefined) setNikError(undefined)
          }}
          required
        />
        {needsLocation ? (
          <Select
            label="Cabang Penugasan"
            placeholder="Pilih cabang / POP"
            options={locationOptions}
            value={locationId}
            onChange={(event) => setLocationId(event.target.value)}
            required
          />
        ) : (
          <>
            {/* Vendor bebas-teks + <datalist>: saran HANYA nama terdaftar;
                teks ketikan manual tidak pernah menjadi opsi daftar. */}
            <Input
              label="Vendor"
              placeholder={
                vendorsQuery.isPending
                  ? 'Memuat vendor…'
                  : 'Pilih dari daftar atau ketik nama vendor'
              }
              hint="Pilih dari daftar atau ketik manual. Nama yang diketik manual tidak masuk daftar vendor."
              value={vendorText}
              onChange={(event) => setVendorText(event.target.value)}
              list="users-create-vendor-datalist"
              autoComplete="off"
              maxLength={VENDOR_NAME_MAX_LENGTH}
            />
            <datalist id="users-create-vendor-datalist">
              {(vendorsQuery.data ?? []).map((vendor) => (
                <option key={vendor.id} value={vendor.name} />
              ))}
            </datalist>
          </>
        )}
      </form>
    </Modal>
  )
}
