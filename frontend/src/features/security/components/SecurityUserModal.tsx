'use client'

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { EditUserModal } from '@/features/users/components/EditUserModal'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Select, type SelectOption } from '@/components/ui/Select'
import { Spinner } from '@/components/ui/Spinner'
import {
  useCreateSecurityUserMutation,
  useDeleteSecurityUserMutation,
  useLocationsQuery,
  useSecurityUsersQuery,
  useUpdateSecurityUserMutation,
  useUpdateSecurityUserStatusMutation,
} from '@/lib/api/hooks'
import { useSession } from '@/lib/auth/session'
import { can, getRoleLabel } from '@/lib/auth/capabilities'
import type { Role, UpdateUserStatusRequest, User } from '@/lib/api/types'

/** Salinan lokal (sengaja tanpa lintas-feature import): pesan error aman untuk UI. */
function apiErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') {
    return error.message
  }
  return 'Terjadi kesalahan. Silakan coba lagi.'
}

/** Pesan konfirmasi hapus satpam — menyebut nama agar tidak salah sasaran. */
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
  if (role === 'super_admin') return true
  return ownLocationId !== null && target.location_id === ownLocationId
}

/** Opsi filter status pada toolbar daftar satpam (sentinel 'all' = semua). */
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
  /** Dipanggil setelah satpam berhasil ditambahkan (modal: tutup diri). */
  onCreated?: () => void
}

/**
 * Isi manajemen satpam: tombol tambah (membuka modal) + daftar kartu
 * responsif (ponsel 1 kolom / tablet & desktop 2 kolom) + toggle status.
 *
 * Dipakai ulang DUA permukaan (DRY): `SecurityUserModal` (SCR-02) dan halaman
 * mandiri `/security`. Logika peran identik di keduanya — super_admin memilih
 * cabang, admin terkunci ke cabangnya. Guard `manageSecurity` di sini adalah
 * lapisan kedua setelah guard rute. Tanpa field NIK (BE menolak NIK untuk
 * security — cermin `rejectSecurityNik` di mock/BE).
 */
export function SecurityUserPanel({ enabled, onCreated }: SecurityUserPanelProps) {
  const { user } = useSession()
  const role: Role | null = user !== null ? user.role : null
  const ownLocationId = user !== null ? user.location_id : null

  const [createOpen, setCreateOpen] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | User['status']>('all')

  // Debounce pencarian 300ms supaya setiap ketikan tidak memicu render filter
  // (pola identik halaman users benchmark).
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  const locationsQuery = useLocationsQuery()
  const toggleStatus = useUpdateSecurityUserStatusMutation()
  const deleteUser = useDeleteSecurityUserMutation()
  const [deleting, setDeleting] = useState<User | null>(null)
  const [editing, setEditing] = useState<User | null>(null)
  const updateSecurity = useUpdateSecurityUserMutation()

  // Lokasi cabang penugasan: super_admin memilih; admin terkunci ke cabangnya.
  const effectiveLocationId = role === 'super_admin' ? '' : (ownLocationId ?? '')
  const usersQuery = useSecurityUsersQuery(effectiveLocationId !== '' ? effectiveLocationId : undefined, enabled)

  // Filter daftar di sisi klien: kontrak GET /users/security hanya punya
  // location_id (tak ada param search/status), jadi pencarian disaring di sini.
  const users = usersQuery.data ?? []
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

  const locationOptions = (locationsQuery.data ?? []).map((location) => ({
    value: location.id,
    label: location.name,
  }))
  const canPickLocation = role === 'super_admin'

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-label font-semibold text-ink">Daftar {getRoleLabel('security')}</p>
        <Button className="min-h-touch" onClick={() => setCreateOpen(true)}>
          <Plus className="size-4 shrink-0" aria-hidden="true" />
          Tambah {getRoleLabel('security')}
        </Button>
      </div>

      {/* Toolbar filter irisan SCR-02 — pola users benchmark: select berlabel
          + search ber-aria-label, wrap rapi di 375/768/1280 tanpa scroll. */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-40 flex-1 sm:w-48 sm:flex-none">
          <Select
            label="Status"
            options={STATUS_FILTER_OPTIONS}
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as 'all' | User['status'])}
          />
        </div>
        <div className="relative min-w-48 flex-1">
          <Input
            aria-label={`Cari ${getRoleLabel('security').toLowerCase()}`}
            placeholder="Cari nama, email, atau cabang…"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
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
        ) : users.length === 0 ? (
          <p className="py-4 text-sm text-ink-muted">Belum ada {getRoleLabel('security').toLowerCase()} terdaftar.</p>
        ) : filteredUsers.length === 0 ? (
          <p className="py-4 text-sm text-ink-muted">
            Tidak ada {getRoleLabel('security').toLowerCase()} yang cocok dengan pencarian atau filter Anda.
          </p>
        ) : (
          /* Tier responsif (design system §5.1 / §5.2): ponsel < 768px
             tumpukan kartu 1 kolom, tablet 768px - 1023px & desktop grid
             2 kolom. Cluster aksi WRAP agar tidak overflow di 375px. */
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {filteredUsers.map((member) => {
              const isActive = member.status === 'active'
              const toggleable = member.status !== 'blacklisted'
              const showDelete =
                role !== null && canShowDeleteSecurityUser(role, member, ownLocationId)
              const detailLabel =
                member.email +
                (member.location_name !== null ? ` · ${member.location_name}` : '')
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
                    <Badge
                      tone={
                        isActive
                          ? 'success'
                          : member.status === 'blacklisted'
                            ? 'danger'
                            : 'neutral'
                      }
                      className="shrink-0"
                    >
                      {isActive ? 'AKTIF' : member.status === 'blacklisted' ? 'DIBLOKIR' : 'NONAKTIF'}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      className="min-h-touch flex-1 px-3"
                      aria-label={`Ubah ${member.name}`}
                      onClick={() => setEditing(member)}
                    >
                      <Pencil aria-hidden="true" className="size-4 shrink-0" />
                      Ubah
                    </Button>
                    {toggleable ? (
                      <Button
                        size="sm"
                        variant={isActive ? 'secondary' : 'primary'}
                        className="min-h-touch flex-1 px-3"
                        loading={toggleStatus.isPending && toggleStatus.variables?.userId === member.id}
                        onClick={() => handleToggle(member.id, member.name, isActive ? 'inactive' : 'active')}
                      >
                        {isActive ? 'Nonaktifkan' : 'Aktifkan'}
                      </Button>
                    ) : null}
                    {showDelete ? (
                      <Button
                        size="sm"
                        variant="danger"
                        className="min-h-touch flex-1 px-3"
                        aria-label={`Hapus ${member.name}`}
                        onClick={() => setDeleting(member)}
                      >
                        <Trash2 aria-hidden="true" className="size-4 shrink-0" />
                        Hapus
                      </Button>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
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
          locationMode="locked"
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
    </div>
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
  /** Dipanggil setelah satpam berhasil ditambahkan (panel: tutup + teruskan). */
  onCreated?: () => void
}

/**
 * Modal Tambah Satpam — form yang dulu inline di panel.
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

  const createUser = useCreateSecurityUserMutation()

  // Reset form setiap modal dibuka agar data sebelumnya tidak tertinggal.
  useEffect(() => {
    if (open) {
      setName('')
      setEmail('')
      setPhone('')
      setPassword('')
      setLocationId('')
    }
  }, [open])

  // Lokasi cabang penugasan: super_admin memilih; admin terkunci ke cabangnya.
  const effectiveLocationId = canPickLocation ? locationId : lockedLocationId

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (name.trim() === '' || email.trim() === '' || password === '') return
    if (effectiveLocationId === '') return

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
            hint={`Dibagikan ke ${getRoleLabel('security').toLowerCase()}; dapat diubah setelah masuk.`}
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
          <div className="flex flex-col gap-1.5">
            <span className="text-label font-semibold text-ink">Cabang Penugasan</span>
            <p className="inline-flex w-fit items-center gap-1.5 rounded-control border border-border-light bg-neutral-bg px-3 py-2 text-label text-ink-secondary">
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
 * Modal Kelola Satpam Cabang (bagian dari SCR-02).
 *
 * Cangkang tipis di atas `SecurityUserPanel`: panel me-refresh daftar
 * setiap modal dibuka (`enabled=open`); form tambah hidup di modal
 * `Tambah Satpam` tersendiri yang dibuka dari tombol panel.
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
      <SecurityUserPanel enabled={open} onCreated={onClose} />
    </Modal>
  )
}
