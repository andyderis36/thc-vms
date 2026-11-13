// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import {
  AVATAR_OBJECT_URL,
  errorResponse,
  flushEffects,
  installAvatarFetchStubs,
  mockAvatarImage,
} from '@/test-utils/avatarFetch'

import { ProfileMenu, type ProfileMenuUser } from './ProfileMenu'

const USER: ProfileMenuUser = { name: 'Budi Santoso', role: 'Admin Cabang' }

let fetchMock: Mock<typeof fetch>

beforeEach(() => {
  fetchMock = installAvatarFetchStubs().fetchMock
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderMenu(overrides: Partial<Parameters<typeof ProfileMenu>[0]> = {}) {
  const onLogout = vi.fn()
  const result = render(<ProfileMenu user={USER} onLogout={onLogout} {...overrides} />)
  return { onLogout, ...result }
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: /Akun Budi Santoso/ }))
}

describe('ProfileMenu', () => {
  it('memicu avatar menampilkan inisial dan membuka panel menu saat diklik', () => {
    renderMenu()
    const trigger = screen.getByRole('button', { name: /Akun Budi Santoso/ })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    openMenu()

    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Keluar' })).toBeInTheDocument()
  })

  it('memanggil onLogout dan menutup panel saat item Keluar diklik', () => {
    const { onLogout } = renderMenu()
    openMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Keluar' }))

    expect(onLogout).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('menampilkan item Profil sebagai tautan ke /profile SEBELUM item Keluar', () => {
    renderMenu()
    openMenu()

    const profil = screen.getByRole('menuitem', { name: 'Profil' })
    expect(profil.tagName).toBe('A')
    expect(profil).toHaveAttribute('href', '/profile')

    const menuItems = screen.getAllByRole('menuitem').map((item) => item.textContent?.trim())
    expect(menuItems).toEqual(['Profil', 'Keluar'])
    expect(screen.getByRole('menuitem', { name: 'Keluar' }).tagName).toBe('BUTTON')
  })

  it('menampilkan item Pengaturan sebagai tautan saat settingsHref diisi', () => {
    renderMenu({ settingsHref: '/settings' })
    openMenu()

    const settings = screen.getByRole('menuitem', { name: 'Pengaturan' })
    expect(settings.tagName).toBe('A')
    expect(settings).toHaveAttribute('href', '/settings')

    const menuItems = screen.getAllByRole('menuitem').map((item) => item.textContent?.trim())
    expect(menuItems).toEqual(['Profil', 'Pengaturan', 'Keluar'])
  })

  it('menutup panel dan mengembalikan fokus ke pemicu saat Escape ditekan', () => {
    renderMenu()
    openMenu()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Akun Budi Santoso/ })).toHaveFocus()
  })

  it('menutup panel saat klik/tap di luar komponen', () => {
    renderMenu()
    openMenu()

    fireEvent.pointerDown(document.body)

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('menampilkan foto avatar sebagai object URL blob bila avatarUrl disediakan', async () => {
    mockAvatarImage(fetchMock)
    renderMenu({ user: { ...USER, avatarUrl: '/api/v1/avatars/abc?v=deadbeef' } })
    const avatar = screen.getByRole('img', { name: 'Akun Budi Santoso' })
    expect(avatar.tagName).toBe('SPAN')

    await waitFor(() => {
      expect(avatar.querySelector('img')).not.toBeNull()
    })

    const img = avatar.querySelector('img')
    expect(img).toHaveAttribute('src', AVATAR_OBJECT_URL)
    expect(avatar.textContent).toBe('')
  })

  it('jatuh ke inisial saat foto gagal dimuat', async () => {
    fetchMock.mockResolvedValue(errorResponse(404))
    renderMenu({ user: { ...USER, avatarUrl: '/api/v1/avatars/abc?v=deadbeef' } })
    const avatar = screen.getByRole('img', { name: 'Akun Budi Santoso' })
    await flushEffects()

    expect(avatar.querySelector('img')).toBeNull()
    expect(avatar.textContent).toBe('BS')
    expect(screen.getByRole('img', { name: 'Akun Budi Santoso' })).toBe(avatar)
  })
})
