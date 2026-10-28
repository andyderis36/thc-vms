/**
 * Regresi bug nyata: `listAuditLogs` sempat membuang `q` dan `order` sehingga
 * filter/pencarian di `/audit` hanya berubah di UI tanpa memengaruhi request.
 * Tes ini mengunci URL request (bukan sekadar helper filter) agar regresi
 * serupa gagal di CI.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { listAuditLogs } from '@/lib/api/client'
import type { AuditLogListResult } from '@/lib/api/types'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))

vi.mock('@/lib/api/fetcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/fetcher')>()
  return { ...actual, apiFetch }
})

const emptyResult: AuditLogListResult = { items: [], total: 0, page: 1, limit: 50 }

beforeEach(() => {
  apiFetch.mockReset()
  apiFetch.mockResolvedValue(emptyResult)
})

describe('listAuditLogs — parameter diteruskan ke request', () => {
  it('meneruskan q dan order beserta page/limit', async () => {
    await listAuditLogs({ q: 'admin', order: 'asc', page: 2, limit: 100 })

    expect(apiFetch).toHaveBeenCalledWith('/audit-logs?q=admin&order=asc&page=2&limit=100')
  })

  it('meneruskan batas tanggal RFC3339 hasil perluasan hari lokal', async () => {
    await listAuditLogs({
      date_from: '2026-10-01T00:00:00.000Z',
      date_to: '2026-10-17T00:00:00.000Z',
      order: 'desc',
    })

    expect(apiFetch).toHaveBeenCalledWith(
      '/audit-logs?date_from=2026-10-01T00%3A00%3A00.000Z'
        + '&date_to=2026-10-17T00%3A00%3A00.000Z&order=desc',
    )
  })

  it('tanpa parameter menghasilkan path polos', async () => {
    await listAuditLogs()

    expect(apiFetch).toHaveBeenCalledWith('/audit-logs')
  })
})
