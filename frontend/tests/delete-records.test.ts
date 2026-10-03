import { describe, expect, it } from 'vitest'

import type { Location, User } from '@/lib/api/types'
import { can } from '@/lib/auth/capabilities'
import { deleteLocationConfirmMessage } from '@/app/facilities/page'
import {
  canShowDeleteUser,
  deleteUserConfirmMessage,
  isDeletableUser,
} from '@/app/users/page'
import { deleteVisitConfirmMessage } from '@/app/visits/[id]/page'

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

describe('deleteRecords capability', () => {
  it('hanya super_admin yang boleh hapus permanen', () => {
    expect(can('super_admin', 'deleteRecords')).toBe(true)
    expect(can('admin', 'deleteRecords')).toBe(false)
    expect(can('security', 'deleteRecords')).toBe(false)
    expect(can('vendor', 'deleteRecords')).toBe(false)
  })
})

describe('isDeletableUser', () => {
  it('menyembunyikan baris akun sendiri', () => {
    const me = userStub()
    expect(isDeletableUser(me, me.id)).toBe(false)
  })

  it('menyembunyikan baris super_admin', () => {
    expect(
      isDeletableUser(userStub({ id: 'other', role: 'super_admin' }), 'me-id'),
    ).toBe(false)
  })

  it('mengizinkan baris admin/vendor lain', () => {
    expect(isDeletableUser(userStub({ id: 'u-1' }), 'me-id')).toBe(true)
    expect(
      isDeletableUser(userStub({ id: 'u-2', role: 'vendor' }), 'me-id'),
    ).toBe(true)
  })
})

describe('canShowDeleteUser', () => {
  it('admin tidak pernah melihat tombol hapus walau baris boleh dihapus', () => {
    const target = userStub({ id: 'u-1' })
    expect(canShowDeleteUser('admin', target, 'me-id')).toBe(false)
  })

  it('super_admin melihat tombol hapus untuk baris yang boleh dihapus', () => {
    const target = userStub({ id: 'u-1' })
    expect(canShowDeleteUser('super_admin', target, 'me-id')).toBe(true)
  })

  it('super_admin tetap tidak melihat tombol untuk diri sendiri & super_admin', () => {
    const me = userStub({ id: 'me-id' })
    expect(canShowDeleteUser('super_admin', me, 'me-id')).toBe(false)
    expect(
      canShowDeleteUser(
        'super_admin',
        userStub({ id: 'u-9', role: 'super_admin' }),
        'me-id',
      ),
    ).toBe(false)
  })
})

describe('pesan konfirmasi hapus', () => {
  it('menyebut visit_id kunjungan', () => {
    expect(deleteVisitConfirmMessage('VST-2026SBY001')).toContain('VST-2026SBY001')
  })

  it('menyebut nama user dan email', () => {
    const message = deleteUserConfirmMessage(userStub())
    expect(message).toContain('Bayu Santoso')
    expect(message).toContain('admin.sby@thc.net.id')
  })

  it('menyebut nama fasilitas', () => {
    expect(deleteLocationConfirmMessage(locationStub())).toContain(
      'Kantor Cabang Malang',
    )
  })
})
