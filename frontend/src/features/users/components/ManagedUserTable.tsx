'use client'

import { Building2, Eye, Pencil, Power, Trash2, UserRound } from 'lucide-react'
import { toast } from 'sonner'
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu'
import { Badge } from '@/components/ui/Badge'
import type { DetailField } from '@/components/ui/DetailModal'
import type { SelectOption } from '@/components/ui/Select'
import { apiErrorMessage } from '@/features/visits/components/ApproveModal'
import { ManagedRoleFilterSelect } from '@/features/users/components/ManagedRoleFilterSelect'
import {
  canShowDeleteUser,
  isProtectedUser,
  userAffiliationLabel,
} from '@/features/users/managed-user-filters'
import { useUpdateManagedUserStatusMutation } from '@/lib/api/hooks'
import type { UpdateUserStatusRequest, User } from '@/lib/api/types'
import { getRoleLabel, type Role } from '@/lib/auth/capabilities'
import {
  TABLE_CARD_LIST_CLASS,
  TABLE_CLASS,
  TABLE_TD_CLASS,
  TABLE_TH_CLASS,
  TABLE_WRAPPER_CLASS,
} from '@/lib/table-styles'
import { managedRoleTone } from '@/lib/visits/status-badge'

/**
 * Tabel user terkelola (desktop >= 1024px) + tumpukan kartu (ponsel/tablet)
 * — SATU komponen yang dipakai kedua layar user terkelola (`/coordinators`,
 * `/vendor-registrations`) supaya base UI tabelnya dijamin identik: token
 * `TABLE_*` yang sama, pil peran yang sama, dan guard aksi yang sama.
 */

export interface ManagedUserListProps {
  users: User[]
  /** ID akun yang sedang login — baris sendiri tak boleh dirusak. */
  currentUserId: string | null
  /** Peran penihat — menentukan apakah tombol hapus tampil. */
  viewerRole: Role | null
  onDelete: (user: User) => void
  onEdit: (user: User) => void
  onView: (user: User) => void
}

/**
 * Kontrol filter peran untuk header kolom "Peran". Absen ⇒ kolom Peran
 * hanya menampilkan label (halaman yang cakup satu peran).
 */
export interface ManagedUserRoleFilterControl {
  options: SelectOption[]
  value: string
  onChange: (value: string) => void
}

/** Parameter penyusunan aksi baris — sama untuk tabel desktop & kartu mobile. */
interface UserActionParams {
  user: User
  currentUserId: string | null
  viewerRole: Role | null
  onDelete: (user: User) => void
  onEdit: (user: User) => void
  onView: (user: User) => void
  toggle: (user: User) => void
}

/**
 * Aksi baris user — disusun di satu tempat supaya tabel desktop dan kartu
 * mobile punya offering yang identik. Toggle status hanya tersedia untuk
 * akun aktif/nonaktif yang tak dilindungi (diri sendiri & `super_admin`).
 */
function buildUserActions({
  user,
  currentUserId,
  viewerRole,
  onDelete,
  onEdit,
  onView,
  toggle,
}: UserActionParams): ActionMenuItem[] {
  const actions: ActionMenuItem[] = [
    {
      id: 'view',
      label: 'Lihat detail',
      icon: <Eye aria-hidden="true" className="size-4" />,
      onSelect: () => onView(user),
      tone: 'default',
    },
    {
      id: 'edit',
      label: 'Ubah',
      icon: <Pencil aria-hidden="true" className="size-4" />,
      onSelect: () => onEdit(user),
      tone: 'default',
    },
  ]
  const toggleable =
    !isProtectedUser(user, currentUserId) &&
    (user.status === 'active' || user.status === 'inactive')
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
  return actions
}

/**
 * Aksi status aktif/nonaktif — satu mutasi per permukaan tabel (desktop &
 * kartu mobile punya instance sendiri, sama seperti sebelum pemisahan ini).
 */
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

/** Pil status akun — dipakai di tabel, kartu, dan modal detail. */
export function ManagedUserStatusCell({
  status,
  className,
}: {
  status: User['status']
  className?: string
}) {
  if (status === 'active') return <Badge tone="success" className={className}>Aktif</Badge>
  if (status === 'blacklisted') return <Badge tone="danger" className={className}>Diblokir</Badge>
  return <Badge tone="neutral" className={className}>Nonaktif</Badge>
}

/**
 * Baris detail satu akun user. Nilai kosong dibiarkan `null`/kosong agar
 * `DetailModal` yang menampilkannya sebagai strip (bukan sel kosong).
 */
export function managedUserDetailFields(user: User): DetailField[] {
  return [
    { label: 'NAMA', value: user.name },
    { label: 'EMAIL', value: user.email },
    { label: 'TELEPON', value: user.phone },
    { label: 'NIK', value: user.nik },
    { label: 'PERAN', value: getRoleLabel(user.role) },
    { label: 'CABANG / VENDOR', value: userAffiliationLabel(user) },
    { label: 'STATUS', value: <ManagedUserStatusCell status={user.status} /> },
    { label: 'TIPE AKUN', value: user.type === 'internal' ? 'Internal' : 'Eksternal' },
  ]
}

/**
 * Kolom tabel. Kolom "Peran" diberi ruang lebih lebar (18%) karena filter
 * peran hidup DI DALAM header kolom itu.
 */
const MANAGED_USER_TABLE_HEADERS = [
  { key: 'name', label: 'Nama', width: 'w-[20%]' },
  { key: 'email', label: 'Email', width: 'w-[22%]' },
  { key: 'role', label: 'Peran', width: 'w-[18%]' },
  { key: 'affiliation', label: 'Cabang / Vendor', width: 'w-[20%]' },
  { key: 'status', label: 'Status', width: 'w-[11%]' },
  { key: 'actions', label: 'Aksi', width: 'w-[7%]' },
] as const

/**
 * Tabel desktop (>= 1024px). Filter peran (bila ada) hidup di dalam header
 * kolom "Peran" — sesuai permintaan pemilik: satu tabel untuk beberapa
 * peran, dibedakan lewat filter di kolomnya, bukan lewat halaman per-peran.
 */
export function ManagedUserTable({
  users,
  currentUserId,
  viewerRole,
  onDelete,
  onEdit,
  onView,
  roleFilter,
}: ManagedUserListProps & { roleFilter?: ManagedUserRoleFilterControl }) {
  const { toggle, isPending, activeId } = useToggleManagedStatus()

  return (
    <div className={TABLE_WRAPPER_CLASS}>
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            {MANAGED_USER_TABLE_HEADERS.map((header) => (
              <th
                key={header.key}
                scope="col"
                className={`${header.width} ${TABLE_TH_CLASS}`}
              >
                {header.key === 'role' ? (
                  <>
                    <span className="block">{header.label}</span>
                    {roleFilter !== undefined ? (
                      <ManagedRoleFilterSelect
                        className="mt-1 hidden lg:block"
                        options={roleFilter.options}
                        value={roleFilter.value}
                        onChange={roleFilter.onChange}
                      />
                    ) : null}
                  </>
                ) : (
                  header.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border-light">
          {users.map((user) => {
            const actions = buildUserActions({
              user,
              currentUserId,
              viewerRole,
              onDelete,
              onEdit,
              onView,
              toggle,
            })
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
                  <ManagedUserStatusCell status={user.status} />
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

/**
 * Kartu pengganti tabel di bawah 1024px: ponsel (< 768px) tumpukan vertikal
 * 1 kolom, tablet (768px - 1023px) grid 2 kolom — tanpa scroll horizontal.
 */
export function ManagedUserCards({
  users,
  currentUserId,
  viewerRole,
  onDelete,
  onEdit,
  onView,
}: ManagedUserListProps) {
  const { toggle, isPending, activeId } = useToggleManagedStatus()

  return (
    <ul className={TABLE_CARD_LIST_CLASS}>
      {users.map((user) => {
        const actions = buildUserActions({
          user,
          currentUserId,
          viewerRole,
          onDelete,
          onEdit,
          onView,
          toggle,
        })
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
                <ManagedUserStatusCell status={user.status} />
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
