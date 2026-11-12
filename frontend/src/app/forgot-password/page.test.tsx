// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/lib/api/fetcher'

import ForgotPasswordPage from './page'

const { replaceMock, requestMock, router, session, toastMock } = vi.hoisted(() => {
  const replaceMock = vi.fn()
  return {
    replaceMock,
    requestMock: vi.fn(),
    // Objek router STABIL antar render — identitas baru tiap render akan
    // membuat efek redirect berjalan ulang (duplikat panggilan replace).
    router: { replace: replaceMock, push: vi.fn() },
    toastMock: { success: vi.fn(), error: vi.fn() },
    session: {
      status: 'unauthenticated' as 'loading' | 'authenticated' | 'unauthenticated' | 'error',
      user: null as { role: string } | null,
    },
  }
})

vi.mock('next/navigation', () => ({
  useRouter: () => router,
}))

vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({ user: session.user, status: session.status }),
}))

vi.mock('@/lib/api/hooks', () => ({
  useRequestPasswordResetMutation: () => ({
    mutateAsync: requestMock,
    isPending: false,
  }),
}))

vi.mock('sonner', () => ({ toast: toastMock }))

const GENERIC_SUCCESS = 'Jika email terdaftar, tautan reset kata sandi telah dikirim.'

function fillEmail(value: string): void {
  fireEvent.change(screen.getByLabelText(/^email/i), { target: { value } })
}

async function submit(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Kirim tautan reset' }))
}

describe('/forgot-password', () => {
  beforeEach(() => {
    requestMock.mockReset()
    replaceMock.mockReset()
    toastMock.success.mockReset()
    toastMock.error.mockReset()
    session.status = 'unauthenticated'
    session.user = null
    window.localStorage.clear()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders the email-only form with a link back to login', () => {
    render(<ForgotPasswordPage />)

    expect(screen.getByRole('heading', { name: 'Lupa kata sandi' })).toBeInTheDocument()
    expect(screen.getByLabelText(/^email/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Kirim tautan reset' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Masuk di sini' })).toHaveAttribute(
      'href',
      '/login',
    )
  })

  it('shows Indonesian validation on empty submit and never calls the API', async () => {
    render(<ForgotPasswordPage />)

    await submit()

    expect(await screen.findByText('Email wajib diisi')).toBeInTheDocument()
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('shows the generic success card on 202 without storing any token', async () => {
    requestMock.mockResolvedValue({ message: GENERIC_SUCCESS })
    render(<ForgotPasswordPage />)

    fillEmail('pengguna@contoh.com')
    await submit()

    expect(await screen.findByText(GENERIC_SUCCESS)).toBeInTheDocument()
    expect(
      await screen.findByText('Butuh bantuan? Hubungi admin cabang Anda.'),
    ).toBeInTheDocument()
    expect(requestMock).toHaveBeenCalledWith({ email: 'pengguna@contoh.com' })
    expect(window.localStorage.getItem('thc_vms_token')).toBeNull()
  })

  it('shows the SAME generic success card on 404 — email existence never leaks', async () => {
    requestMock.mockRejectedValue(new ApiError('Data tidak ditemukan.', 404, 'NOT_FOUND'))
    render(<ForgotPasswordPage />)

    fillEmail('tidak-ada@contoh.com')
    await submit()

    expect(await screen.findByText(GENERIC_SUCCESS)).toBeInTheDocument()
    expect(screen.queryByText('Data tidak ditemukan.')).not.toBeInTheDocument()
  })

  it('maps 422 to an inline email field error without showing the success card', async () => {
    requestMock.mockRejectedValue(
      new ApiError('Format email tidak valid', 422, 'VALIDATION_ERROR'),
    )
    render(<ForgotPasswordPage />)

    fillEmail('bukan-email')
    await submit()

    expect(await screen.findByText('Format email tidak valid')).toBeInTheDocument()
    expect(screen.queryByText(GENERIC_SUCCESS)).not.toBeInTheDocument()
  })

  it('maps 429 to a generic Indonesian toast and stays on the form', async () => {
    requestMock.mockRejectedValue(
      new ApiError('Terlalu banyak permintaan.', 429, 'RATE_LIMITED'),
    )
    render(<ForgotPasswordPage />)

    fillEmail('pengguna@contoh.com')
    await submit()

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        'Terlalu banyak percobaan. Silakan coba lagi nanti.',
      ),
    )
    expect(screen.queryByText(GENERIC_SUCCESS)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Kirim tautan reset' })).toBeInTheDocument()
  })

  it('maps a network failure to a generic inline message, not a success card', async () => {
    requestMock.mockRejectedValue(
      new ApiError('Tidak dapat terhubung ke server. Periksa koneksi Anda.', 0, 'NETWORK_ERROR'),
    )
    render(<ForgotPasswordPage />)

    fillEmail('pengguna@contoh.com')
    await submit()

    expect(
      await screen.findByText('Tidak dapat terhubung ke server. Periksa koneksi Anda.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(GENERIC_SUCCESS)).not.toBeInTheDocument()
  })

  it('redirects authenticated users like the login page', async () => {
    session.status = 'authenticated'
    session.user = { role: 'admin' }

    render(<ForgotPasswordPage />)

    await waitFor(() => expect(replaceMock).toHaveBeenCalledTimes(1))
    expect(requestMock).not.toHaveBeenCalled()
  })
})
