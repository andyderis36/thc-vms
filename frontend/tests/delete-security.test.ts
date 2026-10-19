import { describe, expect, it } from 'vitest'

import type { User } from '@/lib/api/types'
import { can } from '@/lib/auth/capabilities'
import {
  canShowDeleteSecurityUser,
  deleteSecurityUserConfirmMessage,
} from '@/features/security/components/SecurityUserModal'

const LOC_A = 'a11ce5b0-7f2d-4e5a-9c1d-0000000000a1'
const LOC_B = 'b22df6c1-8e3e-4f6b-8d2e-0000000000b2'

function securityStub(overrides: Partial<User> = {}): User {
  return {
    id: 'c9b8a7d6-5e4f-4a3b-8c2d-1e0f9a8b7c04',
    name: 'Joko Susilo',
    email: 'security.sby@thc.net.id',
    phone: '0811-3000-004',
    nik: null,
    role: 'security',
    location_id: LOC_A,
    location_name: 'Kantor Pusat THC (Surabaya)',
    status: 'active',
    type: 'internal',
    vendor_name: null,
    ...overrides,
  }
}

describe('deleteSecurity capability', () => {
  it('dimiliki super_admin dan admin saja', () => {
    expect(can('super_admin', 'deleteSecurity')).toBe(true)
    expect(can('admin', 'deleteSecurity')).toBe(true)
    expect(can('security', 'deleteSecurity')).toBe(false)
    expect(can('vendor', 'deleteSecurity')).toBe(false)
  })

  it('deleteRecords tak berubah: eksklusif super_admin', () => {
    expect(can('super_admin', 'deleteRecords')).toBe(true)
    expect(can('admin', 'deleteRecords')).toBe(false)
    expect(can('security', 'deleteRecords')).toBe(false)
    expect(can('vendor', 'deleteRecords')).toBe(false)
  })
})

describe('canShowDeleteSecurityUser', () => {
  it('super_admin melihat tombol lintas cabang', () => {
    const target = securityStub({ location_id: LOC_B })
    expect(canShowDeleteSecurityUser('super_admin', target, null)).toBe(true)
    expect(canShowDeleteSecurityUser('super_admin', target, LOC_A)).toBe(true)
  })

  it('admin melihat tombol hanya di cabangnya sendiri', () => {
    expect(canShowDeleteSecurityUser('admin', securityStub({ location_id: LOC_A }), LOC_A)).toBe(true)
    expect(canShowDeleteSecurityUser('admin', securityStub({ location_id: LOC_B }), LOC_A)).toBe(false)
  })

  it('admin tanpa lokasi tidak melihat tombol', () => {
    expect(canShowDeleteSecurityUser('admin', securityStub(), null)).toBe(false)
  })

  it('vendor/security tidak pernah melihat tombol', () => {
    const target = securityStub()
    expect(canShowDeleteSecurityUser('vendor', target, LOC_A)).toBe(false)
    expect(canShowDeleteSecurityUser('security', target, LOC_A)).toBe(false)
  })
})

describe('deleteSecurityUserConfirmMessage', () => {
  it('menyebut nama dan email pengawas', () => {
    const message = deleteSecurityUserConfirmMessage(securityStub())
    expect(message).toContain('Joko Susilo')
    expect(message).toContain('security.sby@thc.net.id')
  })
})
