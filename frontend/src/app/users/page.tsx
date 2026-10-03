'use client'

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { AlertTriangle, Building2, Inbox, Pencil, Plus, Power, Trash2, UserRound } from 'lucide-react'
import { toast } from 'sonner'
import { SuperadminShell } from '@/components/layouts/SuperadminShell'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { EmptyState } from '@/components/ui/EmptyState'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
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
  useUpdateManagedUserStatusMutation,
  useVendorsQuery,
  useVisitsQuery,
} from '@/lib/api/hooks'
import type {
  CreateManagedUserRequest,
  ManagedUserListParams,
  ManagedUserRole,
  UpdateUserStatusRequest,
  User,
} from '@/lib/api/types'
import { managedRoleTone, type StatusTone } from '@/lib/visits/status-badge'
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
// Opsi select
// ---------------------------------------------------------------------------

const ROLE_FILTER_OPTIONS: SelectOption[] = [
  { value: '', label: 'Semua Peran' },
  { value: 'admin', label: getRoleLabel('admin') },
  { value: 'vendor', label: getRoleLabel('vendor') },
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
  // Badge antrean shell: total requested lintas cabang (limit 1 — hanya total yang dipakai).
  const pendingQuery = useVisitsQuery({ status: 'requested', limit: 1 })

  const params = useMemo(
    () => toManagedUserListParams({ role: roleFilter, search, locationId }),
    [roleFilter, search, locationId],
  )
  const usersQuery = useManagedUsersQuery(params)

  const locations = useMemo(() => locationsQuery.data ?? [], [locationsQuery.data])
  // Satpam tidak pernah tampil di sini walau API mengembalikannya (filter
  // '' berarti semua peran): rumah kanonisnya `/security`. Satu tempat,
  // satu aturan — anti-bingung.
  const rows: User[] = useMemo(
    () => (usersQuery.data ?? []).filter((user) => user.role !== 'security'),
    [usersQuery.data],
  )
  const pendingCount = pendingQuery.data?.total ?? 0

  const locationOptions: SelectOption[] = useMemo(
    () => [
      { value: 'all', label: 'Semua Cabang / POP' },
      ...locations.map((location) => ({ value: location.id, label: location.name })),
    ],
    [locations],
  )

  const isFiltered = roleFilter !== '' || locationId !== 'all' || search !== ''

  return (
    <SuperadminShell
      pendingCount={pendingCount}
      allLocations={locations}
      activeHref="/users"
      onBranchChange={setLocationId}
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
            onChange={(event) => setRoleFilter(event.target.value as ManagedRoleFilter)}
          />
        </div>
        <div className="min-w-40 flex-1 sm:w-56 sm:flex-none">
          <Select
            label="Cabang"
            options={locationOptions}
            value={locationId}
            onChange={(event) => setLocationId(event.target.value)}
          />
        </div>
        <div className="relative min-w-48 flex-1">
          <Input
            aria-label="Cari user"
            placeholder="Cari nama atau email…"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </div>
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
            <UserTable users={rows} currentUserId={currentUserId} viewerRole={viewerRole} onDelete={setDeleting} onEdit={setEditing} />
            <UserCards users={rows} currentUserId={currentUserId} viewerRole={viewerRole} onDelete={setDeleting} onEdit={setEditing} />
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
  if (status === 'active') return <Badge tone="success" className={className}>AKTIF</Badge>
  if (status === 'blacklisted') return <Badge tone="danger" className={className}>DIBLOKIR</Badge>
  return <Badge tone="neutral" className={className}>NONAKTIF</Badge>
}

function UserTable({ users, currentUserId, viewerRole, onDelete, onEdit }: { users: User[]; currentUserId: string | null; viewerRole: Role | null; onDelete: (user: User) => void; onEdit: (user: User) => void }) {
  const { toggle, isPending, activeId } = useToggleManagedStatus()

  return (
    <div className="card hidden overflow-hidden lg:block">
      <table className="w-full table-fixed border-collapse text-left">
        <thead>
          <tr>
            {[
              { label: 'Nama', width: 'w-[20%]' },
              { label: 'Email', width: 'w-[22%]' },
              { label: 'Peran', width: 'w-[12%]' },
              { label: 'Cabang / Vendor', width: 'w-[20%]' },
              { label: 'Status', width: 'w-[11%]' },
              { label: 'Aksi', width: 'w-[15%]' },
            ].map((header) => (
              <th
                key={header.label}
                scope="col"
                className={`${header.width} border-b border-border-light bg-neutral-bg px-4 py-3 text-label font-semibold text-ink-secondary`}
              >
                {header.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {users.map((user) => {
            const toggleable = user.status === 'active' || user.status === 'inactive'
            return (
              <tr
                key={user.id}
                className="border-b border-border-light transition-colors last:border-b-0 hover:bg-page"
              >
                <td className="px-4 py-3">
                  <p className="truncate text-sm font-semibold text-ink" title={user.name}>
                    {user.name}
                  </p>
                  <p
                    className="mt-0.5 truncate text-xs text-ink-muted"
                    title={user.nik ?? 'Tanpa NIK'}
                  >
                    {user.nik !== null ? `NIK ${user.nik}` : 'NIK —'}
                  </p>
                </td>
                <td className="truncate px-4 py-3 text-sm text-ink-secondary" title={user.email}>
                  {user.email}
                </td>
                <td className="px-4 py-3">
                  <Badge tone={managedRoleTone(user.role)}>{getRoleLabel(user.role)}</Badge>
                </td>
                <td className="truncate px-4 py-3 text-sm text-ink-secondary" title={userAffiliationLabel(user)}>
                  {userAffiliationLabel(user)}
                </td>
                <td className="px-4 py-3">
                  <StatusCell status={user.status} />
                </td>
                <td className="px-4 py-3">
                  {/*
                    Sel Aksi 15% (~105px di 1024px) lebih sempit dari label
                    "Nonaktifkan" (~114px) sehingga tombol meluber ke kolom
                    Status. Pola: ikon-saja di lg–xl, label teks kembali di
                    xl+; screen reader tetap mendengar lewat aria-label.
                  */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="secondary"
                      className="min-h-touch px-3"
                      aria-label={`Ubah ${user.name}`}
                      onClick={() => onEdit(user)}
                    >
                      <Pencil aria-hidden="true" className="size-4 shrink-0" />
                      <span className="hidden xl:inline">Ubah</span>
                    </Button>
                    {toggleable ? (
                      <Button
                        size="sm"
                        variant={user.status === 'active' ? 'secondary' : 'primary'}
                        className="min-h-touch px-3"
                        aria-label={`${user.status === 'active' ? 'Nonaktifkan' : 'Aktifkan'} ${user.name}`}
                        loading={isPending && activeId === user.id}
                        onClick={() => toggle(user)}
                      >
                        <Power aria-hidden="true" className="size-4 shrink-0 xl:hidden" />
                        <span className="hidden xl:inline">
                          {user.status === 'active' ? 'Nonaktifkan' : 'Aktifkan'}
                        </span>
                      </Button>
                    ) : (
                      <span className="text-ink-muted" aria-hidden="true">
                        —
                      </span>
                    )}
                    {viewerRole !== null && canShowDeleteUser(viewerRole, user, currentUserId) ? (
                      <Button
                        size="sm"
                        variant="danger"
                        className="min-h-touch px-3"
                        aria-label={`Hapus ${user.name}`}
                        onClick={() => onDelete(user)}
                      >
                        <Trash2 aria-hidden="true" className="size-4 shrink-0" />
                        <span className="hidden xl:inline">Hapus</span>
                      </Button>
                    ) : null}
                  </div>
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
    <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:hidden">
      {users.map((user) => {
        const toggleable = user.status === 'active' || user.status === 'inactive'
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
              <StatusCell status={user.status} className="shrink-0" />
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
            {/* Halaman ini khusus super_admin: tombol Ubah selalu ada bila sesi
                termuat; toggle/hapus menjaga syarat barisnya masing-masing.
                Cluster aksi WRAP agar 3 tombol muat di 375px tanpa overflow. */}
            {viewerRole !== null ? (
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  className="min-h-touch flex-1"
                  aria-label={`Ubah ${user.name}`}
                  onClick={() => onEdit(user)}
                >
                  <Pencil aria-hidden="true" className="size-4 shrink-0" />
                  Ubah
                </Button>
                {toggleable ? (
                  <Button
                    variant={user.status === 'active' ? 'secondary' : 'primary'}
                    className="min-h-touch flex-1"
                    loading={isPending && activeId === user.id}
                    onClick={() => toggle(user)}
                  >
                    {user.status === 'active' ? 'Nonaktifkan' : 'Aktifkan'}
                  </Button>
                ) : null}
                {viewerRole !== null && canShowDeleteUser(viewerRole, user, currentUserId) ? (
                  <Button
                    variant="danger"
                    className="min-h-touch flex-1"
                    aria-label={`Hapus ${user.name}`}
                    onClick={() => onDelete(user)}
                  >
                    <Trash2 aria-hidden="true" className="size-4 shrink-0" />
                    Hapus
                  </Button>
                ) : null}
              </div>
            ) : null}
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
