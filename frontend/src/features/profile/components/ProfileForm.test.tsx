// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installAvatarFetchStubs } from '@/test-utils/avatarFetch'
import type { User } from '@/lib/api/types'

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
})
