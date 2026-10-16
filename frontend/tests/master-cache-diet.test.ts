import { describe, expect, it } from 'vitest'

import {
  locationsQueryOptions,
  meQueryOptions,
  purposesQueryOptions,
  visitsQueryOptions,
  vendorsQueryOptions,
} from '@/lib/api/hooks'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Kontrak cache master data (diet data S5): lokasi, tujuan, dan katalog
 * vendor memakai staleTime Infinity + gcTime 24 jam agar N petugas pos
 * tidak menuju API dengan permintaan identik. Query operasional (daftar
 * kunjungan) TIDAK ikut Infinity — staleTime 30 detik dinyatakan eksplisit.
 */
describe('master data — staleTime Infinity + gcTime 24 jam', () => {
  it('locationsQueryOptions memakai staleTime Infinity + gcTime 24 jam', () => {
    const options = locationsQueryOptions()
    expect(options.staleTime).toBe(Number.POSITIVE_INFINITY)
    expect(options.gcTime).toBe(DAY_MS)
  })

  // purposesQueryOptions & vendorsQueryOptions adalah objek konstanta (bukan
  // factory), berbeda dengan locationsQueryOptions yang bergantung pada param.
  it('purposesQueryOptions memakai staleTime Infinity + gcTime 24 jam', () => {
    expect(purposesQueryOptions.staleTime).toBe(Number.POSITIVE_INFINITY)
    expect(purposesQueryOptions.gcTime).toBe(DAY_MS)
  })

  it('vendorsQueryOptions memakai staleTime Infinity + gcTime 24 jam', () => {
    expect(vendorsQueryOptions.staleTime).toBe(Number.POSITIVE_INFINITY)
    expect(vendorsQueryOptions.gcTime).toBe(DAY_MS)
  })
})

describe('query operasional TIDAK ikut Infinity (staleTime 30 detik eksplisit)', () => {
  it('visitsQueryOptions daftar kunjungan tetap staleTime 30 detik', () => {
    expect(visitsQueryOptions({}).staleTime).toBe(30_000)
  })
})

describe('me-query tak tersentuh (semantik baseline)', () => {
  it('meQueryOptions staleTime 0 + retry false (validasi identitas tiap mount)', () => {
    expect(meQueryOptions.staleTime).toBe(0)
    expect(meQueryOptions.retry).toBe(false)
  })
})
