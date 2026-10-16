import { afterEach, describe, expect, it, vi } from 'vitest'

import { visitDetailQueryOptions, visitQrQueryOptions } from '@/lib/api/hooks'
import { queryKeys } from '@/lib/api/query-keys'
import type { VisitStatus } from '@/lib/api/types'

/**
 * Kontrak pembaruan mandiri SCR-04 (diet data/baterai S5):
 * - Polling HANYA saat tab terlihat dan status masih bergerak:
 *   `approved` → 60 detik, `visiting` → 30 detik (jendela check-out gerbang).
 * - Polling BERHENTI (`false`) saat tab tersembunyi (`document.hidden`),
 *   status terminal (completed/cancelled/rejected/not_visit), `requested`,
 *   `rescheduled`, atau data belum termuat.
 * - `refetchOnWindowFocus` DIHAPUS dari opsi (fokus tak lagi memicu refetch).
 */

const ALL_STATUSES: VisitStatus[] = [
  'requested',
  'approved',
  'visiting',
  'completed',
  'not_visit',
  'rejected',
  'cancelled',
  'rescheduled',
]
const POLLING_STATUSES: VisitStatus[] = ['approved', 'visiting']
const NON_POLLING_STATUSES = ALL_STATUSES.filter(
  (status) => !POLLING_STATUSES.includes(status),
)

type DetailInterval = (query: {
  state: { data?: { status: VisitStatus } }
}) => number | false
type PlainInterval = () => number | false

function asDetailInterval(options: { refetchInterval?: unknown }): DetailInterval {
  if (typeof options.refetchInterval !== 'function') {
    throw new Error('refetchInterval detail harus berupa fungsi, bukan angka statis')
  }
  return options.refetchInterval as DetailInterval
}

function asPlainInterval(options: { refetchInterval?: unknown }): PlainInterval {
  if (typeof options.refetchInterval !== 'function') {
    throw new Error('refetchInterval QR harus berupa fungsi, bukan angka statis')
  }
  return options.refetchInterval as PlainInterval
}

function detailIntervalFor(status: VisitStatus): number | false {
  return asDetailInterval(visitDetailQueryOptions('visit-123'))({
    state: { data: { status } },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('interval polling detail kunjungan — approved 60 dtk / visiting 30 dtk', () => {
  const id = 'visit-123'

  it('polling 60 detik saat status approved dan tab terlihat', () => {
    expect(detailIntervalFor('approved')).toBe(60_000)
  })

  it('polling 30 detik saat status visiting (jendela check-out gerbang)', () => {
    expect(detailIntervalFor('visiting')).toBe(30_000)
  })

  it('polling BERHENTI untuk status terminal, requested, dan rescheduled', () => {
    for (const status of NON_POLLING_STATUSES) {
      expect(detailIntervalFor(status)).toBe(false)
    }
  })

  it('polling BERHENTI saat data belum termuat (status tak diketahui)', () => {
    expect(
      asDetailInterval(visitDetailQueryOptions(id))({ state: {} }),
    ).toBe(false)
  })

  it('polling BERHENTI saat tab tersembunyi (document.hidden) — approved & visiting', () => {
    vi.stubGlobal('document', { hidden: true })
    expect(detailIntervalFor('approved')).toBe(false)
    expect(detailIntervalFor('visiting')).toBe(false)
  })

  it('refetchOnWindowFocus DIHAPUS (tak ada lagi refetch saat fokus)', () => {
    expect(visitDetailQueryOptions(id).refetchOnWindowFocus).toBeUndefined()
  })

  it('refetchIntervalInBackground tetap false', () => {
    expect(visitDetailQueryOptions(id).refetchIntervalInBackground).toBe(false)
  })
})

describe('interval polling QR — mengikuti status kunjungan', () => {
  const id = 'visit-123'

  it('polling 60 detik saat status approved dan tab terlihat', () => {
    expect(asPlainInterval(visitQrQueryOptions(id, 'approved'))()).toBe(60_000)
  })

  it('polling 30 detik saat status visiting (QR yang sama dipakai check-out)', () => {
    expect(asPlainInterval(visitQrQueryOptions(id, 'visiting'))()).toBe(30_000)
  })

  it('polling BERHENTI untuk status terminal, requested, dan rescheduled', () => {
    for (const status of NON_POLLING_STATUSES) {
      expect(asPlainInterval(visitQrQueryOptions(id, status))()).toBe(false)
    }
  })

  it('polling BERHENTI saat status tak diberikan (fail-closed)', () => {
    expect(asPlainInterval(visitQrQueryOptions(id))()).toBe(false)
  })

  it('polling BERHENTI saat tab tersembunyi (document.hidden) — approved & visiting', () => {
    vi.stubGlobal('document', { hidden: true })
    expect(asPlainInterval(visitQrQueryOptions(id, 'approved'))()).toBe(false)
    expect(asPlainInterval(visitQrQueryOptions(id, 'visiting'))()).toBe(false)
  })

  it('refetchOnWindowFocus DIHAPUS (tak ada lagi refetch saat fokus)', () => {
    expect(visitQrQueryOptions(id).refetchOnWindowFocus).toBeUndefined()
  })

  it('refetchIntervalInBackground tetap false', () => {
    expect(visitQrQueryOptions(id).refetchIntervalInBackground).toBe(false)
  })
})

describe('kunci cache & staleTime tak berubah (invalidasi lama tetap berlaku)', () => {
  const id = 'visit-123'

  it('queryKey & staleTime detail/QR identik dengan baseline', () => {
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
