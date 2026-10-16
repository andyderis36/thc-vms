import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

// providers.tsx memuat <Toaster> sonner yang tidak diuji di sini.
vi.mock('sonner', () => ({ Toaster: () => null }))

import { makeQueryClient } from '@/app/providers'
import { ApiError } from '@/lib/api/fetcher'
import { visitsQueryOptions } from '@/lib/api/hooks'

/**
 * Kontrak ketahanan jaringan buruk (S5):
 * - Query default `retry: 2` — koneksi seluler putus-putus diberi dua
 *   kesempatan ulang sebelum menyerah.
 * - `retryDelay` eksponensial (1 dtk → 2 → 4 …) dibatasi 30 detik.
 * - Mutasi POST TIDAK pernah diulang otomatis (retry 0 — sudah benar, tetap).
 * - `networkMode: 'online'` dieksplisitkan pada query & mutasi.
 * - Persistensi cache ditunda: paket resmi TanStack persist belum terpasang.
 */

const MAX_RETRY_DELAY_MS = 30_000

type RetryDelayFn = (retryAttempt: number, error: unknown) => number
type RetryFn = (failureCount: number, error: unknown) => boolean

function asRetryDelayFn(value: unknown): RetryDelayFn {
  if (typeof value !== 'function') {
    throw new Error('retryDelay harus berupa fungsi backoff eksponensial')
  }
  return value as RetryDelayFn
}

function asRetryFn(value: unknown): RetryFn {
  if (typeof value !== 'function') {
    throw new Error('retry query operasional harus berupa fungsi kebijakan')
  }
  return value as RetryFn
}

describe('ketahanan jaringan buruk — retry & backoff query', () => {
  const queries = makeQueryClient().getDefaultOptions().queries

  it('query default dicoba ulang 2 kali', () => {
    expect(queries?.retry).toBe(2)
  })

  it('retryDelay eksponensial 1 dtk → 2 → 4 → 8, dibatasi 30 detik', () => {
    const delay = asRetryDelayFn(queries?.retryDelay)
    expect(delay(0, new Error('jaringan putus'))).toBe(1000)
    expect(delay(1, new Error('jaringan putus'))).toBe(2000)
    expect(delay(2, new Error('jaringan putus'))).toBe(4000)
    expect(delay(3, new Error('jaringan putus'))).toBe(8000)
    expect(delay(10, new Error('jaringan putus'))).toBe(MAX_RETRY_DELAY_MS)
  })

  it('networkMode query eksplisit "online"', () => {
    expect(queries?.networkMode).toBe('online')
  })
})

describe('mutasi POST tidak pernah diulang otomatis', () => {
  const mutations = makeQueryClient().getDefaultOptions().mutations

  it('retry mutasi tetap no-retry (nilai ini sudah benar sejak awal)', () => {
    expect(mutations?.retry).toBe(0)
  })

  it('networkMode mutasi eksplisit "online"', () => {
    expect(mutations?.networkMode).toBe('online')
  })
})

describe('query operasional selaras dengan retry 2', () => {
  it('mencoba ulang saat failureCount 0 & 1, berhenti di 2', () => {
    const retry = asRetryFn(visitsQueryOptions({}).retry)
    expect(retry(0, new Error('jaringan putus'))).toBe(true)
    expect(retry(1, new Error('jaringan putus'))).toBe(true)
    expect(retry(2, new Error('jaringan putus'))).toBe(false)
  })

  it('galat definitif 401/403/404 tidak pernah dicoba ulang', () => {
    const retry = asRetryFn(visitsQueryOptions({}).retry)
    for (const status of [401, 403, 404]) {
      expect(retry(0, new ApiError('definitif', status, 'HTTP_ERROR'))).toBe(false)
    }
  })
})

describe('persistensi cache ditunda (paket resmi belum terpasang)', () => {
  it('package.json tanpa paket persist TanStack Query', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies }
    expect(deps['@tanstack/react-query-persist-client']).toBeUndefined()
    expect(deps['@tanstack/query-persist-client-core']).toBeUndefined()
    expect(deps['@tanstack/query-sync-storage-persister']).toBeUndefined()
  })
})
