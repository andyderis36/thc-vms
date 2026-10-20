// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, type ImgHTMLAttributes, type ReactNode } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { SuperadminShell } from './SuperadminShell'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

vi.mock('next/image', () => ({
  default: (props: ImgHTMLAttributes<HTMLImageElement>) => createElement('img', props),
}))

vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({
    user: { name: 'Pusat', role: 'super_admin', location_name: 'Pontianak' },
    status: 'authenticated',
    signOut: vi.fn(),
  }),
}))

vi.mock('@/components/ui/NotificationsMenu', () => ({
  NotificationsMenu: ({ className }: { className?: string }) =>
    createElement('div', { 'data-testid': 'notif-menu', className }),
}))

/** jsdom tidak menyediakan `matchMedia`; efek laci memanggilnya saat dibuka. */
beforeAll(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
})

afterAll(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  cleanup()
})

function renderShell(): void {
  const children: ReactNode = createElement('div', null, 'konten')
  render(createElement(SuperadminShell, null, children))
}

function openDrawer(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Buka menu navigasi' }))
}

describe('SuperadminShell — regresi defek mobile', () => {
  it('tombol tutup laci adalah kotak kompak di dalam viewport (bukan tombol atom yang melar)', () => {
    renderShell()
    openDrawer()

    const close = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Tutup menu navigasi"]',
    )
    expect(close).not.toBeNull()
    if (close === null) return

    // `size-11` = kotak 44×44 eksplisit — penjaga regresi bug `align-self: stretch`.
    expect(close.className).toContain('size-11')
    expect(close.className).toContain('absolute')
    // Bukan `Button` atom: kelas dasar `px-4` miliknya tidak boleh ada.
    expect(close.className).not.toContain('px-4')
  })

  it('membuka laci memfokuskan tombol tutup', () => {
    renderShell()
    openDrawer()

    expect(document.activeElement).toHaveAttribute('aria-label', 'Tutup menu navigasi')
  })

  it('kontrol notifikasi ada di KEDUA topbar (desktop + mobile)', () => {
    renderShell()

    expect(screen.getAllByTestId('notif-menu')).toHaveLength(2)
  })

  it('memakai aset merek asli /thcw.png, bukan kotak teks ungu palsu', () => {
    renderShell()

    expect(screen.getAllByAltText('THC').map((image) => image.getAttribute('src'))).toContain(
      '/thcw.png',
    )

    const [logo] = screen.getAllByAltText('THC')
    expect(logo?.className).toContain('h-10')
    expect(logo?.className).toContain('w-auto')
  })

  it('kotak teks "THC" palsu sudah hilang', () => {
    renderShell()

    expect(screen.queryByText('THC', { exact: true })).toBeNull()
  })

  it('wordmark "THC VMS" hilang dari topbar mobile & sidebar', () => {
    renderShell()

    // Identitas lengkap lama sudah dihapus dari header sidebar.
    expect(screen.queryByText('THC VMS PUSAT', { exact: true })).toBeNull()
    expect(screen.queryByText('Kantor Pusat Pontianak')).toBeNull()

    // Wordmark ringkas juga DIHAPUS dari topbar mobile (permintaan pengguna).
    expect(screen.queryByText('THC VMS', { exact: true })).toBeNull()
    const headerWordmarks = Array.from(document.querySelectorAll('header span')).filter(
      (span) => span.textContent === 'THC VMS',
    )
    expect(headerWordmarks).toHaveLength(0)
  })

  it('topbar mobile 56px dan lonceng tetap di paling kanan', () => {
    renderShell()

    const mobileHeader = document.querySelectorAll('header')[1]
    expect(mobileHeader?.className).toContain('h-bar-mobile')

    const bells = screen.getAllByTestId('notif-menu')
    expect(bells[1]?.className).toContain('ml-auto')
  })
})

/**
 * Switcher cabang TIDAK lagi hidup di shell: setiap halaman pemilik
 * menyediakannya tepat SATU kali di filter bar halamannya sendiri
 * (`/dashboard` → "Fasilitas", `/facilities` → "Cabang", `/users` → "Cabang",
 * `/approvals` → "Cabang"). Shell yang memuat switcher kedua kali berarti
 * kontrol filter ganda pada satu layar.
 */
describe('SuperadminShell — switcher cabang dihapus dari topbar', () => {
  it('tak ada satu pun <select> di shell (desktop maupun mobile topbar)', () => {
    renderShell()

    expect(document.querySelectorAll('header select')).toHaveLength(0)
    expect(document.querySelectorAll('select')).toHaveLength(0)
  })

  it('tak ada opsi "Semua Cabang / POP" di shell', () => {
    renderShell()

    expect(screen.queryByText('Semua Cabang / POP')).toBeNull()
    expect(screen.queryByLabelText('Pilih cabang atau POP')).toBeNull()
  })
})
