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
  return (element?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
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

  it('pintu profil selalu terjangkau di ponsel: chip ikon 44px, nama tampil hanya sm–lg (ikon-only lagi di desktop)', () => {
    renderShell()

    const profileLink = screen.getByRole('link', { name: 'Profil PT Lintas Fiber' })
    const linkClasses = classTokens(profileLink)

    // Regresi yang dijaga: bottom nav SHELL-04 hanya punya 3 tujuan, jadi
    // anchor `hidden` di < sm membuat vendor di ponsel tak punya jalan ke
    // /profile sama sekali (terukur 0x0 di viewport 360px).
    expect(linkClasses).not.toContain('hidden')
    expect(linkClasses).toContain('w-11')
    expect(linkClasses).toContain('min-h-touch')
    expect(profileLink).toHaveAttribute('href', '/profile')

    const icon = profileLink.querySelector('svg')
    expect(icon).not.toBeNull()
    // Kontrak baru: ikon disembunyikan hanya pada rentang sm–lg (nama
    // penuh mengambil alih), lalu MUNCUL LAGI di desktop sebagai chip
    // ikon 44px — `lg:block` mengembalikannya setelah `sm:hidden`.
    expect(classTokens(icon)).toContain('sm:hidden')
    expect(classTokens(icon)).toContain('lg:block')

    const vendorName = screen.getByText('PT Lintas Fiber')
    expect(vendorName.tagName).toBe('SPAN')
    // Nama penuh hanya untuk rentang sm–lg; di desktop nama disembunyikan
    // (`lg:hidden`) supaya profil kembali murni chip ikon.
    expect(classTokens(vendorName)).toContain('hidden')
    expect(classTokens(vendorName)).toContain('sm:block')
    expect(classTokens(vendorName)).toContain('lg:hidden')

    // Tooltip `title` DILARANG: nama vendor akan muncul sebagai tooltip
    // di seluruh breakpoint termasuk desktop, membatalkan chip ikon-only.
    expect(profileLink).not.toHaveAttribute('title')
  })

  it('desktop (≥ lg): profil kembali chip ikon terpusat tanpa nama & tanpa tooltip', () => {
    renderShell()

    const profileLink = screen.getByRole('link', { name: 'Profil PT Lintas Fiber' })
    const linkClasses = classTokens(profileLink)

    // Kontrak desktop: lebar di-reset ke chip ikon (`lg:w-11`), `max-w-none`
    // melepas clamp `sm:max-w-72`, dan `lg:justify-center` menetralkan
    // `sm:justify-start` agar ikon kembali terpusat di chip 44px.
    expect(linkClasses).toContain('lg:w-11')
    expect(linkClasses).toContain('lg:max-w-none')
    expect(linkClasses).toContain('lg:justify-center')

    // Nama tetap ada di DOM (aksesibilitas: accessible name link) tetapi
    // dibawa `lg:hidden` — assert kelas, bukan visibilitas jsdom.
    const vendorName = screen.getByText('PT Lintas Fiber')
    expect(classTokens(vendorName)).toContain('lg:hidden')
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
    if (!last) {
      throw new Error('bottom nav ponsel tidak ditemukan')
    }
    // Bar TIDAK lagi memakai `height` tetap: `min-h-bar-mobile` +
    // padding bawah safe area iOS → bar tumbuh sebesar
    // `env(safe-area-inset-bottom)` tanpa terjepit.
    expect(classTokens(last)).toContain('min-h-bar-mobile')
    expect(classTokens(last)).not.toContain('h-bar-mobile')
    expect(classTokens(last)).toContain('pb-[env(safe-area-inset-bottom)]')
    // Isi bar dikunci 56px → ikon & label tetap setinggi/terpusat sama
    // seperti sebelumnya (grow by inset, bukan squash).
    expect(classTokens(last.firstElementChild)).toContain('h-bar-mobile')
  })

  it('ruang bawah konten ikut tumbuh sebesar inset safe area', () => {
    renderShell()

    const main = document.querySelector('main')
    // Padding bawah = 96px (bar 56px + tonjolan tombol bundar 24px + sisa)
    // PLUS inset home indicator, supaya konten tak pernah tertutup bar.
    expect(classTokens(main)).toContain('pb-[calc(6rem_+_env(safe-area-inset-bottom))]')
  })

  it('tombol keluar adalah elemen TERAKHIR di cluster kanan (paling kanan)', () => {
    renderShell()

    const bell = screen.getByTestId('notif-menu')
    const cluster = bell.parentElement
    const children = Array.from(cluster?.children ?? [])
    const logout = screen.getByRole('button', { name: 'Keluar dari akun' })

    // Aksi "keluar" harus selalu di posisi paling kanan: jauh lebih mudah
    // dijangkau ibu jari, dan posisinya tidak berubah-ubah. Lonceng notifikasi
    // ada SEBELUM logout.
    expect(children[children.length - 1]).toBe(logout)
    expect(children.indexOf(bell)).toBeLessThan(children.indexOf(logout))
    expect(logout.className).toContain('size-11')
  })
})
