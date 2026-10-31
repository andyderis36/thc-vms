import { describe, expect, it } from 'vitest'

import { visitVendorCompany } from './visit-company'

describe('visitVendorCompany - urutan menang perusahaan pengaju', () => {
  it('override manual per kunjungan menang atas segalanya', () => {
    expect(
      visitVendorCompany({
        vendor_name: 'PT Kunjungan Mandiri',
        vendor_user: { name: 'Dimas', vendor_name: 'PT Akun Vendor' },
      }),
    ).toBe('PT Kunjungan Mandiri')
  })

  it('teks override hanya-spasi dianggap kosong → perusahaan akun menang', () => {
    expect(
      visitVendorCompany({
        vendor_name: '   ',
        vendor_user: { name: 'Dimas', vendor_name: 'PT Akun Vendor' },
      }),
    ).toBe('PT Akun Vendor')
  })

  it('tanpa override → perusahaan akun vendor pengaju', () => {
    expect(
      visitVendorCompany({
        vendor_name: '',
        vendor_user: { name: 'Dimas', vendor_name: 'PT Akun Vendor' },
      }),
    ).toBe('PT Akun Vendor')
  })

  it('tanpa override dan tanpa perusahaan akun → nama pemegang akun', () => {
    expect(
      visitVendorCompany({
        vendor_name: null,
        vendor_user: { name: 'Dimas', vendor_name: null },
      }),
    ).toBe('Dimas')
  })

  it('fallback legacy `pic_user` tetap terbaca', () => {
    expect(
      visitVendorCompany({
        pic_user: { name: 'Dimas', vendor_name: 'PT Lama' },
      }),
    ).toBe('PT Lama')
  })

  it('tanpa identitas apa pun → tanda strip', () => {
    expect(visitVendorCompany({})).toBe('—')
  })
})
