// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { User } from '@/lib/api/types'

import { RequireRole, roleSatisfies } from './guards'

const { session, replaceMock } = vi.hoisted(() => ({
  session: { user: null as User | null },
  replaceMock: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}))

vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({
    user: session.user,
    status: 'authenticated',
    refresh: vi.fn(),
  }),
  consumeSessionExpiredFlag: () => false,
}))

/** Query hooks dashboard dipasang datar agar uji shell tak menyentuh jaringan. */
vi.mock('@/lib/api/hooks', () => ({
  useLocationsQuery: () => ({ data: [] }),
  useVisitsQuery: () => ({
    data: { items: [], total: 0 },
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  usePendingApprovalCount: () => ({ pendingCount: 0 }),
}))

/** Empat shell peran dipasang sebagai wrapper passthrough bercarrier `data-testid`. */
vi.mock('@/components/layouts/SuperadminShell', () => ({
  SuperadminShell: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-testid': 'superadmin-shell' }, children),
}))

vi.mock('@/components/layouts/AdminBranchShell', () => ({
  AdminBranchShell: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-testid': 'admin-shell' }, children),
}))

vi.mock('@/components/layouts/VendorMobileShell', () => ({
  VendorMobileShell: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-testid': 'vendor-shell' }, children),
}))

function makeUser(role: User['role']): User {
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
  replaceMock.mockClear()
  session.user = makeUser('dev-superadmin')
})

afterEach(cleanup)

describe('roleSatisfies — gate super_admin mengakui dev-superadmin', () => {
  it('admits super_admin and dev-superadmin when the gate allows super_admin', () => {
    expect(roleSatisfies('super_admin', ['super_admin'])).toBe(true)
    expect(roleSatisfies('dev-superadmin', ['super_admin'])).toBe(true)
  })

  it('admits dev-superadmin to mixed gates that include super_admin', () => {
    expect(roleSatisfies('dev-superadmin', ['super_admin', 'admin'])).toBe(true)
  })

  it('refuses every other role when the gate only allows super_admin', () => {
    expect(roleSatisfies('admin', ['super_admin'])).toBe(false)
    expect(roleSatisfies('security', ['super_admin'])).toBe(false)
    expect(roleSatisfies('vendor', ['super_admin'])).toBe(false)
  })

  it('refuses dev-superadmin when the gate never lists super_admin', () => {
    expect(roleSatisfies('dev-superadmin', ['admin'])).toBe(false)
    expect(roleSatisfies('dev-superadmin', ['security', 'admin'])).toBe(false)
  })
})

describe('RequireRole allow=[super_admin]', () => {
  it('renders protected children for a dev-superadmin session without redirecting', () => {
    session.user = makeUser('dev-superadmin')

    render(
      <RequireRole allow={['super_admin']}>
        <div data-testid="superadmin-area" />
      </RequireRole>,
    )

    expect(screen.getByTestId('superadmin-area')).toBeInTheDocument()
    expect(replaceMock).not.toHaveBeenCalled()
  })

  it('redirects an admin session to its home and renders nothing', () => {
    session.user = makeUser('admin')

    render(
      <RequireRole allow={['super_admin']}>
        <div data-testid="superadmin-area" />
      </RequireRole>,
    )

    expect(screen.queryByTestId('superadmin-area')).not.toBeInTheDocument()
    expect(replaceMock).toHaveBeenCalledWith('/dashboard')
  })
})

describe('/dashboard — pemilihan shell mengikuti peran sesi', () => {
  async function renderDashboard(): Promise<void> {
    const { default: DashboardPage } = await import('@/app/dashboard/page')
    render(<DashboardPage />)
  }

  it('dev-superadmin merender SuperadminShell, bukan AdminBranchShell', async () => {
    session.user = makeUser('dev-superadmin')

    await renderDashboard()

    await waitFor(() => {
      expect(screen.getByTestId('superadmin-shell')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('admin-shell')).not.toBeInTheDocument()
    expect(screen.queryByTestId('vendor-shell')).not.toBeInTheDocument()
  })

  it('super_admin tetap merender SuperadminShell', async () => {
    session.user = makeUser('super_admin')

    await renderDashboard()

    await waitFor(() => {
      expect(screen.getByTestId('superadmin-shell')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('admin-shell')).not.toBeInTheDocument()
  })

  it('admin merender AdminBranchShell', async () => {
    session.user = makeUser('admin')

    await renderDashboard()

    await waitFor(() => {
      expect(screen.getByTestId('admin-shell')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('superadmin-shell')).not.toBeInTheDocument()
  })
})
