// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/lib/api/fetcher'
import type { User } from '@/lib/api/types'

import VerifyEmailPage from './page'

const { confirmMock, refreshMock, replaceMock, session, toastMock, tokenGet } = vi.hoisted(() => ({
  confirmMock: vi.fn(),
  refreshMock: vi.fn(),
  replaceMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn() },
  session: { status: 'authenticated' as 'loading' | 'authenticated' | 'unauthenticated' | 'error' },
  tokenGet: { value: 'tok-abc-123' as string | null },
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  useSearchParams: () => ({ get: () => tokenGet.value }),
}))

vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({ user: null, status: session.status, refresh: refreshMock }),
}))

vi.mock('@/lib/api/hooks', () => ({
  useConfirmEmailChangeMutation: () => ({
    mutateAsync: confirmMock,
    isPending: false,
  }),
}))

vi.mock('sonner', () => ({ toast: toastMock }))

function makeUser(): User {
  return {
    id: 'u1',
    name: 'Budi Santoso',
    email: 'baru@contoh.com',
    phone: '081234567890',
    nik: null,
    role: 'vendor',
    location_id: null,
    location_name: null,
    status: 'active',
    type: 'external',
    vendor_name: 'PT Uji',
    avatar_url: null,
    editable_fields: ['phone'],
  }
}

beforeEach(() => {
  confirmMock.mockReset()
  refreshMock.mockReset().mockResolvedValue(undefined)
  replaceMock.mockReset()
  toastMock.success.mockReset()
  toastMock.error.mockReset()
  session.status = 'authenticated'
  tokenGet.value = 'tok-abc-123'
  window.history.replaceState({}, '', '/verify-email?token=tok-abc-123')
})

afterEach(() => {
  cleanup()
})

describe('/verify-email', () => {
  it('anonim: menampilkan ajakan masuk, TIDAK pernah POST, token tetap di query', async () => {
    session.status = 'unauthenticated'

    render(<VerifyEmailPage />)

    expect(screen.getByRole('button', { name: 'Masuk' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Masuk' })).toHaveAttribute('href', '/login')
    expect(window.location.search).toContain('token=tok-abc-123')

    await waitFor(() => expect(confirmMock).not.toHaveBeenCalled())
    expect(confirmMock).not.toHaveBeenCalled()
    expect(replaceMock).not.toHaveBeenCalled()
  })

  it('terautentikasi: tombol eksplisit memuat token lalu sukses → toast + refresh + redirect /profile', async () => {
    confirmMock.mockResolvedValue(makeUser())

    render(<VerifyEmailPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Verifikasi email baru' }))

    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1))
    expect(confirmMock).toHaveBeenCalledWith({ token: 'tok-abc-123' })
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/profile'))
    expect(refreshMock).toHaveBeenCalledTimes(1)
    expect(toastMock.success).toHaveBeenCalled()
  })

  it('galat konfirmasi selalu memakai teks generik — pesan server tidak pernah tampil', async () => {
    confirmMock.mockRejectedValue(new ApiError('Detail rahasia server', 400, 'INVALID_TOKEN'))

    render(<VerifyEmailPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Verifikasi email baru' }))

    expect(
      await screen.findByText('Tautan tidak valid atau kedaluwarsa.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Detail rahasia server')).not.toBeInTheDocument()
    expect(replaceMock).not.toHaveBeenCalled()
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it('token hilang saat sesi aktif → langsung tampil kegagalan generik tanpa POST', async () => {
    tokenGet.value = null

    render(<VerifyEmailPage />)

    expect(
      screen.getByText('Tautan tidak valid atau kedaluwarsa.'),
    ).toBeInTheDocument()
    expect(confirmMock).not.toHaveBeenCalled()
  })
})
