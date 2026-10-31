// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ImgHTMLAttributes } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import RegisterPage from './page'
import { ApiError } from '@/lib/api/fetcher'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

vi.mock('next/image', () => ({
  default: (props: ImgHTMLAttributes<HTMLImageElement>) => createElement('img', props),
}))

const replaceMock = vi.fn()

vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({ user: null, status: 'unauthenticated', signIn: vi.fn() }),
  SessionNetworkError: class SessionNetworkError extends Error {},
}))

const registerVendorMock = vi.fn()

vi.mock('@/lib/api/client', () => ({
  registerVendor: (...args: unknown[]) => registerVendorMock(...args),
}))

vi.mock('@/lib/api/hooks', () => ({
  useVendorsQuery: () => ({
    data: [{ id: 'vendor-1', name: 'PT Lintas Fiber' }],
    isPending: false,
    isError: false,
  }),
}))

function fillValidForm(): void {
  fireEvent.change(screen.getByLabelText(/nama lengkap/i), {
    target: { value: 'Dimas Prasetyo' },
  })
  fireEvent.change(screen.getByLabelText(/email/i), {
    target: { value: 'dimas@vendor.example' },
  })
  fireEvent.change(screen.getByPlaceholderText('Minimal 8 karakter'), {
    target: { value: 'Password123!' },
  })
  fireEvent.change(screen.getByLabelText(/no\. telepon/i), {
    target: { value: '081234567890' },
  })
  fireEvent.change(screen.getByLabelText(/^nik/i), {
    target: { value: '3201010101900001' },
  })
}

describe('RegisterPage', () => {
  afterEach(() => {
    cleanup()
    registerVendorMock.mockReset()
    replaceMock.mockReset()
    window.localStorage.clear()
  })

  it('renders all vendor account fields with Indonesian labels', () => {
    render(createElement(RegisterPage))
    expect(screen.getByLabelText(/nama lengkap/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Minimal 8 karakter')).toBeInTheDocument()
    expect(screen.getByLabelText(/no\. telepon/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^nik/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/perusahaan vendor/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Masuk di sini' })).toHaveAttribute(
      'href',
      '/login',
    )
  })

  it('shows validation errors for empty submit (Indonesian messages)', async () => {
    render(createElement(RegisterPage))
    fireEvent.click(screen.getByRole('button', { name: 'Daftar' }))
    await waitFor(() => {
      expect(screen.getByText('Nama wajib diisi')).toBeInTheDocument()
    })
    expect(screen.getByText('Email wajib diisi')).toBeInTheDocument()
    expect(screen.getByText('Kata sandi wajib diisi')).toBeInTheDocument()
    expect(
      screen.getByText('NIK wajib diisi (16 digit angka)'),
    ).toBeInTheDocument()
    expect(registerVendorMock).not.toHaveBeenCalled()
  })

  it('rejects short password and malformed NIK client-side', async () => {
    render(createElement(RegisterPage))
    fillValidForm()
    fireEvent.change(screen.getByPlaceholderText('Minimal 8 karakter'), {
      target: { value: 'pendek' },
    })
    fireEvent.change(screen.getByLabelText(/^nik/i), {
      target: { value: '123' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Daftar' }))
    await waitFor(() => {
      expect(screen.getByText('Kata sandi minimal 8 karakter')).toBeInTheDocument()
    })
    expect(
      screen.getByText(/NIK harus terdiri dari tepat 16 digit angka/),
    ).toBeInTheDocument()
    expect(registerVendorMock).not.toHaveBeenCalled()
  })

  it('maps catalogue vendor text to vendor_id (vendor wins)', async () => {
    registerVendorMock.mockResolvedValue({ id: 'u-1' })
    render(createElement(RegisterPage))
    fillValidForm()
    fireEvent.change(screen.getByLabelText(/perusahaan vendor/i), {
      target: { value: 'pt lintas fiber' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Daftar' }))
    await waitFor(() => {
      expect(registerVendorMock).toHaveBeenCalledTimes(1)
    })
    const body = registerVendorMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(body.vendor_id).toBe('vendor-1')
    expect(body.vendor_name).toBeUndefined()
    expect(body.nik).toBe('3201010101900001')
  })

  it('maps manual vendor text to vendor_name (never enters the catalogue)', async () => {
    registerVendorMock.mockResolvedValue({ id: 'u-1' })
    render(createElement(RegisterPage))
    fillValidForm()
    fireEvent.change(screen.getByLabelText(/perusahaan vendor/i), {
      target: { value: 'PT Manual Sejahtera' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Daftar' }))
    await waitFor(() => {
      expect(registerVendorMock).toHaveBeenCalledTimes(1)
    })
    const body = registerVendorMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(body.vendor_name).toBe('PT Manual Sejahtera')
    expect(body.vendor_id).toBeUndefined()
  })

  it('shows a neutral confirmation screen on success without storing a token', async () => {
    registerVendorMock.mockResolvedValue({ id: 'u-1' })
    render(createElement(RegisterPage))
    fillValidForm()
    fireEvent.click(screen.getByRole('button', { name: 'Daftar' }))
    await waitFor(() => {
      expect(screen.getByText('Pendaftaran diterima')).toBeInTheDocument()
    })
    expect(screen.getByText('Menunggu persetujuan')).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'Kembali ke halaman masuk' }),
    ).toHaveAttribute('href', '/login')
    expect(window.localStorage.getItem('thc_vms_token')).toBeNull()
  })

  it('maps duplicate email (409) to an inline email error', async () => {
    registerVendorMock.mockRejectedValue(new ApiError('bentrok', 409, 'CONFLICT'))
    render(createElement(RegisterPage))
    fillValidForm()
    fireEvent.click(screen.getByRole('button', { name: 'Daftar' }))
    await waitFor(() => {
      expect(
        screen.getByText('Email sudah terdaftar. Gunakan email lain atau hubungi admin.'),
      ).toBeInTheDocument()
    })
    expect(screen.queryByText('Pendaftaran diterima')).not.toBeInTheDocument()
  })
})
