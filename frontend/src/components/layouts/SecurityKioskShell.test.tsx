// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { AVATAR_OBJECT_URL, installAvatarFetchStubs, mockAvatarImage } from '@/test-utils/avatarFetch'

import { SecurityKioskShell } from './SecurityKioskShell'

const AVATAR_IMG_SELECTOR = 'header img[src^="blob:"]'

let fetchMock: Mock<typeof fetch>

/** State mutable agar tiap kasus uji bisa menguji visibilitas rute berbeda. */
const pathnameState = vi.hoisted(() => ({ value: '/gate' }))

const sessionUserState: {
  value: {
    name: string
    role: string
    location_id: string | null
    location_ids: string[]
    location_name: string | null
    avatar_url: string
  }
} = vi.hoisted(() => ({
  value: {
    name: 'Joko Susilo',
    role: 'security',
    location_id: 'loc-pontianak',
    location_ids: ['loc-pontianak'],
    location_name: 'POP Pontianak',
    avatar_url: '/api/v1/avatars/abc?v=1a2b3c4d',
  },
}))

vi.mock('next/navigation', () => ({ usePathname: () => pathnameState.value }))

/** Ganti `next/image` dengan `<img>` polos: jsdom tidak menjalankan loader optimasi. */
vi.mock('next/image', () => ({
  default: (props: ComponentProps<'img'>) => createElement('img', props),
}))

vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({
    user: sessionUserState.value,
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

beforeEach(() => {
  pathnameState.value = '/gate'
  sessionUserState.value = {
    name: 'Joko Susilo',
    role: 'security',
    location_id: 'loc-pontianak',
    location_ids: ['loc-pontianak'],
    location_name: 'POP Pontianak',
    avatar_url: '/api/v1/avatars/abc?v=1a2b3c4d',
  }
  fetchMock = installAvatarFetchStubs().fetchMock
})

/**
 * Topbar kios SATU baris di semua breakpoint:
 * - kiri: logo THC; badge lokasi `md:inline-flex` (di ponsel pindah ke
 *   `KioskStatusStrip` di body `/gate`).
 * - tengah: jam live WIB dengan counter "X Teknisi On-Site" TEPAT di
 *   bawahnya (ponsel: kolom bertumpuk di antara logo dan lonceng;
 *   md+: jam + counter sebaris).
 * - kanan: tautan kembali (ikon di ponsel), lonceng notifikasi, avatar +
 *   nama petugas (md+), dan tombol logout ringkas.
 *
 * Identitas petugas + pos jaga tidak di navbar; ia ada di pita body `/gate`.
 * Label kiri topbar lama (judul pos) sudah dihapus — kiri hanya logo +
 * badge lokasi — dan tidak boleh muncul lagi.
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

  it('nama petugas hanya muncul SATU kali dan menaut ke /profile', () => {
    render(<SecurityKioskShell>konten kios</SecurityKioskShell>)

    expect(screen.getAllByText('Joko Susilo').length).toBeLessThanOrEqual(1)

    const nameLink = screen.getByText('Joko Susilo')
    expect(nameLink.tagName).toBe('A')
    expect(nameLink).toHaveAttribute('href', '/profile')
    expect(nameLink).toHaveAccessibleName('Profil Joko Susilo')
  })

  it('header menampilkan avatar sesi: <img> object URL blob, wrapper image, aria-hidden, alt kosong', async () => {
    mockAvatarImage(fetchMock)
    render(<SecurityKioskShell>konten kios</SecurityKioskShell>)

    await waitFor(() => {
      expect(document.querySelector(AVATAR_IMG_SELECTOR)).not.toBeNull()
    })
    const img = document.querySelector(AVATAR_IMG_SELECTOR)
    expect(img?.getAttribute('alt')).toBe('')
    expect(img?.getAttribute('aria-hidden')).toBe('true')

    const wrapper = img?.closest('[data-avatar-state]')
    expect(wrapper).not.toBeNull()
    expect(wrapper?.getAttribute('data-avatar-state')).toBe('image')
    expect(wrapper?.getAttribute('aria-hidden')).toBe('true')
  })

  it('avatar mendahului nama di DOM dan grupnya hidden md:flex (tak masuk bar ponsel 56px)', async () => {
    mockAvatarImage(fetchMock)
    render(<SecurityKioskShell>konten kios</SecurityKioskShell>)

    await waitFor(() => {
      expect(document.querySelector(AVATAR_IMG_SELECTOR)).not.toBeNull()
    })

    const nameLink = screen.getByText('Joko Susilo')
    const ordered = Array.from(
      document.querySelectorAll('header img[src^="blob:"], header a[href="/profile"]'),
    )
    // querySelectorAll selalu mengembalikan urutan dokumen: avatar dulu,
    // tautan nama menyusul (bukan sebaliknya).
    expect(ordered).toHaveLength(2)
    expect(ordered[0]?.getAttribute('src')).toBe(AVATAR_OBJECT_URL)
    expect(ordered[1]).toBe(nameLink)

    const group = ordered[0]?.closest('[data-avatar-state]')?.parentElement
    expect(group).not.toBeNull()
    const classes = (group?.getAttribute('class') ?? '').split(/\s+/)
    // Tampil mulai 768px (md), bukan lg — di <768px permukaan avatar adalah
    // pita body `/gate`. `hidden` + `md:flex` menjamin tak ada di bar ponsel.
    expect(classes).toContain('hidden')
    expect(classes).toContain('md:flex')
    expect(classes).not.toContain('lg:flex')
    // `min-w-0` = syarat `truncate` nama agar cluster kanan tak overflow.
    expect(classes).toContain('min-w-0')
    expect(group?.contains(nameLink)).toBe(true)

    const nameAnchor = nameLink as HTMLAnchorElement
    expect(nameAnchor.className).toContain('truncate')
    expect(nameAnchor.className).toContain('max-w-full')
  })

  it('label topbar lama di kiri sudah dihapus dari header', () => {
    render(<SecurityKioskShell>konten kios</SecurityKioskShell>)

    const removedLabel = ['Gate', 'Access', 'Control'].join(' ')
    expect(screen.queryByText(removedLabel)).toBeNull()
    const header = document.querySelector('header')?.textContent ?? ''
    expect(header).not.toContain(removedLabel)
  })

  it('badge lokasi disembunyikan di ponsel (hidden md:inline-flex)', () => {
    render(<SecurityKioskShell>konten kios</SecurityKioskShell>)

    const badge = document.querySelector('[title="POP Pontianak"]')?.closest('.status-badge')
    expect(badge).not.toBeNull()
    const className = badge?.getAttribute('class') ?? ''
    expect(className).toContain('hidden')
    expect(className).toContain('md:inline-flex')
  })

  it('di md badge lokasi punya lantai lebar agar tak terlipat jadi sliver', () => {
    render(<SecurityKioskShell>konten kios</SecurityKioskShell>)

    const badge = document.querySelector('[title="POP Pontianak"]')?.closest('.status-badge')
    expect(badge).not.toBeNull()
    const classes = (badge?.getAttribute('class') ?? '').split(/\s+/)
    expect(classes).toContain('md:min-w-24')
    expect(classes).toContain('md:max-w-56')
    // Pemotongan teks ada pada span isi badge, bukan pada pembungkusnya.
    expect(badge?.querySelector('span.truncate')).not.toBeNull()
  })

  it('tidak ada pita identitas kios di dalam shell (pita hidup di body /gate)', () => {
    render(<SecurityKioskShell>konten kios</SecurityKioskShell>)

    expect(screen.queryByTestId('kiosk-status-strip')).toBeNull()
  })

  it('tombol keluar adalah elemen TERAKHIR di cluster kanan (paling kanan)', async () => {
    mockAvatarImage(fetchMock)
    render(<SecurityKioskShell>konten kios</SecurityKioskShell>)

    await waitFor(() => {
      expect(document.querySelector(AVATAR_IMG_SELECTOR)).not.toBeNull()
    })

    const bell = screen.getByTestId('notif-menu')
    const cluster = bell.parentElement
    const children = Array.from(cluster?.children ?? [])
    const logout = screen.getByRole('button', { name: 'Ganti Shift / Logout' })

    // Aksi "ganti shift / keluar" paling kanan, lonceng notifikasi
    // SEBELUMNYA — posisi logout konsisten & mudah dijangkau ibu jari.
    expect(children[children.length - 1]).toBe(logout)
    expect(children.indexOf(bell)).toBeLessThan(children.indexOf(logout))
    expect(cluster?.textContent).toContain('Joko Susilo')

    const nameGroup = document
      .querySelector(AVATAR_IMG_SELECTOR)
      ?.closest('[data-avatar-state]')?.parentElement
    expect(nameGroup).not.toBeNull()
    expect(children.indexOf(bell)).toBeLessThan(children.indexOf(nameGroup!))
    expect(children.indexOf(nameGroup!)).toBeLessThan(children.indexOf(logout))
  })

  it('bottom bar ponsel reservasi safe area iOS tanpa terjepit', () => {
    render(<SecurityKioskShell>konten kios</SecurityKioskShell>)

    const bar = Array.from(document.querySelectorAll('div')).find(
      (node) => node.className.includes('fixed') && node.className.includes('bottom-0'),
    )
    const classes = (bar?.getAttribute('class') ?? '').split(/\s+/)
    expect(classes).toContain('min-h-bar-mobile')
    expect(classes).toContain('pb-[env(safe-area-inset-bottom)]')
    // Isi bar tetap 56px (min-h-bar-mobile pada tab gerbang).
    expect(screen.getAllByRole('tab')[0]?.className).toContain('min-h-bar-mobile')
  })

  it('ruang bawah konten ikut tumbuh sebesar inset safe area', () => {
    render(<SecurityKioskShell>konten kios</SecurityKioskShell>)

    const main = document.querySelector('main')
    const classes = (main?.getAttribute('class') ?? '').split(/\s+/)
    // Padding bawah 96px (bar 56px + sisanya) PLUS inset home indicator.
    expect(classes).toContain('pb-[calc(6rem_+_env(safe-area-inset-bottom))]')
  })
})

describe('visibilitas rute', () => {
  it('/gate: tab gerbang tampil, tanpa tautan kembali, padding bawah bar tetap', () => {
    pathnameState.value = '/gate'
    const { container } = render(<SecurityKioskShell>konten kios</SecurityKioskShell>)

    expect(screen.getAllByRole('tab').length).toBeGreaterThan(0)
    expect(
      screen.queryAllByRole('link', { name: 'Kembali ke Pos Check-in' }).length,
    ).toBe(0)
    const classes = (container.querySelector('main')?.getAttribute('class') ?? '').split(/\s+/)
    expect(classes).toContain('pb-[calc(6rem_+_env(safe-area-inset-bottom))]')
  })

  it('/profile: tab gerbang disembunyikan, bottom bar absen, padding konten pb-4', () => {
    pathnameState.value = '/profile'
    const { container } = render(<SecurityKioskShell>konten kios</SecurityKioskShell>)

    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(
      screen.queryAllByRole('link', { name: 'Kembali ke Pos Check-in' }).length,
    ).toBe(0)
    const classes = (container.querySelector('main')?.getAttribute('class') ?? '').split(/\s+/)
    expect(classes).toContain('pb-4')
    expect(container.querySelector('div.fixed.bottom-0.min-h-bar-mobile')).toBeNull()
  })

  it('/visits/visit-1: tab disembunyikan, dua tautan kembali menaut ke /gate, padding pb-4', () => {
    pathnameState.value = '/visits/visit-1'
    const { container } = render(<SecurityKioskShell>konten kios</SecurityKioskShell>)

    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    const backLinks = screen.getAllByRole('link', { name: 'Kembali ke Pos Check-in' })
    expect(backLinks).toHaveLength(2)
    for (const link of backLinks) {
      expect(link).toHaveAttribute('href', '/gate')
    }
    const classes = (container.querySelector('main')?.getAttribute('class') ?? '').split(/\s+/)
    expect(classes).toContain('pb-4')
  })
})

describe('visibilitas lencana cabang multi-branch', () => {
  it('satu cabang: badge lokasi tampil', () => {
    render(<SecurityKioskShell>konten kios</SecurityKioskShell>)

    const badge = document.querySelector('[title="POP Pontianak"]')?.closest('.status-badge')
    expect(badge).not.toBeNull()
  })

  it('lebih dari satu cabang: badge lokasi disembunyikan, tanpa placeholder', () => {
    sessionUserState.value = {
      name: 'Joko Susilo',
      role: 'security',
      location_id: 'loc-pontianak',
      location_ids: ['loc-pontianak', 'loc-singkawang'],
      location_name: 'POP Pontianak',
      avatar_url: '/api/v1/avatars/abc?v=1a2b3c4d',
    }
    render(<SecurityKioskShell>konten kios</SecurityKioskShell>)

    expect(document.querySelector('[title="POP Pontianak"]')).toBeNull()
    expect(screen.queryByText('POP Pontianak')).toBeNull()
  })

  it('cakupan kosong: fallback lama tetap tampil', () => {
    sessionUserState.value = {
      name: 'Joko Susilo',
      role: 'security',
      location_id: null,
      location_ids: [],
      location_name: null,
      avatar_url: '/api/v1/avatars/abc?v=1a2b3c4d',
    }
    render(<SecurityKioskShell>konten kios</SecurityKioskShell>)

    expect(screen.getByText('Lokasi Terkunci')).toBeInTheDocument()
  })
})
