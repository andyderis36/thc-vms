import { describe, expect, it } from 'vitest'

import type { VisitStatus } from '@/lib/api/types'
import { isApprovableStatus, isRejectableStatus } from '@/lib/visits/visit-status'

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
