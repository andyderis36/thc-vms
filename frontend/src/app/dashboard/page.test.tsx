// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Role, User } from '@/lib/api/types'

import DashboardPage from './page'

const { session } = vi.hoisted(() => ({
  session: { user: null as User | null },
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}))

// RequireAuth hanya menahan render sampai sesi siap; fokus uji di sini adalah
// pemilihan shell & perilaku filter fasilitas per peran (guard rute sendiri
// diuji di guards.test.tsx).
vi.mock('@/lib/auth/guards', () => ({
  RequireAuth: ({ children }: { children: ReactNode }) => children,
}))

vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({ user: session.user, status: 'authenticated', refresh: vi.fn() }),
}))

vi.mock('@/lib/api/hooks', () => ({
  useLocationsQuery: () => ({
    data: [
      { id: 'loc-1', name: 'POP Jakarta', city: 'Jakarta' },
      { id: 'loc-2', name: 'POP Bandung', city: 'Bandung' },
      { id: 'loc-3', name: 'POP Surabaya', city: 'Surabaya' },
    ],
  }),
  usePendingApprovalCount: () => ({ pendingCount: 0 }),
  useVisitsQuery: () => ({
    data: { items: [], total: 0 },
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  }),
}))

/** Empat shell peran dibungkus sebagai wrapper passthrough bercarrier `data-testid`. */
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

function makeUser(role: Role, locationIds?: string[]): User {
  return {
    id: `u-${role}`,
    name: 'Budi Santoso',
    email: 'budi@thc.id',
    phone: '081234567890',
    nik: null,
    role,
    location_id: 'loc-1',
    ...(locationIds !== undefined ? { location_ids: locationIds } : {}),
    location_name: 'POP Jakarta',
    status: 'active',
    type: 'internal',
    vendor_name: null,
    avatar_url: null,
    editable_fields: ['phone'],
  }
}

beforeEach(() => {
  session.user = makeUser('super_admin')
})

afterEach(cleanup)

describe('/dashboard — shell superadmin untuk dev-superadmin', () => {
  it('dev-superadmin merender SuperadminShell, bukan shell admin/vendor', () => {
    session.user = makeUser('dev-superadmin')

    render(<DashboardPage />)

    expect(screen.getByTestId('superadmin-shell')).toBeInTheDocument()
    expect(screen.queryByTestId('admin-shell')).not.toBeInTheDocument()
    expect(screen.queryByTestId('vendor-shell')).not.toBeInTheDocument()
  })

  it('dev-superadmin: select "Fasilitas" aktif dan defaultnya "Semua Cabang / POP"', () => {
    session.user = makeUser('dev-superadmin')

    render(<DashboardPage />)

    const facilitySelect = screen.getByLabelText('Fasilitas')
    expect(facilitySelect).toBeEnabled()
    expect(facilitySelect).toHaveValue('all')
    expect(screen.getByRole('option', { name: 'Semua Cabang / POP' })).toBeInTheDocument()
  })

  it('admin multi-cabang: select "Fasilitas" aktif dengan opsi terbatas cakupan', () => {
    session.user = makeUser('admin', ['loc-1', 'loc-2'])

    render(<DashboardPage />)

    expect(screen.getByTestId('admin-shell')).toBeInTheDocument()
    const facilitySelect = screen.getByLabelText('Fasilitas')
    expect(facilitySelect).toBeEnabled()
    expect(facilitySelect).toHaveValue('all')
    expect(screen.getByRole('option', { name: 'Semua Cabang Saya' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'POP Jakarta' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'POP Bandung' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'POP Surabaya' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Semua Cabang / POP' })).not.toBeInTheDocument()
  })

  it('admin tanpa cakupan ter-resolve: kontrol tersisa sentinel dan terkunci', () => {
    session.user = { ...makeUser('admin'), location_id: null, location_ids: [] }

    render(<DashboardPage />)

    const facilitySelect = screen.getByLabelText('Fasilitas')
    expect(facilitySelect).toBeDisabled()
    expect(screen.getByRole('option', { name: 'Semua Cabang Saya' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'POP Jakarta' })).not.toBeInTheDocument()
  })
})
