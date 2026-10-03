import { describe, expect, it } from 'vitest'

import { visitDetailQueryOptions, visitQrQueryOptions } from '@/lib/api/hooks'
import { queryKeys } from '@/lib/api/query-keys'

/**
 * Kontrak pembaruan mandiri SCR-04 (T3): detail kunjungan & QR wajib
 * polling agar QR muncul setelah approve dan "Riwayat Status" menyegarkan
 * diri setelah check-in/out tanpa reload manual.
 */
describe('opsi polling detail kunjungan', () => {
  const id = 'visit-123'

  it('visitDetailQueryOptions memakai interval 10-15 detik + refetch saat fokus', () => {
    const options = visitDetailQueryOptions(id)
    expect(options.refetchInterval).toBeGreaterThanOrEqual(10_000)
    expect(options.refetchInterval).toBeLessThanOrEqual(15_000)
    expect(options.refetchOnWindowFocus).toBe(true)
    expect(options.refetchIntervalInBackground).toBe(false)
  })

  it('visitQrQueryOptions memakai interval 10-15 detik + refetch saat fokus', () => {
    const options = visitQrQueryOptions(id)
    expect(options.refetchInterval).toBeGreaterThanOrEqual(10_000)
    expect(options.refetchInterval).toBeLessThanOrEqual(15_000)
    expect(options.refetchOnWindowFocus).toBe(true)
    expect(options.refetchIntervalInBackground).toBe(false)
  })

  it('kunci cache & staleTime tidak berubah (invalidasi lama tetap berlaku)', () => {
    expect(visitDetailQueryOptions(id).queryKey).toEqual(queryKeys.visits.detail(id))
    expect(visitDetailQueryOptions(id).staleTime).toBe(30 * 1000)
    expect(visitQrQueryOptions(id).queryKey).toEqual(queryKeys.visits.qr(id))
    expect(visitQrQueryOptions(id).staleTime).toBe(30 * 1000)
  })

  it('id null tetap menonaktifkan kedua query (tidak ada polling yatim)', () => {
    expect(visitDetailQueryOptions(null).enabled).toBe(false)
    expect(visitQrQueryOptions(null).enabled).toBe(false)
  })
})
