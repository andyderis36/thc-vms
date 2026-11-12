// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/lib/api/fetcher'

import ResetPasswordPage from './page'

const { confirmMock, toastMock, tokenGet } = vi.hoisted(() => ({
  confirmMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn() },
  tokenGet: { value: 'tok-abc-123' as string | null },
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: () => tokenGet.value }),
}))

vi.mock('@/lib/api/hooks', () => ({
  useConfirmPasswordResetMutation: () => ({
    mutateAsync: confirmMock,
    isPending: false,
  }),
}))

vi.mock('sonner', () => ({ toast: toastMock }))

const GENERIC_FAILURE = 'Tautan tidak valid atau kedaluwarsa.'

function fillPasswords(newPassword: string, confirmPassword: string): void {
  fireEvent.change(screen.getByLabelText(/^kata sandi baru/i), {
    target: { value: newPassword },
  })
  fireEvent.change(screen.getByLabelText(/^konfirmasi kata sandi baru/i), {
    target: { value: confirmPassword },
  })
}

async function submit(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Simpan kata sandi baru' }))
}

describe('/reset-password', () => {
  beforeEach(() => {
    confirmMock.mockReset()
    toastMock.success.mockReset()
    toastMock.error.mockReset()
    tokenGet.value = 'tok-abc-123'
    window.history.replaceState({}, '', '/reset-password?token=tok-abc-123')
    window.localStorage.clear()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders two password fields when a token is present', () => {
    render(<ResetPasswordPage />)

    expect(screen.getByRole('heading', { name: 'Atur ulang kata sandi' })).toBeInTheDocument()
    expect(screen.getByLabelText(/^kata sandi baru/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^konfirmasi kata sandi baru/i)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Simpan kata sandi baru' }),
    ).toBeInTheDocument()
  })

  it('missing token → generic invalid-link card, never POSTs', async () => {
    tokenGet.value = null

    render(<ResetPasswordPage />)

    expect(await screen.findByText(GENERIC_FAILURE)).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Simpan kata sandi baru' }),
    ).not.toBeInTheDocument()
    await waitFor(() => expect(confirmMock).not.toHaveBeenCalled())
  })

  it('blank (whitespace) token → generic invalid-link card, never POSTs', async () => {
    tokenGet.value = '   '

    render(<ResetPasswordPage />)

    expect(await screen.findByText(GENERIC_FAILURE)).toBeInTheDocument()
    await waitFor(() => expect(confirmMock).not.toHaveBeenCalled())
  })

  it('rejects a mismatched confirmation client-side without calling the API', async () => {
    render(<ResetPasswordPage />)

    fillPasswords('Password123!', 'Password1234!')
    await submit()

    expect(await screen.findByText('Konfirmasi kata sandi tidak sama.')).toBeInTheDocument()
    expect(confirmMock).not.toHaveBeenCalled()
  })

  it('rejects a short password client-side without calling the API', async () => {
    render(<ResetPasswordPage />)

    fillPasswords('pendek', 'pendek')
    await submit()

    expect(await screen.findByText('Kata sandi minimal 8 karakter')).toBeInTheDocument()
    expect(confirmMock).not.toHaveBeenCalled()
  })

  it('submits { token, new_password } then shows the success card with login link', async () => {
    confirmMock.mockResolvedValue({ message: 'ok' })
    render(<ResetPasswordPage />)

    fillPasswords('Password123!', 'Password123!')
    await submit()

    expect(await screen.findByText('Kata sandi berhasil diubah')).toBeInTheDocument()
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1))
    expect(confirmMock).toHaveBeenCalledWith({
      token: 'tok-abc-123',
      new_password: 'Password123!',
    })
    expect(screen.getByRole('link', { name: 'Masuk' })).toHaveAttribute('href', '/login')
    expect(window.localStorage.getItem('thc_vms_token')).toBeNull()
  })

  it('401 → generic invalid-link card, server detail never forwarded', async () => {
    confirmMock.mockRejectedValue(
      new ApiError('Detail rahasia server', 401, 'UNAUTHORIZED'),
    )
    render(<ResetPasswordPage />)

    fillPasswords('Password123!', 'Password123!')
    await submit()

    expect(await screen.findByText(GENERIC_FAILURE)).toBeInTheDocument()
    expect(screen.queryByText('Detail rahasia server')).not.toBeInTheDocument()
    expect(screen.queryByText('Kata sandi berhasil diubah')).not.toBeInTheDocument()
  })

  it('maps 400 to an inline new-password field error', async () => {
    confirmMock.mockRejectedValue(
      new ApiError('Kata sandi minimal 8 karakter.', 400, 'VALIDATION_ERROR'),
    )
    render(<ResetPasswordPage />)

    fillPasswords('Password123!', 'Password123!')
    await submit()

    expect(await screen.findByText('Kata sandi minimal 8 karakter.')).toBeInTheDocument()
    expect(screen.queryByText(GENERIC_FAILURE)).not.toBeInTheDocument()
  })

  it('maps 429 to a generic Indonesian toast and stays on the form', async () => {
    confirmMock.mockRejectedValue(
      new ApiError('Terlalu banyak permintaan.', 429, 'RATE_LIMITED'),
    )
    render(<ResetPasswordPage />)

    fillPasswords('Password123!', 'Password123!')
    await submit()

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        'Terlalu banyak percobaan. Silakan coba lagi nanti.',
      ),
    )
    expect(screen.queryByText(GENERIC_FAILURE)).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Simpan kata sandi baru' }),
    ).toBeInTheDocument()
  })
})
