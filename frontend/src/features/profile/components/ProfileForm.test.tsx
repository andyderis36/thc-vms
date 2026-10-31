// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installAvatarFetchStubs } from '@/test-utils/avatarFetch'
import type { User } from '@/lib/api/types'
import { MAX_UPLOAD_INGEST_BYTES } from '@/lib/uploads/validation'

import { ProfileForm } from './ProfileForm'

const { updateMock, uploadMock, session } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  uploadMock: vi.fn(),
  session: { user: null as User | null },
}))

vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({ user: session.user, status: 'authenticated', refresh: vi.fn() }),
}))

vi.mock('@/lib/api/hooks', () => ({
  useUpdateProfileMutation: () => ({ mutateAsync: updateMock, isPending: false }),
  useUploadFileMutation: () => ({ mutateAsync: uploadMock, isPending: false }),
}))

// Stub tanpa kanvas/react-easy-crop: hanya menguji kontrak induk (buka/tutup,
// onConfirm, onCancel) — persiapan kanvas diuji di AvatarCropDialog.test.tsx.
vi.mock('./AvatarCropDialog', () => ({
  AvatarCropDialog: ({
    open,
    file,
    onCancel,
    onConfirm,
  }: {
    open: boolean
    file: File | null
    onCancel: () => void
    onConfirm: (file: File) => Promise<void> | void
  }) => {
    if (!open || file === null) {
      return null
    }
    return createElement(
      'div',
      { 'data-testid': 'avatar-crop-dialog', 'data-file-name': file.name },
      createElement('button', { type: 'button', onClick: onCancel }, 'Batal'),
      createElement(
        'button',
        {
          type: 'button',
          onClick: () => void onConfirm(new File(['crop'], 'foto.jpg', { type: 'image/jpeg' })),
        },
        'Gunakan foto',
      ),
    )
  },
}))

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'u1',
    name: 'Budi Santoso',
    email: 'budi@thc.id',
    phone: '081234567890',
    nik: null,
    role: 'vendor',
    location_id: null,
    location_name: null,
    status: 'active',
    type: 'external',
    vendor_name: 'PT Uji',
    avatar_url: null,
    editable_fields: ['phone', 'avatar_url'],
    ...overrides,
  }
}

beforeEach(() => {
  updateMock.mockReset()
  uploadMock.mockReset()
  updateMock.mockResolvedValue(makeUser())
  uploadMock.mockResolvedValue({
    file_url: 'http://localhost:9000/thc-vms-bucket/uploads/avatar.jpg',
    file_name: 'avatar.jpg',
  })
  session.user = makeUser()
  installAvatarFetchStubs()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ProfileForm', () => {
  it('vendor (tanpa "name" di editable_fields): input nama absen, input telepon ada', () => {
    session.user = makeUser({
      role: 'vendor',
      editable_fields: ['phone', 'avatar_url'],
    })

    render(<ProfileForm />)

    expect(screen.queryByLabelText(/Nama Lengkap/)).not.toBeInTheDocument()
    expect(screen.getByLabelText(/No\. Telepon/)).toBeInTheDocument()
  })

  it('super_admin: input nama ada dan terisi dari sesi', () => {
    session.user = makeUser({
      role: 'super_admin',
      name: 'Siti Admin',
      editable_fields: ['name', 'phone', 'avatar_url'],
    })

    render(<ProfileForm />)

    expect(screen.getByLabelText(/Nama Lengkap/)).toHaveValue('Siti Admin')
  })

  it('mengirim hanya { phone } saat nomor telepon berubah', async () => {
    session.user = makeUser({ phone: '081234567890' })

    render(<ProfileForm />)

    fireEvent.change(screen.getByLabelText(/No\. Telepon/), {
      target: { value: '081298765432' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Simpan Perubahan/i }))

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1))

    const payload = updateMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(payload).toEqual({ phone: '081298765432' })
    expect(payload).not.toHaveProperty('name')
  })

  it('tombol "Hapus foto" hanya tampil saat avatar ada dan mengirim { avatar_url: null }', async () => {
    session.user = makeUser({ avatar_url: null })

    const { rerender } = render(<ProfileForm />)
    expect(screen.queryByRole('button', { name: /Hapus foto/i })).not.toBeInTheDocument()

    session.user = makeUser({ avatar_url: '/api/v1/avatars/abc?v=1a2b3c4d' })
    rerender(<ProfileForm />)

    const removeButton = screen.getByRole('button', { name: /Hapus foto/i })
    fireEvent.click(removeButton)

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1))
    expect(updateMock.mock.calls[0]?.[0]).toEqual({ avatar_url: null })
  })

  it('tombol simpan nonaktif saat belum ada perubahan', () => {
    session.user = makeUser()

    render(<ProfileForm />)

    expect(screen.getByRole('button', { name: /Simpan Perubahan/i })).toBeDisabled()
  })

  describe('ganti kata sandi sendiri', () => {
    function fillPasswordForm(current: string, next: string, confirm: string): void {
      fireEvent.change(screen.getByLabelText('Kata sandi saat ini'), {
        target: { value: current },
      })
      fireEvent.change(screen.getByLabelText('Kata sandi baru'), {
        target: { value: next },
      })
      fireEvent.change(screen.getByLabelText('Konfirmasi kata sandi baru'), {
        target: { value: confirm },
      })
    }

    it.each(['vendor', 'admin', 'security', 'super_admin', 'dev-superadmin'] as const)(
      'seksi "Ganti kata sandi" tampil untuk peran %s',
      (role) => {
        session.user = makeUser({
          role,
          editable_fields: role === 'super_admin' || role === 'dev-superadmin'
            ? ['name', 'phone', 'avatar_url']
            : ['phone', 'avatar_url'],
        })

        render(<ProfileForm />)

        expect(screen.getByLabelText('Kata sandi saat ini')).toBeInTheDocument()
        expect(screen.getByLabelText('Kata sandi baru')).toBeInTheDocument()
        expect(screen.getByLabelText('Konfirmasi kata sandi baru')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Ubah Kata Sandi/i })).toBeInTheDocument()
      },
    )

    it('konfirmasi yang tidak sama ditolak tanpa memanggil API', async () => {
      session.user = makeUser()
      render(<ProfileForm />)

      fillPasswordForm('Lama12345!', 'Baru12345!', 'Beda12345!')
      fireEvent.click(screen.getByRole('button', { name: /Ubah Kata Sandi/i }))

      expect(await screen.findByText('Konfirmasi kata sandi tidak sama.')).toBeInTheDocument()
      expect(updateMock).not.toHaveBeenCalled()
    })

    it('kata sandi baru yang pendek ditolak dengan pesan min-8 tanpa memanggil API', async () => {
      session.user = makeUser()
      render(<ProfileForm />)

      fillPasswordForm('Lama12345!', 'pendek', 'pendek')
      fireEvent.click(screen.getByRole('button', { name: /Ubah Kata Sandi/i }))

      expect(
        await screen.findByText('Kata sandi minimal 8 karakter dan maksimal 72 byte.'),
      ).toBeInTheDocument()
      expect(updateMock).not.toHaveBeenCalled()
    })

    it('sukses mengirim { new_password, current_password } lalu mengosongkan field', async () => {
      session.user = makeUser()
      render(<ProfileForm />)

      fillPasswordForm('Lama12345!', 'Baru12345!', 'Baru12345!')
      fireEvent.click(screen.getByRole('button', { name: /Ubah Kata Sandi/i }))

      await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1))
      expect(updateMock).toHaveBeenCalledWith({
        new_password: 'Baru12345!',
        current_password: 'Lama12345!',
      })

      await waitFor(() => {
        expect(screen.getByLabelText('Kata sandi saat ini')).toHaveValue('')
        expect(screen.getByLabelText('Kata sandi baru')).toHaveValue('')
        expect(screen.getByLabelText('Konfirmasi kata sandi baru')).toHaveValue('')
      })
    })
  })

  describe('alur foto profil (crop 1:1)', () => {
    function selectProfilePhoto(file: File): void {
      fireEvent.change(screen.getByLabelText('Pilih foto profil'), {
        target: { files: [file] },
      })
    }

    it('memilih foto valid membuka dialog crop tanpa langsung mengunggah', () => {
      render(<ProfileForm />)

      selectProfilePhoto(new File(['isi'], 'foto.png', { type: 'image/png' }))

      expect(screen.getByTestId('avatar-crop-dialog')).toBeInTheDocument()
      expect(uploadMock).not.toHaveBeenCalled()
    })

    it('konfirmasi crop mengunggah (default compress) lalu PATCH avatar_url dan menutup dialog', async () => {
      render(<ProfileForm />)

      selectProfilePhoto(new File(['isi'], 'foto.jpg', { type: 'image/jpeg' }))
      fireEvent.click(screen.getByRole('button', { name: 'Gunakan foto' }))

      await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1))

      expect(uploadMock).toHaveBeenCalledWith({
        file: expect.any(File),
        category: 'profile_photo',
      })
      expect(updateMock).toHaveBeenCalledWith({
        avatar_url: 'http://localhost:9000/thc-vms-bucket/uploads/avatar.jpg',
      })

      const [uploadOrder = Number.MAX_SAFE_INTEGER] = uploadMock.mock.invocationCallOrder
      const [updateOrder = Number.MAX_SAFE_INTEGER] = updateMock.mock.invocationCallOrder
      expect(uploadOrder).toBeLessThan(updateOrder)
      expect(screen.queryByTestId('avatar-crop-dialog')).not.toBeInTheDocument()
    })

    it('berkas melebihi MAX_UPLOAD_INGEST_BYTES ditolak sebelum dialog terbuka', () => {
      render(<ProfileForm />)

      const oversized = new File(['isi'], 'foto.jpg', { type: 'image/jpeg' })
      Object.defineProperty(oversized, 'size', { value: MAX_UPLOAD_INGEST_BYTES + 1 })
      selectProfilePhoto(oversized)

      expect(screen.queryByTestId('avatar-crop-dialog')).not.toBeInTheDocument()
      expect(uploadMock).not.toHaveBeenCalled()
    })

    it('foto 6 MB JPG lolos ingest dan diunggah lewat jalur kompresi default', async () => {
      render(<ProfileForm />)

      const big = new File(['isi'], 'foto-besar.jpg', { type: 'image/jpeg' })
      Object.defineProperty(big, 'size', { value: 6 * 1024 * 1024 })
      selectProfilePhoto(big)

      expect(screen.getByTestId('avatar-crop-dialog')).toBeInTheDocument()
      expect(uploadMock).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: 'Gunakan foto' }))

      await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1))
      expect(uploadMock).toHaveBeenCalledWith({
        file: expect.any(File),
        category: 'profile_photo',
      })
      expect(uploadMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ compress: false }),
      )
    })

    it('membatalkan crop menutup dialog tanpa mengunggah', () => {
      render(<ProfileForm />)

      selectProfilePhoto(new File(['isi'], 'foto.jpg', { type: 'image/jpeg' }))
      fireEvent.click(screen.getByRole('button', { name: 'Batal' }))

      expect(screen.queryByTestId('avatar-crop-dialog')).not.toBeInTheDocument()
      expect(uploadMock).not.toHaveBeenCalled()
    })
  })
})
