// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Suspense, createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Role, User, VisitDetail, VisitLog, VisitStatus } from '@/lib/api/types'
import { formatTanggalWaktu } from '@/features/visits/detail/Timeline'

import VisitDetailPage from './page'

const { session, visit, logs, logsError, completeMutate, toastSuccess, toastError } = vi.hoisted(() => ({
  session: { user: null as User | null },
  visit: { current: null as VisitDetail | null },
  logs: { current: [] as VisitLog[] },
  logsError: { current: false },
  completeMutate: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: { success: toastSuccess, error: toastError },
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}))

// RequireAuth hanya menahan render sampai sesi siap; fokus uji di sini adalah
// baris pelaku & teks timeline pada SCR-04 (guard rute sendiri diuji terpisah).
vi.mock('@/lib/auth/guards', () => ({
  RequireAuth: ({ children }: { children: ReactNode }) => children,
}))

vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({ user: session.user, status: 'authenticated', refresh: vi.fn() }),
}))

// Kartu bukti kerja punya suite sendiri (WorkPhotoCard.test.tsx) dan butuh
// QueryClientProvider; di sini fokusnya baris pelaku + timeline.
vi.mock('@/features/visits/detail/WorkPhotoCard', () => ({
  WorkPhotoCard: () => null,
}))

vi.mock('@/lib/api/hooks', () => ({
  useVisitQuery: () => ({
    data: visit.current,
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useVisitLogsQuery: () => ({
    data: logs.current,
    isPending: false,
    isError: logsError.current,
    error: null,
    refetch: vi.fn(),
  }),
  useCompleteVisitMutation: () => ({ mutate: completeMutate, isPending: false }),
  useDeleteVisitMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useUpdateVisitorContactMutation: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
  useApproveVisitMutation: vi.fn(),
  useRejectVisitMutation: vi.fn(),
  useCancelVisitMutation: vi.fn(),
  useRescheduleVisitMutation: vi.fn(),
  useVisitQrQuery: vi.fn(),
}))

vi.mock('@/components/layouts/AdminBranchShell', () => ({
  AdminBranchShell: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-testid': 'admin-shell' }, children),
}))

vi.mock('@/components/layouts/SuperadminShell', () => ({
  SuperadminShell: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-testid': 'superadmin-shell' }, children),
}))

vi.mock('@/components/layouts/SecurityKioskShell', () => ({
  SecurityKioskShell: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-testid': 'security-shell' }, children),
}))

vi.mock('@/components/layouts/VendorMobileShell', () => ({
  VendorMobileShell: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-testid': 'vendor-shell' }, children),
  isQrVisible: (status: string) =>
    status === 'approved' || status === 'visiting' || status === 'offsite',
}))

vi.mock('@/features/visits/detail/QrCard', () => ({
  QrCard: () => null,
}))

function makeUser(role: Role): User {
  return {
    id: `u-${role}`,
    name: 'Siti Rahayu',
    email: 'siti@thc.id',
    phone: '081234567890',
    nik: '3273012345678901',
    role,
    location_id: 'loc-1',
    location_name: 'POP Tebet',
    status: 'active',
    type: 'internal',
    vendor_name: null,
    avatar_url: null,
    editable_fields: ['phone'],
  }
}

function makeVisit(): VisitDetail {
  return {
    id: 'visit-1',
    visit_id: 'VST-9548545669',
    status: 'completed',
    location: {
      id: 'loc-1',
      name: 'POP Tebet',
      type: 'pop',
      address: 'Jl. Tebet Raya',
      city: 'Jakarta',
      timezone: 'WIB',
    },
    purposes: [{ id: 'pur-1', name: 'Maintenance Genset' }],
    vendor_user: {
      id: 'vendor-1',
      name: 'Dimas Prasetyo',
      email: 'dimas@vendor.example',
      phone: '08111111111',
      nik: '3273019876543210',
      role: 'vendor',
      location_id: null,
      location_name: null,
      status: 'active',
      type: 'external',
      vendor_name: 'PT Lintas Fiber',
      avatar_url: null,
      editable_fields: [],
    },
    vendor_name: 'PT Lintas Fiber',
    start_date: '2026-09-26T09:00:00+07:00',
    end_date: '2026-09-26T17:00:00+07:00',
    assignment_letter_url: null,
    notes: null,
    visitors: [],
    created_at: '2026-09-20T10:00:00+07:00',
    created_by_name: 'Wulan Sari',
    created_by_role_label: 'Vendor/Mitra',
    checked_in_by_name: 'Bagus Prakoso',
    checked_out_by_name: 'Rina Wati',
    history: [
      {
        status: 'requested',
        at: '2026-09-20T10:00:00+07:00',
        actor_name: 'Wulan Sari',
        actor_role_label: 'Vendor/Mitra',
      },
      {
        status: 'approved',
        at: '2026-09-21T09:30:00+07:00',
        actor_name: 'Siti Rahayu',
        actor_role_label: 'Admin Cabang',
      },
      {
        status: 'visiting',
        at: '2026-09-26T14:30:00+07:00',
        actor_name: 'Bagus Prakoso',
        actor_role_label: 'Petugas Keamanan',
      },
      {
        status: 'completed',
        at: '2026-09-26T16:45:00+07:00',
        actor_name: 'Rina Wati',
        actor_role_label: 'Petugas Keamanan',
      },
    ],
  }
}

// `params` adalah Promise (Next.js 16): komponen membukanya dengan `use()`,
// sehingga render pertama SUSPEND. Await act agar resolusi promise &
// render ulang ter-flush di dalam act scope, bukan di luarnya.
async function renderDetail(): Promise<void> {
  await act(async () => {
    render(
      createElement(
        Suspense,
        { fallback: createElement('div', null, 'memuat') },
        createElement(VisitDetailPage, { params: Promise.resolve({ id: 'visit-1' }) }),
      ),
    )
  })
}

beforeEach(() => {
  session.user = makeUser('admin')
  visit.current = makeVisit()
  logs.current = []
  logsError.current = false
  completeMutate.mockReset()
  toastSuccess.mockReset()
  toastError.mockReset()
})

afterEach(cleanup)

describe('/visits/[id] — baris pelaku & riwayat status', () => {
  it('kartu Informasi Kunjungan menampilkan tiga baris pelaku', async () => {
    await renderDetail()

    expect(screen.getByText('VST-9548545669')).toBeInTheDocument()

    expect(screen.getByText('Diajukan oleh')).toBeInTheDocument()
    expect(screen.getByText('Wulan Sari (Vendor/Mitra)')).toBeInTheDocument()

    expect(screen.getByText('Check-in oleh')).toBeInTheDocument()
    expect(screen.getByText('Bagus Prakoso')).toBeInTheDocument()

    expect(screen.getByText('Check-out oleh')).toBeInTheDocument()
    expect(screen.getByText('Rina Wati')).toBeInTheDocument()
  })

  it('panel Riwayat Status menampilkan baris riwayat dengan "oleh <nama> (<peran>)"', async () => {
    await renderDetail()

    expect(screen.getByText('Riwayat Status')).toBeInTheDocument()

    expect(
      screen.getByText(
        `oleh Siti Rahayu (Admin Cabang) · ${formatTanggalWaktu('2026-09-21T09:30:00+07:00')}`,
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        `oleh Wulan Sari (Vendor/Mitra) · ${formatTanggalWaktu('2026-09-20T10:00:00+07:00')}`,
      ),
    ).toBeInTheDocument()
    // Label status Bahasa Indonesia per baris riwayat.
    expect(screen.getByText('Diminta')).toBeInTheDocument()
    expect(screen.getByText('Disetujui')).toBeInTheDocument()
    expect(screen.getByText('Sedang di Lokasi')).toBeInTheDocument()
    // Fallback langkah turunan TIDAK ikut dirender saat riwayat ada.
    expect(screen.queryByText('Persetujuan')).not.toBeInTheDocument()
    expect(screen.queryByText('Disetujui oleh admin')).not.toBeInTheDocument()
  })

  it('payload tanpa riwayat: fallback langkah turunan dan baris pelaku hilang', async () => {
    const legacy = makeVisit()
    delete legacy.history
    delete legacy.created_by_name
    delete legacy.created_by_role_label
    delete legacy.checked_in_by_name
    delete legacy.checked_out_by_name
    visit.current = legacy

    await renderDetail()

    expect(screen.getByText('VST-9548545669')).toBeInTheDocument()

    expect(screen.getByText('Persetujuan')).toBeInTheDocument()
    expect(
      screen.getByText(`Diajukan ${formatTanggalWaktu('2026-09-20T10:00:00+07:00')}`),
    ).toBeInTheDocument()
    expect(screen.queryByText('Diajukan oleh')).not.toBeInTheDocument()
    expect(screen.queryByText('Check-in oleh')).not.toBeInTheDocument()
    expect(screen.queryByText('Check-out oleh')).not.toBeInTheDocument()
    expect(screen.queryByText(/oleh Siti Rahayu/)).not.toBeInTheDocument()
  })
})

describe('/visits/[id] — Riwayat Kunjungan (visit_logs)', () => {
  it('merender baris check-in/check-out dengan pelaku dan waktu', async () => {
    logs.current = [
      {
        id: 'log-1',
        visit_request_id: 'visit-1',
        direction: 'in',
        actor_user_id: 'guard-1',
        actor_role: 'Petugas Keamanan',
        actor_name: 'Dewi Anggraini',
        created_at: '2026-09-26T14:30:00+07:00',
      },
      {
        id: 'log-2',
        visit_request_id: 'visit-1',
        direction: 'out',
        actor_user_id: 'guard-2',
        actor_role: 'Petugas Keamanan',
        actor_name: 'Fajar Nugroho',
        created_at: '2026-09-26T16:45:00+07:00',
      },
    ]

    await renderDetail()

    expect(screen.getByText('Riwayat Kunjungan')).toBeInTheDocument()
    expect(screen.getByText('Check-in')).toBeInTheDocument()
    expect(screen.getByText('Check-out')).toBeInTheDocument()
    expect(screen.getByText('Dewi Anggraini')).toBeInTheDocument()
    expect(screen.getByText('Fajar Nugroho')).toBeInTheDocument()
    expect(screen.getByText(formatTanggalWaktu('2026-09-26T14:30:00+07:00'))).toBeInTheDocument()
    expect(screen.getByText(formatTanggalWaktu('2026-09-26T16:45:00+07:00'))).toBeInTheDocument()
  })

  it('menampilkan keadaan kosong saat tidak ada log', async () => {
    await renderDetail()

    expect(
      screen.getByText('Belum ada riwayat check-in atau check-out pada kunjungan ini.'),
    ).toBeInTheDocument()
  })

  it('menampilkan keadaan galat beserta tombol coba lagi', async () => {
    logsError.current = true

    await renderDetail()

    expect(screen.getByText('Riwayat kunjungan gagal dimuat')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Coba Lagi' })).toBeInTheDocument()
  })

  it('lebih dari 6 log: tampil 6 baris + Lihat Semua membuka modal berisi semua', async () => {
    logs.current = Array.from({ length: 8 }, (_, i) => ({
      id: `log-${i + 1}`,
      visit_request_id: 'visit-1',
      direction: i % 2 === 0 ? ('in' as const) : ('out' as const),
      actor_user_id: `guard-${i + 1}`,
      actor_role: 'Petugas Keamanan',
      actor_name: `Petugas ${i + 1}`,
      created_at: `2026-09-26T1${i}:00:00+07:00`,
    }))

    await renderDetail()

    expect(screen.getByText('Riwayat Kunjungan')).toBeInTheDocument()
    expect(screen.getAllByText('Check-in')).toHaveLength(3)
    expect(screen.getAllByText('Check-out')).toHaveLength(3)
    expect(screen.queryByText('Petugas 7')).not.toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Lihat Semua (8)' }))
    })

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Riwayat Kunjungan Lengkap')).toBeInTheDocument()
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getAllByText('Check-in')).toHaveLength(4)
    expect(within(dialog).getAllByText('Check-out')).toHaveLength(4)
    expect(within(dialog).getByText('Petugas 7')).toBeInTheDocument()
  })
})

describe('/visits/[id] — tombol Selesaikan', () => {
  function setVisit(status: VisitStatus): void {
    const next = makeVisit()
    next.status = status
    visit.current = next
  }

  it('tampil untuk admin pada visiting dan offsite', async () => {
    for (const status of ['visiting', 'offsite'] as VisitStatus[]) {
      cleanup()
      setVisit(status)
      session.user = makeUser('admin')
      await renderDetail()
      expect(screen.getByRole('button', { name: /Selesaikan kunjungan VST-/ })).toBeInTheDocument()
    }
  })

  it('tampil untuk super_admin pada offsite', async () => {
    setVisit('offsite')
    session.user = makeUser('super_admin')
    await renderDetail()

    expect(screen.getByRole('button', { name: /Selesaikan kunjungan VST-/ })).toBeInTheDocument()
  })

  it('tidak tampil untuk security, vendor, atau status completed', async () => {
    for (const role of ['security', 'vendor'] as Role[]) {
      cleanup()
      setVisit('visiting')
      session.user = makeUser(role)
      await renderDetail()
      expect(screen.queryByRole('button', { name: /Selesaikan kunjungan VST-/ })).not.toBeInTheDocument()
    }

    cleanup()
    setVisit('completed')
    session.user = makeUser('admin')
    await renderDetail()
    expect(screen.queryByRole('button', { name: /Selesaikan kunjungan VST-/ })).not.toBeInTheDocument()
  })

  it('konfirmasi memanggil mutasi lalu toast sukses', async () => {
    setVisit('visiting')
    session.user = makeUser('admin')
    completeMutate.mockImplementation((_vars, options) => options?.onSuccess?.())
    await renderDetail()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Selesaikan kunjungan VST-/ }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Ya, Selesaikan' }))
    })

    await waitFor(() => expect(completeMutate).toHaveBeenCalledTimes(1))
    expect(toastSuccess).toHaveBeenCalledWith('Kunjungan VST-9548545669 telah diselesaikan.')
  })
})
