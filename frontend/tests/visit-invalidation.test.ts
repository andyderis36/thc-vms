// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApproveModal } from '@/features/visits/components/ApproveModal'
import { RejectModal } from '@/features/visits/components/RejectModal'
import {
  useApproveVisitMutation,
  useCheckInVisitMutation,
  useCheckOutVisitMutation,
  useRejectVisitMutation,
  useRescheduleVisitMutation,
} from '@/lib/api/hooks'
import { queryKeys } from '@/lib/api/query-keys'
import type { VisitDetail } from '@/lib/api/types'
import {
  approveVisit,
  checkInVisit,
  checkOutVisit,
  rejectVisit,
} from '@/lib/api/client'

/**
 * Kontrak invalidasi pasca-mutasi (failing-first untuk FIX-2):
 * - Hook mutasi HARUS meng-invalidate key detail + prefix list + key QR
 *   dengan visitId yang diterimanya (kontrak ini sudah benar — dikunci hijau).
 * - Modal approve/reject HARUS meng-invalidate key detail yang dipakai halaman
 *   (`/visits/<routeId>`). Saat halaman dibuka langsung via kode bisnis
 *   (`/visits/VST-...`), routeId = `visit.visit_id`, BUKAN `visit.id` (UUID).
 *   Kode saat ini meng-invalidate UUID → halaman basi (2 kasus modal MERAH).
 */

vi.mock('@/lib/api/client', () => ({
  approveVisit: vi.fn().mockResolvedValue({}),
  rejectVisit: vi.fn().mockResolvedValue({}),
  rescheduleVisit: vi.fn().mockResolvedValue({}),
  checkInVisit: vi.fn().mockResolvedValue({}),
  checkOutVisit: vi.fn().mockResolvedValue({}),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const ROUTE_CODE = 'VST-9801185741'
const ENTITY_UUID = '40958d46-0000-4000-8000-000000000001'

const visitFixture: VisitDetail = {
  id: ENTITY_UUID,
  visit_id: ROUTE_CODE,
  status: 'requested',
  location: {
    id: 'loc-a',
    name: 'Cabang A',
    type: 'cabang',
    address: 'Jl A No 1',
    city: 'Kota A',
    timezone: 'WIB',
  },
  purposes: [],
  vendor_user: {
    id: 'vendor-1',
    name: 'Vendor Uji',
    email: 'vendor@uji.test',
    phone: '081200000001',
    nik: null,
    role: 'vendor',
    location_id: null,
    location_name: null,
    status: 'active',
    type: 'external',
    vendor_name: null,
  },
  vendor_name: '',
  start_date: '2026-10-20T08:00:00+07:00',
  end_date: '2026-10-20T17:00:00+07:00',
  assignment_letter_url: null,
  notes: null,
  visitors: [],
  created_at: '2026-10-15T08:00:00+07:00',
}

function makeClient(): { client: QueryClient; invalidateSpy: ReturnType<typeof vi.spyOn> } {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const invalidateSpy = vi.spyOn(client, 'invalidateQueries')
  return { client, invalidateSpy }
}

function providerWrapper(client: QueryClient): ({ children }: { children: ReactNode }) => ReactNode {
  return function Wrapper({ children }: { children: ReactNode }): ReactNode {
    return createElement(QueryClientProvider, { client }, children)
  }
}

function expectVisitKeysInvalidated(
  invalidateSpy: ReturnType<typeof vi.spyOn>,
  routeId: string,
): void {
  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.visits.detail(routeId) })
  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.visits.list({}).slice(0, 2) })
  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.visits.qr(routeId) })
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('kontrak invalidasi hook mutasi — dikunci hijau', () => {
  it('approve meng-invalidate detail + list + QR dengan visitId yang diterima', async () => {
    const { client, invalidateSpy } = makeClient()
    const { result } = renderHook(() => useApproveVisitMutation(), {
      wrapper: providerWrapper(client),
    })
    await result.current.mutateAsync({ visitId: ROUTE_CODE })
    expect(approveVisit).toHaveBeenCalledWith(ROUTE_CODE, undefined)
    expectVisitKeysInvalidated(invalidateSpy, ROUTE_CODE)
  })

  it('reject meng-invalidate detail + list + QR dengan visitId yang diterima', async () => {
    const { client, invalidateSpy } = makeClient()
    const { result } = renderHook(() => useRejectVisitMutation(), {
      wrapper: providerWrapper(client),
    })
    await result.current.mutateAsync({ visitId: ROUTE_CODE, body: { reason: 'jadwal bentrok' } })
    expect(rejectVisit).toHaveBeenCalledWith(ROUTE_CODE, { reason: 'jadwal bentrok' })
    expectVisitKeysInvalidated(invalidateSpy, ROUTE_CODE)
  })

  it('reschedule meng-invalidate detail + list + QR dengan visitId yang diterima', async () => {
    const { client, invalidateSpy } = makeClient()
    const { result } = renderHook(() => useRescheduleVisitMutation(), {
      wrapper: providerWrapper(client),
    })
    await result.current.mutateAsync({
      visitId: ROUTE_CODE,
      body: {
        start_date: '2026-10-21T08:00:00+07:00',
        end_date: '2026-10-21T17:00:00+07:00',
        reason: 'geser jadwal',
      },
    })
    expectVisitKeysInvalidated(invalidateSpy, ROUTE_CODE)
  })

  it('check-in meng-invalidate detail + list + QR dengan visitId yang diterima', async () => {
    const { client, invalidateSpy } = makeClient()
    const { result } = renderHook(() => useCheckInVisitMutation(), {
      wrapper: providerWrapper(client),
    })
    await result.current.mutateAsync({ visitId: ROUTE_CODE })
    expect(checkInVisit).toHaveBeenCalledWith(ROUTE_CODE, undefined)
    expectVisitKeysInvalidated(invalidateSpy, ROUTE_CODE)
  })

  it('check-out meng-invalidate detail + list + QR dengan visitId yang diterima', async () => {
    const { client, invalidateSpy } = makeClient()
    const { result } = renderHook(() => useCheckOutVisitMutation(), {
      wrapper: providerWrapper(client),
    })
    await result.current.mutateAsync({ visitId: ROUTE_CODE })
    expect(checkOutVisit).toHaveBeenCalledWith(ROUTE_CODE)
    expectVisitKeysInvalidated(invalidateSpy, ROUTE_CODE)
  })
})

describe('regresi direct-open /visits/VST-... — MERAH sampai FIX-2', () => {
  it('approve dari modal meng-invalidate key detail route (VST-code), bukan UUID', async () => {
    const { client, invalidateSpy } = makeClient()
    // Simulasi halaman detail yang dibuka langsung via kode bisnis.
    client.setQueryData(queryKeys.visits.detail(ROUTE_CODE), visitFixture)
    render(createElement(ApproveModal, { open: true, visit: visitFixture, onClose: vi.fn() }), {
      wrapper: providerWrapper(client),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Setujui' }))
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalled()
    })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.visits.detail(ROUTE_CODE) })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.visits.qr(ROUTE_CODE) })
  })

  it('reject dari modal meng-invalidate key detail route (VST-code), bukan UUID', async () => {
    const { client, invalidateSpy } = makeClient()
    client.setQueryData(queryKeys.visits.detail(ROUTE_CODE), visitFixture)
    render(createElement(RejectModal, { open: true, visit: visitFixture, onClose: vi.fn() }), {
      wrapper: providerWrapper(client),
    })
    fireEvent.change(screen.getByPlaceholderText('Jelaskan alasan penolakan (min. 5 karakter)'), {
      target: { value: 'jadwal bentrok bro' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Tolak' }))
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalled()
    })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.visits.detail(ROUTE_CODE) })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.visits.qr(ROUTE_CODE) })
  })
})
