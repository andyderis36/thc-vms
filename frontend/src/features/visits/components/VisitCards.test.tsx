// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useVisitFile } from '@/features/visits/hooks/useVisitFile'
import type { Role, VisitDetail } from '@/lib/api/types'
import { visitSchedule } from './VisitTable'
import { VisitCards, type VisitCardsProps } from './VisitCards'

vi.mock('@/features/visits/hooks/useVisitFile', () => ({
  useVisitFile: vi.fn(),
}))

const mockedUseVisitFile = vi.mocked(useVisitFile)

/** `aria-label` kontrak aksi SPK pada kartu mobile. */
const SPK_LINK_NAME = 'Lihat surat tugas SPK kunjungan VISIT-2026-0001'
/** Object URL stabil hasil mock hook — bukan presigned MinIO. */
const MOCKED_SPK_URL = 'blob:spk'

function buildVisit(overrides: Partial<VisitDetail> = {}): VisitDetail {
  return {
    id: 'visit-1',
    visit_id: 'VISIT-2026-0001',
    status: 'requested',
    location: {
      id: 'loc-1',
      name: 'Kantor Pusat THC',
      type: 'pusat',
      address: 'Jl. Thamrin No. 1',
      city: 'Jakarta Pusat',
      timezone: 'WIB',
    },
    purposes: [{ id: 'purp-1', name: 'Splicing FO' }],
    vendor_user: {
      id: 'user-1',
      name: 'Budi Santoso',
      email: 'budi@thc.co.id',
      phone: '08123456789',
      nik: '1234567890123456',
      role: 'admin',
      location_id: 'loc-1',
      location_name: 'Kantor Pusat THC',
      status: 'active',
      type: 'internal',
      vendor_name: null,
      avatar_url: null,
    },
    vendor_name: 'PT Mitra Jaringan',
    start_date: '2026-09-26T08:00:00+07:00',
    end_date: '2026-09-26T16:00:00+07:00',
    assignment_letter_url: 'https://minio.example/assignment_letters/spk.pdf',
    notes: null,
    visitors: [
      {
        id: 'visitor-1',
        name: 'Andi Wijaya',
        id_number: '1234567890123456',
        phone: '08123456789',
        id_card_photo_url: null,
        vendor_name: 'PT Mitra Jaringan',
      },
    ],
    created_at: '2026-09-20T10:00:00+07:00',
    ...overrides,
  }
}

function renderVisitCards(overrides: Partial<VisitCardsProps> = {}) {
  const onApprove = vi.fn()
  const onReject = vi.fn()
  const props: VisitCardsProps = {
    visits: [buildVisit()],
    role: 'admin' as Role,
    onApprove,
    onReject,
    ...overrides,
  }
  render(<VisitCards {...props} />)
  return { onApprove, onReject }
}

/** Baris metadata kartu = `<p>` pembungkus elemen (ikon + konten). */
function rowOf(element: Element): HTMLElement {
  const row = element.closest('p')
  if (row === null) {
    throw new Error('elemen tidak berada di dalam baris <p> metadata')
  }
  return row
}

/** Class ikon `svg` leading — `className` SVG bukan string, pakai atribut. */
function iconClassOf(row: HTMLElement): string {
  return row.querySelector('svg')?.getAttribute('class') ?? ''
}

beforeEach(() => {
  mockedUseVisitFile.mockReturnValue({
    objectUrl: MOCKED_SPK_URL,
    loading: false,
    error: null,
    retry: vi.fn(),
  })
})

describe('VisitCards — kontrak baris "Lihat SPK" (mobile)', () => {
  it('merender link "Lihat SPK" dengan aria-label lengkap dan href object URL hasil mock', () => {
    renderVisitCards()

    const link = screen.getByRole('link', { name: SPK_LINK_NAME })
    expect(link).toHaveTextContent('Lihat SPK')
    // Klik anchor mengikuti `href` — wajib object URL lokal dari hook.
    expect(link).toHaveAttribute('href', MOCKED_SPK_URL)
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('baris SPK kontrak alignment: satu baris flex items-center, ikon shrink-0 tanpa kelas geser vertikal, link min-h-touch items-center', () => {
    renderVisitCards()

    const link = screen.getByRole('link', { name: SPK_LINK_NAME })
    const row = rowOf(link)

    // Satu baris flex tunggal memuat ikon + label (bukan dua pembungkus terpisah).
    expect(row).toHaveClass('flex')
    expect(row).toHaveClass('items-center')
    expect(row).toHaveClass('gap-2')
    expect(row.contains(link)).toBe(true)
    expect(row.querySelectorAll('svg')).toHaveLength(1)

    // Ikon leading: ukuran tetap, tak boleh menyusut, tanpa nudging vertikal
    // (translate-y-*, mt-*, relative -top-*, align-*).
    const iconClass = iconClassOf(row)
    expect(iconClass).toContain('size-4')
    expect(iconClass).toContain('shrink-0')
    expect(iconClass).not.toMatch(/translate-y-/)
    expect(iconClass).not.toMatch(/(^|\s)mt-/)
    expect(iconClass).not.toMatch(/-top-/)
    expect(iconClass).not.toMatch(/align-/)
    expect(iconClass).not.toMatch(/(^|\s)relative(\s|$)/)

    // Link tetap target sentuh penuh dan sejajar tengah dalam baris.
    expect(link).toHaveClass('min-h-touch')
    expect(link).toHaveClass('items-center')
  })

  it('baris SPK: pembungkus non-svg berupa flex min-w-0 items-center (bukan span inline telanjang), tanpa nudging ikon', () => {
    renderVisitCards()

    const link = screen.getByRole('link', { name: SPK_LINK_NAME })
    const row = rowOf(link)

    // Baris metadata tetap satu flex items-center gap-2.
    expect(row).toHaveClass('flex')
    expect(row).toHaveClass('items-center')
    expect(row).toHaveClass('gap-2')

    // Anak langsung baris: ikon svg + SATU pembungkus non-svg (span).
    const nonSvgChildren = Array.from(row.children).filter(
      (child) => child.tagName.toLowerCase() !== 'svg',
    )
    expect(nonSvgChildren).toHaveLength(1)
    const wrapper = nonSvgChildren.at(0)
    if (wrapper === undefined) {
      throw new Error('pembungkus non-svg baris SPK tidak ditemukan')
    }
    expect(wrapper.tagName.toLowerCase()).toBe('span')
    // Wrapper wajib flex items-center agar anchor min-h-touch (44px) ikut
    // ter-center — bukan span inline telanjang yang mem-baseline anchor-nya
    // sehingga ikon 16px tidak lagi segaris optis dengan label.
    expect(wrapper).toHaveClass('flex')
    expect(wrapper).toHaveClass('min-w-0')
    expect(wrapper).toHaveClass('items-center')
    // Kelas wrapper tidak boleh membawa nudging vertikal sama sekali.
    const wrapperClass = wrapper.getAttribute('class') ?? ''
    expect(wrapperClass).not.toMatch(/translate-y-/)
    expect(wrapperClass).not.toMatch(/(^|\s)mt-/)
    expect(wrapperClass).not.toMatch(/-top-/)
    expect(wrapperClass).not.toMatch(/(^|\s)relative(\s|$)/)

    // Anchor di dalam wrapper tetap target sentuh penuh dengan konten center.
    expect(wrapper.contains(link)).toBe(true)
    expect(link).toHaveClass('min-h-touch')
    expect(link).toHaveClass('items-center')

    // Ikon tetap tanpa margin/translate/position utilities.
    const iconClass = iconClassOf(row)
    expect(iconClass).toContain('size-4')
    expect(iconClass).toContain('shrink-0')
    expect(iconClass).not.toMatch(/translate-y-/)
    expect(iconClass).not.toMatch(/(^|\s)mt-/)
    expect(iconClass).not.toMatch(/-top-/)
    expect(iconClass).not.toMatch(/(^|\s)relative(\s|$)/)
  })

  it('baris metadata lain (lokasi, keperluan, teknisi, jadwal) tetap items-start dengan ikon mt-0.5', () => {
    const visit = buildVisit()
    renderVisitCards({ visits: [visit] })
    const schedule = visitSchedule(visit)

    const otherRows: Array<[string, HTMLElement]> = [
      ['lokasi', rowOf(screen.getByTitle(visit.location.name))],
      ['keperluan', rowOf(screen.getByText('Splicing FO'))],
      ['teknisi', rowOf(screen.getByTitle('Andi Wijaya'))],
      ['jadwal', rowOf(screen.getByText(schedule.dateLabel))],
    ]

    expect(otherRows).toHaveLength(4)
    for (const [label, row] of otherRows) {
      // Baris dua baris teks (nama + sublabel) rata atas — bukan rata tengah.
      expect(row, `baris ${label}`).toHaveClass('items-start')
      expect(iconClassOf(row), `ikon baris ${label}`).toContain('mt-0.5')
    }
  })

  it('assignment_letter_url null: tanpa link, fallback "—" text-ink-muted, baris tetap kontrak alignment', () => {
    renderVisitCards({ visits: [buildVisit({ assignment_letter_url: null })] })

    expect(screen.queryByRole('link', { name: SPK_LINK_NAME })).toBeNull()

    // Fallback netral — identik dengan kondisi berkas tidak tersedia.
    const fallback = screen.getByText('—')
    expect(fallback).toHaveClass('text-ink-muted')

    // Baris fallback ikon tetap memenuhi kontrak alignment yang sama.
    const row = rowOf(fallback)
    expect(row).toHaveClass('items-center')

    const iconClass = iconClassOf(row)
    expect(iconClass).toContain('size-4')
    expect(iconClass).toContain('shrink-0')
    expect(iconClass).not.toContain('mt-0.5')
  })
})
