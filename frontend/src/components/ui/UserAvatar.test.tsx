// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import {
  AVATAR_OBJECT_URL,
  errorResponse,
  flushEffects,
  installAvatarFetchStubs,
  mockAvatarImage,
} from '@/test-utils/avatarFetch'

import { UserAvatar } from './UserAvatar'

const NAME = 'Budi Santoso'
const AVATAR_ID = '6f1c2f9a-0d3e-4a55-9a8a-0b1c2d3e4f50'
const AVATAR_PATH = `/api/v1/avatars/${AVATAR_ID}?v=1a2b3c4d`
const API_BASE = 'http://localhost:8080/api/v1'
const RESOLVED_URL = `${API_BASE}/avatars/${AVATAR_ID}?v=1a2b3c4d`
const OBJECT_URL = AVATAR_OBJECT_URL

function wrapperOf(container: HTMLElement): HTMLElement {
  const wrapper = container.querySelector('[data-avatar-state]')
  expect(wrapper).not.toBeNull()
  return wrapper as HTMLElement
}

let fetchMock: Mock<typeof fetch>
let createObjectURL: Mock<() => string>
let revokeObjectURL: Mock<(url: string) => void>

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', API_BASE)
  const stubs = installAvatarFetchStubs()
  fetchMock = stubs.fetchMock
  createObjectURL = stubs.createObjectURL
  revokeObjectURL = stubs.revokeObjectURL
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  window.localStorage.clear()
})

describe('UserAvatar', () => {
  it('menampilkan inisial selagi avatar dimuat', () => {
    fetchMock.mockReturnValue(new Promise<Response>(() => undefined))

    const { container } = render(<UserAvatar name={NAME} avatarUrl={AVATAR_PATH} />)
    const wrapper = wrapperOf(container)

    expect(wrapper).toHaveAttribute('data-avatar-state', 'initials')
    expect(wrapper.querySelector('img')).toBeNull()
    expect(wrapper.textContent).toBe('BS')
  })

  it('merender object URL blob dan menandai wrapper sebagai state image', async () => {
    mockAvatarImage(fetchMock)

    const { container } = render(<UserAvatar name={NAME} avatarUrl={AVATAR_PATH} />)

    await waitFor(() => {
      expect(wrapperOf(container)).toHaveAttribute('data-avatar-state', 'image')
    })

    const wrapper = wrapperOf(container)
    const img = wrapper.querySelector('img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe(OBJECT_URL)
    expect(img?.getAttribute('src')?.startsWith('blob:')).toBe(true)
    expect(img).toHaveAttribute('alt', '')
    expect(wrapper).toHaveAttribute('aria-hidden', 'true')
    expect(wrapper.textContent).toBe('')
  })

  it('meminta avatar ke API base dengan query ?v= dan header Authorization', async () => {
    window.localStorage.setItem('thc_vms_token', 'token-abc')
    mockAvatarImage(fetchMock)

    const { container } = render(<UserAvatar name={NAME} avatarUrl={AVATAR_PATH} />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    const call = fetchMock.mock.calls.at(0)
    expect(call).toBeDefined()

    const [calledUrl, init] = call ?? []
    expect(calledUrl).toBe(RESOLVED_URL)
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token-abc')
    expect(wrapperOf(container)).toHaveAttribute('data-avatar-state', 'image')
  })

  it('jatuh ke inisial tanpa melempar saat respons 404', async () => {
    fetchMock.mockResolvedValue(errorResponse(404))

    const { container } = render(<UserAvatar name={NAME} avatarUrl={AVATAR_PATH} />)
    await flushEffects()

    const wrapper = wrapperOf(container)
    expect(wrapper).toHaveAttribute('data-avatar-state', 'initials')
    expect(wrapper.querySelector('img')).toBeNull()
    expect(wrapper.textContent).toBe('BS')
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('jatuh ke inisial tanpa melempar saat request jaringan gagal', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    const { container } = render(<UserAvatar name={NAME} avatarUrl={AVATAR_PATH} />)
    await flushEffects()

    const wrapper = wrapperOf(container)
    expect(wrapper).toHaveAttribute('data-avatar-state', 'initials')
    expect(wrapper.querySelector('img')).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('melepas object URL saat komponen di-unmount', async () => {
    mockAvatarImage(fetchMock)

    const { container, unmount } = render(<UserAvatar name={NAME} avatarUrl={AVATAR_PATH} />)
    await waitFor(() => {
      expect(createObjectURL).toHaveBeenCalledTimes(1)
    })
    expect(wrapperOf(container)).toHaveAttribute('data-avatar-state', 'image')

    unmount()

    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith(OBJECT_URL)
  })

  it('tidak mengirim request sama sekali saat avatarUrl null/kosong/tidak diisi', () => {
    const withoutValue = render(<UserAvatar name={NAME} />)
    expect(wrapperOf(withoutValue.container)).toHaveAttribute('data-avatar-state', 'initials')
    withoutValue.unmount()

    const withNull = render(<UserAvatar name={NAME} avatarUrl={null} />)
    expect(wrapperOf(withNull.container)).toHaveAttribute('data-avatar-state', 'initials')
    expect(wrapperOf(withNull.container).textContent).toBe('BS')
    withNull.unmount()

    const withBlank = render(<UserAvatar name={NAME} avatarUrl="   " />)
    expect(wrapperOf(withBlank.container)).toHaveAttribute('data-avatar-state', 'initials')
    expect(wrapperOf(withBlank.container).textContent).toBe('BS')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('memetakan ukuran sm/md/lg dan nada onBrand ke kelas tema', () => {
    const sm = render(<UserAvatar name={NAME} size="sm" />)
    expect(wrapperOf(sm.container)).toHaveClass('size-8', 'text-badge')
    sm.unmount()

    const md = render(<UserAvatar name={NAME} />)
    expect(wrapperOf(md.container)).toHaveClass('size-10', 'text-sm', 'bg-brand', 'text-brand-contrast')
    md.unmount()

    const lg = render(<UserAvatar name={NAME} size="lg" />)
    expect(wrapperOf(lg.container)).toHaveClass('size-12', 'text-lg')
    lg.unmount()

    const onBrand = render(<UserAvatar name={NAME} tone="onBrand" />)
    expect(wrapperOf(onBrand.container)).toHaveClass('bg-brand-soft', 'text-brand')
    expect(wrapperOf(onBrand.container)).not.toHaveClass('bg-brand')
  })
})
