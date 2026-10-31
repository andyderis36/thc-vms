import { describe, expect, it } from 'vitest'

import type { Location, User } from '@/lib/api/types'
import { paginate } from '@/lib/pagination'
import {
  LOCATION_TYPE_LABEL,
  applyFacilityFilters,
  isLocationActive,
  locationTypeFormOptions,
} from '@/app/facilities/page'
import {
  DEV_SUPERADMIN_EMAIL,
  USER_FILTER_DEP_KEYS,
  applyManagedUserFilters,
  canShowDeleteUser,
  effectiveManagedRoles,
  filterManagedUsersByRoles,
  isDeletableUser,
  isHiddenDevUser,
  isProtectedUser,
  managedCreateRole,
  managedLocationFilterApplies,
  managedRoleFilterOptions,
  managedServerRoleParam,
  managedVendorOptions,
  parseManagedRoleFilter,
  requiresManagedLocation,
  shouldResetUserPage,
  toManagedUserListParams,
  userAffiliationLabel,
  type UserFilterSnapshot,
} from '@/features/users/managed-user-filters'

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
    avatar_url: null,
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

describe('filter peran di kolom "Peran"', () => {
  const COORDINATOR_ROLES = ['admin', 'super_admin'] as const

  it('opsi filter = "Semua Peran" + satu entri per peran halaman', () => {
    expect(managedRoleFilterOptions([...COORDINATOR_ROLES])).toEqual([
      { value: '', label: 'Semua Peran' },
      { value: 'admin', label: 'Koordinator Wilayah' },
      { value: 'super_admin', label: 'Superadmin' },
    ])
  })

  it('opsi filter peran vendor memakai label aplikasi', () => {
    expect(managedRoleFilterOptions(['vendor'])).toEqual([
      { value: '', label: 'Semua Peran' },
      { value: 'vendor', label: 'Vendor/Mitra' },
    ])
  })

  it('nilai select tak dikenal jatuh ke "Semua Peran"', () => {
    expect(parseManagedRoleFilter('')).toBe('')
    expect(parseManagedRoleFilter('admin')).toBe('admin')
    expect(parseManagedRoleFilter('vendor')).toBe('vendor')
    expect(parseManagedRoleFilter('super_admin')).toBe('super_admin')
    expect(parseManagedRoleFilter('security')).toBe('')
    expect(parseManagedRoleFilter('nonsense')).toBe('')
  })

  it('peran efektif = seluruh peran halaman saat filter "Semua Peran"', () => {
    expect(effectiveManagedRoles([...COORDINATOR_ROLES], '')).toEqual(['admin', 'super_admin'])
  })

  it('peran efektif = satu peran saat superadmin memfilter', () => {
    expect(effectiveManagedRoles([...COORDINATOR_ROLES], 'super_admin')).toEqual(['super_admin'])
    expect(effectiveManagedRoles([...COORDINATOR_ROLES], 'admin')).toEqual(['admin'])
  })

  it('peran di luar halaman tak pernah jadi peran efektif', () => {
    expect(effectiveManagedRoles(['vendor'], 'admin')).toEqual(['vendor'])
  })

  it('halaman satu peran yang bisa difilter server meminta ?role=-nya', () => {
    expect(managedServerRoleParam(['vendor'])).toBe('vendor')
    expect(managedServerRoleParam(['admin'])).toBe('admin')
  })

  it('halaman >1 peran requesting TANPA ?role= (backend menolak super_admin)', () => {
    expect(managedServerRoleParam([...COORDINATOR_ROLES])).toBe('')
    expect(managedServerRoleParam(['super_admin'])).toBe('')
    expect(
      toManagedUserListParams({ role: managedServerRoleParam([...COORDINATOR_ROLES]), search: '', locationId: 'all' }),
    ).toEqual({})
  })

  it('menyaring baris ke set peran efektif dan membuang security', () => {
    const rows = [
      userStub({ id: 'u-admin', role: 'admin' }),
      userStub({ id: 'u-super', role: 'super_admin', location_id: null, location_name: null }),
      userStub({ id: 'u-vendor', role: 'vendor', vendor_name: 'PT Lintas Fiber' }),
      userStub({ id: 'u-security', role: 'security' }),
    ]
    expect(filterManagedUsersByRoles(rows, [...COORDINATOR_ROLES]).map((u) => u.id)).toEqual([
      'u-admin',
      'u-super',
    ])
    expect(filterManagedUsersByRoles(rows, ['super_admin']).map((u) => u.id)).toEqual(['u-super'])
  })

  it('tombol tambah memakai peran yang bisa dibuat backend', () => {
    expect(managedCreateRole([...COORDINATOR_ROLES], '')).toBe('admin')
    expect(managedCreateRole([...COORDINATOR_ROLES], 'admin')).toBe('admin')
    expect(managedCreateRole([...COORDINATOR_ROLES], 'super_admin')).toBeNull()
    expect(managedCreateRole(['vendor'], '')).toBe('vendor')
  })

  it('filter cabang hanya berlaku bila peran efektif memuat admin', () => {
    expect(managedLocationFilterApplies([...COORDINATOR_ROLES])).toBe(true)
    expect(managedLocationFilterApplies(['admin'])).toBe(true)
    expect(managedLocationFilterApplies(['super_admin'])).toBe(false)
    expect(managedLocationFilterApplies(['vendor'])).toBe(false)
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

describe('dev-superadmin tersembunyi (hidden highest role)', () => {
  const hidden = userStub({
    id: 'u-dev',
    role: 'dev-superadmin',
    location_id: null,
    location_name: null,
  })
  const admin = userStub({ id: 'u-admin', role: 'admin' })

  it('filterManagedUsersByRoles selalu membuang dev-superadmin', () => {
    expect(
      filterManagedUsersByRoles([admin, hidden], ['admin', 'super_admin']).map((u) => u.id),
    ).toEqual(['u-admin'])
    expect(filterManagedUsersByRoles([hidden], ['super_admin'])).toEqual([])
  })

  it('applyManagedUserFilters selalu membuang dev-superadmin', () => {
    expect(
      applyManagedUserFilters([admin, hidden], { status: 'all', vendor: 'all' }).map((u) => u.id),
    ).toEqual(['u-admin'])
  })

  it('parseManagedRoleFilter memetakan dev-superadmin ke "Semua Peran" (tak terkirim ke server)', () => {
    expect(parseManagedRoleFilter('dev-superadmin')).toBe('')
  })

  it('akun tersembunyi dilindungi dari aksi merusak untuk semua pemanggil', () => {
    expect(isProtectedUser(hidden, 'me-id')).toBe(true)
    expect(isProtectedUser(hidden, null)).toBe(true)
    expect(isDeletableUser(hidden, 'me-id')).toBe(false)
    expect(canShowDeleteUser('super_admin', hidden, 'me-id')).toBe(false)
    expect(canShowDeleteUser('dev-superadmin', hidden, 'me-id')).toBe(false)
  })
})

describe('email-fallback hiding (drifted prod account)', () => {
  const lower = userStub({
    id: 'u-drift-lower',
    role: 'super_admin',
    email: 'dev-superadmin@transhybrid.net.id',
    location_id: null,
    location_name: null,
  })
  const upper = userStub({
    id: 'u-drift-upper',
    role: 'super_admin',
    email: 'DEV-SUPERADMIN@TRANSHYBRID.NET.ID',
    location_id: null,
    location_name: null,
  })
  const control = userStub({
    id: 'u-control',
    role: 'super_admin',
    email: 'superadmin@thc.net.id',
    location_id: null,
    location_name: null,
  })

  it('DEV_SUPERADMIN_EMAIL diekspor dengan nilai yang diharapkan', () => {
    expect(DEV_SUPERADMIN_EMAIL).toBe('dev-superadmin@transhybrid.net.id')
  })

  it('isHiddenDevUser mendeteksi drift via email (case-insensitive)', () => {
    expect(isHiddenDevUser(lower)).toBe(true)
    expect(isHiddenDevUser(upper)).toBe(true)
    expect(isHiddenDevUser(control)).toBe(false)
  })

  it('filterManagedUsersByRoles membuang drift lower & upper, mempertahankan control', () => {
    const rows = [control, lower, upper]
    expect(filterManagedUsersByRoles(rows, ['super_admin']).map((u) => u.id)).toEqual(['u-control'])
    expect(filterManagedUsersByRoles(rows, ['admin', 'super_admin']).map((u) => u.id)).toEqual(['u-control'])
  })

  it('applyManagedUserFilters membuang drift lower & upper, mempertahankan control', () => {
    const rows = [control, lower, upper]
    expect(applyManagedUserFilters(rows, { status: 'all', vendor: 'all' }).map((u) => u.id)).toEqual([
      'u-control',
    ])
  })
})

describe('shouldResetUserPage (kontrak reset halaman)', () => {
  const base: UserFilterSnapshot = {
    roleFilter: 'admin',
    locationId: 'loc-1',
    search: 'bayu',
    statusFilter: 'active',
    vendorFilter: 'PT Lintas Fiber',
    pageSize: 10,
  }

  it('mengubah salah satu nilai penentu mensinyalkan reset ke halaman 1', () => {
    expect(shouldResetUserPage(base, { ...base, roleFilter: 'vendor' })).toBe(true)
    expect(shouldResetUserPage(base, { ...base, roleFilter: '' })).toBe(true)
    expect(shouldResetUserPage(base, { ...base, locationId: 'all' })).toBe(true)
    expect(shouldResetUserPage(base, { ...base, search: 'santoso' })).toBe(true)
    expect(shouldResetUserPage(base, { ...base, statusFilter: 'blacklisted' })).toBe(true)
    expect(shouldResetUserPage(base, { ...base, vendorFilter: 'CV Andalan' })).toBe(true)
    expect(shouldResetUserPage(base, { ...base, pageSize: 50 })).toBe(true)
  })

  it('nilai penentu yang tak berubah tidak mensinyalkan reset', () => {
    expect(shouldResetUserPage(base, { ...base })).toBe(false)
    expect(shouldResetUserPage(base, base)).toBe(false)
  })

  it('USER_FILTER_DEP_KEYS tepat memuat keenam nilai penentu halaman', () => {
    expect([...USER_FILTER_DEP_KEYS]).toEqual([
      'roleFilter',
      'locationId',
      'search',
      'statusFilter',
      'vendorFilter',
      'pageSize',
    ])
  })
})

describe('pagination daftar user (kontrak halaman)', () => {
  const rows = Array.from({ length: 25 }, (_, index) => index + 1)

  it('25 baris terfilter pada pageSize 10: halaman 3 = 5 item, totalPages 3', () => {
    const result = paginate(rows, 3, 10)
    expect(result.items).toEqual([21, 22, 23, 24, 25])
    expect(result.items).toHaveLength(5)
    expect(result.page).toBe(3)
    expect(result.totalPages).toBe(3)
  })

  it('halaman basi 9 pada daftar 3 halaman di-clamp ke 3 beserta itemnya', () => {
    const result = paginate(rows, 9, 10)
    expect(result.page).toBe(3)
    expect(result.totalPages).toBe(3)
    expect(result.items).toEqual([21, 22, 23, 24, 25])
  })
})
