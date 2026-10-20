// @vitest-environment jsdom
/**
 * Kontrak kontrol tabel `GET /visits` (openapi §/visits) — q / date_from /
 * date_to / page / limit / sort_by / order.
 *
 * Modul produksi yang DITARGETKAN:
 *   · `listVisits` (`src/lib/api/client.ts`) — pass-through query param,
 *     string kosong dibuang, tanpa param → `/visits` polos.
 *   · `queryKeys.visits.list` (`src/lib/api/query-keys.ts`) — kunci cache
 *     berbeda saat TIAP param berubah, identik untuk isi sama.
 *   · `visitsQueryOptions` / `useVisitsQuery` (`src/lib/api/hooks.ts`) —
 *     queryFn → `listVisits(params)`; refetch saat param berubah, TIDAK
 *     refetch saat objek baru berisi nilai sama (structural key).
 *   · helper halaman `toVisitListParams` / `toVisitMetricsParams` /
 *     `toApprovalListParams` / `toGateListParams` — `limit` mengikuti
 *     `filter.pageSize` (default `DEFAULT_PAGE_SIZE` = 10), metrik kartu
 *     tetap `limit: 1`.
 *
 * Strategi mock: `apiFetch` (`@/lib/api/fetcher`) di-mock di lapisan fetch,
 * sehingga `listVisits` ASLI berjalan dan URL yang dibangun bisa di-assert
 * langsung (mock hanya fetcher, bukan client-nya).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  toApprovalListParams,
  type ApprovalListFilter,
} from '@/app/approvals/page'
import { toGateListParams } from '@/app/gate/page'
import {
  toVisitListParams,
  toVisitMetricsParams,
  type VisitListFilter,
} from '@/app/dashboard/page'
import { listVisits } from '@/lib/api/client'
import { useVisitsQuery, visitsQueryOptions } from '@/lib/api/hooks'
import { queryKeys } from '@/lib/api/query-keys'
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS } from '@/lib/pagination'
import type { VisitListParams, VisitListResult } from '@/lib/api/types'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))

vi.mock('@/lib/api/fetcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/fetcher')>()
  return { ...actual, apiFetch }
})

/** Halaman kosong — nilai kembalian `apiFetch` untuk `listVisits`. */
function page(total = 0): VisitListResult {
  return { items: [], total, page: 1, limit: DEFAULT_PAGE_SIZE }
}

/** Wrapper React Query baru PER TEST agar cache tidak bocor antar kasus. */
function renderVisitsHook(initialParams: VisitListParams) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  return renderHook(({ params }: { params: VisitListParams }) => useVisitsQuery(params), {
    wrapper,
    initialProps: { params: initialParams },
  })
}

beforeEach(() => {
  apiFetch.mockReset()
  apiFetch.mockResolvedValue(page())
})

afterEach(() => {
  cleanup()
})

describe('listVisits — pass-through query param kontrak', () => {
  it('meneruskan seluruh param ke URL dengan urutan kontrak backend', async () => {
    await listVisits({
      status: 'approved',
      location_id: 'loc-1',
      q: 'andi',
      date_from: '2026-10-01',
      date_to: '2026-10-03',
      page: 3,
      limit: 20,
      sort_by: 'start_date',
      order: 'asc',
    })

    expect(apiFetch).toHaveBeenCalledWith(
      '/visits?status=approved&location_id=loc-1&q=andi&date_from=2026-10-01'
      + '&date_to=2026-10-03&page=3&limit=20&sort_by=start_date&order=asc',
    )
  })

  it('membuang string kosong sehingga filter kosong tidak memecah kunci cache', async () => {
    await listVisits({
      location_id: '',
      q: '',
      date_from: '',
      date_to: '',
      page: 1,
      limit: 20,
    })

    expect(apiFetch).toHaveBeenCalledWith('/visits?page=1&limit=20')
  })

  it('tanpa param apapun → path polos /visits', async () => {
    await listVisits()

    expect(apiFetch).toHaveBeenCalledWith('/visits')
  })
})

describe('queryKeys.visits.list — kunci per param', () => {
  const base: VisitListParams = { page: 1, limit: DEFAULT_PAGE_SIZE }

  it('berubah untuk setiap param (q/date/sort/page/limit/status/location)', () => {
    const key = queryKeys.visits.list(base)

    expect(queryKeys.visits.list({ ...base, q: 'andi' })).not.toEqual(key)
    expect(queryKeys.visits.list({ ...base, date_from: '2026-10-01' })).not.toEqual(key)
    expect(queryKeys.visits.list({ ...base, date_to: '2026-10-31' })).not.toEqual(key)
    expect(queryKeys.visits.list({ ...base, sort_by: 'start_date' })).not.toEqual(key)
    expect(queryKeys.visits.list({ ...base, order: 'asc' })).not.toEqual(key)
    expect(queryKeys.visits.list({ ...base, page: 2 })).not.toEqual(key)
    expect(queryKeys.visits.list({ ...base, limit: 50 })).not.toEqual(key)
    expect(queryKeys.visits.list({ ...base, status: 'approved' })).not.toEqual(key)
    expect(queryKeys.visits.list({ ...base, location_id: 'loc-1' })).not.toEqual(key)
  })

  it('identik untuk objek berbeda dengan isi sama', () => {
    expect(queryKeys.visits.list({ limit: 20, page: 1 })).toEqual(
      queryKeys.visits.list({ page: 1, limit: 20 }),
    )
  })
})

describe('visitsQueryOptions & useVisitsQuery — queryFn dan refetch', () => {
  it('queryFn memanggil listVisits(params) membangun URL kontrak', async () => {
    const params: VisitListParams = {
      q: 'fiber',
      date_from: '2026-10-01',
      page: 2,
      limit: 50,
      sort_by: 'created_at',
      order: 'desc',
    }
    const options = visitsQueryOptions(params)
    expect(options.queryKey).toEqual(queryKeys.visits.list(params))

    const queryFn = options.queryFn as () => Promise<VisitListResult>
    await queryFn()

    expect(apiFetch).toHaveBeenCalledWith(
      '/visits?q=fiber&date_from=2026-10-01&page=2&limit=50&sort_by=created_at&order=desc',
    )
  })

  it('rerender dengan params berbeda memicu refetch memakai URL baru', async () => {
    const base: VisitListParams = { page: 1, limit: DEFAULT_PAGE_SIZE, sort_by: 'created_at', order: 'desc' }
    const { result, rerender } = renderVisitsHook(base)

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1))
    expect(apiFetch).toHaveBeenLastCalledWith(
      '/visits?page=1&limit=10&sort_by=created_at&order=desc',
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    rerender({ params: { ...base, page: 2 } })

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2))
    expect(apiFetch).toHaveBeenLastCalledWith(
      '/visits?page=2&limit=10&sort_by=created_at&order=desc',
    )
  })

  it('rerender dengan objek baru berisi nilai sama TIDAK refetch', async () => {
    const base: VisitListParams = { page: 1, limit: DEFAULT_PAGE_SIZE, q: 'andi' }
    const { result, rerender } = renderVisitsHook(base)

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(apiFetch).toHaveBeenCalledTimes(1)

    rerender({ params: { q: 'andi', limit: DEFAULT_PAGE_SIZE, page: 1 } })

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })
})

describe('helper halaman — limit mengikuti filter.pageSize', () => {
  const dashFilter: VisitListFilter = {
    facilityId: 'all',
    q: '',
    dateFrom: '',
    dateTo: '',
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    sortBy: 'created_at',
    order: 'desc',
  }

  it('dashboard toVisitListParams: limit = pageSize + pemetaan filter penuh', () => {
    expect(toVisitListParams(dashFilter)).toEqual({
      page: 1,
      limit: DEFAULT_PAGE_SIZE,
      sort_by: 'created_at',
      order: 'desc',
    })
    expect(toVisitListParams(dashFilter, 'visiting')).toEqual({
      status: 'visiting',
      page: 1,
      limit: DEFAULT_PAGE_SIZE,
      sort_by: 'created_at',
      order: 'desc',
    })

    const filled = toVisitListParams({
      facilityId: 'loc-1',
      q: 'andi',
      dateFrom: '2026-10-01',
      dateTo: '2026-10-03',
      page: 4,
      pageSize: 50,
      sortBy: 'start_date',
      order: 'asc',
    })
    expect(filled).toEqual({
      location_id: 'loc-1',
      q: 'andi',
      date_from: '2026-10-01',
      date_to: '2026-10-03',
      page: 4,
      limit: 50,
      sort_by: 'start_date',
      order: 'asc',
    })
  })

  it('dashboard toVisitMetricsParams: limit 1 tanpa page/sort (hanya total server)', () => {
    const params = toVisitMetricsParams(dashFilter, 'requested')

    expect(params).toEqual({ status: 'requested', limit: 1 })
    expect(params).not.toHaveProperty('page')
    expect(params).not.toHaveProperty('sort_by')
    expect(params).not.toHaveProperty('order')
  })

  it('approvals toApprovalListParams: limit = pageSize + scoping lokasi opsional', () => {
    const filter: ApprovalListFilter = {
      q: '',
      locationId: 'all',
      dateFrom: '',
      dateTo: '',
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      sortBy: 'created_at',
      order: 'desc',
    }

    expect(toApprovalListParams(filter)).toEqual({
      page: 1,
      limit: DEFAULT_PAGE_SIZE,
      sort_by: 'created_at',
      order: 'desc',
    })

    const superadmin = toApprovalListParams({
      ...filter,
      locationId: 'loc-9',
      q: 'genset',
      dateFrom: '2026-10-01',
      page: 2,
      pageSize: 20,
    })
    expect(superadmin).toEqual({
      page: 2,
      limit: 20,
      sort_by: 'created_at',
      order: 'desc',
      location_id: 'loc-9',
      q: 'genset',
      date_from: '2026-10-01',
    })
  })

  it('gate toGateListParams: limit = pageSize + status tab + tanggal', () => {
    expect(
      toGateListParams(
        {
          dateFrom: '',
          dateTo: '',
          page: 1,
          pageSize: DEFAULT_PAGE_SIZE,
          sortBy: 'start_date',
          order: 'asc',
        },
        'approved',
      ),
    ).toEqual({
      status: 'approved',
      page: 1,
      limit: DEFAULT_PAGE_SIZE,
      sort_by: 'start_date',
      order: 'asc',
    })

    expect(
      toGateListParams(
        {
          dateFrom: '2026-10-01',
          dateTo: '2026-10-02',
          page: 3,
          pageSize: 100,
          sortBy: 'end_date',
          order: 'desc',
        },
        'visiting',
      ),
    ).toEqual({
      status: 'visiting',
      page: 3,
      limit: 100,
      sort_by: 'end_date',
      order: 'desc',
      date_from: '2026-10-01',
      date_to: '2026-10-02',
    })
  })

  it('DEFAULT_PAGE_SIZE = 10 dan opsi selector 10/20/50/100', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(10)
    expect(PAGE_SIZE_OPTIONS).toEqual([10, 20, 50, 100])
  })
})
