// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ComponentProps } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type Mock } from 'vitest'

import { AVATAR_OBJECT_URL, installAvatarFetchStubs, mockAvatarImage } from '@/test-utils/avatarFetch'

import { AdminBranchShell } from './AdminBranchShell'

const AVATAR_IMG_SELECTOR = 'button[aria-haspopup="menu"] span[role="img"] img'

let fetchMock: Mock<typeof fetch>

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

/** Ganti `next/image` dengan `<img>` polos: jsdom tidak menjalankan loader optimasi. */
vi.mock('next/image', () => ({
  default: (props: ComponentProps<'img'>) => createElement('img', props),
}))

vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({
    user: {
      name: 'Admin Cabang',
      role: 'admin',
      location_name: 'POP Pontianak',
      avatar_url: '/api/v1/avatars/abc?v=1a2b3c4d',
    },
    status: 'authenticated',
    signOut: vi.fn(),
  }),
}))

vi.mock('@/components/ui/NotificationsMenu', () => ({
  NotificationsMenu: ({ className }: { className?: string }) =>
    createElement('div', { 'data-testid': 'notif-menu', className }),
}))

// jsdom belum punya `window.matchMedia`; efek laci memanggilnya saat dibuka.
beforeAll(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
  fetchMock = installAvatarFetchStubs().fetchMock
})

afterAll(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  cleanup()
})

function renderShell() {
  return render(<AdminBranchShell>konten uji</AdminBranchShell>)
}

function openDrawer(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Buka menu navigasi' }))
}

/** Kelas elemen sebagai daftar token (bukan substring) agar `w-full` != `max-w-full`. */
function classTokens(element: Element | null | undefined): string[] {
  return (element?.className ?? '').split(/\s+/).filter(Boolean)
}

describe('AdminBranchShell — topbar mobile & laci', () => {
  it('tombol tutup laci punya ukuran persegi eksplisit (bukan diregangkan panel)', () => {
    renderShell()
    openDrawer()

    const close = screen.getByRole('button', { name: 'Tutup menu navigasi' })
    // `align-self: stretch` pada anak `flex-col` dulu melebarkan tombol ini
    // sampai keluar layar; `size-11` mengunci 44×44 dan bukan padding atom Button.
    expect(close.className).toContain('size-11')
    expect(close.className).toContain('absolute')
    expect(close.className).not.toContain('px-4')
  })

  it('membuka laci memfokuskan tombol tutup lebih dulu (jebakan fokus)', () => {
    renderShell()
    openDrawer()

    expect(document.activeElement).toHaveAttribute('aria-label', 'Tutup menu navigasi')
  })

  it('lonceng notifikasi hadir di KEDUA topbar (mobile & desktop)', () => {
    renderShell()

    expect(screen.getAllByTestId('notif-menu')).toHaveLength(2)
  })

  it('aset brand asli tampil tanpa alas chip (wordmark putih di header gelap)', () => {
    renderShell()

    const logo = screen.getByAltText('THC')
    expect(logo.getAttribute('src')).toContain('thcw')
    // Alas chip ungu `bg-brand` sengaja dihapus: wordmark putih berdiri
    // sendiri di atas latar `bg-sidebar-dark` (lihat AdminBranchShell).
    expect(logo.parentElement?.className).not.toContain('bg-brand')

    const tokens = classTokens(logo)
    expect(tokens).toContain('h-10')
    expect(tokens).toContain('w-auto')
  })

  it('kotak teks "THC" palsu sudah hilang', () => {
    renderShell()

    expect(screen.queryByText('THC', { exact: true })).toBeNull()
  })

  it('wordmark "THC VMS" sudah hilang (navbar & sidebar); pita cabang tetap dibatasi lebarnya', () => {
    renderShell()

    expect(screen.queryByText('THC VMS', { exact: true })).toBeNull()

    const chipLabel = screen
      .getAllByText('POP Pontianak')
      .find((el) => el.parentElement?.className.includes('max-w-40'))
    expect(chipLabel).toBeDefined()
    expect(chipLabel?.parentElement?.className).toContain('max-w-40')
    expect(chipLabel?.parentElement?.className).toContain('shrink-0')
  })

  it('footer Penugasan tidak lagi menulis keterangan akses "(Read-Only)"', () => {
    renderShell()

    expect(screen.queryByText(/Read-Only/)).toBeNull()
    expect(screen.getByText('Penugasan: POP Pontianak')).toBeInTheDocument()
  })

  it('topbar mobile 56px', () => {
    renderShell()

    const mobileHeader = document.querySelectorAll('header')[1]
    expect(classTokens(mobileHeader)).toContain('h-bar-mobile')
  })

  it('item sidebar aktif tanpa aksen garis tepi (varian terang)', () => {
    renderShell()

    const active = document.querySelector('aside nav a[aria-current="page"]')
    const classes = classTokens(active)

    // Tidak boleh ada border aksen (3px kiri) pada status mana pun.
    expect(classes).not.toContain('border-l-[3px]')
    expect(classes.filter((token) => token.startsWith('border-'))).toHaveLength(0)
    // Identitas aktif tetap lewat permukaan ber-tint + tinta brand.
    expect(classes).toContain('bg-brand-soft')
    expect(classes).toContain('text-brand')
  })
})

describe('AdminBranchShell — foto profil sesi pada pemicu akun', () => {
  it('pemicu profil merender <img> dari object URL blob avatar sesi', async () => {
    mockAvatarImage(fetchMock)
    renderShell()

    await waitFor(() => {
      expect(document.querySelector(AVATAR_IMG_SELECTOR)).not.toBeNull()
    })
    expect(document.querySelector(AVATAR_IMG_SELECTOR)).toHaveAttribute('src', AVATAR_OBJECT_URL)
  })
})
