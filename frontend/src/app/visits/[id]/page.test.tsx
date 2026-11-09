// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { act, cleanup, render, screen } from '@testing-library/react'
import { Suspense, createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Role, User, VisitDetail } from '@/lib/api/types'
import { formatTanggalWaktu } from '@/features/visits/detail/Timeline'

import VisitDetailPage from './page'

const { session, visit } = vi.hoisted(() => ({
  session: { user: null as User | null },
  visit: { current: null as VisitDetail | null },
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
  isQrVisible: (status: string) => status === 'approved' || status === 'visiting',
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
