import { describe, expect, it } from 'vitest'

import type { VisitDetail, VisitStatus } from '@/lib/api/types'

import { selectActiveQrVisit } from './active-qr-ticket'

const visit = (id: string, status: VisitStatus): VisitDetail =>
  ({ id, status }) as VisitDetail

describe('selectActiveQrVisit - hanya tiket yang menampilkan QR', () => {
  it('memilih `visiting` lebih dulu daripada `approved`', () => {
    expect(selectActiveQrVisit([visit('a', 'approved'), visit('v', 'visiting')])?.id).toBe('v')
  })

  it('memilih `visiting` lebih dulu daripada `offsite`', () => {
    expect(selectActiveQrVisit([visit('o', 'offsite'), visit('v', 'visiting')])?.id).toBe('v')
  })

  it('memilih `offsite` (permit aktif di luar lokasi) daripada `approved`', () => {
    expect(selectActiveQrVisit([visit('a', 'approved'), visit('o', 'offsite')])?.id).toBe('o')
  })

  it('memilih `approved` bila tidak ada `visiting`', () => {
    expect(selectActiveQrVisit([visit('r', 'requested'), visit('a', 'approved')])?.id).toBe('a')
  })

  it('TIDAK memilih pengajuan terbaru yang belum disetujui (bug Tiket QR)', () => {
    expect(selectActiveQrVisit([visit('r', 'requested')])).toBeNull()
  })

  it('mengabaikan status non-QR (rescheduled/rejected/cancelled/completed/not_visit)', () => {
    expect(
      selectActiveQrVisit([
        visit('s', 'rescheduled'),
        visit('x', 'rejected'),
        visit('c', 'cancelled'),
        visit('d', 'completed'),
        visit('n', 'not_visit'),
      ]),
    ).toBeNull()
  })

  it('null untuk daftar kosong', () => {
    expect(selectActiveQrVisit([])).toBeNull()
  })
})
