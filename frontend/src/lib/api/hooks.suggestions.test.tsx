// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import type { ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { User } from '@/lib/api/types'
import {
  useMemberSuggestionsQuery,
  useVendorSuggestionsQuery,
} from '@/lib/api/hooks'
import { SUGGESTION_QUERY_MAX_LENGTH } from '@/lib/visits/suggestions'

/**
 * Kontrak lapisan hook saran (T9/T11): debounce 300 ms, clamp ?q= 80 rune
 * (81 = 400 backend), dan gerbang peran yang menahan request untuk role yang
 * dijaga 403. Transport di-mock di sini; komponen form meng-mock hook ini
 * secara modul (lihat VisitForm.member-suggestions.test.tsx).
 */

const {
  listVendorSuggestionsMock,
  listMemberSuggestionsMock,
  getMemberSuggestionMock,
  sessionState,
} = vi.hoisted(() => ({
  listVendorSuggestionsMock: vi.fn<(q?: string) => Promise<unknown[]>>(),
  listMemberSuggestionsMock:
    vi.fn<(params: { q?: string; vendor?: string }) => Promise<unknown[]>>(),
  getMemberSuggestionMock: vi.fn<(visitorId: string) => Promise<unknown>>(),
  sessionState: {
    user: { id: 'adm-1', role: 'admin' } as Partial<User> | null,
  },
}))

vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/client')>()
  return {
    ...actual,
    listVendorSuggestions: listVendorSuggestionsMock,
    listMemberSuggestions: listMemberSuggestionsMock,
    getMemberSuggestion: getMemberSuggestionMock,
  }
})

vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({
    user: sessionState.user,
    status: 'authenticated',
  }),
}))

function createWrapper(): (props: { children: ReactNode }) => ReactNode {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
  return Wrapper
}

beforeEach(() => {
  vi.useFakeTimers()
  listVendorSuggestionsMock.mockReset().mockResolvedValue([])
  listMemberSuggestionsMock.mockReset().mockResolvedValue([])
  getMemberSuggestionMock.mockReset().mockResolvedValue({})
  sessionState.user = { id: 'adm-1', role: 'admin' }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useVendorSuggestionsQuery', () => {
  it('nilai awal langsung dikirim; ketikan berikutnya menunggu debounce 300 ms', async () => {
    const { rerender } = renderHook(({ q }: { q: string }) => useVendorSuggestionsQuery(q), {
      wrapper: createWrapper(),
      initialProps: { q: '' },
    })
    await act(async () => {})
    expect(listVendorSuggestionsMock).toHaveBeenCalledWith('')

    rerender({ q: 'bud' })
    await act(async () => {})
    expect(listVendorSuggestionsMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(listVendorSuggestionsMock).toHaveBeenCalledTimes(2)
    expect(listVendorSuggestionsMock).toHaveBeenLastCalledWith('bud')
  })

  it('q dipotong ke 80 karakter sebelum dikirim (81 ditolak backend)', async () => {
    const { rerender } = renderHook(({ q }: { q: string }) => useVendorSuggestionsQuery(q), {
      wrapper: createWrapper(),
      initialProps: { q: '' },
    })
    await act(async () => {})

    rerender({ q: 'a'.repeat(SUGGESTION_QUERY_MAX_LENGTH + 20) })
    await act(async () => {
      vi.advanceTimersByTime(300)
    })

    const sent = listVendorSuggestionsMock.mock.calls.at(-1)?.[0] ?? ''
    expect(sent).toHaveLength(SUGGESTION_QUERY_MAX_LENGTH)
  })

  it('peran vendor tidak pernah menembak endpoint yang dijaga 403', async () => {
    sessionState.user = { id: 'v-1', role: 'vendor' }
    renderHook(() => useVendorSuggestionsQuery('budi'), { wrapper: createWrapper() })
    await act(async () => {
      vi.advanceTimersByTime(600)
    })

    expect(listVendorSuggestionsMock).not.toHaveBeenCalled()
  })
})

describe('useMemberSuggestionsQuery', () => {
  it('meneruskan q apa adanya dan vendor hasil trim setelah debounce', async () => {
    renderHook(() => useMemberSuggestionsQuery({ q: 'budi', vendor: '  PT Lintas Fiber  ' }), { wrapper: createWrapper() })
    await act(async () => {
      vi.advanceTimersByTime(300)
    })

    expect(listMemberSuggestionsMock).toHaveBeenCalledWith({
      q: 'budi',
      vendor: 'PT Lintas Fiber',
    })
  })

  it('peran security tidak pernah menembak feed anggota (403 backend)', async () => {
    sessionState.user = { id: 'sec-1', role: 'security' }
    renderHook(() => useMemberSuggestionsQuery({ q: 'budi' }), { wrapper: createWrapper() })
    await act(async () => {
      vi.advanceTimersByTime(600)
    })

    expect(listMemberSuggestionsMock).not.toHaveBeenCalled()
  })
})
