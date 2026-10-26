'use client'

import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Select, type SelectOption } from '@/components/ui/Select'
import { apiErrorMessage } from '@/features/visits/components/ApproveModal'
import { requiresManagedLocation } from '@/features/users/managed-user-filters'
import { useCreateManagedUserMutation, useVendorsQuery } from '@/lib/api/hooks'
import type { CreateManagedUserRequest, ManagedUserRole } from '@/lib/api/types'
import { getRoleLabel } from '@/lib/auth/capabilities'
import {
  EMAIL_MAX_LENGTH,
  NAME_MAX_LENGTH,
  PASSWORD_MAX_BYTES,
  PHONE_MAX_LENGTH,
  isValidEmail,
  isValidPassword,
  isValidPhone,
  sanitizePhoneInput,
} from '@/lib/limits'
import { validateNik } from '@/lib/users/nik'
import {
  VENDOR_NAME_MAX_LENGTH,
  resolveVendorInput,
} from '@/lib/visits/vendor-input'

export interface ManagedUserCreateModalProps {
  /**
   * Peran yang DIPIN modal ini — tanpa dropdown peran. Perannya mengikuti
   * filter peran yang sedang aktif di layar: `admin` (cabang penugasan wajib)
   * atau `vendor` (perusahaan vendor opsional).
   */
  role: ManagedUserRole
  locations: Array<{ id: string; name: string }>
  onClose: () => void
}

/**
 * Modal daftar akun terkelola (POST /users) — dipakai bersama oleh layar
 * Koordinator Wilayah dan Pendaftaran Vendor/Mitra. Peran terkunci lewat
 * prop `role`, jadi tak ada lagi dropdown peran: yang berubah antar layar
 * hanyalah field afiliasi (cabang penugasan vs perusahaan vendor).
 */
export function ManagedUserCreateModal({
  role,
  locations,
  onClose,
}: ManagedUserCreateModalProps) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [phone, setPhone] = useState('')
  const [nik, setNik] = useState('')
  const [nikError, setNikError] = useState<string | undefined>(undefined)
  const [emailError, setEmailError] = useState<string | undefined>(undefined)
  const [phoneError, setPhoneError] = useState<string | undefined>(undefined)
  const [passwordError, setPasswordError] = useState<string | undefined>(undefined)
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
  const roleLabel = getRoleLabel(role)

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (name.trim() === '' || email.trim() === '' || password === '') return
    if (needsLocation && locationId === '') return

    const nextEmailError = isValidEmail(email) ? undefined : 'Format email tidak valid.'
    setEmailError(nextEmailError)
    if (nextEmailError !== undefined) return

    const nextPhoneError =
      phone.trim() === '' || isValidPhone(phone) ? undefined : 'Format nomor telepon tidak valid.'
    setPhoneError(nextPhoneError)
    if (nextPhoneError !== undefined) return

    const nextPasswordError = isValidPassword(password)
      ? undefined
      : 'Kata sandi minimal 8 karakter dan maksimal 72 byte.'
    setPasswordError(nextPasswordError)
    if (nextPasswordError !== undefined) return

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
      title={`Tambah ${roleLabel}`}
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
            {`Tambah ${roleLabel}`}
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
          <Input
            label="Kata Sandi"
            type="password"
            placeholder="Kata sandi awal"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value)
              if (passwordError !== undefined) setPasswordError(undefined)
            }}
            autoComplete="new-password"
            maxLength={PASSWORD_MAX_BYTES}
            hint="Minimal 8 karakter. Dibagikan ke user; dapat diubah setelah masuk."
            error={passwordError}
            required
          />
        </div>
        {/* NIK wajib untuk admin & vendor (BE wajib untuk keduanya). */}
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
