import { describe, expect, it } from 'vitest'

import { nextCameraScan, type CameraScanGateState } from '@/features/gate/ScannerPanel'

/**
 * Regresi bug one-shot pemindai gerbang (SCR-05): kunci anti-duplikat kamera
 * harus melepas kembali lewat `resetKey` (dinaikkan layar /gate saat siklus
 * pindai selesai), sehingga pindaian berikutnya — termasuk QR yang sama untuk
 * check-out — diterima tanpa memuat ulang halaman.
 */
const TERBUKA: CameraScanGateState = { locked: false, lastCode: null }

describe('nextCameraScan (kunci decode kamera gerbang)', () => {
  it('menerima kode baru dari state terbuka, trim, dan mengunci siklus', () => {
    const result = nextCameraScan(TERBUKA, '  VST-123  ')
    expect(result.accept).toBe(true)
    expect(result.state).toEqual({ locked: true, lastCode: 'VST-123' })
  })

  it('menahan SEMUA decode selama siklus masih terkunci', () => {
    const locked: CameraScanGateState = { locked: true, lastCode: 'VST-123' }
    const result = nextCameraScan(locked, 'VST-999')
    expect(result.accept).toBe(false)
    expect(result.state).toBe(locked)
  })

  it('menahan QR yang sama selama siklus belum di-reset (dedupe)', () => {
    const state: CameraScanGateState = { locked: false, lastCode: 'VST-123' }
    expect(nextCameraScan(state, 'VST-123').accept).toBe(false)
    expect(nextCameraScan(state, ' VST-123 ').accept).toBe(false)
  })

  it('menerima QR yang sama lagi setelah resetKey mengosongkan ref (regresi one-shot)', () => {
    // Siklus check-in: decode mengunci state…
    const afterScan = nextCameraScan(TERBUKA, 'VST-123').state
    expect(afterScan.locked).toBe(true)
    // …layar /gate mengangkat resetKey → effect ScannerPanel mengosongkan
    // lockRef + lastCodeRef, lalu QR yang sama dipakai untuk check-out.
    const afterReset: CameraScanGateState = { locked: false, lastCode: null }
    expect(nextCameraScan(afterReset, 'VST-123').accept).toBe(true)
  })

  it('menerima kode berbeda untuk pindaian berikutnya tanpa reset', () => {
    const state: CameraScanGateState = { locked: false, lastCode: 'VST-123' }
    const result = nextCameraScan(state, 'VST-456')
    expect(result.accept).toBe(true)
    expect(result.state.lastCode).toBe('VST-456')
  })
})
