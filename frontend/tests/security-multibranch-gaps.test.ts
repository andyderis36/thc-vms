import { describe, expect, it } from 'vitest'

import type { User } from '@/lib/api/types'
import {
  canShowDeleteSecurityUser,
  mergeSecurityUsers,
  securityUserDetailLabel,
  securityUserInBranch,
  securityUserLocationLabel,
  securityUserQueryLocationIds,
} from '@/features/security/components/SecurityUserModal'
import {
  mergeUsersById,
  userAffiliationLabel,
  userAffiliationTitle,
  userBranchNames,
} from '@/features/users/managed-user-filters'

const LOC_A = 'loc-a'
const LOC_B = 'loc-b'
const LOC_C = 'loc-c'

const LOCATIONS = [
  { id: LOC_A, name: 'Cabang A' },
  { id: LOC_B, name: 'Cabang B' },
  { id: LOC_C, name: 'Cabang C' },
]

function userStub(overrides: Partial<User> = {}): User {
  return {
    id: 'usr-1',
    name: 'Agus Setiawan',
    email: 'agus@thc.id',
    phone: '08111111111',
    nik: null,
    role: 'admin',
    location_id: LOC_A,
    location_ids: undefined,
    location_name: 'Cabang A',
    status: 'active',
    type: 'internal',
    vendor_name: null,
    avatar_url: null,
    ...overrides,
  }
}

function securityStub(overrides: Partial<User> = {}): User {
  return userStub({ role: 'security', ...overrides })
}

function adminSession(overrides: Partial<User> = {}): Pick<User, 'role' | 'location_id' | 'location_ids'> {
  return {
    role: 'admin',
    location_id: LOC_A,
    location_ids: [LOC_A, LOC_B],
    ...overrides,
  }
}

describe('G1 — securityUserQueryLocationIds: admin multi-cabang query tiap cabang, bukan hanya primer', () => {
  it('super_admin -> satu query tanpa filter (undefined)', () => {
    expect(
      securityUserQueryLocationIds({ role: 'super_admin', location_id: null, location_ids: undefined }),
    ).toEqual([undefined])
  })

  it('admin dua cabang -> dua id sesuai cakupan (urut cakupan)', () => {
    expect(securityUserQueryLocationIds(adminSession())).toEqual([LOC_A, LOC_B])
  })

  it('admin satu cabang (location_ids absen) -> satu id primer', () => {
    expect(
      securityUserQueryLocationIds(adminSession({ location_ids: undefined })),
    ).toEqual([LOC_A])
  })

  it('admin cakupan kosong -> fallback satu query tanpa filter (perilaku lama)', () => {
    expect(
      securityUserQueryLocationIds(adminSession({ location_id: null, location_ids: undefined })),
    ).toEqual([undefined])
  })
})

describe('G1 — mergeSecurityUsers/mergeUsersById: dedupe per id SIS', () => {
  it('gabung dua daftar cabang dengan dedupe per id, urutan pertama menang', () => {
    const a1 = securityStub({ id: 's-1', location_id: LOC_A, location_ids: [LOC_A], location_name: 'Cabang A' })
    const b1 = securityStub({ id: 's-2', location_id: LOC_B, location_ids: [LOC_B], location_name: 'Cabang B' })
    const dup = securityStub({ id: 's-1', location_id: LOC_B, location_ids: [LOC_A, LOC_B], location_name: 'Cabang A' })
    const merged = mergeSecurityUsers([[a1], [b1, dup]])
    expect(merged.map((u) => u.id)).toEqual(['s-1', 's-2'])
    expect(merged[0]).toBe(a1)
  })

  it('generic mergeUsersById sama perilaku', () => {
    const a1 = userStub({ id: 'u-1' })
    const b1 = userStub({ id: 'u-2' })
    expect(mergeUsersById([[a1], [a1, b1]]).map((u) => u.id)).toEqual(['u-1', 'u-2'])
    expect(mergeUsersById([])).toEqual([])
    expect(mergeUsersById([[], []])).toEqual([])
  })
})

describe('G2 — guard hapus union-aware (includes, bukan === primer)', () => {
  it('admin cakupan [A,B] boleh hapus target primer B (sebelumnya === primer gagal)', () => {
    const target = securityStub({ location_id: LOC_B, location_ids: undefined })
    expect(canShowDeleteSecurityUser('admin', target, [LOC_A, LOC_B])).toBe(true)
  })

  it('admin cakupan [A] boleh hapus target union [B,A] (sekunder cocok)', () => {
    const target = securityStub({ location_id: LOC_B, location_ids: [LOC_B, LOC_A] })
    expect(canShowDeleteSecurityUser('admin', target, LOC_A)).toBe(true)
    expect(canShowDeleteSecurityUser('admin', target, [LOC_A])).toBe(true)
  })

  it('tetap menolak lintas cabang di luar union', () => {
    const target = securityStub({ location_id: LOC_C, location_ids: undefined })
    expect(canShowDeleteSecurityUser('admin', target, [LOC_A, LOC_B])).toBe(false)
    expect(canShowDeleteSecurityUser('admin', target, LOC_A)).toBe(false)
  })

  it('kompatibilitas lama string tunggal tetap jalan', () => {
    expect(canShowDeleteSecurityUser('admin', securityStub({ location_id: LOC_A }), LOC_A)).toBe(true)
    expect(canShowDeleteSecurityUser('admin', securityStub({ location_id: LOC_B }), LOC_A)).toBe(false)
  })
})

describe('G2 — branchFilter union-aware (memberMatchesBranch)', () => {
  it('target union [A,B] cocok untuk filter B walau primer A', () => {
    const member = securityStub({ location_id: LOC_A, location_ids: [LOC_A, LOC_B] })
    expect(securityUserInBranch(member, LOC_B)).toBe(true)
    expect(securityUserInBranch(member, LOC_A)).toBe(true)
    expect(securityUserInBranch(member, LOC_C)).toBe(false)
  })

  it('tanpa location_ids -> fallback [location_id]', () => {
    const member = securityStub({ location_id: LOC_A, location_ids: undefined })
    expect(securityUserInBranch(member, LOC_A)).toBe(true)
    expect(securityUserInBranch(member, LOC_B)).toBe(false)
  })
})

describe('G4 — affiliation union-aware display ("N cabang" + title)', () => {
  it('userAffiliationLabel dua cabang -> "2 cabang"', () => {
    const user = userStub({ location_id: LOC_A, location_ids: [LOC_A, LOC_B], location_name: 'Cabang A' })
    expect(userAffiliationLabel(user, LOCATIONS)).toBe('2 cabang')
    expect(userAffiliationTitle(user, LOCATIONS)).toBe('Cabang A, Cabang B')
  })

  it('satu cabang -> nama cabang (bukan "1 cabang")', () => {
    const user = userStub({ location_id: LOC_A, location_ids: undefined, location_name: 'Cabang A' })
    expect(userAffiliationLabel(user, LOCATIONS)).toBe('Cabang A')
    expect(userAffiliationTitle(user, LOCATIONS)).toBe('Cabang A')
  })

  it('tanpa katalog pun "2 cabang" tetap benar (tak tampilkan id sekunder)', () => {
    const user = userStub({ location_id: LOC_A, location_ids: [LOC_A, LOC_B], location_name: 'Cabang A' })
    expect(userBranchNames(user, LOCATIONS)).toEqual(['Cabang A', 'Cabang B'])
    expect(userAffiliationLabel(user, [])).toBe('2 cabang')
  })

  it('vendor tanpa cabang -> nama vendor', () => {
    const vendor = userStub({ role: 'vendor', location_id: null, location_ids: undefined, location_name: null, vendor_name: 'PT Lintas Fiber', type: 'external' })
    expect(userAffiliationLabel(vendor, LOCATIONS)).toBe('PT Lintas Fiber')
    expect(userAffiliationTitle(vendor, LOCATIONS)).toBe('PT Lintas Fiber')
  })

  it('securityUserLocationLabel union-aware', () => {
    const member = securityStub({ location_id: LOC_A, location_ids: [LOC_A, LOC_B], location_name: 'Cabang A' })
    expect(securityUserLocationLabel(member, LOCATIONS)).toBe('2 cabang')
    expect(securityUserDetailLabel(member, LOCATIONS)).toContain('2 cabang')
    const single = securityStub({ location_id: LOC_A, location_ids: undefined, location_name: 'Cabang A' })
    expect(securityUserLocationLabel(single, LOCATIONS)).toBe('Cabang A')
  })
})
