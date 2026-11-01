// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import {
  AVATAR_OBJECT_URL,
  errorResponse,
  flushEffects,
  installAvatarFetchStubs,
  mockAvatarImage,
} from '@/test-utils/avatarFetch'

import { KioskStatusStrip } from './KioskStatusStrip'

let fetchMock: Mock<typeof fetch>

beforeEach(() => {
  fetchMock = installAvatarFetchStubs().fetchMock
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/**
 * Pita identitas kios SHELL-03 untuk ponsel (< 768px): permukaan `.card`
 * seperti kartu identitas vendor. Baris 1 = nama petugas (truncate) + pill
 * shift BERSAUDARA di kanan (`ml-auto shrink-0`, tak terpotong truncation
 * nama); baris 2 = chip lokasi rata KANAN (`self-end`) di bawah baris 1.
 *
 * Pita ini MURNI identitas. Jam live dan counter "X Teknisi On-Site" adalah
 * status BERJALAN yang wajib selalu terlihat petugas, jadi keduanya tetap
 * di navbar — bukan di pita.
 */
describe('KioskStatusStrip — pita identitas kios ponsel', () => {
  it('menampilkan nama petugas beserta label shift', () => {
    render(
      <KioskStatusStrip
        guardName="Joko Susilo"
        locationName="Kantor Pusat THC (Pontianak)"
        shiftLabel="Shift Malam"
      />,
    )

    expect(screen.getByText('Joko Susilo')).toBeInTheDocument()
    expect(screen.getByText(/Shift Malam/)).toBeInTheDocument()
  })

  it('menampilkan nama lokasi tepat DI BAWAH nama petugas', () => {
    render(
      <KioskStatusStrip guardName="Joko Susilo" locationName="Kantor Pusat THC (Pontianak)" />,
    )

    const guard = screen.getByText('Joko Susilo')
    const location = screen.getByTitle('Kantor Pusat THC (Pontianak)')
    expect(location).toHaveTextContent('Kantor Pusat THC (Pontianak)')
    expect(
      guard.compareDocumentPosition(location) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('TIDAK merender jam live (jam tetap di navbar)', () => {
    const { container } = render(
      <KioskStatusStrip guardName="Joko Susilo" locationName="Kantor Pusat THC (Pontianak)" />,
    )

    expect(container.querySelector('time')).toBeNull()
  })

  it('TIDAK merender counter on-site (counter tetap di navbar)', () => {
    render(
      <KioskStatusStrip guardName="Joko Susilo" locationName="Kantor Pusat THC (Pontianak)" />,
    )

    expect(screen.queryByText(/On-Site/)).toBeNull()
  })

  it('hanya tampil di ponsel (md:hidden) dan punya testid yang stabil', () => {
    render(
      <KioskStatusStrip guardName="Joko Susilo" locationName="Kantor Pusat THC (Pontianak)" />,
    )

    const strip = screen.getByTestId('kiosk-status-strip')
    expect(strip.className).toContain('md:hidden')
  })

  it('avatarUrl diisi → strip memuat <img> object URL blob (data-avatar-state image)', async () => {
    mockAvatarImage(fetchMock)
    const { container } = render(
      <KioskStatusStrip
        guardName="Joko Susilo"
        locationName="Kantor Pusat THC (Pontianak)"
        avatarUrl="/api/v1/avatars/abc?v=deadbeef"
      />,
    )

    await waitFor(() => {
      expect(container.querySelector('[data-avatar-state="image"]')).not.toBeNull()
    })

    const strip = screen.getByTestId('kiosk-status-strip')
    const img = strip.querySelector('img')
    expect(img).toHaveAttribute('src', AVATAR_OBJECT_URL)
  })

  it('avatarUrl dihilangkan atau null → inisial, tanpa <img>', () => {
    const omitted = render(
      <KioskStatusStrip guardName="Joko Susilo" locationName="Kantor Pusat THC (Pontianak)" />,
    )
    expect(omitted.container.querySelector('img')).toBeNull()
    expect(omitted.container.querySelector('[data-avatar-state="initials"]')).toHaveTextContent(
      'JS',
    )

    const nulled = render(
      <KioskStatusStrip
        guardName="Joko Susilo"
        locationName="Kantor Pusat THC (Pontianak)"
        avatarUrl={null}
      />,
    )
    expect(nulled.container.querySelector('img')).toBeNull()
    expect(nulled.container.querySelector('[data-avatar-state="initials"]')).toHaveTextContent(
      'JS',
    )
  })

  it('avatar mendahului nama petugas dalam urutan DOM', async () => {
    mockAvatarImage(fetchMock)
    const { container } = render(
      <KioskStatusStrip
        guardName="Joko Susilo"
        locationName="Kantor Pusat THC (Pontianak)"
        avatarUrl="/api/v1/avatars/abc?v=deadbeef"
      />,
    )

    await waitFor(() => {
      expect(container.querySelector('[data-avatar-state="image"]')).not.toBeNull()
    })

    const avatar = container.querySelector('[data-avatar-state]')
    const name = screen.getByText('Joko Susilo')
    expect(avatar).not.toBeNull()
    expect(
      avatar !== null &&
        avatar.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('gagal memuat avatar → jatuh ke inisial', async () => {
    fetchMock.mockResolvedValue(errorResponse(404))
    const { container } = render(
      <KioskStatusStrip
        guardName="Joko Susilo"
        locationName="Kantor Pusat THC (Pontianak)"
        avatarUrl="/api/v1/avatars/abc?v=deadbeef"
      />,
    )

    await flushEffects()

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('[data-avatar-state="initials"]')).toHaveTextContent('JS')
  })

  it('avatar memakai ukuran lg (48px, sejajar kartu identitas vendor)', () => {
    const { container } = render(
      <KioskStatusStrip guardName="Joko Susilo" locationName="Kantor Pusat THC (Pontianak)" />,
    )

    const avatar = container.querySelector('[data-avatar-state]')
    expect(avatar).not.toBeNull()
    expect(avatar?.className).toContain('size-12')
  })

  it('chip lokasi memakai text-badge (lebih kecil dari nama)', () => {
    render(<KioskStatusStrip guardName="Joko Susilo" locationName="Kantor Pusat THC (Pontianak)" />)

    const location = screen.getByTestId('kiosk-location')
    expect(location).toHaveAttribute('title', 'Kantor Pusat THC (Pontianak)')
    expect(location).toHaveTextContent('Kantor Pusat THC (Pontianak)')
    const badge = location.closest('.status-badge')
    expect(badge).not.toBeNull()
    const classes = badge?.className.split(/\s+/) ?? []
    expect(classes).toContain('text-badge')
    expect(classes).toContain('px-1.5')
    expect(classes).toContain('py-0')
    expect(classes).toContain('gap-1')
    expect(classes).toContain('max-w-full')
    // Ikon MapPin lebih ringkas dari sebelumnya: size-2.5, tak ikut menyusut.
    const icon = badge?.querySelector('svg')
    expect(icon).not.toBeNull()
    expect(icon?.getAttribute('class')).toContain('size-2.5')
  })

  it('chip lokasi berbagi kolom flex yang sama dengan nama petugas', () => {
    render(<KioskStatusStrip guardName="Joko Susilo" locationName="Kantor Pusat THC (Pontianak)" />)

    const strip = screen.getByTestId('kiosk-status-strip')
    const nameParagraph = screen.getByTestId('kiosk-guard-name').closest('p')
    const badge = screen.getByTestId('kiosk-location').closest('.status-badge')
    const column = badge?.parentElement

    expect(nameParagraph).not.toBeNull()
    expect(badge).not.toBeNull()
    expect(column).toBe(nameParagraph?.parentElement)
    expect(column?.className).toContain('flex-col')
    // Kolom identitas ≠ root pita: root memuat avatar, kolom hanya teks.
    expect(column).not.toBe(strip)

    const avatar = strip.querySelector('[data-avatar-state]')
    expect(avatar).not.toBeNull()
    expect(column?.contains(avatar)).toBe(false)
  })

  it('chip lokasi rata KANAN kolom identitas (self-end, bukan di bawah avatar)', () => {
    render(<KioskStatusStrip guardName="Joko Susilo" locationName="Kantor Pusat THC (Pontianak)" />)

    const strip = screen.getByTestId('kiosk-status-strip')
    const badge = screen.getByTestId('kiosk-location').closest('.status-badge')
    const nameParagraph = screen.getByTestId('kiosk-guard-name').closest('p')
    const avatar = strip.querySelector('[data-avatar-state]')
    const column = badge?.parentElement

    expect(column).not.toBeNull()
    expect(badge).not.toBeNull()
    expect(nameParagraph).not.toBeNull()

    // Kolom identitas = anak langsung root BERDAMPINGAN dengan avatar; chip
    // lokasi memakai `self-end` sehingga menempel tepi KANAN kolom identitas.
    expect(column?.parentElement).toBe(strip)
    expect(column).toContainElement(nameParagraph as HTMLElement)
    expect(column).toContainElement(badge as HTMLElement)
    expect(badge?.className).toContain('self-end')
    expect(badge?.className).not.toContain('self-start')
    expect(avatar).not.toBeNull()
    expect(column?.contains(avatar)).toBe(false)
    expect(strip).toContainElement(avatar as HTMLElement)
  })

  it('baris 1 = nama (truncate) + pill shift BERSAUDARA; pill shift tidak bisa terpotong', () => {
    render(
      <KioskStatusStrip
        guardName="Joko Susilo"
        locationName="Kantor Pusat THC (Pontianak)"
        shiftLabel="Shift Malam"
      />,
    )

    const name = screen.getByTestId('kiosk-guard-name')
    const shift = screen.getByTestId('kiosk-shift')
    const row = name.closest('p')

    // Pill shift bersaudara dengan teks nama — BUKAN inline di dalamnya,
    // sehingga truncation nama tidak pernah memotong teks shift.
    expect(row).not.toBeNull()
    expect(name.parentElement).toBe(row)
    expect(shift.parentElement).toBe(row)
    expect(name.contains(shift)).toBe(false)

    // Baris 1 = flex row; nama menyusut (min-w-0 truncate), pill `ml-auto`.
    expect(row?.className).toContain('flex')
    expect(row?.className).toContain('items-center')
    expect(row?.className).toContain('gap-2')
    expect(name.className).toContain('min-w-0')
    expect(name.className).toContain('truncate')
    expect(name.className).toContain('font-bold')
    // Nama = pengisi baris (flex-1) yang menyusut sendiri, dan membawa
    // tooltip nama PENUH di elemennya (bukan gabungan di baris).
    expect(name.className).toContain('flex-1')
    expect(name).toHaveAttribute('title', 'Joko Susilo')

    const shiftClasses = shift.className.split(/\s+/)
    expect(shiftClasses).toContain('ml-auto')
    expect(shiftClasses).toContain('shrink-0')
    expect(shiftClasses).toContain('whitespace-nowrap')
    expect(shiftClasses).toContain('px-1.5')
    expect(shiftClasses).toContain('py-0')
    expect(shiftClasses).toContain('text-badge')
    expect(shiftClasses).toContain('status-badge')
    // Pill shift polos: teks saja, TANPA ikon SVG.
    expect(shift.querySelector('svg')).toBeNull()
    expect(shift).toHaveTextContent('Shift Malam')
  })

  it('nama panjang di 360px: ketiga elemen tetap tampil, nama truncate + tooltip penuh', () => {
    render(
      <KioskStatusStrip
        guardName="Muhammad Abdurrahman Wahyudi Pratama"
        locationName="Kantor Pusat THC (Pontianak)"
        shiftLabel="Shift Malam"
      />,
    )

    const name = screen.getByTestId('kiosk-guard-name')
    const shift = screen.getByTestId('kiosk-shift')
    const location = screen.getByTestId('kiosk-location')

    // Ketiga elemen identitas tampil serentak — tak satu pun disembunyikan
    // atau digantikan saat nama panjang memaksa baris 1 menyempit.
    expect(name).toHaveTextContent('Muhammad Abdurrahman Wahyudi Pratama')
    expect(shift).toHaveTextContent('Shift Malam')
    expect(location).toHaveTextContent('Kantor Pusat THC (Pontianak)')

    // Nama memecah dirinya sendiri (flex-1 + min-w-0 truncate) dan
    // menyimpan nama PENUH di title; pill shift dijaga utuh.
    expect(name.className).toContain('flex-1')
    expect(name.className).toContain('min-w-0')
    expect(name.className).toContain('truncate')
    expect(name).toHaveAttribute('title', 'Muhammad Abdurrahman Wahyudi Pratama')
    expect(shift.className).toContain('ml-auto')
    expect(shift.className).toContain('shrink-0')
    expect(shift.className).toContain('whitespace-nowrap')
  })

  it('chip lokasi datang SETELAH baris 1 dalam urutan DOM', () => {
    render(<KioskStatusStrip guardName="Joko Susilo" locationName="Kantor Pusat THC (Pontianak)" />)

    const name = screen.getByTestId('kiosk-guard-name')
    const location = screen.getByTestId('kiosk-location')
    const row = name.closest('p')
    const badge = location.closest('.status-badge')

    expect(row).not.toBeNull()
    expect(badge).not.toBeNull()
    expect(
      row !== null && badge !== null &&
        row.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    // Chip lokasi bersaudara dengan baris 1 di kolom identitas yang sama.
    expect(badge?.parentElement).toBe(row?.parentElement)
  })

  it('tanpa href → root tetap <div> (bukan tautan)', () => {
    render(<KioskStatusStrip guardName="Joko Susilo" locationName="Kantor Pusat THC (Pontianak)" />)

    const strip = screen.getByTestId('kiosk-status-strip')
    expect(strip.tagName).toBe('DIV')
  })

  it('dengan href → root menjadi <Link> tap-to-profile ke /profile', () => {
    render(
      <KioskStatusStrip
        guardName="Joko Susilo"
        locationName="Kantor Pusat THC (Pontianak)"
        href="/profile"
      />,
    )

    const strip = screen.getByTestId('kiosk-status-strip')
    expect(strip.tagName).toBe('A')
    expect(strip).toHaveAttribute('href', '/profile')
    expect(strip).toHaveAccessibleName('Buka profil Joko Susilo')
    expect(strip.className).toContain('min-h-touch')
    expect(strip.className).toContain('md:hidden')
  })

  it('root memakai permukaan & ritme kartu identitas vendor (K3)', () => {
    render(
      <KioskStatusStrip
        guardName="Joko Susilo"
        locationName="Kantor Pusat THC (Pontianak)"
        href="/profile"
      />,
    )

    const strip = screen.getByTestId('kiosk-status-strip')
    const classes = strip.className.split(/\s+/)
    // `.card` = surface + border 1px + --radius-card + --shadow-card.
    expect(classes).toContain('card')
    expect(classes).toContain('p-4')
    expect(classes).toContain('gap-4')
    // Slot avatar 48px sejajar kartu vendor (`size="lg"` → size-12).
    const avatar = strip.querySelector('[data-avatar-state]')
    expect(avatar).not.toBeNull()
    expect(avatar?.className).toContain('size-12')
  })

  it('varian link TIDAK memuat kontrol interaktif bersarang', () => {
    render(
      <KioskStatusStrip
        guardName="Joko Susilo"
        locationName="Kantor Pusat THC (Pontianak)"
        href="/profile"
      />,
    )

    const strip = screen.getByTestId('kiosk-status-strip')
    expect(strip.querySelector('a, button, input, select, textarea')).toBeNull()
  })
})
