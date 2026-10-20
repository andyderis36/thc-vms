// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { createElement, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { VendorMobileShell } from './VendorMobileShell'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

/** Ganti `next/image` dengan `<img>` polos: jsdom tidak menjalankan loader optimasi. */
vi.mock('next/image', () => ({
  default: (props: ComponentProps<'img'>) => createElement('img', props),
}))

vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({
    user: { name: 'Budi', role: 'vendor', vendor_name: 'PT Lintas Fiber' },
    status: 'authenticated',
    signOut: vi.fn(),
  }),
}))

/** Lonceng dimock seperti pada shell sekelas: cukup bukti pemicunya dirender. */
vi.mock('@/components/ui/NotificationsMenu', () => ({
  NotificationsMenu: ({ className, tone }: { className?: string; tone?: string }) =>
    createElement('div', { 'data-testid': 'notif-menu', 'data-tone': tone, className }),
}))

afterEach(() => {
  cleanup()
})

function renderShell() {
  return render(<VendorMobileShell>konten uji</VendorMobileShell>)
}

/** Kelas elemen sebagai daftar token (bukan substring) supaya `bg-brand` != `bg-brand-dark`. */
function classTokens(element: Element | null | undefined): string[] {
  return (element?.className ?? '').split(/\s+/).filter(Boolean)
}

describe('VendorMobileShell — navbar biru & ringkas (SHELL-04)', () => {
  it('header memakai permukaan brand biru dengan tinta kontras', () => {
    renderShell()

    const header = document.querySelector('header')
    const classes = classTokens(header)

    expect(classes).toContain('bg-brand')
    expect(classes).toContain('text-brand-contrast')
  })

  it('logo THC tetap ada tanpa alas chip (chip bg-brand tak akan terlihat di header biru)', () => {
    renderShell()

    const logo = screen.getByAltText('THC')
    expect(logo.getAttribute('src')).toContain('thcw')
    // Chip `bg-brand` di atas header `bg-brand` lenyap: alas chip dihapus,
    // gambar logo tetap dipertahankan.
    expect(logo.parentElement?.className).not.toContain('bg-brand')
  })

  it('wordmark "Visitor Portal" tidak lagi ada di navbar', () => {
    renderShell()

    expect(screen.queryByText('Visitor Portal')).toBeNull()
  })

  it('nama vendor disembunyikan di layar sempit lalu tampil sejak sm (640px)', () => {
    renderShell()

    const vendorName = screen.getByText('PT Lintas Fiber')
    const classes = classTokens(vendorName)

    expect(classes).toContain('hidden')
    expect(classes).toContain('sm:block')
  })

  it('lonceng notifikasi tetap ada di navbar', () => {
    renderShell()

    expect(screen.getByTestId('notif-menu')).toBeInTheDocument()
  })

  it('lonceng memakai nada brand agar tinta kontras di atas permukaan biru', () => {
    renderShell()

    expect(screen.getByTestId('notif-menu').getAttribute('data-tone')).toBe('brand')
  })

  it('tombol keluar memakai state hover gelap di atas permukaan biru', () => {
    renderShell()

    const logout = screen.getByRole('button', { name: 'Keluar dari akun' })
    expect(logout.className).toContain('hover:bg-brand-dark')
  })

  it('navbar ponsel 56px, desktop tetap 64px', () => {
    renderShell()

    const classes = classTokens(document.querySelector('header'))
    expect(classes).toContain('h-bar-mobile')
    expect(classes).toContain('lg:h-topbar')
    expect(classes).not.toContain('h-14')
  })

  it('bottom nav ponsel memakai tinggi bar 56px', () => {
    renderShell()

    const navs = screen.getAllByRole('navigation', { name: 'Navigasi utama' })
    const last = navs[navs.length - 1]
    expect(classTokens(last)).toContain('h-bar-mobile')
  })
})
