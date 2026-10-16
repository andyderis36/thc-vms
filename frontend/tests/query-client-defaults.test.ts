import { describe, expect, it, vi } from 'vitest'

// providers.tsx juga memuat <Toaster> sonner yang tidak diuji di sini.
vi.mock('sonner', () => ({ Toaster: () => null }))

import { makeQueryClient } from '@/app/providers'

/**
 * Kontrak default cache global (diet data S5):
 * - `refetchOnWindowFocus: false` — kembali fokus tidak lagi memicu refetch
 *   (reaksi terhadap fokus dihapus dari lapisan global).
 * - `staleTime: Infinity` — data master (lokasi/purposes/vendor) tak pernah
 *   dianggap basi; query operasional menyetor staleTime 30 detik sendiri.
 * - `gcTime: 24 jam` — cache dipertahankan sehari penuh.
 * - `retry: 2` (query, backoff eksponensial cap 30 dtk) & `retry: 0` (mutasi, no-retry).
 */
describe('makeQueryClient — default cache global', () => {
  const client = makeQueryClient()
  const queries = client.getDefaultOptions().queries
  const mutations = client.getDefaultOptions().mutations

  it('refetchOnWindowFocus global DIMATIKAN (diet fokus)', () => {
    expect(queries?.refetchOnWindowFocus).toBe(false)
  })

  it('refetchOnReconnect tetap aktif (pemulihan jaringan menyegarkan data)', () => {
    expect(queries?.refetchOnReconnect).toBe(true)
  })

  it('staleTime default Infinity (master data tanpa override)', () => {
    expect(queries?.staleTime).toBe(Number.POSITIVE_INFINITY)
  })

  it('gcTime default 24 jam', () => {
    expect(queries?.gcTime).toBe(24 * 60 * 60 * 1000)
  })

  it('retry query 2 & mutasi 0 (POST tidak pernah diulang)', () => {
    expect(queries?.retry).toBe(2)
    expect(mutations?.retry).toBe(0)
  })
})
