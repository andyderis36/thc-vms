// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ProfileMenu, type ProfileMenuUser } from './ProfileMenu'

const USER: ProfileMenuUser = { name: 'Budi Santoso', role: 'Admin Cabang' }

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

  it('menampilkan foto avatar bila avatarUrl disediakan', () => {
    renderMenu({ user: { ...USER, avatarUrl: 'https://cdn.example/u.png' } })
    expect(screen.getByRole('img', { name: 'Akun Budi Santoso' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Akun Budi Santoso' }).tagName).toBe('SPAN')
  })
})
