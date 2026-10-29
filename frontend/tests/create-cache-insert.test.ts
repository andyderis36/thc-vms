// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createLocation, createSecurityUser } from '@/lib/api/client'
import {
  useCreateLocationMutation,
  useCreateSecurityUserMutation,
} from '@/lib/api/hooks'
import { queryKeys } from '@/lib/api/query-keys'
import type { Location, User } from '@/lib/api/types'

/**
 * Kontrak pasca-create: baris baru ditulis ke cache daftar yang sudah dimuat
 * (tanpa menunggu refetch), diganti — bukan diduplikasi — bila id-nya sudah
 * ada, dan prefix cache lain tidak tersentuh.
 */

vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/client')>()
  return {
    ...actual,
    createLocation: vi.fn(),
    createSecurityUser: vi.fn(),
  }
})

const existingLocation: Location = {
  id: 'loc-lama',
  name: 'Kantor Cabang Lama',
  type: 'cabang',
  address: 'Jl. Lama No. 1',
  city: 'Pontianak',
  timezone: 'WIB',
  is_active: true,
}

const createdLocation: Location = {
  id: 'loc-baru',
  name: 'Kantor Cabang Sambas',
  type: 'cabang',
  address: 'Jl. Sukaramai No. 12',
  city: 'Sambas',
  timezone: 'WIB',
  is_active: true,
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-baru',
    name: 'Petugas Baru',
    email: 'petugas.baru@thc.test',
    phone: '081200000099',
    nik: null,
    role: 'security',
    location_id: 'loc-a',
    location_name: 'Kantor Cabang A',
    status: 'active',
    type: 'internal',
    vendor_name: null,
    avatar_url: null,
    ...overrides,
  }
}

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }): ReactNode {
    return createElement(QueryClientProvider, { client }, children)
  }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('useCreateLocationMutation — fasilitas baru langsung masuk cache', () => {
  it('menyisipkan fasilitas baru ke cache daftar penuh (active_only=false)', async () => {
    const client = makeClient()
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries')
    client.setQueryData(queryKeys.locations(false), [existingLocation])
    vi.mocked(createLocation).mockResolvedValue(createdLocation)

    const { result } = renderHook(() => useCreateLocationMutation(), {
      wrapper: wrapperFor(client),
    })
    await result.current.mutateAsync({ body: { name: 'Kantor Cabang Sambas', type: 'cabang' } })

    expect(createLocation).toHaveBeenCalledWith({ name: 'Kantor Cabang Sambas', type: 'cabang' })
    const rows = client.getQueryData<Location[]>(queryKeys.locations(false))
    expect(rows?.map((row) => row.id)).toEqual(['loc-baru', 'loc-lama'])
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.locations().slice(0, 1) })
  })

  it('mengganti entri ber-id sama alih-alih menduplikasinya', async () => {
    const client = makeClient()
    client.setQueryData(queryKeys.locations(false), [
      { ...createdLocation, name: 'Nama Basi' },
      existingLocation,
    ])
    vi.mocked(createLocation).mockResolvedValue(createdLocation)

    const { result } = renderHook(() => useCreateLocationMutation(), {
      wrapper: wrapperFor(client),
    })
    await result.current.mutateAsync({ body: { name: 'Kantor Cabang Sambas', type: 'cabang' } })

    const rows = client.getQueryData<Location[]>(queryKeys.locations(false)) ?? []
    expect(rows).toHaveLength(2)
    expect(rows.filter((row) => row.id === createdLocation.id)).toHaveLength(1)
    expect(rows[0]).toEqual(createdLocation)
  })

  it('tidak menaruh fasilitas nonaktif di varian katalog aktif', async () => {
    const client = makeClient()
    const inactive: Location = { ...createdLocation, is_active: false }
    client.setQueryData(queryKeys.locations(false), [existingLocation])
    client.setQueryData(queryKeys.locations(), [existingLocation])
    client.setQueryData(queryKeys.locations(true), [existingLocation])
    vi.mocked(createLocation).mockResolvedValue(inactive)

    const { result } = renderHook(() => useCreateLocationMutation(), {
      wrapper: wrapperFor(client),
    })
    await result.current.mutateAsync({ body: { name: inactive.name, type: 'cabang' } })

    const full = client.getQueryData<Location[]>(queryKeys.locations(false)) ?? []
    const activeDefault = client.getQueryData<Location[]>(queryKeys.locations()) ?? []
    const activeOnly = client.getQueryData<Location[]>(queryKeys.locations(true)) ?? []
    expect(full.map((row) => row.id)).toEqual(['loc-baru', 'loc-lama'])
    expect(activeDefault.map((row) => row.id)).toEqual(['loc-lama'])
    expect(activeOnly.map((row) => row.id)).toEqual(['loc-lama'])
  })

  it('tidak menyentuh cache prefix lain', async () => {
    const client = makeClient()
    client.setQueryData(queryKeys.locations(false), [existingLocation])
    const purposes = [{ id: 'purpose-1', name: 'Maintenance' }]
    const securityUsers = [makeUser()]
    client.setQueryData(queryKeys.purposes(), purposes)
    client.setQueryData(queryKeys.securityUsers('loc-a'), securityUsers)
    vi.mocked(createLocation).mockResolvedValue(createdLocation)

    const { result } = renderHook(() => useCreateLocationMutation(), {
      wrapper: wrapperFor(client),
    })
    await result.current.mutateAsync({ body: { name: createdLocation.name, type: 'cabang' } })

    expect(client.getQueryData(queryKeys.purposes())).toEqual(purposes)
    expect(client.getQueryData(queryKeys.securityUsers('loc-a'))).toEqual(securityUsers)
  })
})

describe('useCreateSecurityUserMutation — pengawas baru langsung masuk cache cabangnya', () => {
  const createdSecurityUser = makeUser()

  it('menyisipkan ke cache cabang yang sama dan daftar global, bukan cabang lain', async () => {
    const client = makeClient()
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries')
    const sameBranch = [makeUser({ id: 'user-lama', name: 'Petugas Lama' })]
    const otherBranch = [makeUser({ id: 'user-b', location_id: 'loc-b', location_name: 'Cabang B' })]
    const globalList = [...sameBranch, ...otherBranch]
    client.setQueryData(queryKeys.securityUsers('loc-a'), sameBranch)
    client.setQueryData(queryKeys.securityUsers('loc-b'), otherBranch)
    client.setQueryData(queryKeys.securityUsers(), globalList)
    vi.mocked(createSecurityUser).mockResolvedValue(createdSecurityUser)

    const { result } = renderHook(() => useCreateSecurityUserMutation(), {
      wrapper: wrapperFor(client),
    })
    await result.current.mutateAsync({
      body: { name: createdSecurityUser.name, email: createdSecurityUser.email, password: 'rahasia123' },
    })

    expect(client.getQueryData<User[]>(queryKeys.securityUsers('loc-a'))?.map((row) => row.id)).toEqual([
      'user-baru',
      'user-lama',
    ])
    expect(client.getQueryData<User[]>(queryKeys.securityUsers('loc-b'))).toEqual(otherBranch)
    expect(client.getQueryData<User[]>(queryKeys.securityUsers())?.map((row) => row.id)).toEqual([
      'user-baru',
      'user-lama',
      'user-b',
    ])
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.securityUsers().slice(0, 1),
    })
  })

  it('mengganti entri ber-id sama pada cache cabang dan global tanpa duplikat', async () => {
    const client = makeClient()
    const stale = makeUser({ id: createdSecurityUser.id, name: 'Nama Lama' })
    client.setQueryData(queryKeys.securityUsers('loc-a'), [stale, makeUser({ id: 'user-lama' })])
    client.setQueryData(queryKeys.securityUsers(), [stale])
    vi.mocked(createSecurityUser).mockResolvedValue(createdSecurityUser)

    const { result } = renderHook(() => useCreateSecurityUserMutation(), {
      wrapper: wrapperFor(client),
    })
    await result.current.mutateAsync({
      body: { name: createdSecurityUser.name, email: createdSecurityUser.email, password: 'rahasia123' },
    })

    const branchRows = client.getQueryData<User[]>(queryKeys.securityUsers('loc-a')) ?? []
    const globalRows = client.getQueryData<User[]>(queryKeys.securityUsers()) ?? []
    expect(branchRows).toHaveLength(2)
    expect(branchRows.filter((row) => row.id === createdSecurityUser.id)).toHaveLength(1)
    expect(branchRows[0]).toEqual(createdSecurityUser)
    expect(globalRows).toEqual([createdSecurityUser])
  })

  it('tidak menyentuh cache prefix lain', async () => {
    const client = makeClient()
    client.setQueryData(queryKeys.securityUsers('loc-a'), [])
    const locations = [existingLocation]
    client.setQueryData(queryKeys.locations(false), locations)
    vi.mocked(createSecurityUser).mockResolvedValue(createdSecurityUser)

    const { result } = renderHook(() => useCreateSecurityUserMutation(), {
      wrapper: wrapperFor(client),
    })
    await result.current.mutateAsync({
      body: { name: createdSecurityUser.name, email: createdSecurityUser.email, password: 'rahasia123' },
    })

    expect(client.getQueryData(queryKeys.locations(false))).toEqual(locations)
  })
})
