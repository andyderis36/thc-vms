// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { KioskStatusStrip } from './KioskStatusStrip'

afterEach(() => {
  cleanup()
})

/**
 * Pita identitas kios SHELL-03 untuk ponsel (< 768px): nama petugas + shift
 * di baris 1, badge lokasi TEPAT DI BAWAHNYA.
 *
 * Pita ini MURNI identitas. Jam live dan counter "X Teknisi On-Site" adalah
 * status BERJALAN yang wajib selalu terlihat petugas, jadi keduanya tetap
 * di navbar (tier-2) — bukan di pita.
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
})
