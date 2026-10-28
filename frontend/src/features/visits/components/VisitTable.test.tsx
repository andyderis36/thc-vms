// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { VisitTable, type VisitTableProps } from './VisitTable'
import { TABLE_TH_CLASS } from '@/lib/table-styles'
import type { Role, VisitDetail } from '@/lib/api/types'

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
    assignment_letter_url: null,
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

function renderVisitTable(overrides: Partial<VisitTableProps> = {}) {
  const onApprove = vi.fn()
  const onReject = vi.fn()
  const props: VisitTableProps = {
    visits: [buildVisit()],
    role: 'admin' as Role,
    onApprove,
    onReject,
    ...overrides,
  }
  render(<VisitTable {...props} />)
  return { onApprove, onReject }
}

function headerWidthPercent(th: HTMLElement): number {
  const match = th.className.match(/w-\[(\d+)%\]/)
  return match ? Number(match[1]) : 0
}

describe('VisitTable (desktop)', () => {
  it('menampilkan tepat 8 columnheader dan tidak ada "Keperluan"', () => {
    renderVisitTable()

    const headers = screen.getAllByRole('columnheader')
    expect(headers).toHaveLength(8)

    expect(
      headers.some((h) => (h.textContent ?? '').includes('Keperluan'))
    ).toBe(false)
  })

  it('lebar 8 kolom (w-[n%]) bertambah tepat 100%', () => {
    renderVisitTable()

    const headers = screen.getAllByRole('columnheader')
    const total = headers.reduce((sum, th) => sum + headerWidthPercent(th), 0)

    expect(total).toBe(100)
  })

  it('selalu merender ikon + label Setujui, label tak lagi bersyarat lebar layar', () => {
    renderVisitTable()

    const approveButton = screen.getByRole('button', {
      name: 'Setujui kunjungan VISIT-2026-0001',
    })

    // Label selalu tampil: tidak lagi dibungkus `span.hidden xl:inline`.
    expect(screen.getByText('Setujui')).toBeVisible()
    expect(approveButton.querySelector('.hidden')).toBeNull()

    // Ikon selalu tampil: tidak lagi `size-4 xl:hidden`.
    const icon = approveButton.querySelector('svg')
    expect(icon).not.toBeNull()
    expect(icon?.getAttribute('class') ?? '').toContain('shrink-0')
    expect(icon?.getAttribute('class') ?? '').not.toContain('xl:hidden')
  })

  it('memakai token TABLE_TH_CLASS pada tiap sel header (lg:px-6)', () => {
    renderVisitTable()

    const headers = screen.getAllByRole('columnheader')
    for (const th of headers) {
      // Sel header memakai token bersama, bukan salinan string mentah.
      expect(th.className).toContain(TABLE_TH_CLASS)
      expect(th.className).toContain('lg:px-6')
    }
  })
})
