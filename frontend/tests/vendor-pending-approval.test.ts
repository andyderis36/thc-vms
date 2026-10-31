// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement, type ImgHTMLAttributes } from 'react'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest'

import { ManagedUsersScreen } from '@/features/users/components/ManagedUsersScreen'
import {
  installAvatarFetchStubs,
  mockAvatarImage,
} from '@/test-utils/avatarFetch'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

vi.mock('next/image', () => ({
  default: (props: ImgHTMLAttributes<HTMLImageElement>) => createElement('img', props),
}))

vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({
    user: { id: 'me-id', name: 'Pusat', role: 'super_admin', location_name: 'Pontianak' },
    status: 'authenticated',
    signOut: vi.fn(),
    refresh: vi.fn(),
  }),
}))

vi.mock('@/components/ui/NotificationsMenu', () => ({
  NotificationsMenu: ({ className }: { className?: string }) =>
    createElement('div', { 'data-testid': 'notif-menu', className }),
}))

const { pendingFixture, statusMutateMock, deleteMutateMock } = vi.hoisted(() => ({
  pendingFixture: [
    {
      id: 'u-pending',
      name: 'Dimas Prasetyo',
      email: 'dimas@vendor.example',
      phone: '081234567890',
      nik: '3201010101900001',
      role: 'vendor',
      location_id: null,
      location_name: null,
      status: 'inactive',
      type: 'external',
      vendor_name: 'PT Lintas Fiber',
      avatar_url: null,
    },
    {
      id: 'u-active',
      name: 'Citra Lestari',
      email: 'vendor@lintasfiber.co.id',
      phone: '08113000004',
      nik: '3201010101990003',
      role: 'vendor',
      location_id: null,
      location_name: null,
      status: 'active',
      type: 'external',
      vendor_name: 'PT Lintas Fiber',
      avatar_url: null,
    },
  ],
  statusMutateMock: vi.fn(),
  deleteMutateMock: vi.fn(),
}))

vi.mock('@/lib/api/hooks', () => ({
  useDeleteManagedUserMutation: () => ({ mutate: deleteMutateMock, isPending: false }),
  useLocationsQuery: () => ({ data: [] }),
  useManagedUsersQuery: () => ({
    data: pendingFixture,
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  usePendingApprovalCount: () => ({ pendingCount: 0 }),
  useUpdateManagedUserMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateManagedUserStatusMutation: () => ({
    mutate: statusMutateMock,
    isPending: false,
    variables: undefined,
  }),
}))

beforeAll(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
})

afterAll(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  cleanup()
  statusMutateMock.mockReset()
  deleteMutateMock.mockReset()
})

let fetchMock: Mock<typeof fetch>

beforeEach(() => {
  fetchMock = installAvatarFetchStubs().fetchMock
  mockAvatarImage(fetchMock)
})

function renderPendingScreen(): void {
  render(
    createElement(ManagedUsersScreen, {
      roles: ['vendor'],
      activeHref: '/vendor-registrations',
      title: 'Pendaftaran Vendor/Mitra',
      subtitle: 'Subjudul uji',
      showPendingSection: true,
    }),
  )
}

describe('Vendor pending-approval section', () => {
  it('lists inactive vendors with Setujui and Tolak actions', () => {
    renderPendingScreen()
    const pending = screen.getByRole('region', { name: 'Menunggu persetujuan' })
    expect(within(pending).getByText('Dimas Prasetyo')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Setujui' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Tolak' })).toBeInTheDocument()
  })

  it('approves a pending vendor via status→active (audit milik server)', async () => {
    renderPendingScreen()
    fireEvent.click(screen.getByRole('button', { name: 'Setujui' }))
    await waitFor(() => {
      expect(statusMutateMock).toHaveBeenCalledTimes(1)
    })
    expect(statusMutateMock).toHaveBeenCalledWith(
      { userId: 'u-pending', body: { status: 'active' } },
      expect.anything(),
    )
  })

  it('rejects a pending vendor through the delete confirmation flow', async () => {
    renderPendingScreen()
    fireEvent.click(screen.getByRole('button', { name: 'Tolak' }))
    expect(screen.getByText(/Hapus permanen akun/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Hapus Permanen' }))
    await waitFor(() => {
      expect(deleteMutateMock).toHaveBeenCalledTimes(1)
    })
    expect(deleteMutateMock).toHaveBeenCalledWith(
      { userId: 'u-pending' },
      expect.anything(),
    )
  })

  it('hides the section without the flag or without pending accounts', () => {
    render(
      createElement(ManagedUsersScreen, {
        roles: ['vendor'],
        activeHref: '/vendor-registrations',
        title: 'Pendaftaran Vendor/Mitra',
        subtitle: 'Subjudul uji',
      }),
    )
    expect(screen.queryByText(/Menunggu persetujuan/)).not.toBeInTheDocument()
  })
})
