import { describe, expect, it } from 'vitest'

import {
  AUDIT_ACTION_LABEL,
  AUDIT_ENTITY_LABEL,
  AUDIT_PAGE_LIMIT,
  EMPTY_AUDIT_FILTER,
  auditActionLabel,
  auditActionTone,
  auditActorLabel,
  auditEntityLabel,
  auditMetadataSummary,
  toAuditLogListParams,
} from '@/app/audit/page'

describe('toAuditLogListParams', () => {
  it('hanya menyertakan page dan limit saat filter kosong', () => {
    expect(toAuditLogListParams(EMPTY_AUDIT_FILTER, 1)).toEqual({
      page: 1,
      limit: AUDIT_PAGE_LIMIT,
    })
  })

  it('meneruskan semua filter terisi beserta page/limit', () => {
    expect(
      toAuditLogListParams(
        {
          userId: 'c9b8a7d6-5e4f-4a3b-8c2d-1e0f9a8b7c02',
          entity: 'user',
          action: 'user.create',
          dateFrom: '2026-10-01',
          dateTo: '2026-10-16',
        },
        3,
      ),
    ).toEqual({
      user_id: 'c9b8a7d6-5e4f-4a3b-8c2d-1e0f9a8b7c02',
      entity: 'user',
      action: 'user.create',
      date_from: '2026-10-01',
      date_to: '2026-10-16',
      page: 3,
      limit: AUDIT_PAGE_LIMIT,
    })
  })

  it('membuang whitespace, string kosong, dan sentinel all', () => {
    expect(
      toAuditLogListParams(
        {
          userId: ' all ',
          entity: '  ',
          action: ' user.create ',
          dateFrom: '',
          dateTo: '   ',
        },
        2,
      ),
    ).toEqual({ page: 2, limit: AUDIT_PAGE_LIMIT, action: 'user.create' })
  })
})

describe('auditActorLabel', () => {
  const names = new Map([['uuid-1', 'Bayu Santoso']])

  it('baris sistem (null) berlabel Sistem', () => {
    expect(auditActorLabel(null, names)).toBe('Sistem')
  })

  it('mengambil nama dari peta user', () => {
    expect(auditActorLabel('uuid-1', names)).toBe('Bayu Santoso')
  })

  it('user yang tak ada di peta memakai 8 karakter pertama UUID', () => {
    expect(auditActorLabel('c9b8a7d6-5e4f-4a3b', names)).toBe('c9b8a7d6')
  })
})

describe('auditMetadataSummary', () => {
  it('metadata kosong berupa strip', () => {
    expect(auditMetadataSummary({})).toBe('—')
  })

  it('merangkai entri kunci→nilai dengan pemisah', () => {
    expect(auditMetadataSummary({ email: 'a@thc.net.id', status: 'active' })).toBe(
      'email: a@thc.net.id · status: active',
    )
  })
})

describe('label & nada aksi', () => {
  it('mencakup persis 10 aksi MVP domain audit.go', () => {
    expect([...Object.keys(AUDIT_ACTION_LABEL)].sort()).toEqual(
      [
        'auth.login.failed',
        'auth.login.success',
        'location.create',
        'location.delete',
        'location.update',
        'user.create',
        'user.delete',
        'user.status',
        'user.update',
        'visit.delete',
      ].sort(),
    )
  })

  it('menutupi keempat entitas kontrak', () => {
    expect(Object.keys(AUDIT_ENTITY_LABEL).sort()).toEqual([
      'auth',
      'location',
      'user',
      'visit',
    ])
  })

  it('aksi/entitas tak dikenal jatuh ke kode mentah', () => {
    expect(auditActionLabel('visit.approve')).toBe('visit.approve')
    expect(auditEntityLabel('purpose')).toBe('purpose')
  })

  it('nada mengikuti hasil aksi', () => {
    expect(auditActionTone('auth.login.success')).toBe('success')
    expect(auditActionTone('auth.login.failed')).toBe('danger')
    expect(auditActionTone('user.delete')).toBe('warning')
    expect(auditActionTone('user.create')).toBe('info')
  })
})
