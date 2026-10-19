import { describe, expect, it } from 'vitest'

import type { Location, User } from '@/lib/api/types'
import {
  LOCATION_TYPE_LABEL,
  applyFacilityFilters,
  isLocationActive,
  locationTypeFormOptions,
} from '@/app/facilities/page'
import {
  applyManagedUserFilters,
  managedVendorOptions,
  requiresManagedLocation,
  toManagedUserListParams,
  userAffiliationLabel,
} from '@/app/users/page'

function locationStub(overrides: Partial<Location> = {}): Location {
  return {
    id: 'a11ce5b0-7f2d-4e5a-9c1d-0000000000a1',
    name: 'Kantor Cabang Malang',
    type: 'cabang',
    address: 'Jl. Ijen No. 12, Malang',
    city: 'Malang',
    timezone: 'WIB',
    ...overrides,
  }
}

function userStub(overrides: Partial<User> = {}): User {
  return {
    id: 'c9b8a7d6-5e4f-4a3b-8c2d-1e0f9a8b7c02',
    name: 'Bayu Santoso',
    email: 'admin.sby@thc.net.id',
    phone: '0811-3000-002',
    nik: null,
    role: 'admin',
    location_id: 'a11ce5b0-7f2d-4e5a-9c1d-0000000000a1',
    location_name: 'Kantor Cabang Malang',
    status: 'active',
    type: 'internal',
    vendor_name: null,
    ...overrides,
  }
}

describe('isLocationActive', () => {
  it('memaknai absen is_active sebagai aktif (payload lama/seed)', () => {
    const { is_active: _dropped, ...withoutFlag } = locationStub({ is_active: true })
    void _dropped
    expect(isLocationActive(withoutFlag)).toBe(true)
  })

  it('menghormati flag true dan false', () => {
    expect(isLocationActive(locationStub({ is_active: true }))).toBe(true)
    expect(isLocationActive(locationStub({ is_active: false }))).toBe(false)
  })
})

describe('LOCATION_TYPE_LABEL', () => {
  it('memetakan keempat tipe ke Bahasa Indonesia', () => {
    expect(LOCATION_TYPE_LABEL).toEqual({
      pusat: 'Kantor Pusat',
      cabang: 'Kantor Cabang',
      pop: 'POP',
      minipop: 'miniPOP',
    })
  })
})

describe('applyFacilityFilters', () => {
  const rows = [
    locationStub({ id: 'loc-1', name: 'Kantor Cabang Malang', city: 'Malang' }),
    locationStub({ id: 'loc-2', name: 'POP Sawojajar', city: 'Malang' }),
    locationStub({ id: 'loc-3', name: 'POP Rungkut Industri', city: 'Surabaya' }),
  ]

  it('sentinel all + query kosong mengembalikan semua', () => {
    expect(applyFacilityFilters(rows, { search: '', branchId: 'all' })).toHaveLength(3)
  })

  it('memfilter per cabang dari switcher shell', () => {
    const result = applyFacilityFilters(rows, { search: '', branchId: 'loc-2' })
    expect(result.map((row) => row.id)).toEqual(['loc-2'])
  })

  it('mencari per nama atau kota (case-insensitive, trim)', () => {
    expect(
      applyFacilityFilters(rows, { search: '  sawojajar ', branchId: 'all' }).map((row) => row.id),
    ).toEqual(['loc-2'])
    expect(
      applyFacilityFilters(rows, { search: 'surabaya', branchId: 'all' }).map((row) => row.id),
    ).toEqual(['loc-3'])
  })

  it('menggabungkan branch + search', () => {
    expect(
      applyFacilityFilters(rows, { search: 'malang', branchId: 'loc-3' }),
    ).toHaveLength(0)
  })

  it('menggabungkan filter tipe dan status aktif (opsional)', () => {
    const withFlags = [
      locationStub({ id: 'loc-1', type: 'cabang', is_active: true }),
      locationStub({ id: 'loc-2', type: 'pop', is_active: false }),
      locationStub({ id: 'loc-3', type: 'pop', is_active: true }),
    ]
    expect(
      applyFacilityFilters(withFlags, { search: '', branchId: 'all', type: 'pop' }).map((row) => row.id),
    ).toEqual(['loc-2', 'loc-3'])
    expect(
      applyFacilityFilters(withFlags, { search: '', branchId: 'all', status: 'active' }).map((row) => row.id),
    ).toEqual(['loc-1', 'loc-3'])
    expect(
      applyFacilityFilters(withFlags, { search: '', branchId: 'all', status: 'inactive' }).map((row) => row.id),
    ).toEqual(['loc-2'])
  })
})

describe('locationTypeFormOptions', () => {
  const pusatRow = locationStub({ id: 'loc-pusat', name: 'Kantor Pusat THC', type: 'pusat' })

  it('create: menyembunyikan pusat saat kantor pusat sudah ada', () => {
    const options = locationTypeFormOptions([pusatRow, locationStub({ id: 'loc-1' })])
    expect(options.map((option) => option.value)).toEqual(['cabang', 'pop', 'minipop'])
  })

  it('create: kantor pusat NONAKTIF tetap dihitung (query aktif + nonaktif)', () => {
    const options = locationTypeFormOptions([
      locationStub({ id: 'loc-pusat', type: 'pusat', is_active: false }),
    ])
    expect(options.map((option) => option.value)).toEqual(['cabang', 'pop', 'minipop'])
  })

  it('create: menawarkan pusat bila belum ada kantor pusat', () => {
    expect(
      locationTypeFormOptions([locationStub({ id: 'loc-1' })]).map((option) => option.value),
    ).toEqual(['pusat', 'cabang', 'pop', 'minipop'])
    expect(locationTypeFormOptions([]).map((option) => option.value)).toContain('pusat')
  })

  it('edit: baris non-pusat tetap tanpa opsi pusat saat kantor pusat ada', () => {
    const options = locationTypeFormOptions(
      [pusatRow, locationStub({ id: 'loc-1' })],
      locationStub({ id: 'loc-1' }),
    )
    expect(options.map((option) => option.value)).toEqual(['cabang', 'pop', 'minipop'])
  })

  it('edit: baris kantor pusat itu sendiri tetap menawarkan pusat', () => {
    const options = locationTypeFormOptions([pusatRow], pusatRow)
    expect(options.map((option) => option.value)).toContain('pusat')
    expect(options.find((option) => option.value === 'pusat')?.label).toBe('Kantor Pusat')
  })
})

describe('requiresManagedLocation', () => {
  it('wajib iff admin, sembunyi iff vendor', () => {
    expect(requiresManagedLocation('admin')).toBe(true)
    expect(requiresManagedLocation('vendor')).toBe(false)
  })
})

describe('userAffiliationLabel', () => {
  it('mengutamakan nama cabang', () => {
    expect(userAffiliationLabel(userStub())).toBe('Kantor Cabang Malang')
  })

  it('jatuh ke nama vendor untuk Vendor/Mitra tanpa cabang', () => {
    expect(
      userAffiliationLabel(
        userStub({ role: 'vendor', location_id: null, location_name: null, vendor_name: 'PT Lintas Fiber' }),
      ),
    ).toBe('PT Lintas Fiber')
  })

  it('strip bila tidak ada keduanya', () => {
    expect(
      userAffiliationLabel(userStub({ location_name: null, vendor_name: null })),
    ).toBe('—')
  })
})

describe('toManagedUserListParams', () => {
  it('menghilangkan string kosong dan sentinel all', () => {
    expect(toManagedUserListParams({ role: '', search: '  ', locationId: 'all' })).toEqual({})
  })

  it('meneruskan filter yang terisi (search di-trim)', () => {
    expect(
      toManagedUserListParams({ role: 'admin', search: ' bayu ', locationId: 'loc-1' }),
    ).toEqual({ role: 'admin', search: 'bayu', location_id: 'loc-1' })
  })
})

describe('managedVendorOptions', () => {
  it('nama vendor unik non-kosong dari peran vendor, terurut, diawali sentinel', () => {
    const rows = [
      userStub({ role: 'vendor', vendor_name: 'PT Lintas Fiber' }),
      userStub({ role: 'vendor', vendor_name: 'PT Lintas Fiber' }),
      userStub({ role: 'vendor', vendor_name: 'CV Andalan' }),
      userStub({ role: 'vendor', vendor_name: null }),
      userStub({ role: 'admin', vendor_name: 'PT Admin Co' }),
    ]
    expect(managedVendorOptions(rows)).toEqual([
      { value: 'all', label: 'Semua Vendor' },
      { value: 'CV Andalan', label: 'CV Andalan' },
      { value: 'PT Lintas Fiber', label: 'PT Lintas Fiber' },
    ])
  })

  it('input kosong hanya mengembalikan sentinel', () => {
    expect(managedVendorOptions([])).toEqual([{ value: 'all', label: 'Semua Vendor' }])
  })
})

describe('applyManagedUserFilters', () => {
  const rows = [
    userStub({ id: 'u1', role: 'admin', status: 'active', vendor_name: null }),
    userStub({ id: 'u2', role: 'vendor', status: 'inactive', vendor_name: 'PT Lintas Fiber' }),
    userStub({ id: 'u3', role: 'vendor', status: 'blacklisted', vendor_name: 'CV Andalan' }),
    userStub({ id: 'u4', role: 'security', status: 'active', vendor_name: null }),
  ]

  it('membuang security; tanpa filter mengembalikan sisanya (urutan tetap)', () => {
    expect(applyManagedUserFilters(rows, { status: 'all', vendor: 'all' }).map((u) => u.id)).toEqual([
      'u1',
      'u2',
      'u3',
    ])
  })

  it('memfilter per status', () => {
    expect(applyManagedUserFilters(rows, { status: 'inactive', vendor: 'all' }).map((u) => u.id)).toEqual(['u2'])
    expect(applyManagedUserFilters(rows, { status: 'blacklisted', vendor: 'all' }).map((u) => u.id)).toEqual(['u3'])
    expect(applyManagedUserFilters(rows, { status: 'active', vendor: 'all' }).map((u) => u.id)).toEqual(['u1'])
  })

  it('memfilter per vendor exact-match (bukan substring)', () => {
    expect(
      applyManagedUserFilters(rows, { status: 'all', vendor: 'PT Lintas Fiber' }).map((u) => u.id),
    ).toEqual(['u2'])
    expect(applyManagedUserFilters(rows, { status: 'all', vendor: 'Lintas' })).toEqual([])
  })

  it('menggabungkan status dan vendor', () => {
    expect(
      applyManagedUserFilters(rows, { status: 'inactive', vendor: 'PT Lintas Fiber' }).map((u) => u.id),
    ).toEqual(['u2'])
    expect(applyManagedUserFilters(rows, { status: 'blacklisted', vendor: 'PT Lintas Fiber' })).toEqual([])
  })
})
