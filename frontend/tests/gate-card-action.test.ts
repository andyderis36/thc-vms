import { describe, expect, it } from 'vitest'

import { gateCardAction } from '@/features/gate/GuestCard'

/**
 * Regresi peta aksi kartu antrean gerbang (SCR-05): kartu `rescheduled`
 * TIDAK BOLEH menawarkan aksi apa pun karena kunjungan yang dijadwalkan
 * ulang wajib disetujui ulang sebelum check-in (backend menolak
 * rescheduled->visiting). Baris `rescheduled` tetap terdaftar di antrean
 * (badge "Jadwal Digeser" + Visit ID yang bisa diklik membuka popup detail,
 * lihat `upcoming-queue.test.ts` untuk penggabungan antrean) — hanya tombol
 * aksinya yang disembunyikan sampai status kembali `approved`.
 * Murni tanpa DOM/camera: hanya memanggil helper murni dari GuestCard.
 */
describe('gateCardAction (peta aksi kartu antrean gerbang)', () => {
  it('approved menawarkan check-in', () => {
    expect(gateCardAction('approved')).toBe('check-in')
  })

  it('rescheduled tidak menawarkan aksi (menunggu persetujuan ulang)', () => {
    expect(gateCardAction('rescheduled')).toBe('none')
  })

  it('visiting menawarkan check-out', () => {
    expect(gateCardAction('visiting')).toBe('check-out')
  })

  it('completed menjadi readout netral, bukan tombol aksi', () => {
    expect(gateCardAction('completed')).toBe('completed')
  })

  it('status di luar siklus gerbang tidak menawarkan aksi', () => {
    for (const status of ['requested', 'rejected', 'cancelled', 'not_visit', 'rescheduled'] as const) {
      expect(gateCardAction(status)).toBe('none')
    }
  })
})
