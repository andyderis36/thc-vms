import { describe, expect, it } from 'vitest'

import type { Role, VisitStatus } from '@/lib/api/types'
import {
  SAME_DIRECTION_DEBOUNCE_MS,
  canCompleteVisit,
  confirmScanMessage,
  gateScanAction,
  gateStatusLabel,
  recentScanResult,
  scanResultKey,
  withScanResult,
} from './gate-status'

describe('gateScanAction — cabang aksi per status permit', () => {
  it('approved dan offsite meminta check-in', () => {
    expect(gateScanAction('approved')).toEqual({ kind: 'confirm', direction: 'in' })
    expect(gateScanAction('offsite')).toEqual({ kind: 'confirm', direction: 'in' })
  })

  it('visiting meminta check-out', () => {
    expect(gateScanAction('visiting')).toEqual({ kind: 'confirm', direction: 'out' })
  })

  it('status terminal dan menunggu approval dinonaktifkan beserta alasan', () => {
    for (const status of ['completed', 'cancelled', 'not_visit', 'rejected', 'requested', 'rescheduled']) {
      const action = gateScanAction(status as VisitStatus)
      expect(action.kind).toBe('disabled')
      if (action.kind === 'disabled') expect(action.reason.length).toBeGreaterThan(0)
    }
  })
})

describe('gateStatusLabel — label Bahasa Indonesia per status', () => {
  it('offsite memakai terminologi multi-entry yang terkunci', () => {
    expect(gateStatusLabel('offsite')).toBe('Check-out — di luar lokasi')
  })
})

describe('confirmScanMessage — salinan konfirmasi direction-aware', () => {
  const now = new Date(2026, 8, 26, 14, 32)

  it('check-in memakai kata check-in dan jam HH:mm', () => {
    expect(confirmScanMessage('in', now)).toBe('Catat check-in 14:32?')
  })

  it('check-out memakai kata check-out dan jam HH:mm', () => {
    expect(confirmScanMessage('out', now)).toBe('Catat check-out 14:32?')
  })

  it('menambahkan nol di depan jam dan menit', () => {
    expect(confirmScanMessage('in', new Date(2026, 8, 26, 9, 5))).toBe('Catat check-in 09:05?')
  })
})

describe('debounce arah-sama 5 menit', () => {
  const at = 1_000_000

  it('kunci memisahkan pasangan (visitId, direction)', () => {
    expect(scanResultKey('v1', 'in')).not.toBe(scanResultKey('v1', 'out'))
    expect(scanResultKey('v1', 'in')).not.toBe(scanResultKey('v2', 'in'))
  })

  it('mengembalikan hasil terakhir di dalam jendela 5 menit', () => {
    const map = withScanResult({}, 'v1', 'in', 'VST-1 berhasil Check-in MASUK.', at)
    expect(recentScanResult(map, 'v1', 'in', at + SAME_DIRECTION_DEBOUNCE_MS - 1)?.message).toBe(
      'VST-1 berhasil Check-in MASUK.',
    )
  })

  it('menganggap tepat 5 menit sebagai kedaluwarsa', () => {
    const map = withScanResult({}, 'v1', 'in', 'hasil', at)
    expect(recentScanResult(map, 'v1', 'in', at + SAME_DIRECTION_DEBOUNCE_MS)).toBeNull()
  })

  it('arah berbeda tidak saling menekan', () => {
    const map = withScanResult({}, 'v1', 'in', 'hasil-in', at)
    expect(recentScanResult(map, 'v1', 'out', at)).toBeNull()
  })

  it('entri baru mengganti entri lama pada kunci yang sama', () => {
    const first = withScanResult({}, 'v1', 'in', 'lama', at)
    const second = withScanResult(first, 'v1', 'in', 'baru', at + 1000)
    expect(recentScanResult(second, 'v1', 'in', at + 1000)?.message).toBe('baru')
  })
})

describe('canCompleteVisit — visibilitas tombol Selesaikan', () => {
  const staff: Role[] = ['admin', 'super_admin', 'dev-superadmin']
  const others: Role[] = ['security', 'vendor']

  it('hanya admin/super_admin pada visiting atau offsite', () => {
    for (const role of staff) {
      expect(canCompleteVisit('visiting', role)).toBe(true)
      expect(canCompleteVisit('offsite', role)).toBe(true)
    }
  })

  it('security dan vendor tidak pernah melihatnya', () => {
    for (const role of others) {
      expect(canCompleteVisit('visiting', role)).toBe(false)
      expect(canCompleteVisit('offsite', role)).toBe(false)
    }
  })

  it('status approved dan completed tidak menawarkannya', () => {
    expect(canCompleteVisit('approved', 'admin')).toBe(false)
    expect(canCompleteVisit('completed', 'super_admin')).toBe(false)
  })
})
