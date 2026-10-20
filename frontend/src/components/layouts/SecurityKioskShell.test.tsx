// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { createElement, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SecurityKioskShell } from './SecurityKioskShell'

vi.mock('next/navigation', () => ({ usePathname: () => '/gate' }))

/** Ganti `next/image` dengan `<img>` polos: jsdom tidak menjalankan loader optimasi. */
vi.mock('next/image', () => ({
  default: (props: ComponentProps<'img'>) => createElement('img', props),
}))

vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({
    user: { name: 'Joko Susilo', role: 'security', location_name: 'POP Pontianak' },
    status: 'authenticated',
    signOut: vi.fn(),
  }),
}))

vi.mock('@/components/ui/NotificationsMenu', () => ({
  NotificationsMenu: ({ className }: { className?: string }) =>
    createElement('div', { 'data-testid': 'notif-menu', className }),
}))

afterEach(() => {
  cleanup()
})

/**
 * Topbar kios SATU baris di semua breakpoint:
 * - kiri: logo THC; badge lokasi `md:inline-flex` (di ponsel pindah ke
 *   `KioskStatusStrip` di body `/gate`).
 * - tengah: jam live WIB dengan counter "X Teknisi On-Site" TEPAT di
 *   bawahnya (ponsel: kolom bertumpuk di antara logo dan lonceng;
 *   md+: jam + counter sebaris).
 * - kanan: tautan kembali (ikon di ponsel), lonceng notifikasi, nama
 *   petugas (lg+), dan tombol logout ringkas.
 *
 * Identitas petugas + pos jaga tidak di navbar; ia ada di pita body `/gate`.
 */
describe('SecurityKioskShell — topbar kios satu baris di semua breakpoint', () => {
  it('header hanya punya SATU baris - tier-2 dihapus', () => {
    render(<SecurityKioskShell>konten kios</SecurityKioskShell>)

    const header = document.querySelector('header')
    expect(header).not.toBeNull()
    expect(header?.children).toHaveLength(1)
    expect(header?.querySelectorAll('time')).toHaveLength(1)
  })

  it('jam + counter berada di kolom tengah yang sama (bertumpuk di ponsel, sebaris di md+)', () => {
    render(<SecurityKioskShell>konten kios</SecurityKioskShell>)

    const centre = document.querySelector('header')?.children.item(0)?.children.item(1)
    const classes = (centre?.getAttribute('class') ?? '').split(/\s+/)
    expect(classes).toContain('flex-col')
    expect(classes).toContain('md:flex-row')
    expect(centre?.querySelector('time')).not.toBeNull()
    expect(centre?.textContent).toContain('Teknisi On-Site')
  })

  it('navbar ponsel 56px, kios desktop tetap 70px', () => {
    render(<SecurityKioskShell>konten kios</SecurityKioskShell>)

    const row = document.querySelector('header')?.children.item(0)
    const classes = (row?.getAttribute('class') ?? '').split(/\s+/)
    expect(classes).toContain('h-bar-mobile')
    expect(classes).toContain('md:h-topbar-kiosk')
  })

  it('tombol logout ringkas seperti vendor: ikon 44px, tanpa label teks dan tanpa border', () => {
    render(<SecurityKioskShell>konten kios</SecurityKioskShell>)

    const logout = screen.getByRole('button', { name: 'Ganti Shift / Logout' })
    const classes = logout.className.split(/\s+/)
    expect(classes).toContain('size-11')
    expect(classes).not.toContain('border')
    expect(logout.textContent).toBe('')
  })

  it('tab gerbang 56px di ponsel, tetap 52px di md+', () => {
    render(<SecurityKioskShell>konten kios</SecurityKioskShell>)

    const tab = screen.getAllByRole('tab')[0]
    expect(tab?.className).toContain('min-h-bar-mobile')
    expect(tab?.className).toContain('md:min-h-touch-lg')
  })

  it('jam live dan counter on-site tetap di dalam header', () => {
    render(<SecurityKioskShell>konten kios</SecurityKioskShell>)

    const header = document.querySelector('header')
    expect(header?.querySelector('time')).not.toBeNull()
    expect(screen.getAllByText(/Teknisi On-Site/).length).toBeGreaterThan(0)
  })

  it('nama petugas hanya muncul SATU kali di dalam shell', () => {
    render(<SecurityKioskShell>konten kios</SecurityKioskShell>)

    expect(screen.getAllByText('Joko Susilo').length).toBeLessThanOrEqual(1)
  })

  it('badge lokasi disembunyikan di ponsel (hidden md:inline-flex)', () => {
    render(<SecurityKioskShell>konten kios</SecurityKioskShell>)

    const badge = document.querySelector('[title="POP Pontianak"]')?.closest('.status-badge')
    expect(badge).not.toBeNull()
    const className = badge?.getAttribute('class') ?? ''
    expect(className).toContain('hidden')
    expect(className).toContain('md:inline-flex')
  })

  it('tidak ada pita identitas kios di dalam shell (pita hidup di body /gate)', () => {
    render(<SecurityKioskShell>konten kios</SecurityKioskShell>)

    expect(screen.queryByTestId('kiosk-status-strip')).toBeNull()
  })
})
