// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Role, User } from '@/lib/api/types'
import { ApiError } from '@/lib/api/fetcher'

import SettingsSystemPage from './page'

const { session, systemState, toastMock, refetchMock } = vi.hoisted(() => {
  const refetchMock = vi.fn()
  const toastMock = { success: vi.fn(), error: vi.fn() }
  const systemState = {
    data: null as unknown,
    isPending: false,
    isError: false,
    error: null as unknown,
    refetch: refetchMock,
  }
  return { session: { user: null as User | null }, systemState, toastMock, refetchMock }
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}))

vi.mock('@/lib/auth/guards', () => ({
  RequireRole: ({ children }: { children: ReactNode }) => children,
}))

vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({ user: session.user, status: 'authenticated', refresh: vi.fn() }),
}))

vi.mock('@/lib/api/hooks', () => ({
  usePendingApprovalCount: () => ({ pendingCount: 0, isPending: false, isError: false, refetch: vi.fn() }),
  useSystemSettingsQuery: () => ({ ...systemState }),
}))

vi.mock('@/components/layouts/SuperadminShell', () => ({
  SuperadminShell: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-testid': 'superadmin-shell' }, children),
}))

vi.mock('sonner', () => ({ toast: toastMock }))

function makeUser(role: Role): User {
  return {
    id: `u-${role}`,
    name: 'Dev Operator',
    email: 'dev@thc.id',
    phone: '081234567890',
    nik: null,
    role,
    location_id: null,
    location_name: null,
    status: 'active',
    type: 'internal',
    vendor_name: null,
    avatar_url: null,
    editable_fields: [],
  }
}

function makeSystemData() {
  return {
    dbVersion: 26,
    repoVersion: 26,
    inSync: true,
  }
}

beforeEach(() => {
  session.user = makeUser('dev-superadmin')
  systemState.data = makeSystemData()
  systemState.isPending = false
  systemState.isError = false
  systemState.error = null
  systemState.refetch = refetchMock
  toastMock.success.mockReset()
  toastMock.error.mockReset()
  refetchMock.mockReset()
})

afterEach(cleanup)

describe('/settings/system', () => {
  it('renders versions and sync badge from mocked GET', () => {
    render(createElement(SettingsSystemPage))

    expect(screen.getByText('Sistem')).toBeInTheDocument()
    expect(screen.getByText('Versi Database')).toBeInTheDocument()
    expect(screen.getAllByText('26')).toHaveLength(2)
    expect(screen.getByText('Sinkron')).toBeInTheDocument()
    expect(screen.queryByText('Antrean Mailer')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /kirim email tes/i })).not.toBeInTheDocument()
  })

  it('shows out-of-sync badge when versions diverge', () => {
    systemState.data = { ...makeSystemData(), inSync: false }
    render(createElement(SettingsSystemPage))

    expect(screen.getByText('Tidak sinkron')).toBeInTheDocument()
    expect(screen.queryByText('Sinkron')).not.toBeInTheDocument()
  })

  it('loading and error states render without leaking detail', () => {
    systemState.isPending = true
    systemState.data = null
    const { unmount } = render(createElement(SettingsSystemPage))
    expect(screen.getByRole('status')).toBeInTheDocument()
    unmount()
    cleanup()

    systemState.isPending = false
    systemState.isError = true
    systemState.error = new ApiError('rahasia-dapur', 403, 'FORBIDDEN')
    render(createElement(SettingsSystemPage))
    expect(screen.queryByText('rahasia-dapur')).not.toBeInTheDocument()
  })

})
