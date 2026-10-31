// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ImgHTMLAttributes } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import LoginPage from './page'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

vi.mock('next/image', () => ({
  default: (props: ImgHTMLAttributes<HTMLImageElement>) => createElement('img', props),
}))

const signInMock = vi.fn()

vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({ user: null, status: 'unauthenticated', signIn: signInMock }),
}))

describe('LoginPage dev dummy account dropdown', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllEnvs()
  })

  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  it('hides the dropdown by default (env flag not true)', () => {
    render(createElement(LoginPage))
    expect(screen.queryByLabelText('Akun dummy (dev)')).not.toBeInTheDocument()
    expect(screen.queryByText('Akun dummy (dev)')).not.toBeInTheDocument()
  })

  it('shows the dropdown when NEXT_PUBLIC_DEMO_ACC_LOGIN is true', () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_ACC_LOGIN', 'true')
    render(createElement(LoginPage))
    expect(screen.getByText('Akun dummy (dev)')).toBeInTheDocument()
    expect(screen.getByRole('combobox')).toBeInTheDocument()
  })

    it('fills email and password when a dummy account is picked', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_ACC_LOGIN', 'true')
    render(createElement(LoginPage))
    const select = screen.getByRole('combobox')
    fireEvent.change(select, { target: { value: 'vendor1a@transhybrid.net.id' } })
    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toHaveValue('vendor1a@transhybrid.net.id')
      expect(screen.getByPlaceholderText('Minimal 8 karakter')).toHaveValue('Password123!')
    })
  })

  it('fills email and local dev password for the dev-superadmin entry', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_ACC_LOGIN', 'true')
    render(createElement(LoginPage))
    const select = screen.getByRole('combobox')
    fireEvent.change(select, {
      target: { value: 'dev-superadmin@transhybrid.net.id' },
    })
    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toHaveValue(
        'dev-superadmin@transhybrid.net.id',
      )
      expect(screen.getByPlaceholderText('Minimal 8 karakter')).toHaveValue('qwqw1234')
    })
  })

  it('maps the dev-superadmin username to its full email on submit', async () => {
    signInMock.mockReset()
    signInMock.mockResolvedValue({ role: 'dev-superadmin' })
    render(createElement(LoginPage))
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'dev-superadmin' } })
    fireEvent.change(screen.getByPlaceholderText('Minimal 8 karakter'), { target: { value: 'qwqw1234' } })
    fireEvent.click(screen.getByRole('button', { name: 'Masuk' }))
    await waitFor(() => {
      expect(signInMock).toHaveBeenCalledWith('dev-superadmin@transhybrid.net.id', 'qwqw1234')
    })
  })

  it('links to the public vendor self-registration page', () => {
    signInMock.mockReset()
    render(createElement(LoginPage))
    expect(
      screen.getByRole('link', { name: 'Daftar sebagai Vendor/Mitra' }),
    ).toHaveAttribute('href', '/register')
  })
})
