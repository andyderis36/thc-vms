// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { VisitDetail, VisitStatus } from '@/lib/api/types'

const mocks = vi.hoisted(() => ({
  checkIn: vi.fn(),
  checkOut: vi.fn(),
  getVisit: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  visit: null as VisitDetail | null,
}))

vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}))

vi.mock('@/lib/auth/guards', () => ({
  RequireRole: ({ children }: { children: ReactNode }) => children,
}))

vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({
    user: {
      id: 'guard-1',
      name: 'Petugas Jaga',
      role: 'security',
      location_name: 'POP Tebet',
      avatar_url: null,
    },
    status: 'authenticated',
  }),
}))

vi.mock('@/lib/api/hooks', () => ({
  GATE_LIST_REFETCH_INTERVAL: 15_000,
  useVisitsQuery: () => ({
    data: { items: [], total: 0 },
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useCheckInVisitMutation: () => ({ mutateAsync: mocks.checkIn, isPending: false }),
  useCheckOutVisitMutation: () => ({ mutateAsync: mocks.checkOut, isPending: false }),
  usePendingApprovalCount: () => ({ pendingCount: 0 }),
}))

vi.mock('@/lib/api/client', () => ({ getVisit: mocks.getVisit }))

vi.mock('@/features/visits/hooks/useVisitFile', () => ({
  useVisitFile: () => ({ objectUrl: null, loading: false, error: null, retry: vi.fn() }),
}))

vi.mock('@/features/gate/GuestCard', async () => {
  const React = await import('react')
  return { GuestSelectContext: React.createContext(null) }
})

vi.mock('@/features/gate/ScannerPanel', () => ({
  ScannerPanel: ({
    onScan,
    phase,
  }: {
    onScan: (raw: string) => void
    phase: { phase: string; title?: string; message?: string }
  }) => (
    <div>
      <button type="button" onClick={() => onScan('VST-1')}>
        pindai
      </button>
      {phase.phase === 'feedback' ? (
        <div role="status">
          <p>{phase.title}</p>
          <p>{phase.message}</p>
        </div>
      ) : null}
    </div>
  ),
}))

vi.mock('@/features/gate/GateQueue', () => ({
  GateQueue: ({
    onCheckIn,
    onCheckOut,
  }: {
    onCheckIn: (visit: VisitDetail) => void
    onCheckOut: (visit: VisitDetail) => void
  }) => (
    <div>
      <button type="button" onClick={() => onCheckIn(mocks.visit!)}>
        baris check-in
      </button>
      <button type="button" onClick={() => onCheckOut(mocks.visit!)}>
        baris check-out
      </button>
    </div>
  ),
}))

vi.mock('@/components/layouts/SecurityKioskShell', () => ({
  SecurityKioskShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/components/layouts/KioskStatusStrip', () => ({
  KioskStatusStrip: () => null,
}))
vi.mock('@/components/layouts/AdminBranchShell', () => ({
  AdminBranchShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/components/layouts/SuperadminShell', () => ({
  SuperadminShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

import GatePage from './page'

function makeVisit(status: VisitStatus): VisitDetail {
  return {
    id: 'visit-1',
    visit_id: 'VST-1',
    status,
    location: {
      id: 'loc-1',
      name: 'POP Tebet',
      type: 'pop',
      address: 'Jl. Tebet Raya',
      city: 'Jakarta',
      timezone: 'WIB',
    },
    purposes: [],
    vendor_user: {
      id: 'vendor-1',
      name: 'PT Mitra Jaringan',
      email: 'vendor@example.com',
      phone: '08123456789',
      nik: null,
      role: 'vendor',
      location_id: null,
      location_name: null,
      status: 'active',
      type: 'external',
      vendor_name: 'PT Mitra Jaringan',
      avatar_url: null,
    },
    vendor_name: 'PT Mitra Jaringan',
    start_date: '2026-10-18T08:00:00+07:00',
    end_date: '2026-10-18T16:00:00+07:00',
    assignment_letter_url: null,
    notes: null,
    visitors: [
      {
        id: 'visitor-1',
        name: 'Andi Wijaya',
        id_number: '1234567890123456',
        phone: '08123456789',
        id_card_photo_url: null,
        photo_url: null,
      },
    ],
    created_at: '2026-10-17T08:00:00+07:00',
  }
}

async function scan(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'pindai' }))
  })
}

async function confirm(): Promise<void> {
  const button = await screen.findByRole('button', { name: /Ya, Catat check-/ })
  await act(async () => {
    fireEvent.click(button)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.checkIn.mockResolvedValue(undefined)
  mocks.checkOut.mockResolvedValue(undefined)
  mocks.visit = makeVisit('approved')
  mocks.getVisit.mockImplementation(async () => mocks.visit)
})

afterEach(cleanup)

describe('/gate — konfirmasi direction-aware', () => {
  it('approved menampilkan "Catat check-in HH:mm?" lalu memanggil check-in', async () => {
    render(<GatePage />)
    await scan()

    expect(await screen.findByText(/Catat check-in \d{2}:\d{2}\?/)).toBeInTheDocument()
    expect(screen.queryByText(/Catat check-out/)).not.toBeInTheDocument()

    await confirm()
    await waitFor(() => expect(mocks.checkIn).toHaveBeenCalledWith({ visitId: 'visit-1' }))
    expect(mocks.checkOut).not.toHaveBeenCalled()
    expect(screen.queryByText(/Catat check-in \d{2}:\d{2}\?/)).not.toBeInTheDocument()
  })

  it('visiting menampilkan "Catat check-out HH:mm?" lalu memanggil check-out', async () => {
    mocks.visit = makeVisit('visiting')
    render(<GatePage />)
    await scan()

    expect(await screen.findByText(/Catat check-out \d{2}:\d{2}\?/)).toBeInTheDocument()
    expect(screen.queryByText(/Catat check-in/)).not.toBeInTheDocument()

    await confirm()
    await waitFor(() => expect(mocks.checkOut).toHaveBeenCalledWith({ visitId: 'visit-1' }))
    expect(mocks.checkIn).not.toHaveBeenCalled()
  })

  it('offsite dibaca sebagai check-in (re-entry)', async () => {
    mocks.visit = makeVisit('offsite')
    render(<GatePage />)
    await scan()

    expect(await screen.findByText(/Catat check-in \d{2}:\d{2}\?/)).toBeInTheDocument()
  })

  it('completed ditolak dengan alasan tanpa membuka modal', async () => {
    mocks.visit = makeVisit('completed')
    render(<GatePage />)
    await scan()

    expect(await screen.findByText('Status tidak dapat diproses')).toBeInTheDocument()
    expect(screen.getByText(/sudah selesai/)).toBeInTheDocument()
    expect(screen.queryByText(/Catat check-/)).not.toBeInTheDocument()
    expect(mocks.checkIn).not.toHaveBeenCalled()
    expect(mocks.checkOut).not.toHaveBeenCalled()
  })

  it('galat mutasi tetap berada di dalam modal', async () => {
    mocks.checkIn.mockRejectedValueOnce(new Error('Jendela check-in ditutup'))
    render(<GatePage />)
    await scan()
    await confirm()

    expect(await screen.findByRole('alert')).toHaveTextContent('Jendela check-in ditutup')
    expect(screen.getByText(/Catat check-in \d{2}:\d{2}\?/)).toBeInTheDocument()
  })
})

describe('/gate — debounce arah-sama 5 menit', () => {
  it('scan identik kedua kalinya menampilkan hasil terakhir tanpa mutasi baru', async () => {
    render(<GatePage />)

    await scan()
    await confirm()
    await waitFor(() => expect(mocks.checkIn).toHaveBeenCalledTimes(1))

    await scan()

    expect(await screen.findByText('Pemindaian berulang')).toBeInTheDocument()
    expect(screen.getByText('VST-1 berhasil Check-in MASUK.')).toBeInTheDocument()
    expect(screen.queryByText(/Catat check-in \d{2}:\d{2}\?/)).not.toBeInTheDocument()
    expect(mocks.checkIn).toHaveBeenCalledTimes(1)
  })

  it('arah berbeda tidak ditekan oleh debounce', async () => {
    render(<GatePage />)

    await scan()
    await confirm()
    await waitFor(() => expect(mocks.checkIn).toHaveBeenCalledTimes(1))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'baris check-out' }))
    })

    expect(await screen.findByText(/Catat check-out \d{2}:\d{2}\?/)).toBeInTheDocument()
  })
})
