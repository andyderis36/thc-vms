// @vitest-environment jsdom
/**
 * Kontrak `usePendingApprovalCount` — badge antrean approval pada shell
 * (SuperadminShell / AdminBranchShell) dan subtitle halaman approvals.
 *
 * Modul produksi yang DITARGETKAN: `src/lib/api/hooks.ts`
 *   · `usePendingApprovalCount(enabled = true)` memanggil `useVisitsQuery`
 *     untuk DUA cabang (`requested` + `rescheduled`, keduanya `limit: 1`) dan
 *     menjumlahkan `total` dari server.
 *   → `{ pendingCount, isPending, isError, refetch }`
 *
 * Strategi mock: `@/lib/api/client` di-mock pada level fetch (`listVisits`),
 * sehingga badan hook, `visitsQueryOptions`, dan `useQuery` React Query
 * berjalan ASLI (bukan mock hook-nya sendiri).
 *
 * Kasus:
 *  · Sukses        → `pendingCount` = total requested + total rescheduled.
 *  · Data hilang   → `0` (bukan NaN/`undefined`).
 *  · Galat cabang requested → `isError` true, total rescheduled tetap dijumlah.
 *  · `enabled=false` → TIDAK ada fetch sama sekali.
 *  · `refetch()`   → memicu ulang KEDUA cabang query.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/lib/api/fetcher'
import { usePendingApprovalCount } from '@/lib/api/hooks'
import type { VisitListParams, VisitListResult } from '@/lib/api/types'

const { listVisits } = vi.hoisted(() => ({ listVisits: vi.fn() }))

vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/client')>()
  return { ...actual, listVisits }
})

/** Halaman kosong dengan `total` tertentu — satu-satunya field yang dibaca hook. */
function page(total: number): VisitListResult {
  return { items: [], total, page: 1, limit: 1 }
}

/** Wrapper React Query baru PER TEST agar cache tidak bocor antar kasus. */
function renderPendingHook(enabled?: boolean) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  return renderHook(() => usePendingApprovalCount(enabled), { wrapper })
}

beforeEach(() => {
  listVisits.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('usePendingApprovalCount — sukses', () => {
  it('menjumlahkan total requested dan rescheduled menjadi pendingCount', async () => {
    listVisits.mockImplementation(async (params: VisitListParams) =>
      page(params.status === 'requested' ? 3 : 2),
    )

    const { result } = renderPendingHook()

    await waitFor(() => expect(result.current.isPending).toBe(false))

    expect(result.current.pendingCount).toBe(5)
    expect(result.current.isError).toBe(false)
  })

  it('data belum tersedia (query belum settle) dihitung 0, bukan NaN', () => {
    // Promise tak pernah selesai → kedua query tetap pending; `data` hilang.
    listVisits.mockImplementation(() => new Promise<VisitListResult>(() => {}))

    const { result } = renderPendingHook()

    expect(result.current.isPending).toBe(true)
    expect(result.current.pendingCount).toBe(0)
    expect(result.current.isError).toBe(false)
  })
})

describe('usePendingApprovalCount — galat', () => {
  it('galat hanya dari cabang requested: isError true dan total rescheduled tetap dijumlahkan', async () => {
    listVisits.mockImplementation(async (params: VisitListParams) => {
      if (params.status === 'requested') {
        throw new ApiError('Not Found', 404, 'NOT_FOUND')
      }
      return page(4)
    })

    const { result } = renderPendingHook()

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(result.current.isPending).toBe(false)
    expect(result.current.pendingCount).toBe(4)
  })
})

describe('usePendingApprovalCount — enabled & refetch', () => {
  it('enabled=false tidak memicu fetch apa pun', async () => {
    listVisits.mockResolvedValue(page(9))

    const { result } = renderPendingHook(false)

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })

    expect(listVisits).not.toHaveBeenCalled()
    expect(result.current.isPending).toBe(true)
    expect(result.current.pendingCount).toBe(0)
  })

  it('refetch memicu ulang KEDUA cabang query (requested + rescheduled)', async () => {
    listVisits.mockResolvedValue(page(1))

    const { result } = renderPendingHook()

    await waitFor(() => expect(result.current.isPending).toBe(false))

    listVisits.mockClear()

    await act(async () => {
      result.current.refetch()
    })

    await waitFor(() => expect(listVisits).toHaveBeenCalledTimes(2))
    const statuses = listVisits.mock.calls
      .map((call) => (call[0] as VisitListParams).status)
      .sort()
    expect(statuses).toEqual(['requested', 'rescheduled'])
  })
})
