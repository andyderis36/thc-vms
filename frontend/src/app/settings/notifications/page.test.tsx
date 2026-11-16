// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Role, User } from '@/lib/api/types'
import { ApiError } from '@/lib/api/fetcher'

import SettingsNotificationsPage from './page'

const { session, queryState, mutationState, toastMock, refetchMock } = vi.hoisted(() => {
  const refetchMock = vi.fn()
  const toastMock = { success: vi.fn(), error: vi.fn() }
  const queryState = {
    data: null as unknown,
    isPending: false,
    isError: false,
    error: null as unknown,
    refetch: refetchMock,
  }
  const mutationState = {
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }
  return {
    session: { user: null as User | null },
    queryState,
    mutationState,
    toastMock,
    refetchMock,
  }
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
  useNotificationSettingsQuery: () => ({ ...queryState }),
  useUpdateNotificationSettingsMutation: () => ({ ...mutationState }),
}))

vi.mock('@/components/layouts/SuperadminShell', () => ({
  SuperadminShell: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-testid': 'superadmin-shell' }, children),
}))

vi.mock('sonner', () => ({ toast: toastMock }))

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
    editable_fields: [],
  }
}

function makeData() {
  const events = ['visit_requested', 'visit_approved', 'visit_rejected', 'visit_rescheduled', 'visit_check_in', 'visit_check_out', 'visit_cancelled', 'visit_auto_cancelled', 'visit_reminder']
  const mandatory = new Set(['visit_approved', 'visit_rejected', 'visit_cancelled', 'visit_auto_cancelled'])
  return {
    toggles: events.map((event, i) => ({
      event,
      in_app: { staff: true, vendor: i % 2 === 0 },
      email: { staff: i % 3 === 0, vendor: false },
      mandatory: mandatory.has(event),
    })),
    version: 7,
  }
}

beforeEach(() => {
  session.user = makeUser('super_admin')
  queryState.data = makeData()
  queryState.isPending = false
  queryState.isError = false
  queryState.error = null
  queryState.refetch = refetchMock
  mutationState.mutate.mockReset()
  mutationState.mutateAsync.mockReset()
  mutationState.isPending = false
  toastMock.success.mockReset()
  toastMock.error.mockReset()
  refetchMock.mockReset()
})

afterEach(cleanup)

describe('/settings/notifications', () => {
  it('renders 9 rows from mocked GET', () => {
    render(createElement(SettingsNotificationsPage))
    // 9 event labels present
    expect(screen.getAllByRole('checkbox')).toHaveLength(9 * 4 * 2)
  })

  it('non-mandatory toggle triggers PUT with correct version + full payload', async () => {
    // make mutate invoke onSuccess
    mutationState.mutate.mockImplementation((payload, opts) => {
      opts?.onSuccess?.({ toggles: payload.toggles, version: payload.version })
    })
    render(createElement(SettingsNotificationsPage))
    const checkboxes = screen.getAllByRole('checkbox')
    const enabledCb = checkboxes.find((cb) => !(cb as HTMLInputElement).disabled) as HTMLElement
    fireEvent.click(enabledCb)
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }))
    await waitFor(() => {
      expect(mutationState.mutate).toHaveBeenCalled()
    })
    const payload = mutationState.mutate.mock.calls[0]![0]
    expect(payload.version).toBe(7)
    expect(payload.toggles).toHaveLength(9)
  })

  it('mandatory rows disabled + badge', () => {
    render(createElement(SettingsNotificationsPage))
    expect(screen.getAllByText('Wajib sistem').length).toBeGreaterThan(0)
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    // some disabled
    expect(checkboxes.some((cb) => cb.disabled)).toBe(true)
  })

  it('409 resets draft and refetches', async () => {
    mutationState.mutate.mockImplementation((payload, opts) => {
      opts?.onError?.(new ApiError('stale', 409, 'CONFLICT'))
    })
    render(createElement(SettingsNotificationsPage))
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }))
    await waitFor(() => {
      expect(refetchMock).toHaveBeenCalled()
    })
    expect(toastMock.error).toHaveBeenCalledWith('Versi basi — memuat ulang…')
  })

  it('kontrak backend: render dari payload GET nama-penuh lalu PUT mengirim nama-penuh', async () => {
    mutationState.mutate.mockImplementation((payload, opts) => {
      opts?.onSuccess?.({ toggles: payload.toggles, version: payload.version })
    })
    render(createElement(SettingsNotificationsPage))
    expect(screen.getAllByRole('checkbox')).toHaveLength(9 * 4 * 2)
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }))
    await waitFor(() => {
      expect(mutationState.mutate).toHaveBeenCalled()
    })
    const payload = mutationState.mutate.mock.calls[0]![0]
    const events = payload.toggles.map((t: { event: string }) => t.event)
    expect(events).toEqual([
      'visit_requested',
      'visit_approved',
      'visit_rejected',
      'visit_rescheduled',
      'visit_check_in',
      'visit_check_out',
      'visit_cancelled',
      'visit_auto_cancelled',
      'visit_reminder',
    ])
  })

  it('dibatalkan otomatis terkunci dari flag server (mandatory)', () => {
    render(createElement(SettingsNotificationsPage))
    const autoBoxes = screen.getAllByRole('checkbox', { name: /Dibatalkan Otomatis in_app staff/i })
    expect(autoBoxes.length).toBeGreaterThan(0)
    for (const box of autoBoxes) {
      expect(box).toBeDisabled()
      expect(box).toHaveAttribute('title', 'Wajib sistem')
    }
  })

  it('email staf baris diminta hidup dan terkirim di PUT', async () => {
    mutationState.mutate.mockImplementation((payload, opts) => {
      opts?.onSuccess?.({ toggles: payload.toggles, version: payload.version })
    })
    render(createElement(SettingsNotificationsPage))
    const emailStaffBoxes = screen.getAllByRole('checkbox', { name: /Diminta email staff/i })
    expect(emailStaffBoxes.length).toBeGreaterThan(0)
    for (const box of emailStaffBoxes.slice(0, 1)) {
      expect(box).toBeEnabled()
    }
    fireEvent.click(emailStaffBoxes[0]!)
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }))
    await waitFor(() => {
      expect(mutationState.mutate).toHaveBeenCalled()
    })
    const payload = mutationState.mutate.mock.calls[0]![0]
    const requested = payload.toggles.find((t: { event: string }) => t.event === 'visit_requested')
    expect(requested.email.staff).toBe(false)
    expect(payload.toggles).toHaveLength(9)
    expect(payload.version).toBe(7)
  })

  it('togel staf baris pengingat dapat diubah', async () => {
    mutationState.mutate.mockImplementation((payload, opts) => {
      opts?.onSuccess?.({ toggles: payload.toggles, version: payload.version })
    })
    render(createElement(SettingsNotificationsPage))
    const reminderInApp = screen.getAllByRole('checkbox', { name: /Pengingat in_app staff/i })
    const reminderEmail = screen.getAllByRole('checkbox', { name: /Pengingat email staff/i })
    expect(reminderInApp.length).toBeGreaterThan(0)
    expect(reminderEmail.length).toBeGreaterThan(0)
    for (const box of [...reminderInApp, ...reminderEmail]) {
      expect(box).toBeEnabled()
    }
    fireEvent.click(reminderEmail[0]!)
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }))
    await waitFor(() => {
      expect(mutationState.mutate).toHaveBeenCalled()
    })
    const payload = mutationState.mutate.mock.calls[0]![0]
    const reminder = payload.toggles.find((t: { event: string }) => t.event === 'visit_reminder')
    expect(reminder.email.staff).toBe(true)
  })

  it('loading + error states', () => {
    queryState.isPending = true
    queryState.data = null
    const { unmount } = render(createElement(SettingsNotificationsPage))
    expect(screen.getByRole('status')).toBeInTheDocument()
    unmount()

    queryState.isPending = false
    queryState.isError = true
    queryState.error = new ApiError('boom', 500, 'SERVER_ERROR')
    render(createElement(SettingsNotificationsPage))
    expect(screen.getByRole('button', { name: 'Coba Lagi' })).toBeInTheDocument()
  })
})
