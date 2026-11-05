// @vitest-environment jsdom
/**
 * Kontrak polling terlingkup daftar kunjungan + notifikasi (tanpa websocket):
 * - visitsQueryOptions: default `refetchInterval` 30 dtk + `refetchOnWindowFocus`
 *   true + `refetchIntervalInBackground` false — mencakup dashboard,
 *   approvals, badge usePendingApprovalCount (kunci status-param berbeda, jadi
 *   tidak ada timer ganda pada satu kunci), dan prefill VisitForm.
 * - Tier kios gerbang: OPT-IN 15 dtk HANYA untuk 3 query /gate (params gerbang
 *   tidak pernah ter-mount bersamaan dengan pemilik 30 dtk pada kunci yang
 *   sama — halaman berbeda/role berbeda — jadi tidak ada timer ganda).
 * - Resolver tiket /qr (`{ limit: 50 }` + includes): interval BERSYARAT via
 *   `qrResolverRefetchInterval` — poll 30 dtk selama unresolved
 *   (requested/rescheduled/kosong), stop (false) begitu tiket aktif terpilih
 *   atau semua baris terminal; satu kunci + satu owner sehingga tidak ada
 *   timer ganda.
 * - notificationsQueryOptions (badge unread) + useNotificationsFeed (panel
 *   lonceng): interval 30 dtk tetap + `refetchOnWindowFocus` true +
 *   background false; feed `enabled=open` (panel-terbuka saja).
 * - Master data (locations/purposes/vendors/jabatan): TANPA interval polling.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'

const capturedFeed = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
}))

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useInfiniteQuery: ((
      options: unknown,
    ): never => {
      capturedFeed.options = options as Record<string, unknown>
      return { data: undefined } as never
    }) as typeof actual.useInfiniteQuery,
  }
})

import {
  jabatanQueryOptions,
  locationsQueryOptions,
  notificationsQueryOptions,
  purposesQueryOptions,
  qrResolverRefetchInterval,
  useNotificationsFeed,
  vendorsQueryOptions,
  visitsQueryOptions,
} from '@/lib/api/hooks'
import type { VisitDetail } from '@/lib/api/types'

afterEach(() => {
  cleanup()
  capturedFeed.options = null
})

describe('visitsQueryOptions — polling terlingkup 30 dtk + focus', () => {
  it('refetchInterval 30 dtk dengan staleTime 30 dtk tetap', () => {
    const options = visitsQueryOptions({})
    expect(options.refetchInterval).toBe(30_000)
    expect(options.staleTime).toBe(30_000)
  })

  it('refetchOnWindowFocus true dan background tab tetap diam', () => {
    const options = visitsQueryOptions({})
    expect(options.refetchOnWindowFocus).toBe(true)
    expect(options.refetchIntervalInBackground).toBe(false)
  })

  it('cabang status-param berbeda memakai kunci berbeda (tanpa timer ganda per kunci)', () => {
    const requested = visitsQueryOptions({ status: 'requested', limit: 1 })
    const rescheduled = visitsQueryOptions({ status: 'rescheduled', limit: 1 })
    expect(requested.queryKey).not.toEqual(rescheduled.queryKey)
    expect(requested.refetchInterval).toBe(30_000)
    expect(rescheduled.refetchInterval).toBe(30_000)
  })

  it('badge pending (limit:1) tetap pada tier default 30 dtk', () => {
    expect(visitsQueryOptions({ status: 'requested', limit: 1 }).refetchInterval).toBe(30_000)
    expect(visitsQueryOptions({ status: 'rescheduled', limit: 1 }).refetchInterval).toBe(30_000)
  })
})

describe('visitsQueryOptions — tier kios gerbang 15 dtk (opt-in)', () => {
  it('override 15 dtk eksplisit untuk query gerbang', () => {
    const options = visitsQueryOptions({ status: 'approved', page: 1, limit: 10 }, 15_000)
    expect(options.refetchInterval).toBe(15_000)
    expect(options.staleTime).toBe(30_000)
  })

  it('tier gerbang tetap: background diam + focus menyegarkan', () => {
    const options = visitsQueryOptions({ status: 'visiting', page: 1, limit: 100 }, 15_000)
    expect(options.refetchOnWindowFocus).toBe(true)
    expect(options.refetchIntervalInBackground).toBe(false)
  })
})

describe('visitsQueryOptions — resolver /qr conditional polling', () => {
  /**
   * PILIHAN DESAIN (didokumentasikan): conditional interval pada kunci resolver
   * yang SAMA (`{ limit: 50 }`, satu owner — halaman /qr tidak pernah
   * ter-mount bersama pemilik lain), BUKAN probe ringan limit:1 terpisah.
   * Alasan: satu observer = satu timer (React Query v5), jadi membalik nilai
   * interval 30_000 ↔ false tidak pernah menciptakan timer ganda; probe
   * terpisah justru menambah kunci + owner + invalidasi baru. Poll hanya saat
   * unresolved (requested/rescheduled/kosong/error→items kosong) agar approval
   * yang mendarat auto-advance ±30 dtk seperti baseline; stop (false) begitu
   * tiket aktif terpilih atau semua baris terminal.
   */
  const visit = (status: VisitDetail['status']): VisitDetail =>
    ({ id: `id-${status}`, status }) as VisitDetail

  it('unresolved (requested/rescheduled) → poll 30 dtk', () => {
    expect(qrResolverRefetchInterval([visit('requested')])).toBe(30_000)
    expect(qrResolverRefetchInterval([visit('rescheduled')])).toBe(30_000)
    expect(
      qrResolverRefetchInterval([visit('completed'), visit('requested')]),
    ).toBe(30_000)
  })

  it('belum ada kunjungan / error (items kosong) → poll 30 dtk', () => {
    expect(qrResolverRefetchInterval([])).toBe(30_000)
  })

  it('resolved (approved/visiting terpilih) → stop (false)', () => {
    expect(qrResolverRefetchInterval([visit('approved')])).toBe(false)
    expect(qrResolverRefetchInterval([visit('visiting')])).toBe(false)
    expect(
      qrResolverRefetchInterval([visit('requested'), visit('approved')]),
    ).toBe(false)
  })

  it('semua terminal (tanpa requested/rescheduled/aktif) → stop (false)', () => {
    expect(
      qrResolverRefetchInterval([visit('completed'), visit('rejected')]),
    ).toBe(false)
    expect(
      qrResolverRefetchInterval([visit('cancelled'), visit('not_visit')]),
    ).toBe(false)
  })

  it('satu kunci resolver untuk semua kondisi (tanpa double owner)', () => {
    expect(visitsQueryOptions({ limit: 50 }).queryKey).toEqual(
      visitsQueryOptions({ limit: 50 }, false).queryKey,
    )
  })
})

describe('notifikasi — badge + feed ikut polling 30 dtk + focus', () => {
  it('notificationsQueryOptions: interval 30 dtk + focus true + background false', () => {
    const options = notificationsQueryOptions()
    expect(options.refetchInterval).toBe(30_000)
    expect(options.refetchOnWindowFocus).toBe(true)
    expect(options.refetchIntervalInBackground).toBe(false)
    expect(options.staleTime).toBe(30_000)
  })

  it('useNotificationsFeed: interval 30 dtk + focus true + background false', () => {
    renderHook(() => useNotificationsFeed(true))
    expect(capturedFeed.options?.['refetchInterval']).toBe(30_000)
    expect(capturedFeed.options?.['refetchOnWindowFocus']).toBe(true)
    expect(capturedFeed.options?.['refetchIntervalInBackground']).toBe(false)
  })

  it('useNotificationsFeed meneruskan enabled panel (tertutup = tanpa polling latar)', () => {
    renderHook(() => useNotificationsFeed(false))
    expect(capturedFeed.options?.['enabled']).toBe(false)
    renderHook(() => useNotificationsFeed(true))
    expect(capturedFeed.options?.['enabled']).toBe(true)
  })
})

describe('master data — TANPA interval polling', () => {
  it('locations/purposes/vendors/jabatan tidak memasang refetchInterval', () => {
    expect(locationsQueryOptions().refetchInterval).toBeUndefined()
    expect(purposesQueryOptions.refetchInterval).toBeUndefined()
    expect(vendorsQueryOptions.refetchInterval).toBeUndefined()
    expect(jabatanQueryOptions.refetchInterval).toBeUndefined()
  })
})
