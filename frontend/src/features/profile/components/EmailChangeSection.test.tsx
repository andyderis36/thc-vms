// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/lib/api/fetcher'

import { EmailChangeSection } from './EmailChangeSection'

const { requestMock, toastMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('@/lib/api/hooks', () => ({
  useRequestEmailChangeMutation: () => ({
    mutateAsync: requestMock,
    isPending: false,
  }),
}))

vi.mock('sonner', () => ({ toast: toastMock }))

const NEW_EMAIL = 'baru.sangat.panjang@contoh-domain.co.id'

function fillForm(newEmail: string, confirmEmail: string, password: string): void {
  // Label field wajib membawa bintang ("Email baru *") — pakai regex berjangkar
  // agar "Konfirmasi email baru" tidak ikut cocok oleh query "Email baru".
  fireEvent.change(screen.getByLabelText(/^Email baru/), {
    target: { value: newEmail },
  })
  fireEvent.change(screen.getByLabelText(/^Konfirmasi email baru/), {
    target: { value: confirmEmail },
  })
  fireEvent.change(screen.getByLabelText(/^Kata sandi saat ini/), {
    target: { value: password },
  })
}

async function goToReview(newEmail = NEW_EMAIL): Promise<void> {
  fillForm(newEmail, newEmail, 'Lama12345!')
  fireEvent.click(screen.getByRole('button', { name: 'Lanjutkan' }))
  expect(await screen.findByTestId('email-change-review')).toBeInTheDocument()
}

beforeEach(() => {
  requestMock.mockReset()
  requestMock.mockResolvedValue({ message: 'OK' })
  toastMock.success.mockReset()
  toastMock.error.mockReset()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('EmailChangeSection', () => {
  it('zod refine: konfirmasi yang tidak sama ditolak tanpa memanggil API', async () => {
    render(<EmailChangeSection />)

    fillForm('baru@contoh.com', 'beda@contoh.com', 'Lama12345!')
    fireEvent.click(screen.getByRole('button', { name: 'Lanjutkan' }))

    expect(await screen.findByText('Konfirmasi email tidak sama.')).toBeInTheDocument()
    expect(requestMock).not.toHaveBeenCalled()
    expect(screen.queryByTestId('email-change-review')).not.toBeInTheDocument()
  })

  it('layar "cek kembali" menampilkan alamat baru UTUH beserta [Kirim tautan] dan [Ubah]', async () => {
    render(<EmailChangeSection />)

    await goToReview()

    expect(screen.getByTestId('new-email-full')).toHaveTextContent(NEW_EMAIL)
    expect(screen.getByRole('button', { name: 'Kirim tautan' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ubah' })).toBeInTheDocument()
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('[Kirim tautan] mengirim { new_email, current_password } lalu masuk status terkirim', async () => {
    render(<EmailChangeSection />)

    await goToReview()
    fireEvent.click(screen.getByRole('button', { name: 'Kirim tautan' }))
    await screen.findByTestId('email-change-sent')

    expect(requestMock).toHaveBeenCalledTimes(1)
    expect(requestMock).toHaveBeenCalledWith({
      new_email: NEW_EMAIL,
      current_password: 'Lama12345!',
    })
    expect(screen.getByTestId('new-email-full')).toHaveTextContent(NEW_EMAIL)
  })

  it('tombol kirim ulang nonaktif selama cooldown 60 detik lalu aktif kembali', async () => {
    vi.useFakeTimers()
    render(<EmailChangeSection />)

    // Di bawah fake timer: hindari findBy/waitFor (bisa menggantung) —
    // resolver zod + mutateAsync diselesaikan lewat flush microtask `act`.
    fillForm(NEW_EMAIL, NEW_EMAIL, 'Lama12345!')
    fireEvent.click(screen.getByRole('button', { name: 'Lanjutkan' }))
    await act(async () => {})
    expect(screen.getByTestId('email-change-review')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Kirim tautan' }))
    await act(async () => {})

    expect(screen.getByTestId('email-change-sent')).toBeInTheDocument()
    const resend = screen.getByRole('button', { name: /Kirim ulang/ })
    expect(resend).toBeDisabled()
    expect(resend).toHaveTextContent('Kirim ulang (60s)')

    act(() => {
      vi.advanceTimersByTime(59_000)
    })
    expect(screen.getByRole('button', { name: /Kirim ulang/ })).toBeDisabled()

    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(screen.getByRole('button', { name: 'Kirim ulang' })).toBeEnabled()
  })

  it('server 429 → toast sonner berbahasa Indonesia, status tidak berpindah ke terkirim', async () => {
    requestMock.mockRejectedValue(
      new ApiError('Terlalu banyak percobaan. Silakan coba lagi nanti.', 429, 'RATE_LIMITED'),
    )
    render(<EmailChangeSection />)

    await goToReview()
    fireEvent.click(screen.getByRole('button', { name: 'Kirim tautan' }))
    await screen.findByText('Kirim tautan')

    expect(toastMock.error).toHaveBeenCalledWith(
      'Terlalu banyak percobaan. Silakan coba lagi nanti.',
    )
    expect(screen.queryByTestId('email-change-sent')).not.toBeInTheDocument()
  })

  it('[Ubah] kembali ke form dengan nilai yang dipertahankan', async () => {
    render(<EmailChangeSection />)

    await goToReview()
    fireEvent.click(screen.getByRole('button', { name: 'Ubah' }))

    expect(screen.getByLabelText(/^Email baru/)).toHaveValue(NEW_EMAIL)
    expect(screen.getByLabelText(/^Konfirmasi email baru/)).toHaveValue(NEW_EMAIL)
    expect(screen.getByLabelText(/^Kata sandi saat ini/)).toHaveValue('Lama12345!')
  })
})
