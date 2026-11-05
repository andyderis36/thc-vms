'use client'

import { useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { PasswordInput } from '@/components/ui/PasswordInput'
import { useUserAvatar } from '@/components/ui/useUserAvatar'
import { useUpdateProfileMutation, useUploadFileMutation } from '@/lib/api/hooks'
import type { UpdateSelfProfileRequest } from '@/lib/api/types'
import { useSession } from '@/lib/auth/session'
import { getRoleLabel } from '@/lib/auth/capabilities'
import {
  NAME_MAX_LENGTH,
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  PHONE_DIGIT_MESSAGE,
  PHONE_MAX_LENGTH,
  PHONE_MIN_LENGTH,
  isValidPassword,
  isValidPhone,
  sanitizePhoneInput,
} from '@/lib/limits'
import { MAX_UPLOAD_INGEST_BYTES } from '@/lib/uploads/validation'

import { AvatarCropDialog } from './AvatarCropDialog'
import { EmailChangeSection } from './EmailChangeSection'

/** MIME yang boleh dipilih untuk foto profil (cermin backend `profile_photo`). */
const AVATAR_MIME_TYPES = ['image/jpeg', 'image/png'] as const

/** Pesan galat aman untuk UI (pola sama dengan form pengawas/managed user). */
function apiErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') {
    return error.message
  }
  return 'Terjadi kesalahan. Silakan coba lagi.'
}

/**
 * Inisial maksimal 2 huruf — salinan lokal dari helper `ProfileMenu`
 * (komponen shell tidak diekspor/diubah pada tugas ini).
 */
export function initialsOf(name: string): string {
  const initials = name
    .split(/\s+/)
    .filter((part) => part !== '')
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('')
  return initials === '' ? '?' : initials
}

/**
 * Form "Profil Saya" — satu-satunya layar swalayan untuk semua peran.
 *
 * Sumber data identitas adalah sesi (`/auth/me` sudah menyertakan
 * `avatar_url` + `editable_fields`); foto profil diambil sebagai blob lewat
 * `useUserAvatar` karena `avatar_url` adalah path terautentikasi. Nama hanya
 * dirender bila backend menyatakan `name` editable
 * (`super_admin`); peran lain tidak melihat input itu sama sekali.
 *
 * Setiap perubahan dikirim parsial: hanya field yang benar-benar berbeda dari
 * nilai sesi, dan `name` tidak pernah ikut bila tidak editable (backend
 * menolak field asing dengan 400 dan nama non-super_admin dengan 403).
 */
export function ProfileForm() {
  const { user } = useSession()
  const updateProfile = useUpdateProfileMutation()
  const uploadFile = useUploadFileMutation()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [name, setName] = useState(user?.name ?? '')
  const [phone, setPhone] = useState(user?.phone ?? '')
  const [nameError, setNameError] = useState<string | undefined>(undefined)
  const [phoneError, setPhoneError] = useState<string | undefined>(undefined)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [currentPasswordError, setCurrentPasswordError] = useState<string | undefined>(undefined)
  const [newPasswordError, setNewPasswordError] = useState<string | undefined>(undefined)
  const [confirmPasswordError, setConfirmPasswordError] = useState<string | undefined>(undefined)
  // Berkas yang menunggu pemotongan 1:1; unggah baru terjadi setelah konfirmasi.
  const [cropFile, setCropFile] = useState<File | null>(null)
  const { objectUrl: avatarObjectUrl } = useUserAvatar(user?.avatar_url)

  if (user === null) {
    return null
  }

  // Alias non-null: narrowing `user` tidak bertahan di dalam closure async
  // (handler submit), jadi pegangan `const` ini yang dipakai di sana.
  const me = user
  // Satu normalisasi: API mengirim null untuk akun tanpa foto, dan nilai yang
  // hilang (server lama / cache basi saat rilis) diperlakukan sama supaya
  // tidak merender <img> kosong atau tombol "Hapus foto" palsu.
  const avatarUrl = user.avatar_url ?? null
  const editableFields = user.editable_fields
  const nameEditable = editableFields?.includes('name') ?? false
  const phoneEditable = editableFields?.includes('phone') ?? true
  const avatarEditable = editableFields?.includes('avatar_url') ?? true
  const nothingEditable = editableFields !== undefined && editableFields.length === 0

  const busy = uploadFile.isPending || updateProfile.isPending
  const nameDirty = nameEditable && name.trim() !== user.name
  const phoneDirty = phoneEditable && phone.trim() !== user.phone
  const dirty = nameDirty || phoneDirty

  function pickFile(): void {
    fileInputRef.current?.click()
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0]
    // Kosongkan agar berkas yang sama dapat dipilih ulang.
    event.target.value = ''
    if (file === undefined || busy) {
      return
    }
    if (!AVATAR_MIME_TYPES.includes(file.type as (typeof AVATAR_MIME_TYPES)[number])) {
      toast.error('Format foto tidak didukung. Gunakan JPG atau PNG.')
      return
    }
    if (file.size > MAX_UPLOAD_INGEST_BYTES) {
      toast.error('Ukuran foto melebihi batas 20 MB.')
      return
    }
    setCropFile(file)
  }

  function handleCropCancel(): void {
    if (busy) {
      return
    }
    setCropFile(null)
  }

  // Galat unggah/patch diteruskan apa adanya: AvatarCropDialog menampilkannya
  // sebagai galat inline dan menutup dialog hanya bila induk membersihkan state.
  async function handleCropConfirm(cropped: File): Promise<void> {
    const uploaded = await uploadFile.mutateAsync({
      file: cropped,
      category: 'profile_photo',
    })
    await updateProfile.mutateAsync({ avatar_url: uploaded.file_url })
    toast.success('Foto profil berhasil diperbarui.')
    setCropFile(null)
  }

  async function handleRemovePhoto(): Promise<void> {
    if (busy) {
      return
    }
    try {
      await updateProfile.mutateAsync({ avatar_url: null })
      toast.success('Foto profil berhasil dihapus.')
    } catch (error) {
      toast.error(apiErrorMessage(error))
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (busy) {
      return
    }

    const nextName = name.trim()
    if (nameEditable) {
      if (nextName === '') {
        setNameError('Nama wajib diisi.')
        return
      }
      if (nextName.length > NAME_MAX_LENGTH) {
        setNameError(`Nama maksimal ${NAME_MAX_LENGTH} karakter.`)
        return
      }
    }

    const nextPhone = phone.trim()
    if (phoneEditable) {
      if (nextPhone === '') {
        setPhoneError('Nomor telepon wajib diisi.')
        return
      }
      if (
        nextPhone.length < PHONE_MIN_LENGTH ||
        nextPhone.length > PHONE_MAX_LENGTH
      ) {
        setPhoneError(PHONE_DIGIT_MESSAGE)
        return
      }
      if (!isValidPhone(nextPhone)) {
        setPhoneError('Format nomor telepon tidak valid (contoh: 081234567890).')
        return
      }
    }

    const payload: UpdateSelfProfileRequest = {}
    if (nameEditable && nextName !== me.name) {
      payload.name = nextName
    }
    if (phoneEditable && nextPhone !== me.phone) {
      payload.phone = nextPhone
    }
    if (Object.keys(payload).length === 0) {
      return
    }

    try {
      await updateProfile.mutateAsync(payload)
      toast.success('Profil berhasil diperbarui.')
    } catch (error) {
      toast.error(apiErrorMessage(error))
    }
  }

  function clearPasswordFields(): void {
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
  }

  async function handlePasswordSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (busy) {
      return
    }

    if (currentPassword === '') {
      setCurrentPasswordError('Kata sandi saat ini wajib diisi.')
      return
    }
    if (!isValidPassword(newPassword)) {
      setNewPasswordError('Kata sandi minimal 8 karakter dan maksimal 72 byte.')
      return
    }
    if (confirmPassword !== newPassword) {
      setConfirmPasswordError('Konfirmasi kata sandi tidak sama.')
      return
    }

    try {
      await updateProfile.mutateAsync({
        new_password: newPassword,
        current_password: currentPassword,
      })
      toast.success('Kata sandi berhasil diubah.')
      clearPasswordFields()
    } catch (error) {
      toast.error(apiErrorMessage(error))
    }
  }

  // Ganti kata sandi milik sendiri — tersedia untuk SEMUA peran (termasuk
  // super_admin dan dev-superadmin) lewat PATCH /auth/me yang sama. Form
  // terpisah dari profil agar validasi dan pengiriman tidak tercampur; nilai
  // tidak pernah ditampilkan kembali dan dibersihkan setiap sukses.
  const passwordSection = (
    <section className="card flex flex-col gap-4 p-4 sm:p-6" aria-label="Ganti kata sandi">
      <div>
        <h2 className="text-base font-semibold text-ink">Ganti kata sandi</h2>
        <p className="mt-1 text-sm text-ink-secondary">
          Masukkan kata sandi saat ini lalu kata sandi baru Anda.
        </p>
      </div>
      <form onSubmit={(event) => void handlePasswordSubmit(event)} className="flex flex-col gap-4">
        <PasswordInput
          label="Kata sandi saat ini"
          placeholder="Kata sandi yang sedang dipakai"
          value={currentPassword}
          onChange={(event) => {
            setCurrentPassword(event.target.value)
            if (currentPasswordError !== undefined) setCurrentPasswordError(undefined)
          }}
          autoComplete="current-password"
          className="min-h-touch"
          maxLength={PASSWORD_MAX_BYTES}
          error={currentPasswordError}
        />
        <PasswordInput
          label="Kata sandi baru"
          placeholder="Minimal 8 karakter"
          value={newPassword}
          onChange={(event) => {
            setNewPassword(event.target.value)
            if (newPasswordError !== undefined) setNewPasswordError(undefined)
          }}
          autoComplete="new-password"
          className="min-h-touch"
          maxLength={PASSWORD_MAX_BYTES}
          hint={`Minimal ${PASSWORD_MIN_LENGTH} karakter.`}
          error={newPasswordError}
        />
        <PasswordInput
          label="Konfirmasi kata sandi baru"
          placeholder="Ulangi kata sandi baru"
          value={confirmPassword}
          onChange={(event) => {
            setConfirmPassword(event.target.value)
            if (confirmPasswordError !== undefined) setConfirmPasswordError(undefined)
          }}
          autoComplete="new-password"
          className="min-h-touch"
          maxLength={PASSWORD_MAX_BYTES}
          error={confirmPasswordError}
        />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="submit"
            className="min-h-touch-lg focus-visible:outline-brand-contrast"
            disabled={currentPassword === '' || newPassword === '' || confirmPassword === '' || busy}
            loading={updateProfile.isPending}
          >
            Ubah Kata Sandi
          </Button>
        </div>
      </form>
    </section>
  )

  const heading = (
    <div className="min-w-0">
      <h1 className="text-2xl font-bold tracking-tight text-ink">Profil Saya</h1>
      <p className="mt-1.5 text-sm text-ink-secondary">
        Kelola informasi akun dan foto profil Anda.
      </p>
    </div>
  )

  if (nothingEditable) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
        {heading}
        {passwordSection}
        <EmailChangeSection />
        <section className="card p-4 sm:p-6" aria-label="Informasi akun">
          <h2 className="text-base font-semibold text-ink">Informasi Akun</h2>
          <p className="mt-1 text-sm text-ink-secondary">
            Akun Anda tidak memiliki data yang dapat diubah sendiri. Hubungi
            Superadmin untuk perubahan data.
          </p>
          <dl className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-xs text-ink-muted">Nama</dt>
              <dd className="truncate text-sm text-ink">{user.name}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-ink-muted">Email</dt>
              <dd className="truncate text-sm text-ink">{user.email}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-ink-muted">No. Telepon</dt>
              <dd className="truncate text-sm text-ink">{user.phone}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-ink-muted">Peran</dt>
              <dd className="text-sm text-ink">{getRoleLabel(user.role)}</dd>
            </div>
          </dl>
        </section>
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      {heading}

      <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4">
        <section className="card flex flex-col items-center gap-4 p-4 sm:flex-row sm:items-start sm:p-6">
          <span
            aria-hidden={avatarObjectUrl !== null ? undefined : true}
            className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand text-2xl font-bold text-brand-contrast"
          >
            {avatarObjectUrl !== null ? (
              // eslint-disable-next-line @next/next/no-img-element -- src berupa object URL `blob:`, di luar jangkauan optimizer next/image.
              <img
                src={avatarObjectUrl}
                alt={`Foto profil ${user.name}`}
                className="size-full object-cover"
              />
            ) : (
              initialsOf(user.name)
            )}
          </span>

          <div className="flex min-w-0 flex-1 flex-col items-center gap-2 sm:items-start">
            <p className="max-w-full truncate text-sm font-semibold text-ink">{user.name}</p>
            <p className="max-w-full truncate text-xs text-ink-secondary">{user.email}</p>

            {avatarEditable ? (
              <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
                <Button
                  type="button"
                  variant="secondary"
                  className="min-h-touch"
                  onClick={pickFile}
                  loading={uploadFile.isPending}
                  disabled={updateProfile.isPending}
                >
                  <Upload aria-hidden="true" className="size-4 shrink-0" />
                  Unggah foto
                </Button>
                {avatarUrl !== null ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-touch"
                    onClick={() => void handleRemovePhoto()}
                    disabled={busy}
                  >
                    <Trash2 aria-hidden="true" className="size-4 shrink-0" />
                    Hapus foto
                  </Button>
                ) : null}
              </div>
            ) : null}

            <p className="text-xs text-ink-muted">JPG atau PNG. Foto dikompresi otomatis (hasil ≤5 MB).</p>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png"
              className="hidden"
              tabIndex={-1}
              aria-label="Pilih foto profil"
              onChange={handleFileChange}
            />
          </div>
        </section>

        <section className="card flex flex-col gap-4 p-4 sm:p-6">
          {nameEditable ? (
            <Input
              label="Nama Lengkap"
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                if (nameError !== undefined) setNameError(undefined)
              }}
              autoComplete="name"
              maxLength={NAME_MAX_LENGTH}
              required
              className="min-h-touch"
              error={nameError}
            />
          ) : null}

          {phoneEditable ? (
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
              required
              className="min-h-touch"
              hint="Nomor aktif yang dapat dihubungi petugas pos."
              error={phoneError}
            />
          ) : null}
        </section>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="submit"
            className="min-h-touch-lg focus-visible:outline-brand-contrast"
            disabled={!dirty || busy}
            loading={updateProfile.isPending}
          >
            Simpan Perubahan
          </Button>
        </div>
      </form>

      {passwordSection}

      <EmailChangeSection />

      <AvatarCropDialog
        open={cropFile !== null}
        file={cropFile}
        busy={busy}
        onCancel={handleCropCancel}
        onConfirm={handleCropConfirm}
      />
    </div>
  )
}
