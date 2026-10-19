'use client'

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { AlertTriangle, Building2, Inbox, MapPin, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { SuperadminShell } from '@/components/layouts/SuperadminShell'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { EmptyState } from '@/components/ui/EmptyState'
import { FilterResetButton } from '@/components/ui/FilterResetButton'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Select, type SelectOption } from '@/components/ui/Select'
import { Spinner } from '@/components/ui/Spinner'
import { apiErrorMessage } from '@/features/visits/components/ApproveModal'
import {
  useCreateLocationMutation,
  useDeleteLocationMutation,
  useLocationsQuery,
  usePendingApprovalCount,
  useUpdateLocationMutation,
} from '@/lib/api/hooks'
import type { Location } from '@/lib/api/types'
import { can } from '@/lib/auth/capabilities'
import { RequireRole } from '@/lib/auth/guards'
import { useSession } from '@/lib/auth/session'

// ---------------------------------------------------------------------------
// Helper murni (diekspor agar dapat diuji unit — lihat tests/superadmin-filters.test.ts)
// ---------------------------------------------------------------------------

/** Label tipe fasilitas dalam Bahasa Indonesia (bukan mentah `pusat`, `pop`, dst). */
export const LOCATION_TYPE_LABEL: Record<Location['type'], string> = {
  pusat: 'Kantor Pusat',
  cabang: 'Kantor Cabang',
  pop: 'POP',
  minipop: 'miniPOP',
}

/** Absen `is_active` dimaknai aktif (payload lama/seed tanpa field ini tetap valid). */
export function isLocationActive(location: Location): boolean {
  return location.is_active !== false
}

/** Pesan konfirmasi hapus fasilitas — menyebut nama agar tidak salah sasaran. */
export function deleteLocationConfirmMessage(location: Location): string {
  return `Hapus permanen fasilitas "${location.name}"? Tindakan ini tidak dapat dibatalkan.`
}

export interface FacilityFilter {
  search: string
  branchId: string
  /** Tipe fasilitas; `''` (atau absen) = semua tipe. */
  type?: Location['type'] | ''
  /** Status aktif; `'all'` (atau absen) = semua status. */
  status?: 'all' | 'active' | 'inactive'
}

/** Filter daftar fasilitas: sentinel `branchId: 'all'` = semua cabang/POP. */
export function applyFacilityFilters(locations: Location[], filter: FacilityFilter): Location[] {
  const query = filter.search.trim().toLowerCase()
  return locations.filter((location) => {
    if (filter.branchId !== 'all' && location.id !== filter.branchId) return false
    if (filter.type !== undefined && filter.type !== '' && location.type !== filter.type) return false
    if (filter.status === 'active' && !isLocationActive(location)) return false
    if (filter.status === 'inactive' && isLocationActive(location)) return false
    if (query === '') return true
    return (
      location.name.toLowerCase().includes(query) ||
      location.city.toLowerCase().includes(query)
    )
  })
}

// ---------------------------------------------------------------------------
// Form state (KISS: useState polos seperti SecurityUserModal, tanpa RHF/zod)
// ---------------------------------------------------------------------------

type LocationTypeOption = Location['type'] | ''

interface LocationFormValues {
  name: string
  type: LocationTypeOption
  address: string
  city: string
  timezone: Location['timezone']
}

const EMPTY_FORM: LocationFormValues = {
  name: '',
  type: '',
  address: '',
  city: '',
  timezone: 'WIB',
}

const TYPE_OPTIONS: SelectOption[] = [
  { value: 'pusat', label: 'Kantor Pusat' },
  { value: 'cabang', label: 'Kantor Cabang' },
  { value: 'pop', label: 'POP' },
  { value: 'minipop', label: 'miniPOP' },
]

/**
 * Opsi tipe untuk modal create/edit fasilitas (diekspor agar diuji unit).
 * `pusat` hanya ditawarkan bila BELUM ada kantor pusat ATAU saat baris yang
 * diedit memang kantor pusat tersebut. Semua baris dihitung apa adanya —
 * termasuk yang nonaktif (query memuat aktif + nonaktif) — supaya opsi tidak
 * muncul kembali dan server tetap jadi otoritas penolakan (409).
 */
export function locationTypeFormOptions(
  locations: Location[],
  editing?: Location,
): SelectOption[] {
  const pusatExists = locations.some((location) => location.type === 'pusat')
  const editingIsPusat = editing?.type === 'pusat'
  if (pusatExists && !editingIsPusat) {
    return TYPE_OPTIONS.filter((option) => option.value !== 'pusat')
  }
  return TYPE_OPTIONS
}

const TIMEZONE_OPTIONS: SelectOption[] = [
  { value: 'WIB', label: 'WIB' },
  { value: 'WITA', label: 'WITA' },
  { value: 'WIT', label: 'WIT' },
]

/** Opsi filter tipe pada toolbar daftar (sentinel '' = semua tipe). */
const TYPE_FILTER_OPTIONS: SelectOption[] = [
  { value: '', label: 'Semua Tipe' },
  ...TYPE_OPTIONS,
]

/** Opsi filter status pada toolbar daftar (sentinel 'all' = semua status). */
const STATUS_FILTER_OPTIONS: SelectOption[] = [
  { value: 'all', label: 'Semua Status' },
  { value: 'active', label: 'Aktif' },
  { value: 'inactive', label: 'Nonaktif' },
]

/**
 * PRD §4 — Fasilitas & Cabang (super_admin).
 * Guard penuh `RequireRole allow=['super_admin']` + `SuperadminShell`.
 */
export default function FacilitiesPage() {
  return (
    <RequireRole allow={['super_admin']}>
      <FacilitiesScreen />
    </RequireRole>
  )
}

function FacilitiesScreen() {
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [branchId, setBranchId] = useState('all')
  const [typeFilter, setTypeFilter] = useState<Location['type'] | ''>('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all')
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<Location | null>(null)
  const [deleting, setDeleting] = useState<Location | null>(null)
  const { user } = useSession()
  const deleteMutation = useDeleteLocationMutation()
  const role = user !== null ? user.role : null
  const showDelete = role !== null && can(role, 'deleteRecords')

  // Debounce pencarian 300ms supaya setiap ketikan tidak memicu render filter.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  // Halaman admin butuh SEMUA baris (aktif + nonaktif) agar fasilitas yang
  // dinonaktifkan tetap terlihat dan bisa diaktifkan lagi.
  const locationsQuery = useLocationsQuery(false)
  // Badge antrean shell: total requested + rescheduled lintas cabang
  // (server-total, limit 1 — hanya total yang dipakai); lihat usePendingApprovalCount.
  const { pendingCount } = usePendingApprovalCount()

  const locations = useMemo(() => locationsQuery.data ?? [], [locationsQuery.data])
  const rows = useMemo(
    () => applyFacilityFilters(locations, { search, branchId, type: typeFilter, status: statusFilter }),
    [locations, search, branchId, typeFilter, statusFilter],
  )

  // Reset SEMUA state filter sekaligus — termasuk debounce `search` yang belum
  // tentu sinkron dengan `searchInput`, plus sentinel filter ke default-nya,
  // DAN `branchId` supaya dropdown switcher cabang di SuperadminShell ikut
  // kembali ke "Semua Cabang" (state-nya terkontrol dari halaman ini).
  const handleResetFilters = (): void => {
    setSearchInput('')
    setSearch('')
    setBranchId('all')
    setTypeFilter('')
    setStatusFilter('all')
  }

  // Halaman ini tidak punya boolean `isFiltered` bawaan — hitung sendiri dari
  // nilai filter aktif: tombol Reset Filter hanya aktif bila ADA yang disaring
  // (input kosong + semua sentinel default = tidak ada yang perlu di-reset).
  const isFiltered =
    searchInput.trim() !== '' ||
    search !== '' ||
    branchId !== 'all' ||
    typeFilter !== '' ||
    statusFilter !== 'all'

  const emptyTitle =
    locations.length === 0 ? 'Belum ada fasilitas' : 'Tidak ada fasilitas yang cocok'
  const emptyDescription =
    locations.length === 0
      ? 'Tambahkan kantor cabang, POP, atau miniPOP pertama via tombol di atas.'
      : 'Coba ubah kata kunci pencarian atau filter Anda.'

  return (
    <SuperadminShell
      pendingCount={pendingCount}
      allLocations={locations}
      activeHref="/facilities"
      branchId={branchId}
      onBranchChange={setBranchId}
    >
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-ink">Fasilitas & Cabang</h1>
          <p className="mt-1 text-sm text-ink-secondary">
            Kelola kantor cabang, POP, dan miniPOP THC di seluruh nasional.
          </p>
        </div>
        <Button className="min-h-touch" onClick={() => setCreateOpen(true)}>
          <Plus className="size-4 shrink-0" aria-hidden="true" />
          Tambah Fasilitas
        </Button>
      </div>

      {/* Toolbar filter irisan SCR-02 — pola users benchmark: select berlabel
          + search ber-aria-label, wrap rapi di 375/768/1280 tanpa scroll. */}
      <div className="card flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-40 flex-1 sm:w-48 sm:flex-none">
          <Select
            label="Tipe"
            options={TYPE_FILTER_OPTIONS}
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value as Location['type'] | '')}
          />
        </div>
        <div className="min-w-40 flex-1 sm:w-48 sm:flex-none">
          <Select
            label="Status"
            options={STATUS_FILTER_OPTIONS}
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as 'all' | 'active' | 'inactive')}
          />
        </div>
        <div className="relative min-w-48 flex-1">
          <Input
            aria-label="Cari fasilitas"
            placeholder="Cari nama fasilitas atau kota…"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </div>
        {/* Anak TERAKHIR toolbar: reset semua filter (termasuk switcher cabang). */}
        <FilterResetButton onReset={handleResetFilters} disabled={!isFiltered} />
      </div>

      <div className="mt-4">
        {locationsQuery.isPending ? (
          <div className="card flex items-center justify-center gap-3 py-12 text-sm text-ink-secondary">
            <Spinner size="sm" />
            Memuat daftar fasilitas…
          </div>
        ) : locationsQuery.isError ? (
          <div className="card p-6">
            <p className="flex items-center gap-2 text-sm font-semibold text-danger-text">
              <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
              Gagal memuat daftar fasilitas
            </p>
            <p className="mt-2 text-sm text-ink-secondary">
              {apiErrorMessage(locationsQuery.error)}
            </p>
            <Button variant="secondary" className="mt-4 min-h-touch" onClick={() => void locationsQuery.refetch()}>
              Coba Lagi
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="card">
            <EmptyState
              icon={<Inbox aria-hidden="true" className="size-8" />}
              title={emptyTitle}
              description={emptyDescription}
            />
          </div>
        ) : (
          <>
            <FacilityTable locations={rows} onEdit={setEditing} onDelete={showDelete ? setDeleting : undefined} />
            <FacilityCards locations={rows} onEdit={setEditing} onDelete={showDelete ? setDeleting : undefined} />
          </>
        )}
      </div>

      {deleting !== null ? (
        <ConfirmModal
          open
          title={`Hapus ${deleting.name}`}
          message={deleteLocationConfirmMessage(deleting)}
          loading={deleteMutation.isPending}
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            deleteMutation.mutate(
              { locationId: deleting.id },
              {
                onSuccess: () => {
                  toast.success(`${deleting.name} dihapus permanen`)
                  setDeleting(null)
                },
                // 409 (masih direferensikan) tampil apa adanya dari server.
                onError: (error) => {
                  toast.error(apiErrorMessage(error))
                },
              },
            )
          }}
        />
      ) : null}

      {createOpen ? (
        <LocationFormModal
          title="Tambah Fasilitas"
          submitLabel="Tambah Fasilitas"
          locations={locations}
          onClose={() => setCreateOpen(false)}
        />
      ) : null}
      {editing !== null ? (
        <LocationFormModal
          title={`Ubah ${editing.name}`}
          submitLabel="Simpan Perubahan"
          locations={locations}
          initial={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </SuperadminShell>
  )
}

// ---------------------------------------------------------------------------
// Tabel desktop (>= 1024px) + kartu responsif: ponsel (< 768px) tumpukan
// vertikal 1 kolom, tablet (768px - 1023px) grid 2 kolom — tanpa scroll.
// ---------------------------------------------------------------------------

interface FacilityListProps {
  locations: Location[]
  onEdit: (location: Location) => void
  onDelete?: (location: Location) => void
}

function useToggleLocation() {
  const update = useUpdateLocationMutation()
  const toggle = (location: Location): void => {
    update.mutate(
      { locationId: location.id, body: { is_active: !isLocationActive(location) } },
      {
        onSuccess: () => {
          toast.success(
            isLocationActive(location)
              ? `${location.name} dinonaktifkan`
              : `${location.name} diaktifkan`,
          )
        },
        onError: (error) => {
          toast.error(apiErrorMessage(error))
        },
      },
    )
  }
  return { toggle, isPending: update.isPending, activeId: update.variables?.locationId }
}

function FacilityTable({ locations, onEdit, onDelete }: FacilityListProps) {
  const { toggle, isPending, activeId } = useToggleLocation()

  return (
    <div className="card hidden overflow-hidden lg:block">
      <table className="w-full table-fixed border-collapse text-left">
        <thead>
          <tr>
            {[
              { label: 'Nama Fasilitas', width: 'w-[24%]' },
              { label: 'Tipe', width: 'w-[14%]' },
              { label: 'Kota', width: 'w-[14%]' },
              { label: 'Zona', width: 'w-[10%]' },
              { label: 'Status', width: 'w-[13%]' },
              { label: 'Aksi', width: 'w-[25%]' },
            ].map((header) => (
              <th
                key={header.label}
                scope="col"
                className={`${header.width} border-b border-border-light bg-brand/5 px-2 sm:px-3 lg:px-6 py-3 text-xs sm:text-sm font-semibold text-ink-secondary`}
              >
                {header.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border-light">
          {locations.map((location) => {
            const active = isLocationActive(location)
            return (
              <tr
                key={location.id}
                className="transition-colors hover:bg-brand/5"
              >
                <td className="px-2 sm:px-3 lg:px-6 py-3">
<p className="truncate text-xs sm:text-sm font-semibold text-ink" title={location.name}>
                    {location.name}
                  </p>
                </td>
                <td className="px-2 sm:px-3 lg:px-6 py-3">
                  <Badge tone="info">{LOCATION_TYPE_LABEL[location.type]}</Badge>
                </td>
                <td className="truncate px-2 sm:px-3 lg:px-6 py-3 text-xs sm:text-sm text-ink-secondary" title={location.city}>
                  {location.city !== '' ? location.city : '—'}
                </td>
                <td className="px-2 sm:px-3 lg:px-6 py-3">
                  <Badge tone="neutral">{location.timezone}</Badge>
                </td>
                <td className="px-2 sm:px-3 lg:px-6 py-3">
                  <Badge tone={active ? 'success' : 'neutral'}>
                    {active ? 'Aktif' : 'Nonaktif'}
                  </Badge>
                </td>
                <td className="px-2 sm:px-3 lg:px-6 py-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="secondary"
                      className="min-h-touch px-3"
                      aria-label={`Ubah ${location.name}`}
                      onClick={() => onEdit(location)}
                    >
                      <Pencil aria-hidden="true" className="size-4 shrink-0" />
                      Ubah
                    </Button>
                    <Button
                      size="sm"
                      variant={active ? 'secondary' : 'primary'}
                      className="min-h-touch px-3"
                      loading={isPending && activeId === location.id}
                      onClick={() => toggle(location)}
                    >
                      {active ? 'Nonaktifkan' : 'Aktifkan'}
                    </Button>
                    {onDelete !== undefined ? (
                      <Button
                        size="sm"
                        variant="danger"
                        className="min-h-touch px-3"
                        aria-label={`Hapus ${location.name}`}
                        onClick={() => onDelete(location)}
                      >
                        <Trash2 aria-hidden="true" className="size-4 shrink-0" />
                        Hapus
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

function FacilityCards({ locations, onEdit, onDelete }: FacilityListProps) {
  const { toggle, isPending, activeId } = useToggleLocation()

  return (
    <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:hidden">
      {locations.map((location) => {
        const active = isLocationActive(location)
        return (
          <li key={location.id} className="card flex flex-col p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink" title={location.name}>
                  {location.name}
                </p>
                <p className="truncate text-xs text-ink-muted">
                  {location.city !== '' ? location.city : '—'} · {location.timezone}
                </p>
              </div>
              <Badge tone={active ? 'success' : 'neutral'} className="shrink-0">
                {active ? 'Aktif' : 'Nonaktif'}
              </Badge>
            </div>
            <div className="mt-3 flex flex-1 flex-col gap-2 text-sm text-ink-secondary">
              <p className="flex items-start gap-2">
                <Building2 className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
                <span>{LOCATION_TYPE_LABEL[location.type]}</span>
              </p>
              <p className="flex items-start gap-2">
                <MapPin className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
                <span className="min-w-0 wrap-anywhere">
                  {location.address !== '' ? location.address : 'Alamat belum diisi.'}
                </span>
              </p>
            </div>
            {/* Cluster aksi WRAP:3 tombol (Ubah/Nonaktifkan/Hapus) harus muat
                di 375px tanpa scroll horizontal (design system §5.2). */}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                className="min-h-touch flex-1"
                aria-label={`Ubah ${location.name}`}
                onClick={() => onEdit(location)}
              >
                <Pencil aria-hidden="true" className="size-4 shrink-0" />
                Ubah
              </Button>
              <Button
                variant={active ? 'secondary' : 'primary'}
                className="min-h-touch flex-1"
                loading={isPending && activeId === location.id}
                onClick={() => toggle(location)}
              >
                {active ? 'Nonaktifkan' : 'Aktifkan'}
              </Button>
              {onDelete !== undefined ? (
                <Button
                  variant="danger"
                  className="min-h-touch flex-1"
                  aria-label={`Hapus ${location.name}`}
                  onClick={() => onDelete(location)}
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
  )
}

// ---------------------------------------------------------------------------
// Modal create / edit (satu komponen, pola SecurityUserModal)
// ---------------------------------------------------------------------------

interface LocationFormModalProps {
  title: string
  submitLabel: string
  locations: Location[]
  initial?: Location
  onClose: () => void
}

function LocationFormModal({ title, submitLabel, locations, initial, onClose }: LocationFormModalProps) {
  const [form, setForm] = useState<LocationFormValues>(
    initial !== undefined
      ? {
          name: initial.name,
          type: initial.type,
          address: initial.address,
          city: initial.city,
          timezone: initial.timezone,
        }
      : EMPTY_FORM,
  )
  const create = useCreateLocationMutation()
  const update = useUpdateLocationMutation()
  const pending = create.isPending || update.isPending
  const formId = initial !== undefined ? 'location-edit-form' : 'location-create-form'

  // Aturan penyembunyian `pusat` per modal ada di locationTypeFormOptions.
  const typeOptions = useMemo(
    () => locationTypeFormOptions(locations, initial),
    [locations, initial],
  )

  // Invariant: nilai select wajib selalu terkandung di daftar opsi — bila opsi
  // berubah saat modal terbuka (refetch), kosongkan pilihan agar user memilih
  // tipe yang valid secara sadar; server tetap otoritas (tanpa toast blokir).
  useEffect(() => {
    if (form.type !== '' && !typeOptions.some((option) => option.value === form.type)) {
      setForm((prev) => ({ ...prev, type: '' }))
    }
  }, [form.type, typeOptions])

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (form.name.trim() === '' || form.type === '') return
    if (initial !== undefined) {
      update.mutate(
        {
          locationId: initial.id,
          body: {
            name: form.name.trim(),
            type: form.type,
            address: form.address.trim(),
            city: form.city.trim(),
            timezone: form.timezone,
          },
        },
        {
          onSuccess: () => {
            toast.success(`${form.name.trim()} berhasil diperbarui`)
            onClose()
          },
          onError: (error) => {
            toast.error(apiErrorMessage(error))
          },
        },
      )
      return
    }
    create.mutate(
      {
        body: {
          name: form.name.trim(),
          type: form.type,
          ...(form.address.trim() !== '' ? { address: form.address.trim() } : {}),
          ...(form.city.trim() !== '' ? { city: form.city.trim() } : {}),
          timezone: form.timezone,
        },
      },
      {
        onSuccess: () => {
          toast.success(`${form.name.trim()} berhasil ditambahkan`)
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
      title={title}
      size="lg"
      footer={
        <>
          <Button variant="ghost" className="min-h-touch" onClick={onClose}>
            Batal
          </Button>
          <Button type="submit" form={formId} className="min-h-touch" loading={pending}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Input
          label="Nama Fasilitas"
          placeholder="Kantor Cabang Sambas"
          value={form.name}
          onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
          required
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Tipe Fasilitas"
            placeholder="Pilih tipe"
            options={typeOptions}
            value={form.type}
            onChange={(event) =>
              setForm((prev) => ({ ...prev, type: event.target.value as LocationTypeOption }))
            }
            required
          />
          <Select
            label="Zona Waktu"
            options={TIMEZONE_OPTIONS}
            value={form.timezone}
            onChange={(event) =>
              setForm((prev) => ({ ...prev, timezone: event.target.value as Location['timezone'] }))
            }
            required
          />
        </div>
        <Input
          label="Alamat"
          placeholder="Jl. Sukaramai No. 12, Sambas"
          value={form.address}
          onChange={(event) => setForm((prev) => ({ ...prev, address: event.target.value }))}
        />
        <Input
          label="Kota"
          placeholder="Sambas"
          value={form.city}
          onChange={(event) => setForm((prev) => ({ ...prev, city: event.target.value }))}
        />
      </form>
    </Modal>
  )
}
