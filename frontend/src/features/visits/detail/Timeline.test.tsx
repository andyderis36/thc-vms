// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { VisitHistoryEntry } from '@/lib/api/types'

import { Timeline, formatTanggalWaktu, historyDetail } from './Timeline'

afterEach(cleanup)

const CREATED_AT = '2026-11-05T15:47:00+07:00'
const APPROVED_AT = '2026-11-10T22:32:00+07:00'
const START = '2026-11-10T16:00:00+07:00'
const END = '2026-11-11T00:00:00+07:00'

function baseProps() {
  return {
    status: 'approved' as const,
    createdAt: CREATED_AT,
    startDate: START,
    endDate: END,
  }
}

describe('Timeline append-only — node Pengajuan tak boleh hilang', () => {
  it('riwayat produksi tanpa requested: sisipkan Pengajuan + tahap jadwal di bawahnya', () => {
    const history: VisitHistoryEntry[] = [
      {
        status: 'approved',
        at: APPROVED_AT,
        actor_name: 'Hendra Wijaya',
        actor_role_label: 'Superadmin',
      },
    ]
    render(<Timeline {...baseProps()} history={history} />)

    // Node pengajuan tetap ada dengan stempel pembuatannya.
    expect(screen.getByText('Pengajuan')).toBeInTheDocument()
    expect(
      screen.getByText(`Diajukan ${formatTanggalWaktu(CREATED_AT)}`),
    ).toBeInTheDocument()
    // Baris riwayat berpelaku tetap ada.
    expect(screen.getByText('Disetujui')).toBeInTheDocument()
    expect(
      screen.getByText(
        `oleh Hendra Wijaya (Superadmin) · ${formatTanggalWaktu(APPROVED_AT)}`,
      ),
    ).toBeInTheDocument()
    // Tahap masa depan (jadwal gerbang) tidak dikurangkan.
    expect(screen.getByText('Kedatangan di Lokasi')).toBeInTheDocument()
    expect(
      screen.getByText(`Jadwal mulai ${formatTanggalWaktu(START)}`),
    ).toBeInTheDocument()
    expect(screen.getByText('Selesai')).toBeInTheDocument()
    expect(
      screen.getByText(`Jadwal selesai ${formatTanggalWaktu(END)}`),
    ).toBeInTheDocument()
  })

  it('riwayat yang sudah berisi requested: jangan gandakan Pengajuan', () => {
    const history: VisitHistoryEntry[] = [
      {
        status: 'requested',
        at: CREATED_AT,
        actor_name: 'Wulan Sari',
        actor_role_label: 'Vendor/Mitra',
      },
      {
        status: 'approved',
        at: APPROVED_AT,
        actor_name: 'Siti Rahayu',
        actor_role_label: 'Admin Cabang',
      },
    ]
    render(<Timeline {...baseProps()} history={history} />)

    expect(screen.queryByText('Pengajuan')).not.toBeInTheDocument()
    expect(screen.getByText('Diminta')).toBeInTheDocument()
    expect(screen.getByText('Disetujui')).toBeInTheDocument()
  })

  it('status terminal dengan riwayat tanpa requested: Pengajuan + Status akhir', () => {
    const history: VisitHistoryEntry[] = [
      {
        status: 'rejected',
        at: APPROVED_AT,
        actor_name: 'Siti Rahayu',
        actor_role_label: 'Admin Cabang',
      },
    ]
    render(
      <Timeline
        {...baseProps()}
        status="rejected"
        history={history}
        statusNote="Berkas tidak lengkap"
      />,
    )

    expect(screen.getByText('Pengajuan')).toBeInTheDocument()
    expect(
      screen.getByText(`Diajukan ${formatTanggalWaktu(CREATED_AT)}`),
    ).toBeInTheDocument()
    expect(screen.getByText('Status akhir')).toBeInTheDocument()
    expect(screen.getByText('Berkas tidak lengkap')).toBeInTheDocument()
  })
})

describe('historyDetail — dedupe label peran', () => {
  it('nama yang sudah membawa peran tidak ditempeli label lagi', () => {
    expect(
      historyDetail({
        status: 'approved',
        at: APPROVED_AT,
        actor_name: 'Hendra Wijaya (Super Admin)',
        actor_role_label: 'Superadmin',
      }),
    ).toBe(`oleh Hendra Wijaya (Super Admin) · ${formatTanggalWaktu(APPROVED_AT)}`)
  })

  it('nama bersih tetap mendapat label peran', () => {
    expect(
      historyDetail({
        status: 'approved',
        at: APPROVED_AT,
        actor_name: 'Siti Rahayu',
        actor_role_label: 'Admin Cabang',
      }),
    ).toBe(`oleh Siti Rahayu (Admin Cabang) · ${formatTanggalWaktu(APPROVED_AT)}`)
  })
})

describe('Timeline — cakupan semua status kunjungan', () => {
  it('requested tanpa riwayat: 4 langkah (Pengajuan current + Menunggu + jadwal gerbang)', () => {
    render(
      <Timeline status="requested" createdAt={CREATED_AT} startDate={START} endDate={END} />,
    )

    expect(screen.getByText('Pengajuan')).toBeInTheDocument()
    expect(
      screen.getByText(`Diajukan ${formatTanggalWaktu(CREATED_AT)}`),
    ).toBeInTheDocument()
    expect(screen.getByText('Persetujuan')).toBeInTheDocument()
    expect(screen.getByText('Menunggu persetujuan')).toBeInTheDocument()
    expect(screen.getByText('Kedatangan di Lokasi')).toBeInTheDocument()
    expect(
      screen.getByText(`Jadwal mulai ${formatTanggalWaktu(START)}`),
    ).toBeInTheDocument()
    expect(screen.getByText('Selesai')).toBeInTheDocument()
    expect(
      screen.getByText(`Jadwal selesai ${formatTanggalWaktu(END)}`),
    ).toBeInTheDocument()
  })

  it('rescheduled + history [rescheduled] tanpa requested: Pengajuan sintetis + Jadwal Digeser + tahap masa depan', () => {
    const history: VisitHistoryEntry[] = [
      {
        status: 'rescheduled',
        at: APPROVED_AT,
        actor_name: 'Siti Rahayu',
        actor_role_label: 'Admin Cabang',
      },
    ]
    render(
      <Timeline
        status="rescheduled"
        createdAt={CREATED_AT}
        startDate={START}
        endDate={END}
        history={history}
      />,
    )

    expect(screen.getByText('Pengajuan')).toBeInTheDocument()
    expect(
      screen.getByText(`Diajukan ${formatTanggalWaktu(CREATED_AT)}`),
    ).toBeInTheDocument()
    expect(screen.getByText('Jadwal Digeser')).toBeInTheDocument()
    expect(
      screen.getByText(
        `oleh Siti Rahayu (Admin Cabang) · ${formatTanggalWaktu(APPROVED_AT)}`,
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('Persetujuan')).toBeInTheDocument()
    expect(screen.getByText('Menunggu persetujuan')).toBeInTheDocument()
    expect(screen.getByText('Kedatangan di Lokasi')).toBeInTheDocument()
    expect(
      screen.getByText(`Jadwal mulai ${formatTanggalWaktu(START)}`),
    ).toBeInTheDocument()
    expect(screen.getByText('Selesai')).toBeInTheDocument()
    expect(
      screen.getByText(`Jadwal selesai ${formatTanggalWaktu(END)}`),
    ).toBeInTheDocument()
  })

  it('visiting + history [approved] tanpa requested: Pengajuan + Disetujui berpelaku + Kedatangan + Selesai', () => {
    const history: VisitHistoryEntry[] = [
      {
        status: 'approved',
        at: APPROVED_AT,
        actor_name: 'Siti Rahayu',
        actor_role_label: 'Admin Cabang',
      },
    ]
    render(
      <Timeline
        status="visiting"
        createdAt={CREATED_AT}
        startDate={START}
        endDate={END}
        history={history}
      />,
    )

    expect(screen.getByText('Pengajuan')).toBeInTheDocument()
    expect(
      screen.getByText(`Diajukan ${formatTanggalWaktu(CREATED_AT)}`),
    ).toBeInTheDocument()
    expect(screen.getByText('Disetujui')).toBeInTheDocument()
    expect(
      screen.getByText(
        `oleh Siti Rahayu (Admin Cabang) · ${formatTanggalWaktu(APPROVED_AT)}`,
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('Kedatangan di Lokasi')).toBeInTheDocument()
    expect(
      screen.getByText(`Jadwal mulai ${formatTanggalWaktu(START)}`),
    ).toBeInTheDocument()
    expect(screen.getByText('Selesai')).toBeInTheDocument()
    expect(
      screen.getByText(`Jadwal selesai ${formatTanggalWaktu(END)}`),
    ).toBeInTheDocument()
  })

  it('completed + history penuh: tidak ada duplikasi Pengajuan, tidak ada tahap masa depan', () => {
    const history: VisitHistoryEntry[] = [
      {
        status: 'requested',
        at: CREATED_AT,
        actor_name: 'Wulan Sari',
        actor_role_label: 'Vendor/Mitra',
      },
      {
        status: 'approved',
        at: APPROVED_AT,
        actor_name: 'Siti Rahayu',
        actor_role_label: 'Admin Cabang',
      },
      {
        status: 'visiting',
        at: START,
        actor_name: 'Bagus Prakoso',
        actor_role_label: 'Petugas Keamanan',
      },
      {
        status: 'completed',
        at: END,
        actor_name: null,
        actor_role_label: null,
      },
    ]
    render(
      <Timeline
        status="completed"
        createdAt={CREATED_AT}
        startDate={START}
        endDate={END}
        history={history}
      />,
    )

    expect(screen.queryByText('Pengajuan')).not.toBeInTheDocument()
    expect(screen.getByText('Diminta')).toBeInTheDocument()
    expect(screen.getByText('Disetujui')).toBeInTheDocument()
    expect(screen.getByText('Sedang di Lokasi')).toBeInTheDocument()
    expect(screen.getByText('Selesai')).toBeInTheDocument()
    expect(screen.queryByText('Persetujuan')).not.toBeInTheDocument()
    expect(screen.queryByText('Menunggu persetujuan')).not.toBeInTheDocument()
    expect(screen.queryByText('Kedatangan di Lokasi')).not.toBeInTheDocument()
  })

  it('rejected + history [rejected] tanpa requested: Pengajuan + Status akhir + badge + status_note', () => {
    const history: VisitHistoryEntry[] = [
      {
        status: 'rejected',
        at: APPROVED_AT,
        actor_name: 'Siti Rahayu',
        actor_role_label: 'Admin Cabang',
      },
    ]
    render(
      <Timeline
        status="rejected"
        createdAt={CREATED_AT}
        startDate={START}
        endDate={END}
        history={history}
        statusNote="Berkas tidak lengkap"
      />,
    )

    expect(screen.getByText('Pengajuan')).toBeInTheDocument()
    expect(
      screen.getByText(`Diajukan ${formatTanggalWaktu(CREATED_AT)}`),
    ).toBeInTheDocument()
    expect(screen.getAllByText('Ditolak').length).toBeGreaterThanOrEqual(1)
    expect(
      screen.getByText(
        `oleh Siti Rahayu (Admin Cabang) · ${formatTanggalWaktu(APPROVED_AT)}`,
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('Status akhir')).toBeInTheDocument()
    expect(screen.getByText('Berkas tidak lengkap')).toBeInTheDocument()
  })

  it('cancelled + history [approved,cancelled]: Pengajuan sintetis + kedua baris + Status akhir', () => {
    const history: VisitHistoryEntry[] = [
      {
        status: 'approved',
        at: APPROVED_AT,
        actor_name: 'Siti Rahayu',
        actor_role_label: 'Admin Cabang',
      },
      {
        status: 'cancelled',
        at: END,
        actor_name: 'Wulan Sari',
        actor_role_label: 'Vendor/Mitra',
      },
    ]
    render(
      <Timeline
        status="cancelled"
        createdAt={CREATED_AT}
        startDate={START}
        endDate={END}
        history={history}
        statusNote="Batal oleh vendor"
      />,
    )

    expect(screen.getByText('Pengajuan')).toBeInTheDocument()
    expect(
      screen.getByText(`Diajukan ${formatTanggalWaktu(CREATED_AT)}`),
    ).toBeInTheDocument()
    expect(screen.getByText('Disetujui')).toBeInTheDocument()
    expect(screen.getAllByText('Dibatalkan').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Status akhir')).toBeInTheDocument()
  })

  it('not_visit + history [visiting,not_visit]: Pengajuan sintetis + Status akhir', () => {
    const history: VisitHistoryEntry[] = [
      {
        status: 'visiting',
        at: START,
        actor_name: 'Bagus Prakoso',
        actor_role_label: 'Petugas Keamanan',
      },
      {
        status: 'not_visit',
        at: END,
        actor_name: null,
        actor_role_label: null,
      },
    ]
    render(
      <Timeline
        status="not_visit"
        createdAt={CREATED_AT}
        startDate={START}
        endDate={END}
        history={history}
      />,
    )

    expect(screen.getByText('Pengajuan')).toBeInTheDocument()
    expect(
      screen.getByText(`Diajukan ${formatTanggalWaktu(CREATED_AT)}`),
    ).toBeInTheDocument()
    expect(screen.getByText('Sedang di Lokasi')).toBeInTheDocument()
    expect(screen.getAllByText('Tidak Hadir').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Status akhir')).toBeInTheDocument()
  })
})

describe('historyDetail — aktor null & tanpa peran', () => {
  it('actor null: hanya stempel', () => {
    expect(
      historyDetail({
        status: 'completed',
        at: APPROVED_AT,
        actor_name: null,
        actor_role_label: null,
      }),
    ).toBe(formatTanggalWaktu(APPROVED_AT))
  })

  it('actor tanpa role: tanpa kurung peran', () => {
    expect(
      historyDetail({
        status: 'approved',
        at: APPROVED_AT,
        actor_name: 'Siti Rahayu',
        actor_role_label: null,
      }),
    ).toBe(`oleh Siti Rahayu · ${formatTanggalWaktu(APPROVED_AT)}`)
  })
})
