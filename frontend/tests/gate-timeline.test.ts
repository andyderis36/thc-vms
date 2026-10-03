import { describe, expect, it } from 'vitest'

import { formatTanggalWaktu, gateDetail } from '@/features/visits/detail/Timeline'

const START = '2026-09-26T09:00:00+07:00'
const END = '2026-09-26T17:00:00+07:00'
const CHECK_IN = '2026-09-26T14:30:00+07:00'
const CHECK_OUT = '2026-09-26T16:45:00+07:00'

describe('gateDetail', () => {
  it('memakai stempel aktual saat check-in sudah terjadi', () => {
    expect(gateDetail('Masuk', CHECK_IN, START)).toBe(`Masuk ${formatTanggalWaktu(CHECK_IN)}`)
  })

  it('memakai stempel aktual saat check-out sudah terjadi', () => {
    expect(gateDetail('Keluar', CHECK_OUT, END)).toBe(`Keluar ${formatTanggalWaktu(CHECK_OUT)}`)
  })

  it('mundur ke teks jadwal saat belum check-in (null/undefined/kosong)', () => {
    for (const empty of [null, undefined, ''] as const) {
      expect(gateDetail('Masuk', empty, START)).toBe(`Jadwal mulai ${formatTanggalWaktu(START)}`)
      expect(gateDetail('Keluar', empty, END)).toBe(`Jadwal selesai ${formatTanggalWaktu(END)}`)
    }
  })

  it('tidak pernah menghasilkan Invalid Date untuk stempel rusak', () => {
    expect(gateDetail('Masuk', 'bukan-tanggal', START)).toBe('Masuk bukan-tanggal')
  })
})
