// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { User } from '@/lib/api/types'
import { ApiError } from '@/lib/api/fetcher'

import { SessionProvider, useSession } from './session'
import { RequireAuth } from './guards'

const { loginMock, getMeMock, logoutMock, getTokenMock, clearTokenMock } = vi.hoisted(() => ({
  loginMock: vi.fn(),
  getMeMock: vi.fn(),
  logoutMock: vi.fn(),
  getTokenMock: vi.fn(),
  clearTokenMock: vi.fn(),
}))

const { routerReplaceMock } = vi.hoisted(() => ({ routerReplaceMock: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: routerReplaceMock }),
}))

vi.mock('@/lib/api/client', () => ({
  login: loginMock,
  getMe: getMeMock,
  logout: logoutMock,
}))

vi.mock('@/lib/auth/storage', () => ({
  getToken: getTokenMock,
  clearToken: clearTokenMock,
  setToken: vi.fn(),
}))

/** 10 menit — literal, bukan impor konstanta, agar tes gagal bila interval berubah. */
const TEN_MINUTES = 10 * 60 * 1000

const signInState: { result: User | null } = { result: null }
const applyState: { user: User | null } = { user: null }

function Consumer(): React.JSX.Element {
  const session = useSession()
  return (
    <div>
      <span data-testid="status">{session.status}</span>
      <span data-testid="email">{session.user?.email ?? 'none'}</span>
      <span data-testid="avatar">{session.user?.avatar_url ?? 'none'}</span>
      <button
        type="button"
        onClick={() => {
          void session.signIn('login@thc.id', 'secret').then((signedIn) => {
            signInState.result = signedIn
          })
        }}
      >
        Masuk
      </button>
      <button
        type="button"
        onClick={() => {
          if (applyState.user !== null) {
            session.applyUser(applyState.user)
          }
        }}
      >
        Terapkan
      </button>
    </div>
  )
}

function renderProvider() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <Consumer />
      </SessionProvider>
    </QueryClientProvider>,
  )
}

/** Harness integrasi sesi + guard: membuktikan redirect vs tidak redirect. */
function renderGuarded() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <RequireAuth>
          <span data-testid="protected">Area terlindungi</span>
        </RequireAuth>
      </SessionProvider>
    </QueryClientProvider>,
  )
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'u1',
    name: 'Budi Santoso',
    email: 'budi@thc.id',
    phone: '081234567890',
    nik: null,
    role: 'vendor',
    location_id: null,
    location_name: null,
    status: 'active',
    type: 'external',
    vendor_name: 'PT Uji',
    avatar_url: null,
    editable_fields: ['phone', 'avatar_url'],
    ...overrides,
  }
}

/** Flush microtask + timer tanpa menunggu jam dinding (aman untuk fake timers). */
async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

beforeEach(() => {
  loginMock.mockReset()
  getMeMock.mockReset()
  logoutMock.mockReset()
  getTokenMock.mockReset()
  clearTokenMock.mockReset()
  routerReplaceMock.mockReset()
  window.sessionStorage.clear()
  logoutMock.mockResolvedValue(undefined)
  getTokenMock.mockReturnValue(null)
  signInState.result = null
  applyState.user = null
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('SessionProvider — hidrasi & refresh periodik non-destruktif', () => {
  it('signIn menghidrasi ulang user dari /auth/me sehingga avatar presigned terisi tanpa reload', async () => {
    const loginUser = makeUser({ email: 'login@thc.id', avatar_url: '' })
    const meUser = makeUser({
      email: 'login@thc.id',
      avatar_url: 'https://storage.example/avatar.jpg?sig=abc',
    })
    loginMock.mockResolvedValue({ token: 'tok', user: loginUser })
    getMeMock.mockResolvedValue(meUser)

    renderProvider()

    // Mount effect berjalan tanpa token: unauthenticated dan TIDAK memanggil getMe.
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'),
    )
    expect(getMeMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Masuk' }))
    await waitFor(() => expect(signInState.result).toEqual(meUser))

    // Hasil signIn berasal dari /auth/me (bukan payload login yang avatar-nya kosong).
    expect(signInState.result).toEqual(meUser)
    expect(getMeMock).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('status')).toHaveTextContent('authenticated')
    expect(screen.getByTestId('avatar')).toHaveTextContent(
      'https://storage.example/avatar.jpg?sig=abc',
    )
  })

  it('kegagalan getMe setelah login sukses tidak mengakhiri sesi dan tidak menghapus token', async () => {
    const loginUser = makeUser({ email: 'login@thc.id', avatar_url: 'login-payload-avatar' })
    loginMock.mockResolvedValue({ token: 'tok', user: loginUser })
    getMeMock.mockRejectedValue(new Error('jaringan putus'))

    renderProvider()

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Masuk' }))
    await waitFor(() => expect(signInState.result).toEqual(loginUser))

    // Tetap login dengan payload login; signIn resolve tanpa melempar.
    expect(signInState.result).toEqual(loginUser)
    expect(screen.getByTestId('status')).toHaveTextContent('authenticated')
    expect(screen.getByTestId('email')).toHaveTextContent('login@thc.id')
    expect(screen.getByTestId('avatar')).toHaveTextContent('login-payload-avatar')
    expect(clearTokenMock).not.toHaveBeenCalled()
  })

  it('selama authenticated, /auth/me dipanggil ulang tiap 10 menit; tick gagal tidak mengubah state', async () => {
    vi.useFakeTimers()
    getTokenMock.mockReturnValue('tok')
    const staleUser = makeUser({ email: 'login@thc.id', avatar_url: 'old-url' })
    const freshUser = makeUser({ email: 'login@thc.id', avatar_url: 'fresh-url' })
    getMeMock.mockResolvedValueOnce(staleUser).mockResolvedValueOnce(freshUser)

    renderProvider()
    await flush()

    expect(screen.getByTestId('status')).toHaveTextContent('authenticated')
    expect(screen.getByTestId('avatar')).toHaveTextContent('old-url')
    expect(getMeMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TEN_MINUTES)
    })

    expect(getMeMock).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('avatar')).toHaveTextContent('fresh-url')
    expect(screen.getByTestId('status')).toHaveTextContent('authenticated')

    // Tick berikutnya gagal: user & status tidak berubah, token tidak dihapus.
    getMeMock.mockRejectedValueOnce(new Error('transien'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TEN_MINUTES)
    })

    expect(getMeMock).toHaveBeenCalledTimes(3)
    expect(screen.getByTestId('avatar')).toHaveTextContent('fresh-url')
    expect(screen.getByTestId('status')).toHaveTextContent('authenticated')
    expect(clearTokenMock).not.toHaveBeenCalled()
  })

  it('unmount membersihkan interval sehingga tidak ada getMe tambahan', async () => {
    vi.useFakeTimers()
    getTokenMock.mockReturnValue('tok')
    getMeMock.mockResolvedValue(makeUser())

    const { unmount } = renderProvider()
    await flush()
    expect(getMeMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TEN_MINUTES)
    })
    expect(getMeMock).toHaveBeenCalledTimes(2)

    unmount()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TEN_MINUTES * 2)
    })
    expect(getMeMock).toHaveBeenCalledTimes(2)
  })

  it('tidak ada interval saat unauthenticated', async () => {
    vi.useFakeTimers()
    getTokenMock.mockReturnValue(null)

    renderProvider()
    await flush()

    expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TEN_MINUTES * 3)
    })
    expect(getMeMock).not.toHaveBeenCalled()
  })
})

describe('SessionProvider — applyUser mengalahkan hidrasi /auth/me yang basi', () => {
  it('applyUser langsung memperbarui user di context tanpa menunggu /auth/me', async () => {
    const applied = makeUser({ avatar_url: 'applied-avatar' })
    applyState.user = applied

    renderProvider()
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'),
    )
    expect(screen.getByTestId('avatar')).toHaveTextContent('none')

    fireEvent.click(screen.getByRole('button', { name: 'Terapkan' }))

    expect(screen.getByTestId('avatar')).toHaveTextContent('applied-avatar')
    expect(screen.getByTestId('status')).toHaveTextContent('authenticated')
  })

  it('respons /auth/me lama yang selesai setelah applyUser tidak menimpa avatar baru', async () => {
    getTokenMock.mockReturnValue('tok')
    const staleUser = makeUser({ avatar_url: 'old-avatar' })
    const freshUser = makeUser({ avatar_url: 'new-avatar' })
    applyState.user = freshUser

    let resolveMe: ((value: User) => void) | undefined
    getMeMock.mockImplementation(
      () =>
        new Promise<User>((resolve) => {
          resolveMe = resolve
        }),
    )

    renderProvider()
    await waitFor(() => expect(getMeMock).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('status')).toHaveTextContent('loading')

    // PATCH /auth/me selesai lebih dulu dan menulis avatar baru.
    fireEvent.click(screen.getByRole('button', { name: 'Terapkan' }))
    expect(screen.getByTestId('avatar')).toHaveTextContent('new-avatar')

    // GET /auth/me yang dimulai sebelum PATCH baru selesai sekarang, membawa avatar lama.
    await act(async () => {
      resolveMe?.(staleUser)
      await Promise.resolve()
    })

    expect(screen.getByTestId('avatar')).toHaveTextContent('new-avatar')
    expect(screen.getByTestId('status')).toHaveTextContent('authenticated')
  })
})

describe('SessionProvider — hanya 401 yang mengakhiri sesi', () => {
  it('401 saat hidrasi awal menghapus token dan mengalihkan ke /login?expired=1', async () => {
    getTokenMock.mockReturnValue('tok')
    getMeMock.mockRejectedValue(new ApiError('Sesi habis', 401, 'UNAUTHORIZED'))

    renderGuarded()

    await waitFor(() =>
      expect(routerReplaceMock).toHaveBeenCalledWith('/login?expired=1'),
    )
    expect(clearTokenMock).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('protected')).toBeNull()
    // Flag sekali-pakai dikonsumsi guard, jadi tidak tertinggal di storage.
    expect(window.sessionStorage.getItem('thc_vms_expired')).toBeNull()
  })

  const transientFailures: Array<[string, ApiError]> = [
    [
      'koneksi gagal (tanpa respons HTTP)',
      new ApiError('Tidak dapat terhubung ke server.', 0, 'NETWORK_ERROR'),
    ],
    ['rate limit 429', new ApiError('Terlalu banyak permintaan.', 429, 'RATE_LIMITED')],
    ['gangguan server 500', new ApiError('Gangguan pada server.', 500, 'HTTP_ERROR')],
  ]

  it.each(transientFailures)(
    '%s saat hidrasi awal mempertahankan token, tanpa redirect, dan menampilkan coba lagi',
    async (_label, error) => {
      getTokenMock.mockReturnValue('tok')
      getMeMock.mockRejectedValue(error)

      renderGuarded()

      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Coba Lagi' })).toBeInTheDocument(),
      )
      expect(routerReplaceMock).not.toHaveBeenCalled()
      expect(clearTokenMock).not.toHaveBeenCalled()
      expect(screen.queryByTestId('protected')).toBeNull()
    },
  )

  it('coba lagi setelah gangguan sementara memulihkan sesi tanpa login ulang', async () => {
    getTokenMock.mockReturnValue('tok')
    getMeMock.mockRejectedValueOnce(
      new ApiError('Gangguan pada server.', 500, 'HTTP_ERROR'),
    )

    renderGuarded()

    const retry = await screen.findByRole('button', { name: 'Coba Lagi' })
    getMeMock.mockResolvedValueOnce(makeUser({ email: 'budi@thc.id' }))
    fireEvent.click(retry)

    await waitFor(() =>
      expect(screen.getByTestId('protected')).toBeInTheDocument(),
    )
    expect(clearTokenMock).not.toHaveBeenCalled()
    expect(routerReplaceMock).not.toHaveBeenCalled()
  })
})
