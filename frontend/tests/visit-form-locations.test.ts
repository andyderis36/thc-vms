import { describe, expect, it } from 'vitest'

import type { Location, User } from '@/lib/api/types'
import { scopeLocationOptions, scopeLocations, isLocationScopeUnresolved } from '@/lib/visits/location-scope'

/*
 * Spec HOLE-1 — isolasi dropdown "Fasilitas Tujuan" (SCR-03).
 *
 * Arah keputusan: filter di frontend memakai cakupan sesi
 * `location_ids ?? [location_id]` (model hibrida multi-cabang; lihat
 * `DECISION-hole-1-location-scope.md`). Helper pemurni:
 *
 *     scopeLocationOptions(locations, user): SelectOption[]
 *     scopeLocations(locations, user): Location[]
 *
 * Kontrak: `admin`/`security` -> hanya lokasi dalam cakupan sesi;
 * `super_admin` -> seluruh lokasi (daftar nasional); `vendor` -> tidak diubah.
 */

// --- Fixture: katalog lokasi nasional (3 lokasi lintas cabang) ---------------

const LOC_A_ID = 'loc-a-cabang'
const LOC_B_ID = 'loc-b-pop'
const LOC_C_ID = 'loc-c-minipop'

const LOCATIONS: Location[] = [
  {
    id: LOC_A_ID,
    name: 'Kantor Cabang A',
    type: 'cabang',
    address: 'Jl. Merdeka No. 1',
    city: 'Malang',
    timezone: 'WIB',
    is_active: true,
  },
  {
    id: LOC_B_ID,
    name: 'POP B',
    type: 'pop',
    address: 'Jl. Industri No. 2',
    city: 'Surabaya',
    timezone: 'WIB',
    is_active: true,
  },
  {
    id: LOC_C_ID,
    name: 'miniPOP C',
    type: 'minipop',
    address: 'Jl. Tembok No. 3',
    city: 'Kediri',
    timezone: 'WIB',
    is_active: true,
  },
]

// --- Fixture: pengguna per peran ---------------------------------------------

function userStub(overrides: Partial<User>): User {
  return {
    id: 'usr-000',
    name: 'Pengguna Uji',
    email: 'uji@thc.net.id',
    phone: '0811-000-000',
    nik: null,
    role: 'admin',
    location_id: null,
    location_name: null,
    status: 'active',
    type: 'internal',
    vendor_name: null,
    avatar_url: null,
    ...overrides,
  }
}

/** Admin cabang LOC-A — terisolasi ke satu lokasi. */
const adminAtLocA = userStub({ role: 'admin', location_id: LOC_A_ID, location_name: 'Kantor Cabang A' })

/** Security pos LOC-A — scoping identik dengan admin cabang. */
const securityAtLocA = userStub({ role: 'security', location_id: LOC_A_ID, location_name: 'Kantor Cabang A' })

/** Super admin kantor pusat — akses nasional lintas cabang. */
const superAdmin = userStub({ role: 'super_admin', location_id: null, location_name: null })

// --- Assertion penuh ---------------------------------------------------------

describe('scopeLocationOptions — isolasi dropdown Fasilitas Tujuan', () => {
  it('admin LOC-A -> tepat 1 opsi enabled LOC-A', () => {
    const options = scopeLocationOptions(LOCATIONS, adminAtLocA)
    expect(options).toHaveLength(1)
    expect(options[0]?.value).toBe(LOC_A_ID)
    expect(options[0]?.label).toContain('Kantor Cabang A')
    expect(options.some((option) => option.value === LOC_B_ID)).toBe(false)
  })

  it('security sama seperti admin', () => {
    const options = scopeLocationOptions(LOCATIONS, securityAtLocA)
    expect(options).toHaveLength(1)
    expect(options[0]?.value).toBe(LOC_A_ID)
    expect(options.some((option) => option.value === LOC_B_ID)).toBe(false)
    expect(options.some((option) => option.value === LOC_C_ID)).toBe(false)
  })

  it('super_admin -> daftar nasional >1', () => {
    const options = scopeLocationOptions(LOCATIONS, superAdmin)
    expect(options.length).toBeGreaterThan(1)
    expect(options.map((option) => option.value)).toEqual([LOC_A_ID, LOC_B_ID, LOC_C_ID])
  })

  it('vendor -> tidak difilter (katalog utuh)', () => {
    const vendorUser = userStub({ role: 'vendor', location_id: null })
    const options = scopeLocationOptions(LOCATIONS, vendorUser)
    expect(options.map((option) => option.value)).toEqual([LOC_A_ID, LOC_B_ID, LOC_C_ID])
  })

  it('admin/security dengan location_id null -> daftar kosong (katalog tidak bocor)', () => {
    const unresolvedAdmin = userStub({ role: 'admin', location_id: null })
    expect(scopeLocationOptions(LOCATIONS, unresolvedAdmin)).toEqual([])
    const unresolvedSecurity = userStub({ role: 'security', location_id: null })
    expect(scopeLocationOptions(LOCATIONS, unresolvedSecurity)).toEqual([])
  })
})

// --- Cakupan multi-cabang: location_ids[] -------------------------------

/** Admin dengan cakupan DUA cabang (model hibrida: primary + union). */
const adminMultiBranch = userStub({
  role: 'admin',
  location_id: LOC_A_ID,
  location_ids: [LOC_A_ID, LOC_B_ID],
  location_name: 'Kantor Cabang A',
})

describe('scopeLocations — cakupan sesi location_ids ?? [location_id]', () => {
  it('admin multi-cabang -> hanya entri cakupan (A+B), C tak pernah bocor', () => {
    const visible = scopeLocations(LOCATIONS, adminMultiBranch)
    expect(visible.map((location) => location.id)).toEqual([LOC_A_ID, LOC_B_ID])
    expect(visible.some((location) => location.id === LOC_C_ID)).toBe(false)
  })

  it('admin tanpa location_ids -> fallback [location_id] (satu cabang)', () => {
    const visible = scopeLocations(LOCATIONS, adminAtLocA)
    expect(visible.map((location) => location.id)).toEqual([LOC_A_ID])
  })

  it('admin multi-cabang dengan location_id null -> tetap ter-scope oleh location_ids', () => {
    const odd = userStub({
      role: 'admin',
      location_id: null,
      location_ids: [LOC_B_ID, LOC_C_ID],
    })
    expect(scopeLocations(LOCATIONS, odd).map((location) => location.id)).toEqual([
      LOC_B_ID,
      LOC_C_ID,
    ])
    expect(isLocationScopeUnresolved(odd)).toBe(false)
  })

  it('super_admin & vendor -> katalog utuh (tak tersentuh scoping)', () => {
    expect(scopeLocations(LOCATIONS, superAdmin)).toHaveLength(3)
    const vendorUser = userStub({ role: 'vendor', location_id: null })
    expect(scopeLocations(LOCATIONS, vendorUser)).toHaveLength(3)
  })

  it('scopeLocationOptions multi-cabang -> opsi hanya A+B (dengan label kota)', () => {
    const options = scopeLocationOptions(LOCATIONS, adminMultiBranch)
    expect(options.map((option) => option.value)).toEqual([LOC_A_ID, LOC_B_ID])
    expect(options.some((option) => option.value === LOC_C_ID)).toBe(false)
    expect(options[0]?.label).toContain('Kantor Cabang A')
  })

  it('cakupan kosong -> isLocationScopeUnresolved true (input terkunci)', () => {
    expect(isLocationScopeUnresolved(userStub({ role: 'admin', location_id: null }))).toBe(true)
    expect(isLocationScopeUnresolved(adminMultiBranch)).toBe(false)
    expect(isLocationScopeUnresolved(superAdmin)).toBe(false)
  })
})

// --- Label builder: de-duplikasi kota ---------------------------------------

/** Bangun satu Location untuk pengujian format label. */
function locationLabel(name: string, city: string, id = 'loc-x'): Location {
  return {
    id,
    name,
    type: 'cabang',
    address: 'Jl. Uji No. 1',
    city,
    timezone: 'WIB',
    is_active: true,
  }
}

describe('scopeLocationOptions — label kota tidak duplikat', () => {
  it('(a) nama sudah memuat kota sebagai suffix -> tanpa suffix', () => {
    const options = scopeLocationOptions(
      [locationLabel('Kantor Cabang Sambas', 'Sambas')],
      superAdmin,
    )
    expect(options[0]?.label).toBe('Kantor Cabang Sambas')
  })

  it('(b) kota di dalam tanda kurung -> tanpa suffix', () => {
    const options = scopeLocationOptions(
      [locationLabel('Kantor Pusat THC (Pontianak)', 'Pontianak')],
      superAdmin,
    )
    expect(options[0]?.label).toBe('Kantor Pusat THC (Pontianak)')
  })

  it('(c) city berbeda dari nama -> suffix informatif tetap muncul', () => {
    const options = scopeLocationOptions(
      [locationLabel('miniPOP Aruk', 'Sambas')],
      superAdmin,
    )
    expect(options[0]?.label).toBe('miniPOP Aruk — Sambas')
  })

  it('(d) city kosong -> label nama polos tanpa pemisah menggantung', () => {
    const options = scopeLocationOptions([locationLabel('POP Tanpa Kota', '')], superAdmin)
    expect(options[0]?.label).toBe('POP Tanpa Kota')
    expect(options[0]?.label).not.toContain('—')
  })

  it('(e) scoping admin/security tidak berubah', () => {
    const options = scopeLocationOptions(
      [locationLabel('Kantor Cabang A', 'Malang', LOC_A_ID), locationLabel('POP B', 'Surabaya', LOC_B_ID)],
      adminAtLocA,
    )
    expect(options).toHaveLength(1)
    expect(options[0]?.value).toBe(LOC_A_ID)
  })
})
