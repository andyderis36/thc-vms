import { describe, expect, it } from 'vitest'

import {
  VENDOR_NAME_MAX_LENGTH,
  isBlank,
  resolveVendorInput,
} from '@/lib/visits/vendor-input'

const vendors = [
  { id: 'vnd_lintas', name: 'PT Lintas Fiber' },
  { id: 'vnd_daya', name: 'PT Daya Power Mandiri' },
]

describe('isBlank', () => {
  it('menangani kosong, null, undefined, dan spasi', () => {
    expect(isBlank('')).toBe(true)
    expect(isBlank('   ')).toBe(true)
    expect(isBlank(null)).toBe(true)
    expect(isBlank(undefined)).toBe(true)
  })

  it('false untuk teks berisi', () => {
    expect(isBlank('PT Lintas Fiber')).toBe(false)
    expect(isBlank(' a ')).toBe(false)
  })
})

describe('resolveVendorInput', () => {
  it('kosong / hanya spasi → {} (tidak kirim field)', () => {
    expect(resolveVendorInput('', vendors)).toEqual({})
    expect(resolveVendorInput('   ', vendors)).toEqual({})
    expect(resolveVendorInput(null, vendors)).toEqual({})
    expect(resolveVendorInput(undefined, vendors)).toEqual({})
  })

  it('nama terdaftar persis → vendor_id', () => {
    expect(resolveVendorInput('PT Lintas Fiber', vendors)).toEqual({
      vendor_id: 'vnd_lintas',
    })
    expect(resolveVendorInput('PT Daya Power Mandiri', vendors)).toEqual({
      vendor_id: 'vnd_daya',
    })
  })

  it('nama terdaftar beda huruf besar/kecil + spasi tepi → tetap vendor_id', () => {
    expect(resolveVendorInput('pt lintas fiber', vendors)).toEqual({
      vendor_id: 'vnd_lintas',
    })
    expect(resolveVendorInput('  PT LINTAS FIBER  ', vendors)).toEqual({
      vendor_id: 'vnd_lintas',
    })
  })

  it('nama tak terdaftar → vendor_name (teks manual, trim)', () => {
    expect(resolveVendorInput('PT Foo Baru', vendors)).toEqual({
      vendor_name: 'PT Foo Baru',
    })
    expect(resolveVendorInput('  PT Foo Baru  ', vendors)).toEqual({
      vendor_name: 'PT Foo Baru',
    })
  })

  it('teks manual >120 karakter ditolak FE → {}', () => {
    const tooLong = 'Vendor Manual '.padEnd(VENDOR_NAME_MAX_LENGTH + 1, 'x')
    expect(tooLong.length).toBeGreaterThan(VENDOR_NAME_MAX_LENGTH)
    expect(resolveVendorInput(tooLong, vendors)).toEqual({})
    expect(resolveVendorInput(tooLong, [])).toEqual({})
  })

  it('teks manual tepat 120 karakter tetap diterima', () => {
    const exact = 'V'.repeat(VENDOR_NAME_MAX_LENGTH)
    expect(resolveVendorInput(exact, vendors)).toEqual({
      vendor_name: exact,
    })
  })

  it('vendor_id menang ketika teks cocok dengan katalog', () => {
    const resolved = resolveVendorInput('PT Lintas Fiber', vendors)
    expect(resolved.vendor_id).toBe('vnd_lintas')
    expect(resolved.vendor_name).toBeUndefined()
  })

  it('katalog kosong → semua teks non-blank jadi vendor_name', () => {
    expect(resolveVendorInput('PT Lintas Fiber', [])).toEqual({
      vendor_name: 'PT Lintas Fiber',
    })
  })
})
