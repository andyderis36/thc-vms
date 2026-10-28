// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, within } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Role, User } from '@/lib/api/types'

import ProfilePage from './page'

const { session } = vi.hoisted(() => ({
  session: { user: null as User | null },
}))

vi.mock('@/lib/auth/guards', () => ({
  RequireAuth: ({ children }: { children: ReactNode }) => children,
}))

vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({ user: session.user, status: 'authenticated', refresh: vi.fn() }),
}))

vi.mock('@/lib/api/hooks', () => ({
  usePendingApprovalCount: () => ({
    pendingCount: 0,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  }),
}))

vi.mock('@/features/profile/components/ProfileForm', () => ({
  ProfileForm: () => createElement('h1', null, 'Profil Saya'),
}))

/** Empat shell peran dibungkus sebagai wrapper passthrough bercarrier `data-testid`. */
vi.mock('@/components/layouts/SecurityKioskShell', () => ({
  SecurityKioskShell: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-testid': 'security-shell' }, children),
}))

vi.mock('@/components/layouts/VendorMobileShell', () => ({
  VendorMobileShell: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-testid': 'vendor-shell' }, children),
}))

vi.mock('@/components/layouts/AdminBranchShell', () => ({
  AdminBranchShell: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-testid': 'admin-shell' }, children),
}))

vi.mock('@/components/layouts/SuperadminShell', () => ({
  SuperadminShell: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-testid': 'superadmin-shell' }, children),
}))

function makeUser(role: Role): User {
  return {
    id: `u-${role}`,
    name: 'Budi Santoso',
    email: 'budi@thc.id',
    phone: '081234567890',
    nik: null,
    role,
    location_id: 'loc-1',
    location_name: 'POP Jakarta',
    status: 'active',
    type: 'internal',
    vendor_name: null,
    avatar_url: null,
    editable_fields: ['phone'],
  }
}

beforeEach(() => {
  session.user = makeUser('security')
})

afterEach(cleanup)

describe('/profile — komposisi back-link per peran', () => {
  it('security: link "Gate Check-in" href="/gate" berada DI DALAM security-shell', () => {
    session.user = makeUser('security')

    render(<ProfilePage />)

    const shell = screen.getByTestId('security-shell')
    const link = within(shell).getByRole('link', { name: 'Gate Check-in' })
    expect(link).toHaveAttribute('href', '/gate')
  })

  it('vendor: TIDAK ada back link — nol link "Kunjungan Saya" dan nol link bera-label di dalam vendor-shell', () => {
    session.user = makeUser('vendor')

    render(<ProfilePage />)

    const shell = screen.getByTestId('vendor-shell')
    expect(
      within(shell).queryByRole('link', { name: 'Kunjungan Saya' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: 'Kunjungan Saya' }),
    ).not.toBeInTheDocument()
    expect(shell.querySelectorAll('a[aria-label]')).toHaveLength(0)
  })

  it('admin: TIDAK ada link "Gate Check-in" maupun "Kunjungan Saya"', () => {
    session.user = makeUser('admin')

    render(<ProfilePage />)

    expect(screen.getByTestId('admin-shell')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Gate Check-in' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Kunjungan Saya' })).not.toBeInTheDocument()
  })

  it('super_admin: TIDAK ada link "Gate Check-in" maupun "Kunjungan Saya"', () => {
    session.user = makeUser('super_admin')

    render(<ProfilePage />)

    expect(screen.getByTestId('superadmin-shell')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Gate Check-in' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Kunjungan Saya' })).not.toBeInTheDocument()
  })

  it.each<Role>(['security', 'vendor', 'admin', 'super_admin'])(
    'peran %s tetap merender "Profil Saya"',
    (role) => {
      session.user = makeUser(role)

      render(<ProfilePage />)

      expect(screen.getByRole('heading', { name: 'Profil Saya' })).toBeInTheDocument()
    },
  )
})
