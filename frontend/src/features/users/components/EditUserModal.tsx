'use client'

import { useState, type FormEvent } from 'react'
import { Lock } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Select, type SelectOption } from '@/components/ui/Select'
import { useVendorsQuery } from '@/lib/api/hooks'
import type { UpdateManagedUserRequest, User } from '@/lib/api/types'
import {
  VENDOR_NAME_MAX_LENGTH,
  resolveVendorInput,
} from '@/lib/visits/vendor-input'
import { validateNik } from '@/lib/users/nik'
import { managedRoleTone } from '@/lib/visits/status-badge'
import { getRoleLabel } from '@/lib/auth/capabilities'

export interface EditUserModalProps {
  user: User
  locations: Array<{ id: string; name: string }>
  /** Tombol simpan menampilkan spinner saat mutasi pemilik berjalan. */
  saving: boolean
  /**
   * select = dropdown cabang (konsol superadmin); locked = label terkunci
   * (panel pengawas — pindah cabang lewat konsol); hidden = tanpa cabang
   * (Vendor/Mitra/superadmin tanpa lokasi).
   */
  locationMode: 'select' | 'locked' | 'hidden'
  /** True bila target adalah akun sendiri: wajib buktikan password saat ini. */
  isSelf: boolean
  onClose: () => void
  /** Pemilik menyediakan mutasi + toast (endpoint beda per permukaan). */
  onSubmit: (body: UpdateManagedUserRequest) => void
}

/**
 * Modal ubah user terkelola — dipakai ulang halaman `/users` (endpoint
 * PATCH /users/:id, superadmin) dan panel pengawas (endpoint
 * PATCH /users/security/:id, admin cabang terkunci + superadmin).
 * Prefill dari baris; peran read-only; kata sandi opsional (kosong =
 * biarkan, terisi = reset hash — pesan BE tampil apa adanya di pemilik).
 * NIK tampil iff admin|vendor: prefill + required (BE wajib, tak boleh
 * dikosongkan); disembunyikan untuk security (BE menolak NIK).
 */
export function EditUserModal({ user, locations, saving, locationMode, isSelf, onClose, onSubmit }: EditUserModalProps) {
  const [name, setName] = useState(user.name)
  const [email, setEmail] = useState(user.email)
  const [phone, setPhone] = useState(user.phone ?? '')
  // Prefill NIK dari baris; required — pengosongan ditolak (cermin BE).
  const [nik, setNik] = useState(user.nik ?? '')
  const [nikError, setNikError] = useState<string | undefined>(undefined)
  const [locationId, setLocationId] = useState(user.location_id ?? '')
  // Prefill teks vendor apa adanya dari baris. Tanpa perubahan = field absen
  // dari payload; dikosongkan = kirim `vendor_name: ''` (bersihkan kolom).
  const initialVendorName = (user.vendor_name ?? '').trim()
  const [vendorText, setVendorText] = useState(user.vendor_name ?? '')
  const [password, setPassword] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')

  const showNik = user.role === 'admin' || user.role === 'vendor'
  const showVendor = user.role === 'vendor'
  // Katalog vendor hanya untuk Vendor/Mitra; dimuat hanya saat dibutuhkan.
  const vendorsQuery = useVendorsQuery(showVendor)
  const locationOptions: SelectOption[] = locations.map((location) => ({
    value: location.id,
    label: location.name,
  }))
  const lockedLocationName =
    locations.find((location) => location.id === user.location_id)?.name ??
    user.location_name ??
    '—'

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (name.trim() === '' || email.trim() === '') return
    if (locationMode === 'select' && locationId === '') return
    // NIK tak boleh dikosongkan untuk admin/vendor (BE wajib).
    if (showNik) {
      const error = validateNik(nik, true)
      setNikError(error ?? undefined)
      if (error !== null) return
    }

    // Vendor/Mitra: tak diubah → JANGAN kirim field; dikosongkan →
    // `vendor_name: ''` (bersihkan); diubah → cocok persis dengan katalog
    // (case-insensitive) → `vendor_id`, selain itu `vendor_name` manual.
    // Nama ketikan manual TIDAK pernah masuk katalog vendor.
    let vendorFields: UpdateManagedUserRequest = {}
    if (showVendor) {
      const next = vendorText.trim()
      if (next !== initialVendorName) {
        vendorFields =
          next === ''
            ? { vendor_name: '' }
            : resolveVendorInput(next, vendorsQuery.data ?? [])
      }
    }

    onSubmit({
      name: name.trim(),
      email: email.trim(),
      phone: phone.trim(),
      ...(showNik ? { nik: nik.trim() } : {}),
      ...(locationMode === 'select' ? { location_id: locationId } : {}),
      ...vendorFields,
      ...(password !== '' ? { password } : {}),
      // Bukti anti-pengambilalihan: reset password akun sendiri wajib
      // menyertakan password saat ini (BE memverifikasi hash-nya).
      ...(password !== '' && isSelf ? { current_password: currentPassword } : {}),
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Ubah User — ${user.name}`}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Batal
          </Button>
          <Button
            type="submit"
            form="managed-user-edit-form"
            className="min-h-touch"
            loading={saving}
          >
            Simpan Perubahan
          </Button>
        </>
      }
    >
      <form id="managed-user-edit-form" onSubmit={handleSubmit} className="flex flex-col gap-4">
        <p className="flex items-center gap-2 text-sm text-ink-secondary">
          <Badge tone={managedRoleTone(user.role)}>{getRoleLabel(user.role)}</Badge>
          Peran dan status tidak diubah di sini.
        </p>
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
            hint="Kosongkan untuk menghapus nomor."
          />
          <Input
            label="Kata Sandi Baru"
            type="password"
            placeholder="Kosongkan bila tak diubah"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
          />
          {isSelf ? (
            <Input
              label="Kata Sandi Saat Ini"
              type="password"
              placeholder="Wajib bila mengganti sandi sendiri"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
              required={password !== ''}
            />
          ) : null}
        </div>
        {showNik ? (
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
        ) : null}
        {locationMode === 'select' ? (
          <Select
            label="Cabang Penugasan"
            placeholder="Pilih cabang / POP"
            options={locationOptions}
            value={locationId}
            onChange={(event) => setLocationId(event.target.value)}
            required
          />
        ) : null}
        {locationMode === 'locked' ? (
          <div className="flex flex-col gap-2">
            <span className="text-label font-semibold text-ink">Cabang Penugasan</span>
            <p className="inline-flex w-fit min-h-touch items-center gap-2 rounded-control border border-border-light bg-neutral-bg px-3 py-2 text-label text-ink-secondary">
              <Lock aria-hidden="true" className="size-3.5 shrink-0 text-ink-muted" />
              {lockedLocationName}
              <span className="text-ink-muted">(terkunci)</span>
            </p>
          </div>
        ) : null}
        {showVendor ? (
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
              hint="Pilih dari daftar atau ketik manual. Kosongkan lalu simpan untuk menghapus vendor."
              value={vendorText}
              onChange={(event) => setVendorText(event.target.value)}
              list="edit-user-vendor-datalist"
              autoComplete="off"
              maxLength={VENDOR_NAME_MAX_LENGTH}
            />
            <datalist id="edit-user-vendor-datalist">
              {(vendorsQuery.data ?? []).map((vendor) => (
                <option key={vendor.id} value={vendor.name} />
              ))}
            </datalist>
          </>
        ) : null}
      </form>
    </Modal>
  )
}
