import { describe, expect, it } from 'vitest'

import { isQrVisible } from '@/components/layouts/PicMobileShell'
import type { VisitStatus } from '@/lib/api/types'

/** Seluruh anggota union `VisitStatus`: uji harus tetap exhaustif bila status baru ditambah. */
const ALL_STATUSES: VisitStatus[] = [
  'requested',
  'approved',
  'visiting',
  'completed',
  'not_visit',
  'rejected',
  'cancelled',
  'rescheduled',
]

describe('isQrVisible', () => {
  it('menampilkan QR untuk approved (check-in)', () => {
    expect(isQrVisible('approved')).toBe(true)
  })

  it('menampilkan QR untuk visiting (check-out, QR yang sama)', () => {
    expect(isQrVisible('visiting')).toBe(true)
  })

  it('menyembunyikan QR untuk rescheduled (wajib disetujui ulang sebelum check-in)', () => {
    expect(isQrVisible('rescheduled')).toBe(false)
  })

  it.each([
    'requested',
    'completed',
    'not_visit',
    'rejected',
    'cancelled',
    'rescheduled',
  ] as VisitStatus[])('menyembunyikan QR untuk status %s', (status) => {
    expect(isQrVisible(status)).toBe(false)
  })

  it('tepat mencakup approved dan visiting dari seluruh status', () => {
    expect(ALL_STATUSES.filter(isQrVisible)).toEqual(['approved', 'visiting'])
  })
})
