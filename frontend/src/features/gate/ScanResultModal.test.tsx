// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useVisitFile } from '@/features/visits/hooks/useVisitFile'
import type { VisitDetail } from '@/lib/api/types'
import { ScanResultModal } from './ScanResultModal'

vi.mock('@/features/visits/hooks/useVisitFile', () => ({
  useVisitFile: vi.fn(),
}))

const mockedUseVisitFile = vi.mocked(useVisitFile)

function buildVisit(overrides: Partial<VisitDetail> = {}): VisitDetail {
  return {
    id: 'visit-1',
    visit_id: 'VISIT-2026-0001',
    status: 'approved',
    location: {
      id: 'loc-1',
      name: 'Kantor Pusat THC',
      type: 'pusat',
      address: 'Jl. Thamrin No. 1',
      city: 'Jakarta Pusat',
      timezone: 'WIB',
    },
    purposes: [{ id: 'purp-1', name: 'Survey' }],
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
        photo_url: null,
        vendor_name: 'PT Mitra Jaringan',
      },
    ],
    created_at: '2026-09-20T10:00:00+07:00',
    ...overrides,
  }
}

function renderModal(visit: VisitDetail): void {
  render(
    <ScanResultModal
      visit={visit}
      open
      pending={false}
      onClose={vi.fn()}
      onConfirm={vi.fn()}
    />,
  )
}

function mockFileHook(result: {
  objectUrl: string | null
  loading: boolean
  error: string | null
  retry: () => void
}): void {
  mockedUseVisitFile.mockReturnValue(result)
}

describe('ScanResultModal — Lihat SPK', () => {
  beforeEach(() => {
    mockedUseVisitFile.mockReset()
  })

  it('menampilkan tautan "Lihat SPK" saat assignment_letter_url terisi dan berkas termuat', () => {
    mockFileHook({
      objectUrl: 'blob:http://localhost/spk-uji',
      loading: false,
      error: null,
      retry: vi.fn(),
    })
    renderModal(buildVisit({ assignment_letter_url: 'https://storage.example/spk.pdf' }))

    const link = screen.getByRole('link', {
      name: 'Lihat surat tugas SPK kunjungan VISIT-2026-0001',
    })
    expect(link).toHaveTextContent('Lihat SPK')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('tidak menampilkan "Lihat SPK" saat assignment_letter_url null', () => {
    renderModal(buildVisit({ assignment_letter_url: null }))

    expect(screen.queryByText('Lihat SPK')).toBeNull()
    expect(
      screen.queryByRole('link', { name: /Lihat surat tugas SPK/ }),
    ).toBeNull()
    expect(mockedUseVisitFile).not.toHaveBeenCalled()
    // Baris lain di dalam modal tetap utuh.
    expect(screen.getByText(/Vendor\/Mitra:/)).toBeInTheDocument()
  })

  it('menampilkan fallback netral (bukan tautan) saat berkas belum termuat', () => {
    mockFileHook({
      objectUrl: null,
      loading: true,
      error: null,
      retry: vi.fn(),
    })
    renderModal(buildVisit({ assignment_letter_url: 'https://storage.example/spk.pdf' }))

    expect(screen.queryByText('Lihat SPK')).toBeNull()
    expect(
      screen.queryByRole('link', { name: /Lihat surat tugas SPK/ }),
    ).toBeNull()
    expect(mockedUseVisitFile).toHaveBeenCalledWith({
      visitId: 'visit-1',
      kind: 'assignment_letter',
    })
  })
})
