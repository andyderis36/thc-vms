// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Role, User } from '@/lib/api/types'

import SettingsHubPage from './page'

const { session, requiredRole } = vi.hoisted(() => ({
  session: { user: null as User | null },
  requiredRole: { current: null as Role | null },
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}))

vi.mock('@/lib/auth/guards', () => ({
  RequireRole: ({ children }: { children: ReactNode }) => children,
  useRequireRole: () => requiredRole.current,
}))

vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({ user: session.user, status: 'authenticated', refresh: vi.fn() }),
}))

vi.mock('@/lib/api/hooks', () => ({
  usePendingApprovalCount: () => ({ pendingCount: 0 }),
}))

vi.mock('@/components/layouts/SuperadminShell', () => ({
  SuperadminShell: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-testid': 'superadmin-shell' }, children),
}))

function makeUser(role: Role): User {
  return {
    id: `u-${role}`,
    name: 'Operator',
    email: 'op@thc.id',
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

beforeEach(() => {
  session.user = makeUser('super_admin')
  requiredRole.current = null
})

afterEach(cleanup)

describe('/settings hub', () => {
  it('kartu Notifikasi selalu tampil dan menaut ke /settings/notifications', () => {
    render(createElement(SettingsHubPage))

    const link = screen.getByRole('link', { name: /^notifikasi/i })
    expect(link).toHaveAttribute('href', '/settings/notifications')
  })

  it('kartu Log Email menaut ke /settings/mail-logs', () => {
    render(createElement(SettingsHubPage))

    const link = screen.getByRole('link', { name: /log email/i })
    expect(link).toHaveAttribute('href', '/settings/mail-logs')
  })

  it('kartu Sistem hanya untuk dev-superadmin', () => {
    requiredRole.current = 'dev-superadmin'
    const { unmount } = render(createElement(SettingsHubPage))
    const hrefs = screen
      .getAllByRole('link')
      .map((l) => l.getAttribute('href'))
    expect(hrefs).toContain('/settings/system')
    unmount()
    cleanup()

    requiredRole.current = null
    render(createElement(SettingsHubPage))
    const hrefsAfter = screen
      .getAllByRole('link')
      .map((l) => l.getAttribute('href'))
    expect(hrefsAfter).not.toContain('/settings/system')
    expect(hrefsAfter).toContain('/settings/notifications')
  })
})
