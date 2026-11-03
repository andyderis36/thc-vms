'use client'

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { AlertTriangle, Eye, Inbox, Lock, Pencil, Plus, Power, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { DetailModal, type DetailField } from '@/components/ui/DetailModal'
import { EditUserModal } from '@/features/users/components/EditUserModal'
import { EmptyState } from '@/components/ui/EmptyState'
import { FilterResetButton } from '@/components/ui/FilterResetButton'
import { Input } from '@/components/ui/Input'
import { SearchInput } from '@/components/ui/SearchInput'
import { Modal } from '@/components/ui/Modal'
import { PasswordInput } from '@/components/ui/PasswordInput'
import { Pagination } from '@/components/ui/Pagination'
import { Select, type SelectOption } from '@/components/ui/Select'
import { Spinner } from '@/components/ui/Spinner'
import { UserAvatar } from '@/components/ui/UserAvatar'
import {
  useCreateSecurityUserMutation,
  useDeleteSecurityUserMutation,
  useLocationsQuery,
  useSecurityUsersQuery,
  useUpdateSecurityUserMutation,
  useUpdateSecurityUserStatusMutation,
} from '@/lib/api/hooks'
import { DEFAULT_PAGE_SIZE, paginate } from '@/lib/pagination'
import { TABLE_CLASS, TABLE_WRAPPER_CLASS } from '@/lib/table-styles'
import { useSession } from '@/lib/auth/session'
import { can, getRoleLabel, isSuperAdminRole } from '@/lib/auth/capabilities'
import type { Role, UpdateUserStatusRequest, User } from '@/lib/api/types'
import {
  EMAIL_MAX_LENGTH,
  NAME_MAX_LENGTH,
  PASSWORD_MAX_BYTES,
  PHONE_DIGIT_MESSAGE,
  PHONE_MAX_LENGTH,
  PHONE_MIN_LENGTH,
  SEARCH_QUERY_MAX_LENGTH,
  isValidEmail,
  isValidPassword,
  isValidPhone,
  sanitizePhoneInput,
} from '@/lib/limits'

/** Salinan lokal (sengaja tanpa lintas-feature import): pesan error aman untuk UI. */
function apiErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') {
    return error.message
  }
  return 'Terjadi kesalahan. Silakan coba lagi.'
}

/** Pesan konfirmasi hapus pengawas — menyebut nama agar tidak salah sasaran. */
export function deleteSecurityUserConfirmMessage(target: User): string {
  return `Hapus permanen akun ${getRoleLabel('security').toLowerCase()} "${target.name}" (${target.email})? Tindakan ini tidak dapat dibatalkan.`
}

/**
 * Tombol hapus tampil iff peran boleh hapus (`deleteSecurity`) DAN baris
 * satu cabang dengan admin. `super_admin` bebas lintas cabang; `admin`
 * terkunci ke `location_id` miliknya (pertahanan kedua — server garis utama).
 */
export function canShowDeleteSecurityUser(
  role: Role,
  target: User,
  ownLocationId: string | null,
): boolean {
  if (!can(role, 'deleteSecurity')) return false
  if (isSuperAdminRole(role)) return true
  return ownLocationId !== null && target.location_id === ownLocationId
}

/** Kolom Cabang tabel: nama cabang penugasan, atau strip bila tak ada. */
function securityUserLocationLabel(user: User): string {
  const location = user.location_name
  return location !== null && location !== '' ? location : '—'
}

/**
 * Label ringkas kartu: `email · cabang`. Satu sumber komposisi — tabel
 * memecahnya menjadi kolom Email + Cabang lewat `securityUserLocationLabel`.
 */
function securityUserDetailLabel(user: User): string {
  return user.location_name !== null
    ? `${user.email} · ${user.location_name}`
    : user.email
}

/** Badge status pengawas — satu resep untuk tabel & kartu (visual identik). */
function SecurityStatusBadge({ status, className }: { status: User['status']; className?: string }) {
  if (status === 'active') return <Badge tone="success" className={className}>Aktif</Badge>
  if (status === 'pending') return <Badge tone="warning" className={className}>Menunggu</Badge>
  if (status === 'blacklisted') return <Badge tone="danger" className={className}>Diblokir</Badge>
  return <Badge tone="neutral" className={className}>Nonaktif</Badge>
}

/** Opsi filter status pada toolbar daftar pengawas (sentinel 'all' = semua). */
const STATUS_FILTER_OPTIONS: SelectOption[] = [
  { value: 'all', label: 'Semua Status' },
  { value: 'active', label: 'Aktif' },
  { value: 'inactive', label: 'Nonaktif' },
  { value: 'blacklisted', label: 'Diblokir' },
]

export interface SecurityUserPanelProps {
  /**
   * Gerbang fetch daftar: modal melewatkan `open`, halaman melewatkan `true`.
   * Form di-reset setiap `enabled` berubah false -> true.
   */
  enabled: boolean
  /** Dipanggil setelah pengawas berhasil ditambahkan (modal: tutup diri). */
  onCreated?: () => void
  /**
   * Permukaan render panel: `'page'` = rute mandiri `/security` (boleh tabel
   * desktop); `'modal'` = di dalam `SecurityUserModal` (~512px, KARTU saja —
   * tak pernah tabel, karena `lg:` mengikuti viewport bukan lebar kontainer).
   * Default `'modal'` supaya pemakaian lama tetap aman.
   */
  variant?: 'page' | 'modal'
  /**
   * Dilaporkan setiap jumlah daftar tersaring berubah — dipakai halaman
   * `/security` untuk badge total di samping h1 (panel yang memegang data).
   */
  onCountChange?: (count: number) => void
  /**
   * Modal tambah terkontrol: halaman `/security` memegang tombolnya sendiri
   * di baris judul (sejajar h1) sehingga panel hanya merender daftar +
   * filter. Bila diisi, tombol internal disembunyikan dan modal dikendalikan
   * dari luar; bila kosong (varian modal), perilaku internal tak berubah.
   */
  createOpen?: boolean
  onCreateOpenChange?: (open: boolean) => void
}

/**
 * Isi manajemen pengawas: tombol tambah (membuka modal) + daftar kartu
 * responsif (ponsel 1 kolom / tablet & desktop 2 kolom) + toggle status.
 *
 * Satu permukaan HIDUP saat ini: halaman mandiri `/security` yang men-mount
 * panel dengan `variant="page"` (tabel desktop + kartu). `SecurityUserModal`
 * di file ini masih diekspor untuk PRD SCR-02 ("modal pengawas") tetapi belum
 * dipasang di mana pun — dan itulah alasan `variant` ada: begitu panel
 * dipasang di dalam modal, ia WAJIB memakai `variant="modal"` (kartu saja)
 * agar tabel 5 kolom tidak meluber di modal 512px. Logika peran tetap sama di
 * kedua permukaan: super_admin memilih cabang, admin terkunci ke cabangnya.
 * Guard `manageSecurity` di sini adalah lapisan kedua setelah guard rute.
 * Tanpa field NIK (BE menolak NIK untuk security — cermin `rejectSecurityNik`
 * di mock/BE).
 */
export function SecurityUserPanel({ enabled, onCreated, variant = 'modal', onCountChange, createOpen: controlledOpen, onCreateOpenChange }: SecurityUserPanelProps) {
  const { user } = useSession()
  const role: Role | null = user !== null ? user.role : null
  const ownLocationId = user !== null ? user.location_id : null

  const [createOpenInternal, setCreateOpenInternal] = useState(false)
  const createOpen = controlledOpen ?? createOpenInternal
  const setCreateOpen = onCreateOpenChange ?? setCreateOpenInternal
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | User['status']>('all')
  // Pagination client-side: seluruh anggota cabang dimuat sekali, lalu dipotong
  // per halaman di peramban (GET /users/security tak punya param pagination).
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)

  // Debounce pencarian 300ms supaya setiap ketikan tidak memicu render filter
  // (pola identik halaman users benchmark).
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  // Filter/ukuran halaman berubah → kembali ke halaman 1: baris halaman N
  // tidak relevan untuk kombinasi filter baru. Presisi tiga dependensi ini.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- kontrak reset-on-filter: efek dengan deps persis [search, statusFilter, pageSize]
    setPage(1)
  }, [search, statusFilter, pageSize])

  const locationsQuery = useLocationsQuery()
  const toggleStatus = useUpdateSecurityUserStatusMutation()
  const deleteUser = useDeleteSecurityUserMutation()
  const [deleting, setDeleting] = useState<User | null>(null)
  const [editing, setEditing] = useState<User | null>(null)
  const [detail, setDetail] = useState<User | null>(null)
  const updateSecurity = useUpdateSecurityUserMutation()

  // Lokasi cabang penugasan: super_admin memilih; admin terkunci ke cabangnya.
  const effectiveLocationId = role !== null && isSuperAdminRole(role) ? '' : (ownLocationId ?? '')
  const usersQuery = useSecurityUsersQuery(effectiveLocationId !== '' ? effectiveLocationId : undefined, enabled)

  // Filter daftar di sisi klien: kontrak GET /users/security hanya punya
  // location_id (tak ada param search/status), jadi pencarian disaring di sini.
  // `?? []` di luar useMemo memunculkan larik BARU tiap render, sehingga
  // `filteredUsers` di bawahnya tak pernah benar-benar di-memoize.
  const users = useMemo(() => usersQuery.data ?? [], [usersQuery.data])
  const filteredUsers = useMemo(() => {
    const query = search.toLowerCase()
    return users.filter((member) => {
      if (statusFilter !== 'all' && member.status !== statusFilter) return false
      if (query === '') return true
      return (
        member.name.toLowerCase().includes(query) ||
        member.email.toLowerCase().includes(query) ||
        (member.location_name ?? '').toLowerCase().includes(query)
      )
    })
  }, [users, search, statusFilter])

  // `page` hasil clamp dari `paginate` yang WAJIB dirender (bukan state mentah):
  // setelah data ter-refetch menyusut, halaman basi tak pernah menampilkan slice kosong.
  const { items: pageUsers, page: currentPage, totalPages } = paginate(filteredUsers, page, pageSize)

  useEffect(() => {
    onCountChange?.(filteredUsers.length)
  }, [onCountChange, filteredUsers.length])

  if (role === null || !can(role, 'manageSecurity')) return null

  const handleToggle = (userId: string, userName: string, next: UpdateUserStatusRequest['status']): void => {
    toggleStatus.mutate(
      { userId, body: { status: next } },
      {
        onSuccess: () => {
          toast.success(`Status ${userName} diperbarui`)
        },
        onError: (error) => {
          toast.error(apiErrorMessage(error))
        },
      },
    )
  }

  const handleToggleFor = (member: User): void => {
    handleToggle(member.id, member.name, member.status === 'active' ? 'inactive' : 'active')
  }

  const locationOptions = (locationsQuery.data ?? []).map((location) => ({
    value: location.id,
    label: location.name,
  }))
  const canPickLocation = role !== null && isSuperAdminRole(role)

  // Reset SEMUA filter bar ke default: pencarian (state mentah + state debounced)
  // dan status. Pagination di sini SERBA KLIEN: panel memuat seluruh anggota
  // cabang dalam satu query lalu memotongnya per halaman, dan perubahan filter
  // memicu efek `setPage(1)` (lihat dependensi search/statusFilter di atas) —
  // jadi reset ini tak pernah meninggalkan pengguna di halaman basi.
  // Kedua state pencarian dibersihkan sekaligus supaya debounce 300ms tidak
  // "menghidupkan kembali" query lama dari searchInput yang tertinggal.
  const handleResetFilters = (): void => {
    setSearchInput('')
    setSearch('')
    setStatusFilter('all')
  }

  // Tombol reset hanya aktif bila benar-benar ada filter yang menyimpang dari
  // default (sentinel status 'all' + pencarian kosong) — hindari klik percuma.
  const isFiltered = searchInput.trim() !== '' || search !== '' || statusFilter !== 'all'

  return (
    <div className="flex flex-col gap-4">
      {onCreateOpenChange === undefined ? (
        <div className="flex flex-wrap items-center justify-end gap-3">
          <Button className="min-h-touch" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4 shrink-0" aria-hidden="true" />
            Tambah {getRoleLabel('security')}
          </Button>
        </div>
      ) : null}

      {/* Toolbar filter irisan SCR-02 — pola users benchmark: select berlabel
          + search ber-aria-label, wrap rapi di 375/768/1280 tanpa scroll. */}
      <div className="card flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-40 flex-1 sm:w-48 sm:flex-none">
          <Select
            label="Status"
            options={STATUS_FILTER_OPTIONS}
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as 'all' | User['status'])}
          />
        </div>
        <div className="relative min-w-48 flex-1">
          <span aria-hidden="true" className="mb-2 block text-label font-semibold text-ink">
            Pencarian
          </span>
          <SearchInput
            aria-label={`Cari ${getRoleLabel('security').toLowerCase()}`}
            placeholder="Cari nama, email, atau cabang…"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            maxLength={SEARCH_QUERY_MAX_LENGTH}
          />
        </div>
        <div className="flex items-end gap-3">
          <FilterResetButton onReset={handleResetFilters} disabled={!isFiltered} />
        </div>
      </div>

      <CreateSecurityModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        canPickLocation={canPickLocation}
        locationOptions={locationOptions}
        lockedLocationId={ownLocationId ?? ''}
        lockedLocationLabel={user !== null ? (user.location_name ?? 'Cabang') : 'Cabang'}
        onCreated={() => {
          setCreateOpen(false)
          onCreated?.()
        }}
      />

      <div className="border-t border-border-light pt-4">
        {usersQuery.isPending ? (
          <div className="flex items-center gap-2 py-4 text-sm text-ink-muted">
            <Spinner size="sm" />
            Memuat daftar {getRoleLabel('security').toLowerCase()}…
          </div>
        ) : usersQuery.isError ? (
          <div className="card p-6">
            <p className="flex items-center gap-2 text-sm font-semibold text-danger-text">
              <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
              Gagal memuat daftar {getRoleLabel('security').toLowerCase()}
            </p>
            <p className="mt-2 text-sm text-ink-secondary">{apiErrorMessage(usersQuery.error)}</p>
            <Button
              variant="secondary"
              className="mt-4 min-h-touch"
              onClick={() => void usersQuery.refetch()}
            >
              Coba Lagi
            </Button>
          </div>
        ) : users.length === 0 ? (
          <div className="card">
            <EmptyState
              icon={<Inbox aria-hidden="true" className="size-8" />}
              title={`Belum ada ${getRoleLabel('security').toLowerCase()} terdaftar`}
              description={`${getRoleLabel('security')} yang didaftarkan akan muncul di sini.`}
            />
          </div>
        ) : filteredUsers.length === 0 ? (
          <div className="card">
            <EmptyState
              icon={<Inbox aria-hidden="true" className="size-8" />}
              title={`Tidak ada ${getRoleLabel('security').toLowerCase()} yang cocok`}
              description="Coba ubah kata kunci pencarian atau filter Anda."
            />
          </div>
        ) : (
          <>
            {/* Tabel desktop HANYA untuk variant="page": modal ~512px tetap
                kartu-saja karena `lg:` bergantung pada VIEWPORT, bukan lebar
                kontainer — tabel 5 kolom akan meluber keluar modal pada 1280px. */}
            {variant === 'page' ? (
              <SecurityUserTable
                users={pageUsers}
                role={role}
                ownLocationId={ownLocationId}
                togglePending={toggleStatus.isPending}
                toggleUserId={toggleStatus.variables?.userId}
                onEdit={setEditing}
                onDelete={setDeleting}
                onToggle={handleToggleFor}
                onView={setDetail}
                page={currentPage}
                pageSize={pageSize}
              />
            ) : null}
            {/* Kartu: di mode page dibatasi `lg:hidden` (tabel mengambil alih);
                di mode modal tanpa breakpoint karena inilah satu-satunya daftar. */}
            <SecurityUserCards
              users={pageUsers}
              role={role}
              ownLocationId={ownLocationId}
              togglePending={toggleStatus.isPending}
              toggleUserId={toggleStatus.variables?.userId}
              onEdit={setEditing}
              onDelete={setDeleting}
              onToggle={handleToggleFor}
              onView={setDetail}
              className={variant === 'page' ? 'lg:hidden' : undefined}
            />
            <Pagination
              ariaLabel="Paginasi daftar pengawas"
              page={currentPage}
              totalPages={totalPages}
              pageSize={pageSize}
              onPageSizeChange={setPageSize}
              onPageChange={setPage}
              className="mt-4"
            />
          </>
        )}
      </div>

      {deleting !== null ? (
        <ConfirmModal
          open
          title={`Hapus ${deleting.name}`}
          message={deleteSecurityUserConfirmMessage(deleting)}
          loading={deleteUser.isPending}
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            deleteUser.mutate(
              { userId: deleting.id },
              {
                onSuccess: () => {
                  toast.success(`${deleting.name} dihapus permanen`)
                  setDeleting(null)
                },
                // 403 lintas cabang & 409 tampil apa adanya dari server.
                onError: (error) => {
                  toast.error(apiErrorMessage(error))
                },
              },
            )
          }}
        />
      ) : null}

      {editing !== null ? (
        <EditUserModal
          user={editing}
          locations={locationsQuery.data ?? []}
          saving={updateSecurity.isPending}
          locationMode={canPickLocation ? 'select' : 'locked'}
          isSelf={false}
          onClose={() => setEditing(null)}
          onSubmit={(body) => {
            updateSecurity.mutate(
              {
                userId: editing.id,
                body: {
                  name: body.name,
                  email: body.email,
                  phone: body.phone,
                  ...(body.password !== undefined ? { password: body.password } : {}),
                  ...(body.location_id !== undefined ? { location_id: body.location_id } : {}),
                },
              },
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

      {detail !== null ? (
        <DetailModal
          title="Detail Pengawas"
          subtitle={detail.name}
          avatar={<UserAvatar name={detail.name} avatarUrl={detail.avatar_url} size="lg" />}
          fields={securityUserDetailFields(detail)}
          onClose={() => setDetail(null)}
        />
      ) : null}
    </div>
  )
}

interface SecurityListProps {
  users: User[]
  role: Role
  ownLocationId: string | null
  togglePending: boolean
  toggleUserId?: string
  onEdit: (member: User) => void
  onDelete: (member: User) => void
  onToggle: (member: User) => void
  onView: (member: User) => void
  page?: number
  pageSize?: number
}

/**
 * Baris detail satu pengawas — dibaca dari record yang sudah dimuat di
 * daftar (tanpa fetch tambahan). Nilai kosong dibiarkan apa adanya agar
 * `DetailModal` menampilkannya sebagai strip.
 */
function securityUserDetailFields(member: User): DetailField[] {
  return [
    { label: 'NAMA', value: member.name },
    { label: 'EMAIL', value: member.email },
    { label: 'TELEPON', value: member.phone },
    { label: 'CABANG', value: member.location_name },
    { label: 'STATUS', value: <SecurityStatusBadge status={member.status} /> },
  ]
}

/**
 * Susunan item `ActionMenu` tunggal untuk tabel DAN kartu — satu tempat guard
 * aksi (`toggleable` / `showDelete`) sehingga kedua tampilan tak pernah
 * menyimpang. Guard hapus persis `canShowDeleteSecurityUser` (ada unit test).
 *
 * "Lihat detail" selalu PERTAWA (baca sebelum tulis).
 */
function buildSecurityActionItems(
  member: User,
  role: Role,
  ownLocationId: string | null,
  onEdit: (member: User) => void,
  onToggle: (member: User) => void,
  onDelete: (member: User) => void,
  onView: (member: User) => void,
): ActionMenuItem[] {
  const isActive = member.status === 'active'
  const items: ActionMenuItem[] = [
    {
      id: 'view',
      label: 'Lihat detail',
      icon: <Eye aria-hidden="true" className="size-4" />,
      onSelect: () => onView(member),
    },
    {
      id: 'edit',
      label: 'Ubah',
      icon: <Pencil aria-hidden="true" className="size-4" />,
      onSelect: () => onEdit(member),
    },
  ]
  if (member.status !== 'blacklisted') {
    items.push({
      id: 'toggle',
      label: isActive ? 'Nonaktifkan' : 'Aktifkan',
      icon: <Power aria-hidden="true" className="size-4" />,
      onSelect: () => onToggle(member),
    })
  }
  if (canShowDeleteSecurityUser(role, member, ownLocationId)) {
    items.push({
      id: 'delete',
      label: 'Hapus',
      tone: 'danger',
      icon: <Trash2 aria-hidden="true" className="size-4" />,
      onSelect: () => onDelete(member),
    })
  }
  return items
}

function SecurityUserActionMenu({
  member,
  role,
  ownLocationId,
  togglePending,
  toggleUserId,
  onEdit,
  onDelete,
  onToggle,
  onView,
}: {
  member: User
  role: Role
  ownLocationId: string | null
  togglePending: boolean
  toggleUserId?: string
  onEdit: (member: User) => void
  onDelete: (member: User) => void
  onToggle: (member: User) => void
  onView: (member: User) => void
}) {
  return (
    <ActionMenu
      label={`Aksi untuk ${member.name}`}
      items={buildSecurityActionItems(member, role, ownLocationId, onEdit, onToggle, onDelete, onView)}
      busy={togglePending && toggleUserId === member.id}
    />
  )
}

function SecurityUserTable({ users, role, ownLocationId, togglePending, toggleUserId, onEdit, onDelete, onToggle, onView, page = 1, pageSize }: SecurityListProps) {
  const effectivePageSize = pageSize ?? users.length
  return (
    <div className={TABLE_WRAPPER_CLASS}>
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            {[
              // Aksi 7% seragam dengan /users (ActionMenu ikon tunggal); 9 poin dibagikan proporsional ke kolom data ⇒ total tepat 100%.
              { label: 'No', width: 'w-[4%]' },
              { label: 'Nama', width: 'w-[27%]' },
              { label: 'Email', width: 'w-[26%]' },
              { label: 'Cabang', width: 'w-[23%]' },
              { label: 'Status', width: 'w-[13%]' },
              { label: 'Aksi', width: 'w-[7%]' },
            ].map((header) => (
              <th
                key={header.label}
                scope="col"
                className={`${header.width} border-b border-border-light bg-brand/5 px-3 py-3 text-sm font-semibold text-ink-secondary lg:px-6`}
              >
                {header.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border-light">
          {users.map((member, index) => (
            <tr key={member.id} className="transition-colors hover:bg-brand/5">
              <td className="px-3 py-3 text-right tabular-nums text-sm text-ink-secondary lg:px-6">
                {(page - 1) * effectivePageSize + index + 1}
              </td>
              <td className="px-3 py-3 lg:px-6">
                <p className="truncate text-sm font-semibold text-ink" title={member.name}>
                  {member.name}
                </p>
              </td>
              <td
                className="truncate px-3 py-3 text-sm text-ink-secondary lg:px-6"
                title={member.email}
              >
                {member.email}
              </td>
              <td
                className="truncate px-3 py-3 text-sm text-ink-secondary lg:px-6"
                title={securityUserLocationLabel(member)}
              >
                {securityUserLocationLabel(member)}
              </td>
              <td className="px-3 py-3 lg:px-6">
                <SecurityStatusBadge status={member.status} />
              </td>
              <td className="px-3 py-3 lg:px-6">
                <SecurityUserActionMenu
                  member={member}
                  role={role}
                  ownLocationId={ownLocationId}
                  togglePending={togglePending}
                  toggleUserId={toggleUserId}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onToggle={onToggle}
                  onView={onView}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SecurityUserCards({ users, role, ownLocationId, togglePending, toggleUserId, onEdit, onDelete, onToggle, onView, className }: SecurityListProps & { className?: string }) {
  return (
    <ul className={`grid grid-cols-1 gap-2 md:grid-cols-2 ${className ?? ''}`}>
      {users.map((member) => {
        const detailLabel = securityUserDetailLabel(member)
        return (
          <li
            key={member.id}
            className="flex flex-col gap-3 rounded-control border border-border-light p-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink" title={member.name}>
                  {member.name}
                </p>
                <p className="truncate text-xs text-ink-muted" title={detailLabel}>
                  {detailLabel}
                </p>
              </div>
              <SecurityStatusBadge status={member.status} className="shrink-0" />
            </div>
            <div className="flex justify-end">
              <SecurityUserActionMenu
                member={member}
                role={role}
                ownLocationId={ownLocationId}
                togglePending={togglePending}
                toggleUserId={toggleUserId}
                onEdit={onEdit}
                onDelete={onDelete}
                onToggle={onToggle}
                onView={onView}
              />
            </div>
          </li>
        )
      })}
    </ul>
  )
}

interface CreateSecurityModalProps {
  open: boolean
  onClose: () => void
  /** super_admin memilih cabang; admin memakai cabang terkunci. */
  canPickLocation: boolean
  locationOptions: Array<{ value: string; label: string }>
  lockedLocationId: string
  lockedLocationLabel: string
  /** Dipanggil setelah pengawas berhasil ditambahkan (panel: tutup + teruskan). */
  onCreated?: () => void
}

/**
 * Modal Tambah Pengawas — form yang dulu inline di panel.
 * Pesan toast identik dengan versi inline sebelumnya. Tanpa field NIK
 * (BE menolak NIK untuk security).
 */
function CreateSecurityModal({
  open,
  onClose,
  canPickLocation,
  locationOptions,
  lockedLocationId,
  lockedLocationLabel,
  onCreated,
}: CreateSecurityModalProps) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [locationId, setLocationId] = useState('')
  const [emailError, setEmailError] = useState<string | undefined>(undefined)
  const [phoneError, setPhoneError] = useState<string | undefined>(undefined)
  const [passwordError, setPasswordError] = useState<string | undefined>(undefined)

  const createUser = useCreateSecurityUserMutation()

  // Reset form setiap modal dibuka agar data sebelumnya tidak tertinggal.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset form saat modal dibuka (pelanggaran baseline yang sudah ada sebelum perubahan panel; wajib agar lint 0 error)
      setName('')
      setEmail('')
      setPhone('')
      setPassword('')
      setLocationId('')
      setEmailError(undefined)
      setPhoneError(undefined)
      setPasswordError(undefined)
    }
  }, [open])

  // Lokasi cabang penugasan: super_admin memilih; admin terkunci ke cabangnya.
  const effectiveLocationId = canPickLocation ? locationId : lockedLocationId

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (name.trim() === '' || email.trim() === '' || password === '') return
    if (effectiveLocationId === '') return

    const nextEmailError = isValidEmail(email) ? undefined : 'Format email tidak valid.'
    setEmailError(nextEmailError)
    if (nextEmailError !== undefined) return

    const trimmedPhone = phone.trim()
    const normalizedPhone = trimmedPhone.startsWith('62')
      ? `0${trimmedPhone.slice(2)}`
      : trimmedPhone
    const nextPhoneError =
      trimmedPhone === ''
        ? undefined
        : normalizedPhone.startsWith('0') &&
            (normalizedPhone.length < PHONE_MIN_LENGTH ||
              normalizedPhone.length > PHONE_MAX_LENGTH)
          ? PHONE_DIGIT_MESSAGE
          : isValidPhone(trimmedPhone)
            ? undefined
            : 'Format nomor telepon tidak valid.'
    setPhoneError(nextPhoneError)
    if (nextPhoneError !== undefined) return

    const nextPasswordError = isValidPassword(password)
      ? undefined
      : 'Kata sandi minimal 8 karakter dan maksimal 72 byte.'
    setPasswordError(nextPasswordError)
    if (nextPasswordError !== undefined) return

    createUser.mutate(
      {
        body: {
          name: name.trim(),
          email: email.trim(),
          password,
          ...(phone.trim() !== '' ? { phone: phone.trim() } : {}),
          location_id: effectiveLocationId,
        },
      },
      {
        onSuccess: () => {
          toast.success(`${getRoleLabel('security')} ${name.trim()} berhasil ditambahkan`)
          onCreated?.()
        },
        onError: (error) => {
          toast.error(apiErrorMessage(error))
        },
      },
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Tambah ${getRoleLabel('security')}`}
      size="lg"
      footer={
        <>
          <Button variant="ghost" className="min-h-touch" onClick={onClose}>
            Batal
          </Button>
          <Button
            type="submit"
            form="security-create-form"
            className="min-h-touch"
            loading={createUser.isPending}
          >
            Tambah {getRoleLabel('security')}
          </Button>
        </>
      }
    >
      <form id="security-create-form" onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Nama Lengkap"
            placeholder={`Nama ${getRoleLabel('security').toLowerCase()}`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="name"
            maxLength={NAME_MAX_LENGTH}
            required
          />
          <Input
            label="Email"
            type="email"
            placeholder="nama@thc.id"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value)
              if (emailError !== undefined) setEmailError(undefined)
            }}
            autoComplete="email"
            maxLength={EMAIL_MAX_LENGTH}
            error={emailError}
            required
          />
          <Input
            label="No. Telepon"
            type="tel"
            inputMode="tel"
            placeholder="08xxxxxxxxxx"
            value={phone}
            onChange={(event) => {
              setPhone(sanitizePhoneInput(event.target.value))
              if (phoneError !== undefined) setPhoneError(undefined)
            }}
            autoComplete="tel"
            maxLength={PHONE_MAX_LENGTH}
            error={phoneError}
          />
          <PasswordInput
            label="Kata Sandi"
            placeholder="Kata sandi awal"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value)
              if (passwordError !== undefined) setPasswordError(undefined)
            }}
            autoComplete="new-password"
            maxLength={PASSWORD_MAX_BYTES}
            hint={`Minimal 8 karakter. Dibagikan ke ${getRoleLabel('security').toLowerCase()}; dapat diubah setelah masuk.`}
            error={passwordError}
            required
          />
        </div>

        {canPickLocation ? (
          <Select
            label="Cabang Penugasan"
            placeholder="Pilih cabang / POP"
            options={locationOptions}
            value={locationId}
            onChange={(event) => setLocationId(event.target.value)}
            required
          />
        ) : (
          <div className="flex flex-col gap-2">
            <span className="text-label font-semibold text-ink">Cabang Penugasan</span>
            <p className="inline-flex w-fit min-h-touch items-center gap-2 rounded-control border border-border-light bg-neutral-bg px-3 py-2 text-label text-ink-secondary">
              <Lock aria-hidden="true" className="size-3.5 shrink-0 text-ink-muted" />
              {lockedLocationLabel}
              <span className="text-ink-muted">(terkunci)</span>
            </p>
          </div>
        )}
      </form>
    </Modal>
  )
}

export interface SecurityUserModalProps {
  open: boolean
  onClose: () => void
}

/**
 * Modal Kelola Pengawas Cabang (bagian dari SCR-02).
 *
 * Cangkang tipis di atas `SecurityUserPanel`: panel me-refresh daftar
 * setiap modal dibuka (`enabled=open`); form tambah hidup di modal
 * `Tambah Pengawas` tersendiri yang dibuka dari tombol panel.
 */
export function SecurityUserModal({ open, onClose }: SecurityUserModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Kelola ${getRoleLabel('security')} Cabang`}
      size="lg"
      footer={
        <Button variant="ghost" className="min-h-touch" onClick={onClose}>
          Tutup
        </Button>
      }
    >
      <SecurityUserPanel enabled={open} onCreated={onClose} variant="modal" />
    </Modal>
  )
}
