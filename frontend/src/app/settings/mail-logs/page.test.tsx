// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Role, User } from '@/lib/api/types'
import { ApiError } from '@/lib/api/fetcher'

import SettingsMailLogsPage from './page'

const { session, mailLogsState, mailLogDetailState, mailLogsCalls, mailLogDetailCalls, systemState, testMailState, toastMock } = vi.hoisted(() => {
  const mailLogsCalls: unknown[] = []
  const mailLogDetailCalls: unknown[] = []
  const mailLogsState = {
    data: null as unknown,
    isPending: false,
    isError: false,
    error: null as unknown,
    refetch: vi.fn(),
  }
  const mailLogDetailState = {
    data: null as unknown,
    isPending: false,
    isError: false,
    error: null as unknown,
    refetch: vi.fn(),
  }
  const systemState = {
    data: null as unknown,
    isPending: false,
    isError: false,
    error: null as unknown,
    refetch: vi.fn(),
  }
  const testMailState = {
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }
  const toastMock = { success: vi.fn(), error: vi.fn() }
  return { session: { user: null as User | null }, mailLogsState, mailLogDetailState, mailLogsCalls, mailLogDetailCalls, systemState, testMailState, toastMock }
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
  useMailLogsQuery: (params?: { status?: string; page?: number; limit?: number }) => {
    mailLogsCalls.push(params)
    const status = params?.status ?? ''
    const items = status
      ? [
          { id: 'm1', subject: 'Subjek Terkirim', status: 'sent', to: ['a@thc.id'], createdAt: '2026-01-01T00:00:00Z', template: 'tpl' },
          { id: 'm2', subject: 'Subjek Gagal', status: 'failed', to: ['b@thc.id'], createdAt: '2026-01-02T00:00:00Z', error: 'SMTP timeout', template: 'tpl' },
        ].filter((i) => i.status === status)
      : [
          { id: 'm1', subject: 'Subjek Terkirim', status: 'sent', to: ['a@thc.id'], createdAt: '2026-01-01T00:00:00Z', template: 'tpl' },
          { id: 'm2', subject: 'Subjek Gagal', status: 'failed', to: ['b@thc.id'], createdAt: '2026-01-02T00:00:00Z', error: 'SMTP timeout', template: 'tpl' },
        ]
    if (mailLogsState.isPending) return { data: null, isPending: true, isError: false, error: null, refetch: mailLogsState.refetch }
    if (mailLogsState.isError) return { data: null, isPending: false, isError: true, error: mailLogsState.error, refetch: mailLogsState.refetch }
    return { data: { items, total: items.length }, isPending: false, isError: false, error: null, refetch: mailLogsState.refetch }
  },
  useMailLogDetailQuery: (id: string | null) => {
    mailLogDetailCalls.push(id)
    if (!id) {
      return { data: null, isPending: false, isError: false, error: null, refetch: vi.fn() }
    }
    if (mailLogDetailState.isPending) return { data: null, isPending: true, isError: false, error: null, refetch: mailLogDetailState.refetch }
    if (mailLogDetailState.isError) return { data: null, isPending: false, isError: true, error: mailLogDetailState.error, refetch: mailLogDetailState.refetch }
    return {
      data: {
        id,
        subject: 'Subjek Terkirim',
        status: 'sent',
        to: ['a@thc.id'],
        bcc: ['bos@thc.id'],
        template: 'tpl',
        attempts: 1,
        textBody: 'Isi teks detail email',
        createdAt: '2026-01-01T00:00:00Z',
      },
      isPending: false,
      isError: false,
      error: null,
      refetch: mailLogDetailState.refetch,
    }
  },
  useSystemSettingsQuery: () => ({ ...systemState }),
  useSendTestMailMutation: () => ({ ...testMailState }),
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

beforeEach(() => {
  session.user = makeUser('dev-superadmin')
  mailLogsState.isPending = false
  mailLogsState.isError = false
  mailLogsState.error = null
  mailLogsState.refetch = vi.fn()
  mailLogDetailState.isPending = false
  mailLogDetailState.isError = false
  mailLogDetailState.error = null
  mailLogDetailState.refetch = vi.fn()
  mailLogsCalls.length = 0
  mailLogDetailCalls.length = 0
  systemState.data = { mailer: { queueDepth: 3, dropped: 1 } }
  systemState.isPending = false
  systemState.isError = false
  systemState.error = null
  systemState.refetch = vi.fn()
  testMailState.mutate.mockReset()
  testMailState.mutateAsync.mockReset()
  testMailState.isPending = false
  toastMock.success.mockReset()
  toastMock.error.mockReset()
})

afterEach(cleanup)

describe('/settings/mail-logs', () => {
  it('renders mail log list with subject and status badge', () => {
    render(createElement(SettingsMailLogsPage))

    expect(screen.getAllByText('Subjek Terkirim').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Subjek Gagal').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Terkirim').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Gagal').length).toBeGreaterThan(0)
  })

  it('opens mail log detail modal showing textBody on row click', async () => {
    render(createElement(SettingsMailLogsPage))

    fireEvent.click(screen.getAllByText('Subjek Terkirim')[0]!)

    await waitFor(() => {
      expect(screen.getByText('Isi teks detail email')).toBeInTheDocument()
    })
  })

  it('shows hidden Bcc overseers in the detail modal', async () => {
    render(createElement(SettingsMailLogsPage))

    fireEvent.click(screen.getAllByText('Subjek Terkirim')[0]!)

    await waitFor(() => {
      expect(screen.getByText('Bcc (tersembunyi)')).toBeInTheDocument()
      expect(screen.getByText('bos@thc.id')).toBeInTheDocument()
    })
  })

  it('refetches mail logs with failed status when filter changes to Gagal', async () => {
    render(createElement(SettingsMailLogsPage))

    fireEvent.click(screen.getByRole('button', { name: 'Gagal' }))

    await waitFor(() => {
      const last = mailLogsCalls[mailLogsCalls.length - 1] as { status?: string } | undefined
      expect(last?.status).toBe('failed')
    })
    await waitFor(() => {
      expect(screen.getAllByText('Subjek Gagal').length).toBeGreaterThan(0)
      expect(screen.queryByText('Subjek Terkirim')).not.toBeInTheDocument()
    })
  })

  it('403 → EmptyState tanpa detail', () => {
    mailLogsState.isError = true
    mailLogsState.error = new ApiError('rahasia-dapur', 403, 'FORBIDDEN')
    render(createElement(SettingsMailLogsPage))
    expect(screen.queryByText('rahasia-dapur')).not.toBeInTheDocument()
    expect(screen.getByText('Tidak dapat memuat log email')).toBeInTheDocument()
  })

  it('renders mailer queue stats and test-mail button from system endpoint', () => {
    render(createElement(SettingsMailLogsPage))

    expect(screen.getByText('Status Mailer')).toBeInTheDocument()
    expect(screen.getByText('Antrean Mailer')).toBeInTheDocument()
    expect(screen.getByText('Dropped')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /kirim email tes/i })).toBeInTheDocument()
  })

  it('send button calls the test-mail mutation and toasts success', async () => {
    testMailState.mutate.mockImplementation((_opts: unknown, opts2?: { onSuccess?: () => void }) => {
      opts2?.onSuccess?.()
    })
    render(createElement(SettingsMailLogsPage))

    fireEvent.click(screen.getByRole('button', { name: /kirim email tes/i }))

    await waitFor(() => {
      expect(testMailState.mutate).toHaveBeenCalledTimes(1)
      expect(toastMock.success).toHaveBeenCalledWith('Email tes berhasil dikirim.')
    })
  })

  it('test-mail failure surfaces the server message via toast', async () => {
    testMailState.mutate.mockImplementation((_opts: unknown, opts2?: { onError?: (e: unknown) => void }) => {
      opts2?.onError?.(new ApiError('Batas kirim tercapai', 429, 'RATE_LIMITED'))
    })
    render(createElement(SettingsMailLogsPage))

    fireEvent.click(screen.getByRole('button', { name: /kirim email tes/i }))

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith('Batas kirim tercapai')
    })
  })
})
