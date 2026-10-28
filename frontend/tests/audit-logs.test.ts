import { describe, expect, it } from 'vitest'

import { auditActorEmail, auditDetail, formatRelativeTime } from '@/app/audit/AuditDetailModal'
import {
  AUDIT_ACTION_LABEL,
  AUDIT_ENTITY_LABEL,
  AUDIT_LIMIT_OPTIONS,
  AUDIT_MAX_LIMIT,
  AUDIT_PAGE_LIMIT,
  EMPTY_AUDIT_FILTER,
  auditActionLabel,
  auditActionTone,
  auditActorLabel,
  auditEntityLabel,
  auditHasActiveFilter,
  auditMetadataSummary,
  auditPresetRange,
  auditSearchParams,
  auditUrlStateFromParams,
  expandAuditDateBound,
  isValidAuditDate,
  isValidAuditUserId,
  normaliseAuditLimit,
  toAuditLogListParams,
  withFallbackOption,
} from '@/app/audit/page'
import type { AuditLog } from '@/lib/api/types'

describe('toAuditLogListParams', () => {
  it('hanya menyertakan page, limit, dan order saat filter kosong', () => {
    expect(toAuditLogListParams(EMPTY_AUDIT_FILTER, 1)).toEqual({
      page: 1,
      limit: AUDIT_PAGE_LIMIT,
      order: 'desc',
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
      date_from: expandAuditDateBound('2026-10-01', false),
      date_to: expandAuditDateBound('2026-10-16', true),
      page: 3,
      limit: AUDIT_PAGE_LIMIT,
      order: 'desc',
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
    ).toEqual({ page: 2, limit: AUDIT_PAGE_LIMIT, order: 'desc', action: 'user.create' })
  })

  it('membuang nilai tak valid sebagai pertahanan berlapis', () => {
    expect(
      toAuditLogListParams(
        {
          userId: 'uuid-1',
          entity: 'ghost',
          action: 'ghost.action',
          dateFrom: '2026-02-30',
          dateTo: '16-10-2026',
        },
        1,
      ),
    ).toEqual({ page: 1, limit: AUDIT_PAGE_LIMIT, order: 'desc' })
  })
})

describe('expandAuditDateBound', () => {
  it('mengubah tanggal lokal menjadi tengah malam lokal (RFC3339)', () => {
    const from = new Date(expandAuditDateBound('2026-10-01', false))
    expect(from.getFullYear()).toBe(2026)
    expect(from.getMonth()).toBe(9)
    expect(from.getDate()).toBe(1)
    expect(from.getHours()).toBe(0)
    expect(from.getMinutes()).toBe(0)
    expect(expandAuditDateBound('2026-10-01', false)).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
  })

  it('batas atas eksklusif = 00:00 lokal hari berikutnya', () => {
    const to = new Date(expandAuditDateBound('2026-10-16', true))
    expect(to.getDate()).toBe(17)
    expect(to.getHours()).toBe(0)
    const from = new Date(expandAuditDateBound('2026-10-01', false))
    expect(to.getTime() - from.getTime()).toBe(16 * 24 * 60 * 60 * 1000)
  })

  it('nilai bukan YYYY-MM-DD diteruskan apa adanya', () => {
    expect(expandAuditDateBound('2026-10-01T05:30:00Z', false)).toBe('2026-10-01T05:30:00Z')
    expect(expandAuditDateBound('2026-10-01T05:30:00Z', true)).toBe('2026-10-01T05:30:00Z')
  })
})

describe('isValidAuditUserId', () => {
  it('menerima 8-4-4-4-12 hex', () => {
    expect(isValidAuditUserId('c9b8a7d6-5e4f-4a3b-8c2d-1e0f9a8b7c02')).toBe(true)
    expect(isValidAuditUserId('C9B8A7D6-5E4F-4A3B-8C2D-1E0F9A8B7C02')).toBe(true)
  })

  it('menolak sentinel, potongan UUID, dan bentuk non-hex', () => {
    expect(isValidAuditUserId('all')).toBe(false)
    expect(isValidAuditUserId('uuid-1')).toBe(false)
    expect(isValidAuditUserId('c9b8a7d6-5e4f-4a3b')).toBe(false)
    expect(isValidAuditUserId('c9b8a7d6-5e4f-4a3b-8c2d-1e0f9a8b7c0z')).toBe(false)
    expect(isValidAuditUserId('')).toBe(false)
  })
})

describe('isValidAuditDate', () => {
  it('menerima tanggal kalender nyata', () => {
    expect(isValidAuditDate('2026-10-01')).toBe(true)
    expect(isValidAuditDate('2024-02-29')).toBe(true)
  })

  it('menolak tanggal yang bergulir (round-trip check) dan format lain', () => {
    expect(isValidAuditDate('2026-02-30')).toBe(false)
    expect(isValidAuditDate('2026-13-01')).toBe(false)
    expect(isValidAuditDate('2026-04-31')).toBe(false)
    expect(isValidAuditDate('16-10-2026')).toBe(false)
    expect(isValidAuditDate('2026-1-1')).toBe(false)
    expect(isValidAuditDate('')).toBe(false)
  })
})

describe('withFallbackOption', () => {
  it('tidak mengubah opsi untuk nilai kosong atau sentinel all', () => {
    expect(withFallbackOption(AUDIT_LIMIT_OPTIONS, '', '37 baris')).toBe(AUDIT_LIMIT_OPTIONS)
    expect(withFallbackOption(AUDIT_LIMIT_OPTIONS, 'all', 'Semua Pelaku')).toBe(
      AUDIT_LIMIT_OPTIONS,
    )
  })

  it('tidak menggandakan nilai yang sudah ada', () => {
    expect(withFallbackOption(AUDIT_LIMIT_OPTIONS, '50', 'Lima puluh')).toBe(
      AUDIT_LIMIT_OPTIONS,
    )
  })

  it('menambahkan tepat satu opsi fallback untuk nilai asing', () => {
    const options = withFallbackOption(AUDIT_LIMIT_OPTIONS, '37', '37 baris')
    expect(options).toHaveLength(AUDIT_LIMIT_OPTIONS.length + 1)
    expect(options.at(-1)).toEqual({ value: '37', label: '37 baris' })
    expect(options.slice(0, -1)).toEqual(AUDIT_LIMIT_OPTIONS)
    expect(AUDIT_LIMIT_OPTIONS).toHaveLength(4)
  })

  it('menambahkan opsi fallback untuk pelaku yang tak ada di daftar', () => {
    const actorOptions = [{ value: 'all', label: 'Semua Pelaku' }]
    const options = withFallbackOption(
      actorOptions,
      'c9b8a7d6-5e4f-4a3b-8c2d-1e0f9a8b7c02',
      'c9b8a7d6',
    )
    expect(options).toEqual([
      { value: 'all', label: 'Semua Pelaku' },
      { value: 'c9b8a7d6-5e4f-4a3b-8c2d-1e0f9a8b7c02', label: 'c9b8a7d6' },
    ])
    expect(actorOptions).toHaveLength(1)
  })
})

describe('auditHasActiveFilter', () => {
  it('filter kosong tanpa kata kunci tidak aktif', () => {
    expect(auditHasActiveFilter(EMPTY_AUDIT_FILTER, '')).toBe(false)
    expect(auditHasActiveFilter(EMPTY_AUDIT_FILTER, '   ')).toBe(false)
  })

  it('kata kunci berisi teks membuat filter aktif', () => {
    expect(auditHasActiveFilter(EMPTY_AUDIT_FILTER, 'admin')).toBe(true)
  })
})

describe('auditActorLabel', () => {
  const names = new Map([['uuid-1', { name: 'Bayu Santoso', email: 'bayu@thc.net.id' }]])

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

describe('auditActorEmail', () => {
  const names = new Map([['uuid-1', { name: 'Bayu Santoso', email: 'bayu@thc.net.id' }]])

  it('mengambil email dari peta user', () => {
    expect(auditActorEmail('uuid-1', names)).toBe('bayu@thc.net.id')
  })

  it('user tak dikenal atau tanpa email menjadi strip', () => {
    expect(auditActorEmail('c9b8a7d6-5e4f-4a3b', names)).toBe('—')
    expect(
      auditActorEmail('uuid-2', new Map([['uuid-2', { name: 'Tanpa Email', email: null }]])),
    ).toBe('—')
  })

  it('baris sistem (null) menjadi strip', () => {
    expect(auditActorEmail(null, names)).toBe('—')
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

describe('auditDetail', () => {
  // Record kasar: baris sistem, ip/user-agent/id-entity kosong, metadata nol.
  const baseLog: AuditLog = {
    id: 'log-1',
    user_id: null,
    action: 'auth.login.failed',
    entity: 'auth',
    entity_id: null,
    timestamp: '2026-10-16T10:00:00Z',
    ip: '',
    user_agent: '',
    metadata: {},
  }

  const valueOf = (log: AuditLog, label: string): string | undefined =>
    auditDetail(log, new Map()).rows.find((row) => row.label === label)?.value

  it('mencakup seluruh baris wajib detail', () => {
    expect(auditDetail(baseLog, new Map()).rows.map((row) => row.label)).toEqual([
      'Aksi',
      'Kode aksi',
      'Pelaku',
      'ID Pelaku',
      'Email Pelaku',
      'Entitas',
      'ID Entitas',
      'Waktu',
      'Waktu relatif',
      'Alamat IP',
      'User Agent',
      'ID Jejak',
    ])
  })

  it('baris sistem (user_id null) berlabel Sistem', () => {
    expect(valueOf(baseLog, 'Pelaku')).toBe('Sistem')
  })

  it('pelaku terdaftar memakai nama dari peta user', () => {
    const withActor: AuditLog = { ...baseLog, user_id: 'uuid-1' }
    const detail = auditDetail(
      withActor,
      new Map([['uuid-1', { name: 'Bayu Santoso', email: 'bayu@thc.net.id' }]]),
    )
    expect(detail.rows.find((row) => row.label === 'Pelaku')?.value).toBe('Bayu Santoso')
    expect(detail.rows.find((row) => row.label === 'Email Pelaku')?.value).toBe(
      'bayu@thc.net.id',
    )
  })

  it('email pelaku kosong/tak dikenal menjadi strip', () => {
    expect(valueOf(baseLog, 'Email Pelaku')).toBe('—')
  })

  it('hanya ID Pelaku dan ID Jejak yang ditandai copyable', () => {
    const copyable = auditDetail(baseLog, new Map())
      .rows.filter((row) => row.copyable === true)
      .map((row) => row.label)
    expect(copyable).toEqual(['ID Pelaku', 'ID Jejak'])
  })

  it('ip, user_agent, dan id entitas kosong menjadi strip', () => {
    expect(valueOf(baseLog, 'Alamat IP')).toBe('—')
    expect(valueOf(baseLog, 'User Agent')).toBe('—')
    expect(valueOf(baseLog, 'ID Entitas')).toBe('—')
  })

  it('aksi memakai label Indonesia sedangkan kode aksi tetap mentah', () => {
    expect(valueOf(baseLog, 'Aksi')).toBe('Masuk gagal')
    expect(valueOf(baseLog, 'Kode aksi')).toBe('auth.login.failed')
  })

  it('metadata kosong menghasilkan daftar entri kosong (renderer menampilkan strip)', () => {
    expect(auditDetail(baseLog, new Map()).metadata).toEqual([])
  })

  it('menyertakan setiap pasangan kunci→nilai metadata', () => {
    const withMetadata: AuditLog = {
      ...baseLog,
      metadata: { email: 'a@thc.net.id', status: 'active' },
    }
    expect(auditDetail(withMetadata, new Map()).metadata).toEqual([
      { key: 'email', value: 'a@thc.net.id' },
      { key: 'status', value: 'active' },
    ])
  })
})

describe('toAuditLogListParams — pencarian, urutan, dan limit', () => {
  it('meneruskan q yang sudah di-trim bersama order asc dan limit pilihan', () => {
    expect(
      toAuditLogListParams(
        { ...EMPTY_AUDIT_FILTER, q: '  admin ', order: 'asc', limit: 100 },
        1,
      ),
    ).toEqual({ page: 1, limit: 100, order: 'asc', q: 'admin' })
  })

  it('membuang q berisi spasi saja dan memakai default halaman', () => {
    expect(toAuditLogListParams({ ...EMPTY_AUDIT_FILTER, q: '   ' }, 2)).toEqual({
      page: 2,
      limit: AUDIT_PAGE_LIMIT,
      order: 'desc',
    })
  })
})

describe('normaliseAuditLimit', () => {
  it('memakai default saat nilai tidak valid', () => {
    expect(normaliseAuditLimit(null)).toBe(AUDIT_PAGE_LIMIT)
    expect(normaliseAuditLimit('abc')).toBe(AUDIT_PAGE_LIMIT)
  })

  it('menjepit ke batas server 1..200', () => {
    expect(normaliseAuditLimit('0')).toBe(1)
    expect(normaliseAuditLimit('9999')).toBe(AUDIT_MAX_LIMIT)
    expect(normaliseAuditLimit('100')).toBe(100)
  })
})

describe('auditUrlStateFromParams / auditSearchParams', () => {
  it('URL kosong = filter awal + halaman 1', () => {
    expect(auditUrlStateFromParams(new URLSearchParams(''))).toEqual({
      filter: EMPTY_AUDIT_FILTER,
      page: 1,
    })
  })

  it('memulihkan seluruh filter dari URL', () => {
    const state = auditUrlStateFromParams(
      new URLSearchParams(
        'user_id=c9b8a7d6-5e4f-4a3b-8c2d-1e0f9a8b7c02&entity=user&action=user.create&from=2026-10-01&to=2026-10-16&q=admin&order=asc&limit=100&page=3',
      ),
    )
    expect(state).toEqual({
      filter: {
        userId: 'c9b8a7d6-5e4f-4a3b-8c2d-1e0f9a8b7c02',
        entity: 'user',
        action: 'user.create',
        dateFrom: '2026-10-01',
        dateTo: '2026-10-16',
        q: 'admin',
        order: 'asc',
        limit: 100,
      },
      page: 3,
    })
  })

  it('memetakan user_id yang bukan UUID valid ke sentinel all', () => {
    const state = auditUrlStateFromParams(new URLSearchParams('user_id=uuid-1'))
    expect(state.filter.userId).toBe('all')
    expect(auditHasActiveFilter(state.filter, '')).toBe(false)
  })

  it('membuang tanggal yang tidak ada di kalender atau berformat salah', () => {
    const impossible = auditUrlStateFromParams(
      new URLSearchParams('from=2026-02-30&to=2026-10-16'),
    )
    expect(impossible.filter.dateFrom).toBe('')
    expect(impossible.filter.dateTo).toBe('2026-10-16')

    const wrongFormat = auditUrlStateFromParams(
      new URLSearchParams('from=16-10-2026'),
    )
    expect(wrongFormat.filter.dateFrom).toBe('')

    const outOfRange = auditUrlStateFromParams(
      new URLSearchParams('from=2026-13-45&to=abc'),
    )
    expect(outOfRange.filter.dateFrom).toBe('')
    expect(outOfRange.filter.dateTo).toBe('')
  })

  it('mempertahankan rentang tanggal terbalik apa adanya tanpa menukarnya', () => {
    const query = 'from=2099-01-02&to=2099-01-01'
    const state = auditUrlStateFromParams(new URLSearchParams(query))
    expect(state.filter.dateFrom).toBe('2099-01-02')
    expect(state.filter.dateTo).toBe('2099-01-01')
    expect(auditHasActiveFilter(state.filter, '')).toBe(true)
    expect(auditSearchParams(state.filter, state.page).toString()).toBe(query)
  })

  it('memangkas q dan menuliskannya kembali tanpa spasi', () => {
    const state = auditUrlStateFromParams(new URLSearchParams({ q: ' admin ' }))
    expect(state.filter.q).toBe('admin')
    expect(auditSearchParams(state.filter, state.page).toString()).toBe('q=admin')
  })

  it('membuang entitas/aksi di luar himpunan tertutup', () => {
    const state = auditUrlStateFromParams(
      new URLSearchParams('entity=ghost&action=ghost.action'),
    )
    expect(state.filter.entity).toBe('')
    expect(state.filter.action).toBe('')
  })

  it('mempertahankan limit di luar opsi, lalu menyediakan opsi fallback', () => {
    const state = auditUrlStateFromParams(new URLSearchParams('limit=37'))
    expect(state.filter.limit).toBe(37)
    const options = withFallbackOption(
      AUDIT_LIMIT_OPTIONS,
      String(state.filter.limit),
      '37 baris',
    )
    expect(options).toHaveLength(AUDIT_LIMIT_OPTIONS.length + 1)
    expect(options.at(-1)).toEqual({ value: '37', label: '37 baris' })
  })

  it('menulis URL ringkas: nilai default tidak ditulis', () => {
    expect(auditSearchParams(EMPTY_AUDIT_FILTER, 1).toString()).toBe('')
    expect(
      auditSearchParams(
        { ...EMPTY_AUDIT_FILTER, q: ' admin ', order: 'asc', limit: 100 },
        4,
      ).toString(),
    ).toBe('q=admin&order=asc&limit=100&page=4')
  })

  it('bolak-balik URL → state → URL stabil', () => {
    const query = 'entity=user&q=admin&order=asc&limit=100&page=2'
    const state = auditUrlStateFromParams(new URLSearchParams(query))
    expect(auditSearchParams(state.filter, state.page).toString()).toBe(query)
  })
})

describe('auditPresetRange', () => {
  const now = new Date(2026, 9, 27, 15, 30)

  it('hari ini memakai tanggal yang sama untuk kedua batas', () => {
    expect(auditPresetRange(1, now)).toEqual({
      dateFrom: '2026-10-27',
      dateTo: '2026-10-27',
    })
  })

  it('7 hari dihitung inklusif hari ini', () => {
    expect(auditPresetRange(7, now)).toEqual({
      dateFrom: '2026-10-21',
      dateTo: '2026-10-27',
    })
  })
})

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-10-27T12:00:00Z')

  it('di bawah satu menit = baru saja', () => {
    expect(formatRelativeTime('2026-10-27T11:59:40Z', now)).toBe('baru saja')
  })

  it('menit dan jam', () => {
    expect(formatRelativeTime('2026-10-27T11:55:00Z', now)).toBe('5 menit lalu')
    expect(formatRelativeTime('2026-10-27T09:00:00Z', now)).toBe('3 jam lalu')
  })

  it('hari sampai seminggu', () => {
    expect(formatRelativeTime('2026-10-25T12:00:00Z', now)).toBe('2 hari lalu')
  })

  it('lebih dari seminggu memakai format absolut (tanpa kata lalu)', () => {
    expect(formatRelativeTime('2026-10-01T12:00:00Z', now)).not.toContain('lalu')
  })
})
