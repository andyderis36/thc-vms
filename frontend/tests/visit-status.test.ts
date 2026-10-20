import { describe, expect, it } from 'vitest'

import type { VisitStatus } from '@/lib/api/types'
import {
  isApprovableStatus,
  isCancelableStatus,
  isRejectableStatus,
  isReschedulableStatus,
} from '@/lib/visits/visit-status'

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

describe('isApprovableStatus', () => {
  it('mengizinkan approve untuk requested', () => {
    expect(isApprovableStatus('requested')).toBe(true)
  })

  it('mengizinkan approve untuk rescheduled (perlu persetujuan ulang setelah jadwal digeser)', () => {
    expect(isApprovableStatus('rescheduled')).toBe(true)
  })

  it.each([
    'approved',
    'visiting',
    'completed',
    'not_visit',
    'rejected',
    'cancelled',
  ] as VisitStatus[])('menolak approve untuk status %s', (status) => {
    expect(isApprovableStatus(status)).toBe(false)
  })

  it('tepat mencakup requested dan rescheduled dari seluruh status', () => {
    expect(ALL_STATUSES.filter(isApprovableStatus)).toEqual(['requested', 'rescheduled'])
  })
})

describe('isRejectableStatus', () => {
  it('mengizinkan reject untuk requested', () => {
    expect(isRejectableStatus('requested')).toBe(true)
  })

  it.each([
    'approved',
    'visiting',
    'completed',
    'not_visit',
    'rejected',
    'cancelled',
    'rescheduled',
  ] as VisitStatus[])('menolak reject untuk status %s', (status) => {
    expect(isRejectableStatus(status)).toBe(false)
  })

  it('tepat mencakup requested dari seluruh status', () => {
    expect(ALL_STATUSES.filter(isRejectableStatus)).toEqual(['requested'])
  })

  it('regresi mock contract: rescheduled TIDAK rejectable (rescheduled→rejected ilegal di backend)', () => {
    expect(isRejectableStatus('rescheduled')).toBe(false)
  })
})

describe('isReschedulableStatus', () => {
  it('mengizinkan ubah jadwal untuk requested (requested→rescheduled legal)', () => {
    expect(isReschedulableStatus('requested')).toBe(true)
  })

  it('mengizinkan ubah jadwal untuk approved (approved→rescheduled legal)', () => {
    expect(isReschedulableStatus('approved')).toBe(true)
  })

  it('mengizinkan ubah jadwal untuk rescheduled (rescheduled→rescheduled legal)', () => {
    expect(isReschedulableStatus('rescheduled')).toBe(true)
  })

  it.each([
    'visiting',
    'completed',
    'not_visit',
    'rejected',
    'cancelled',
  ] as VisitStatus[])('menolak ubah jadwal untuk status %s', (status) => {
    expect(isReschedulableStatus(status)).toBe(false)
  })

  it('tepat mencakup requested, approved, dan rescheduled dari seluruh status', () => {
    expect(ALL_STATUSES.filter(isReschedulableStatus)).toEqual([
      'requested',
      'approved',
      'rescheduled',
    ])
  })

  it('regresi mock contract: visiting TIDAK reschedulable (backend hanya mengizinkan visiting→completed)', () => {
    expect(isReschedulableStatus('visiting')).toBe(false)
  })
})

describe('isCancelableStatus', () => {
  it('mengizinkan batal untuk requested (requested→cancelled legal)', () => {
    expect(isCancelableStatus('requested')).toBe(true)
  })

  it('mengizinkan batal untuk approved (approved→cancelled legal)', () => {
    expect(isCancelableStatus('approved')).toBe(true)
  })

  it('mengizinkan batal untuk rescheduled (rescheduled→cancelled legal)', () => {
    expect(isCancelableStatus('rescheduled')).toBe(true)
  })

  it.each([
    'visiting',
    'completed',
    'not_visit',
    'rejected',
    'cancelled',
  ] as VisitStatus[])('menolak batal untuk status %s', (status) => {
    expect(isCancelableStatus(status)).toBe(false)
  })

  it('tepat mencakup requested, approved, dan rescheduled dari seluruh status', () => {
    expect(ALL_STATUSES.filter(isCancelableStatus)).toEqual([
      'requested',
      'approved',
      'rescheduled',
    ])
  })

  it('regresi mock contract: visiting TIDAK cancelable (backend hanya mengizinkan visiting→completed)', () => {
    expect(isCancelableStatus('visiting')).toBe(false)
  })
})
