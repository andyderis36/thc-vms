import { describe, expect, it } from 'vitest'

import type { VisitorItem } from '@/lib/api/types'
import {
  countOnSiteTechnicians,
  ON_SITE_COUNT_PARAMS,
} from '@/lib/visits/on-site-count'

function technician(name: string): VisitorItem {
  return {
    id: `visitor-${name}`,
    name,
    id_number: '1234567890123456',
    phone: '08123456789',
    id_card_photo_url: null,
    vendor_name: 'PT Mitra Jaringan',
  }
}

function visit(...technicians: VisitorItem[]): { visitors: VisitorItem[] } {
  return { visitors: technicians }
}

describe('countOnSiteTechnicians', () => {
  it('nol saat tidak ada kunjungan on-site', () => {
    expect(countOnSiteTechnicians([])).toBe(0)
  })

  it('menjumlahkan teknisi dari seluruh kunjungan on-site', () => {
    const visits = [visit(technician('A'), technician('B')), visit(technician('C'))]
    expect(countOnSiteTechnicians(visits)).toBe(3)
  })

  it('menghitung teknisi, bukan baris kunjungan', () => {
    // Satu kunjungan dengan tiga teknisi = 3 orang di lokasi, bukan 1 baris.
    const visits = [visit(technician('A'), technician('B'), technician('C'))]
    expect(countOnSiteTechnicians(visits)).toBe(3)
  })

  it('kunjungan tanpa teknisi tidak menambah angka', () => {
    expect(countOnSiteTechnicians([visit()])).toBe(0)
  })

  it('aman terhadap visitors yang null/undefined', () => {
    const visits = [{ visitors: undefined }, { visitors: null }] as unknown as {
      visitors: VisitorItem[]
    }[]
    expect(countOnSiteTechnicians(visits)).toBe(0)
  })
})

describe('ON_SITE_COUNT_PARAMS', () => {
  it('selalu meminta status visiting (Sedang di Lokasi)', () => {
    expect(ON_SITE_COUNT_PARAMS.status).toBe('visiting')
  })

  it('tidak membawa filter tab — badge tidak boleh bergantung pada tab/filter', () => {
    expect(ON_SITE_COUNT_PARAMS).not.toHaveProperty('q')
    expect(ON_SITE_COUNT_PARAMS).not.toHaveProperty('date_from')
    expect(ON_SITE_COUNT_PARAMS).not.toHaveProperty('date_to')
  })

  it('hanya satu halaman agar seluruh on-site terhitung', () => {
    expect(ON_SITE_COUNT_PARAMS.page).toBe(1)
    expect(ON_SITE_COUNT_PARAMS.limit).toBeLessThanOrEqual(100)
  })
})
