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
  auditActorLabelHonest,
  auditBeforeAfterFieldLabel,
  auditEntityLabel,
  auditHasActiveFilter,
  auditMetadataDisplayRows,
  auditMetadataSummary,
  auditMetadataSummaryTranslated,
  auditMetadataEntriesTranslated,
  auditMetadataPairSummary,
  auditStatusPair,
  groupBeforeAfter,
  AUDIT_METADATA_KEY_LABEL,
  auditMetadataValueLabel,
  auditImpactSentence,
  auditPresetRange,
  auditSearchParams,
  auditUrlStateFromParams,
  expandAuditDateBound,
  filterVisibleAuditItems,
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

describe('filterVisibleAuditItems', () => {
  const log = (user_id: string | null): AuditLog => ({
    id: `log-${user_id ?? 'system'}`,
    user_id,
    action: 'user.create',
    entity: 'user',
    entity_id: null,
    timestamp: '2026-10-05T10:00:00+07:00',
    ip: '',
    user_agent: '',
    metadata: {},
  })
  const usersById = new Map([['actor-1', { name: 'Pusat', email: 'superadmin@thc.net.id' }]])

  it('tanpa daftar user termuat mengembalikan apa adanya (backend sudah menyaring)', () => {
    const items = [log('actor-1'), log('ghost-9'), log(null)]
    expect(filterVisibleAuditItems(items, new Map(), false)).toEqual(items)
  })

  it('membuang baris berpelaku tak terpecahkan (termasuk dev-superadmin), meloloskan sistem', () => {
    const items = [log('actor-1'), log('hidden-dev-id'), log(null)]
    expect(filterVisibleAuditItems(items, usersById, true).map((row) => row.user_id)).toEqual([
      'actor-1',
      null,
    ])
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

describe('auditActorLabelHonest', () => {
  const names = new Map([['uuid-1', { name: 'Bayu Santoso', email: 'bayu@thc.net.id' }]])
  const entry = (user_id: string | null, action: string): AuditLog => ({
    id: 'log-1',
    user_id,
    action,
    entity: 'auth',
    entity_id: null,
    timestamp: '2026-10-16T10:00:00Z',
    ip: '',
    user_agent: '',
    metadata: {},
  })

  it('aksi autentikasi tanpa sesi = Upaya masuk (tanpa sesi)', () => {
    expect(auditActorLabelHonest(entry(null, 'auth.login.failed'), names)).toBe(
      'Upaya masuk (tanpa sesi)',
    )
    expect(auditActorLabelHonest(entry(null, 'auth.login.success'), names)).toBe(
      'Upaya masuk (tanpa sesi)',
    )
  })

  it('null non-autentikasi tetap Sistem', () => {
    expect(auditActorLabelHonest(entry(null, 'user.create'), names)).toBe('Sistem')
    expect(auditActorLabelHonest(entry(null, 'visit.delete'), names)).toBe('Sistem')
  })

  it('pelaku terdaftar memakai nama dari peta user', () => {
    expect(auditActorLabelHonest(entry('uuid-1', 'user.create'), names)).toBe('Bayu Santoso')
  })

  it('pelaku tak ada di peta = Akun terhapus', () => {
    expect(auditActorLabelHonest(entry('ghost-9', 'user.delete'), names)).toBe('Akun terhapus')
    expect(
      auditActorLabelHonest(
        entry('uuid-9', 'user.create'),
        new Map([['uuid-9', { name: '', email: null }]]),
      ),
    ).toBe('Akun terhapus')
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
  it('mencakup persis 13 aksi MVP domain audit.go', () => {
    expect([...Object.keys(AUDIT_ACTION_LABEL)].sort()).toEqual(
      [
        'auth.login.failed',
        'auth.login.success',
        'location.create',
        'location.delete',
        'location.update',
        'purpose.create',
        'purpose.delete',
        'purpose.update',
        'user.create',
        'user.delete',
        'user.status',
        'user.update',
        'visit.delete',
      ].sort(),
    )
  })

  it('menutupi kelima entitas kontrak', () => {
    expect(Object.keys(AUDIT_ENTITY_LABEL).sort()).toEqual([
      'auth',
      'location',
      'purpose',
      'user',
      'visit',
    ])
  })

  it('aksi/entitas tak dikenal jatuh ke kode mentah', () => {
    expect(auditActionLabel('visit.approve')).toBe('visit.approve')
    expect(auditEntityLabel('ghost')).toBe('ghost')
  })

  it('nada mengikuti hasil aksi', () => {
    expect(auditActionTone('auth.login.success')).toBe('success')
    expect(auditActionTone('auth.login.failed')).toBe('danger')
    expect(auditActionTone('user.delete')).toBe('warning')
    expect(auditActionTone('user.create')).toBe('info')
  })

  it('label purpose sesuai kontrak', () => {
    expect(AUDIT_ACTION_LABEL['purpose.create']).toBe('Buat tujuan')
    expect(AUDIT_ACTION_LABEL['purpose.update']).toBe('Ubah tujuan')
    expect(AUDIT_ACTION_LABEL['purpose.delete']).toBe('Hapus tujuan')
    expect(AUDIT_ENTITY_LABEL['purpose']).toBe('Tujuan')
    expect(auditActionLabel('purpose.update')).toBe('Ubah tujuan')
    expect(auditEntityLabel('purpose')).toBe('Tujuan')
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

  it('login gagal tanpa sesi berlabel jujur, bukan Sistem', () => {
    expect(valueOf(baseLog, 'Pelaku')).toBe('Upaya masuk (tanpa sesi)')
  })

  it('baris sistem non-autentikasi (user_id null) berlabel Sistem', () => {
    const systemLog: AuditLog = { ...baseLog, action: 'user.create' }
    expect(valueOf(systemLog, 'Pelaku')).toBe('Sistem')
  })

  it('pelaku terhapus berlabel Akun terhapus', () => {
    const deletedLog: AuditLog = { ...baseLog, action: 'user.delete', user_id: 'ghost-9' }
    expect(valueOf(deletedLog, 'Pelaku')).toBe('Akun terhapus')
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

  it('ID Pelaku, ID Entitas, dan ID Jejak yang ditandai copyable', () => {
    const copyable = auditDetail(baseLog, new Map())
      .rows.filter((row) => row.copyable === true)
      .map((row) => row.label)
    expect(copyable).toEqual(['ID Pelaku', 'ID Entitas', 'ID Jejak'])
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

  it('round-trip ?entity=purpose&action=purpose.update', () => {
    const query = 'entity=purpose&action=purpose.update'
    const state = auditUrlStateFromParams(new URLSearchParams(query))
    expect(state.filter.entity).toBe('purpose')
    expect(state.filter.action).toBe('purpose.update')
    expect(auditSearchParams(state.filter, state.page).toString()).toBe(query)
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

describe('AUDIT_METADATA_KEY_LABEL', () => {
  it('memetakan kunci penulis ke label Indonesia', () => {
    expect(AUDIT_METADATA_KEY_LABEL.reason).toBe('Alasan')
    expect(AUDIT_METADATA_KEY_LABEL.from).toBe('Dari')
    expect(AUDIT_METADATA_KEY_LABEL.to).toBe('Ke')
    expect(AUDIT_METADATA_KEY_LABEL.fields).toBe('Kolom diubah')
    expect(AUDIT_METADATA_KEY_LABEL.role).toBe('Peran')
    expect(AUDIT_METADATA_KEY_LABEL.source).toBe('Sumber')
    expect(AUDIT_METADATA_KEY_LABEL.email).toBe('Surel')
    expect(AUDIT_METADATA_KEY_LABEL.name).toBe('Nama')
    expect(AUDIT_METADATA_KEY_LABEL.type).toBe('Jenis')
    expect(AUDIT_METADATA_KEY_LABEL.visit_code).toBe('Kode kunjungan')
    expect(AUDIT_METADATA_KEY_LABEL.phone).toBe('Telepon')
    expect(AUDIT_METADATA_KEY_LABEL.status).toBe('Status')
    expect(AUDIT_METADATA_KEY_LABEL.address).toBe('Alamat')
  })
})

describe('auditMetadataValueLabel', () => {
  it('memetakan nilai khusus', () => {
    expect(auditMetadataValueLabel('invalid_credentials')).toBe('kredensial salah')
    expect(auditMetadataValueLabel('active')).toBe('Aktif')
    expect(auditMetadataValueLabel('inactive')).toBe('Nonaktif')
    expect(auditMetadataValueLabel('vendor')).toBe('Vendor')
    expect(auditMetadataValueLabel('admin')).toBe('Admin')
    expect(auditMetadataValueLabel('super_admin')).toBe('Superadmin')
    expect(auditMetadataValueLabel('security')).toBe('Petugas jaga')
    expect(auditMetadataValueLabel('self-registration')).toBe('Pendaftaran mandiri')
  })

  it('memetakan nama field snake_case', () => {
    expect(auditMetadataValueLabel('name')).toBe('Nama')
    expect(auditMetadataValueLabel('email')).toBe('Surel')
  })

  it('nilai tak dikenal jatuh ke mentah', () => {
    expect(auditMetadataValueLabel('foo_bar')).toBe('foo_bar')
  })
})

describe('auditMetadataSummaryTranslated', () => {
  it('invalid_credentials dirender ramah', () => {
    expect(auditMetadataSummaryTranslated({ reason: 'invalid_credentials' })).toBe(
      'Alasan: kredensial salah',
    )
  })

  it('from/to dirender Dari/Ke', () => {
    expect(auditMetadataSummaryTranslated({ from: 'active', to: 'inactive' })).toBe(
      'Dari: Aktif · Ke: Nonaktif',
    )
  })

  it('fields CSV dirender nama terjemahan', () => {
    expect(auditMetadataSummaryTranslated({ fields: 'name,email,phone' })).toBe(
      'Kolom diubah: Nama, Surel, Telepon',
    )
  })

  it('kunci tak dikenal jatuh ke mentah', () => {
    expect(auditMetadataSummaryTranslated({ foo: 'bar' })).toBe('foo: bar')
  })

  it('metadata kosong berupa strip', () => {
    expect(auditMetadataSummaryTranslated({})).toBe('—')
    expect(auditMetadataSummaryTranslated(null)).toBe('—')
    expect(auditMetadataSummaryTranslated(undefined)).toBe('—')
  })
})

describe('auditMetadataEntriesTranslated', () => {
  it('mengembalikan entri dengan kunci dan nilai terjemahan', () => {
    expect(auditMetadataEntriesTranslated({ reason: 'invalid_credentials' })).toEqual([
      { key: 'Alasan', value: 'kredensial salah' },
    ])
  })

  it('from/to dirender Dari/Ke', () => {
    expect(auditMetadataEntriesTranslated({ from: 'active', to: 'inactive' })).toEqual([
      { key: 'Dari', value: 'Aktif' },
      { key: 'Ke', value: 'Nonaktif' },
    ])
  })

  it('fields CSV dirender nama terjemahan', () => {
    expect(auditMetadataEntriesTranslated({ fields: 'name,email,phone' })).toEqual([
      { key: 'Kolom diubah', value: 'Nama, Surel, Telepon' },
    ])
  })

  it('kunci tak dikenal jatuh ke mentah', () => {
    expect(auditMetadataEntriesTranslated({ foo: 'bar' })).toEqual([{ key: 'foo', value: 'bar' }])
  })
})

describe('auditImpactSentence', () => {
  const log = (overrides: Partial<AuditLog>): AuditLog => ({
    id: 'log-1',
    user_id: 'actor-1',
    action: 'user.create',
    entity: 'user',
    entity_id: 'entity-1',
    timestamp: '2026-10-16T10:00:00Z',
    ip: '',
    user_agent: '',
    metadata: {},
    ...overrides,
  })

  it('user.create', () => {
    expect(
      auditImpactSentence(
        log({ action: 'user.create', metadata: { email: 'tek@vendor.local', role: 'vendor' } }),
        'Admin Pusat',
      ),
    ).toBe('Admin Pusat membuat akun tek@vendor.local sebagai Peran Vendor')
  })

  it('location.create', () => {
    expect(
      auditImpactSentence(
        log({ action: 'location.create', entity: 'location', metadata: { name: 'POP Baru', type: 'pop' } }),
        'Admin Pusat',
      ),
    ).toBe('Admin Pusat membuat fasilitas bernama POP Baru')
  })

  it('purpose.create mirrors location wording', () => {
    expect(
      auditImpactSentence(
        log({ action: 'purpose.create', entity: 'purpose', metadata: { name: 'Survey' } }),
        'Admin Pusat',
      ),
    ).toBe('Admin Pusat membuat tujuan kunjungan bernama Survey')
  })

  it('user.status', () => {
    expect(
      auditImpactSentence(
        log({ action: 'user.status', metadata: { from: 'active', to: 'inactive' } }),
        'Admin Pusat',
      ),
    ).toBe('Admin Pusat mengubah status entity-1 dari Aktif menjadi Nonaktif')
  })

  it('visit.delete', () => {
    expect(
      auditImpactSentence(
        log({ action: 'visit.delete', entity: 'visit', metadata: { visit_code: 'VST-0000000042' } }),
        'Admin Pusat',
      ),
    ).toBe('Admin Pusat menghapus kunjungan Kode VST-0000000042')
  })

  it('auth.login.failed', () => {
    expect(
      auditImpactSentence(
        log({ action: 'auth.login.failed', user_id: null, entity: 'auth', metadata: { email: 'x@thc.net.id', reason: 'invalid_credentials' } }),
        'Upaya masuk (tanpa sesi)',
      ),
    ).toBe('Upaya masuk gagal untuk surel x@thc.net.id (kredensial salah)')
  })

  it('auth.login.success', () => {
    expect(
      auditImpactSentence(
        log({ action: 'auth.login.success', entity: 'auth', metadata: { email: 'a@thc.net.id' } }),
        'Bayu',
      ),
    ).toBe('Bayu masuk berhasil (surel a@thc.net.id)')
  })

  it('user.update with fields only (legacy)', () => {
    expect(
      auditImpactSentence(
        log({ action: 'user.update', metadata: { fields: 'name,email' } }),
        'Admin Pusat',
      ),
    ).toBe('Admin Pusat mengubah akun entity-1: Nama, Surel')
  })

  it('user.update with before/after pairs', () => {
    expect(
      auditImpactSentence(
        log({
          action: 'user.update',
          metadata: { fields: 'name', 'before.name': 'Lama', 'after.name': 'Baru' },
        }),
        'Admin Pusat',
      ),
    ).toBe('Admin Pusat mengubah akun entity-1: Nama (Dari Lama→Baru)')
  })

  it('location.update', () => {
    expect(
      auditImpactSentence(
        log({ action: 'location.update', entity: 'location', metadata: { fields: 'name', 'before.name': 'POP Lama', 'after.name': 'POP Baru' } }),
        'Admin Pusat',
      ),
    ).toBe('Admin Pusat mengubah fasilitas entity-1: Nama (Dari POP Lama→POP Baru)')
  })

  it('purpose.update', () => {
    expect(
      auditImpactSentence(
        log({ action: 'purpose.update', entity: 'purpose', metadata: { fields: 'name,is_active', 'before.name': 'Survey', 'after.name': 'Survey Lanjutan', 'before.is_active': 'true', 'after.is_active': 'false' } }),
        'Admin Pusat',
      ),
    ).toBe('Admin Pusat mengubah tujuan kunjungan entity-1: Nama, Status (Dari Survey→Survey Lanjutan)')
  })

  it('user.delete', () => {
    expect(
      auditImpactSentence(
        log({ action: 'user.delete', metadata: { email: 'admin@thc.local', role: 'admin' } }),
        'Admin Pusat',
      ),
    ).toBe('Admin Pusat menghapus akun admin@thc.local')
  })

  it('location.delete', () => {
    expect(
      auditImpactSentence(
        log({ action: 'location.delete', entity: 'location', metadata: { name: 'POP Lama', type: 'pop' } }),
        'Admin Pusat',
      ),
    ).toBe('Admin Pusat menghapus fasilitas POP Lama')
  })

  it('purpose.delete', () => {
    expect(
      auditImpactSentence(
        log({ action: 'purpose.delete', entity: 'purpose', metadata: { name: 'Survey' } }),
        'Admin Pusat',
      ),
    ).toBe('Admin Pusat menghapus tujuan kunjungan Survey')
  })

  it('unknown action fallback', () => {
    expect(
      auditImpactSentence(
        log({ action: 'visit.approve', metadata: { foo: 'bar' } }),
        'Admin Pusat',
      ),
    ).toBe('visit.approve — foo: bar')
  })

  it('missing halves render dash', () => {
    expect(
      auditImpactSentence(
        log({ action: 'user.update', metadata: { fields: 'name', 'before.name': 'Lama' } }),
        'Admin Pusat',
      ),
    ).toBe('Admin Pusat mengubah akun entity-1: Nama (Dari Lama→—)')
  })

  it('null metadata handled', () => {
    expect(
      auditImpactSentence(
        log({ action: 'visit.delete', metadata: null as unknown as Record<string, string> }),
        'Admin Pusat',
      ),
    ).toBe('Admin Pusat menghapus kunjungan Kode —')
  })
})

describe('auditBeforeAfterFieldLabel', () => {
  it('memetakan nama kolom penulis ke label Indonesia', () => {
    expect(auditBeforeAfterFieldLabel('name')).toBe('Nama')
    expect(auditBeforeAfterFieldLabel('email')).toBe('Surel')
    expect(auditBeforeAfterFieldLabel('is_active')).toBe('Status')
    expect(auditBeforeAfterFieldLabel('location_id')).toBe('Fasilitas')
  })

  it('kunci tak dikenal jatuh mentah (jangan mengarang label)', () => {
    expect(auditBeforeAfterFieldLabel('custom_field')).toBe('custom_field')
    expect(auditBeforeAfterFieldLabel('')).toBe('')
  })
})

describe('groupBeforeAfter', () => {
  it('mengelompokkan before/after per kolom mengikuti urutan CSV fields', () => {
    expect(
      groupBeforeAfter({
        fields: 'name,email',
        // Urutan kunci metadata dibalik sengaja: hasil harus ikut CSV.
        'after.email': 'baru@thc.net.id',
        'before.email': 'lama@thc.net.id',
        'after.name': 'Baru',
        'before.name': 'Lama',
      }),
    ).toEqual([
      { field: 'name', label: 'Nama', before: 'Lama', after: 'Baru' },
      {
        field: 'email',
        label: 'Surel',
        before: 'lama@thc.net.id',
        after: 'baru@thc.net.id',
      },
    ])
  })

  it('tanpa CSV fields memakai urutan kemunculan pertama kunci', () => {
    expect(
      groupBeforeAfter({ 'before.phone': '0801', 'after.phone': '0802' }).map(
        (pair) => pair.field,
      ),
    ).toEqual(['phone'])
  })

  it('anggota fields tanpa pasangan dilewati (tetap baris warisan)', () => {
    expect(
      groupBeforeAfter({
        fields: 'name,password',
        'before.name': 'Lama',
        'after.name': 'Baru',
      }),
    ).toEqual([{ field: 'name', label: 'Nama', before: 'Lama', after: 'Baru' }])
  })

  it('sisi pasangan yang hilang dirender null (pemanggil mencetak —)', () => {
    expect(groupBeforeAfter({ 'before.name': 'Lama' })).toEqual([
      { field: 'name', label: 'Nama', before: 'Lama', after: null },
    ])
    expect(groupBeforeAfter({ 'after.name': 'Baru' })).toEqual([
      { field: 'name', label: 'Nama', before: null, after: 'Baru' },
    ])
  })

  it('string kosong (sisi NULL backend) dianggap hilang', () => {
    expect(
      groupBeforeAfter({ 'before.nik': '', 'after.nik': '123' }),
    ).toEqual([{ field: 'nik', label: 'NIK', before: null, after: '123' }])
  })

  it('kolom tak dikenal jatuh mentah', () => {
    expect(
      groupBeforeAfter({ 'before.custom_field': 'a', 'after.custom_field': 'b' }),
    ).toEqual([
      { field: 'custom_field', label: 'custom_field', before: 'a', after: 'b' },
    ])
  })

  it('tanpa kunci baru menghasilkan daftar kosong', () => {
    expect(groupBeforeAfter({ fields: 'name,email' })).toEqual([])
    expect(groupBeforeAfter({ email: 'a@thc.net.id' })).toEqual([])
    expect(groupBeforeAfter({})).toEqual([])
    expect(groupBeforeAfter(null)).toEqual([])
    expect(groupBeforeAfter(undefined)).toEqual([])
  })
})

describe('auditStatusPair', () => {
  it('from/to dirender via kamus: Dari Aktif Ke Nonaktif', () => {
    expect(auditStatusPair({ from: 'active', to: 'inactive' })).toEqual({
      from: 'Aktif',
      to: 'Nonaktif',
    })
  })

  it('sisi yang hilang menjadi strip', () => {
    expect(auditStatusPair({ from: 'active' })).toEqual({ from: 'Aktif', to: '—' })
    expect(auditStatusPair({ to: 'inactive' })).toEqual({ from: '—', to: 'Nonaktif' })
  })

  it('tanpa kedua kunci = null (pemanggil jatuh ke ringkasan lama)', () => {
    expect(auditStatusPair({ email: 'a@thc.net.id' })).toBeNull()
    expect(auditStatusPair({})).toBeNull()
    expect(auditStatusPair(null)).toBeNull()
    expect(auditStatusPair(undefined)).toBeNull()
  })
})

describe('auditMetadataPairSummary', () => {
  it('tanpa kunci baru PERSIS sama dengan ringkasan terjemahan Phase-1', () => {
    const legacy: Array<Record<string, string>> = [
      {},
      { email: 'a@thc.net.id', status: 'active' },
      { fields: 'name,email,phone' },
      { foo: 'bar' },
      { reason: 'invalid_credentials' },
    ]
    for (const metadata of legacy) {
      expect(auditMetadataPairSummary(metadata)).toBe(
        auditMetadataSummaryTranslated(metadata),
      )
    }
    expect(auditMetadataPairSummary(null)).toBe('—')
    expect(auditMetadataPairSummary(undefined)).toBe('—')
  })

  it('status from/to menjadi Dari Aktif Ke Nonaktif', () => {
    expect(auditMetadataPairSummary({ from: 'active', to: 'inactive' })).toBe(
      'Dari Aktif Ke Nonaktif',
    )
  })

  it('pasangan per kolom menjadi Kolom Nama: Lama → Baru', () => {
    expect(
      auditMetadataPairSummary({
        fields: 'name',
        'before.name': 'Lama',
        'after.name': 'Baru',
      }),
    ).toBe('Kolom Nama: Lama → Baru')
  })

  it('sisi pasangan yang hilang menjadi strip', () => {
    expect(
      auditMetadataPairSummary({ fields: 'name', 'before.name': 'Lama' }),
    ).toBe('Kolom Nama: Lama → —')
  })

  it('kolom fields tanpa pasangan tetap dilaporkan (mis. kata sandi)', () => {
    expect(
      auditMetadataPairSummary({
        fields: 'name,password',
        'before.name': 'Lama',
        'after.name': 'Baru',
      }),
    ).toBe('Kolom Nama: Lama → Baru · Kolom diubah: Kata sandi')
  })

  it('kunci lain tetap ikut terjemahan setelah pasangan', () => {
    expect(
      auditMetadataPairSummary({
        fields: 'name',
        'before.name': 'Lama',
        'after.name': 'Baru',
        email: 'a@thc.net.id',
      }),
    ).toBe('Kolom Nama: Lama → Baru · Surel: a@thc.net.id')
  })
})

describe('auditMetadataDisplayRows', () => {
  it('fields warisan saja = baris Kolom diubah terjemahan (tanpa truncate)', () => {
    expect(auditMetadataDisplayRows({ fields: 'name,email' })).toEqual([
      {
        key: 'fields',
        label: 'Kolom diubah',
        value: 'Nama, Surel',
        title: 'Kolom diubah: Nama, Surel',
        truncate: false,
      },
    ])
  })

  it('tanpa kunci baru setara entri terjemahan Phase-1 (truncate false semua)', () => {
    expect(
      auditMetadataDisplayRows({ email: 'a@thc.net.id', fields: 'name' }),
    ).toEqual([
      {
        key: 'fields',
        label: 'Kolom diubah',
        value: 'Nama',
        title: 'Kolom diubah: Nama',
        truncate: false,
      },
      {
        key: 'email',
        label: 'Surel',
        value: 'a@thc.net.id',
        title: 'Surel: a@thc.net.id',
        truncate: false,
      },
    ])
  })

  it('status from/to menjadi baris Perubahan status terpotong + tooltip', () => {
    expect(auditMetadataDisplayRows({ from: 'active', to: 'inactive' })).toEqual([
      {
        key: 'from/to',
        label: 'Perubahan status',
        value: 'Dari Aktif Ke Nonaktif',
        title: 'Dari Aktif Ke Nonaktif',
        truncate: true,
      },
    ])
  })

  it('pasangan per kolom menjadi baris Kolom terpotong + tooltip penuh', () => {
    expect(
      auditMetadataDisplayRows({
        fields: 'name,is_active',
        'before.name': 'POP Lama',
        'after.name': 'POP Baru dengan nama yang sangat panjang melebihi lebar kolom modal',
        'before.is_active': 'true',
        'after.is_active': 'false',
      }),
    ).toEqual([
      {
        key: 'before.name',
        label: 'Kolom Nama',
        value:
          'POP Lama → POP Baru dengan nama yang sangat panjang melebihi lebar kolom modal',
        title:
          'Kolom Nama: POP Lama → POP Baru dengan nama yang sangat panjang melebihi lebar kolom modal',
        truncate: true,
      },
      {
        key: 'before.is_active',
        label: 'Kolom Status',
        value: 'true → false',
        title: 'Kolom Status: true → false',
        truncate: true,
      },
    ])
  })

  it('kunci terkonsumsi tak pernah bocor sebagai baris mentah', () => {
    const rows = auditMetadataDisplayRows({
      fields: 'name',
      'before.name': 'Lama',
      'after.name': 'Baru',
      from: 'active',
      to: 'inactive',
    })
    expect(rows.map((row) => row.key)).toEqual(['from/to', 'before.name'])
    expect(
      rows.every((row) => !row.key.startsWith('before.') || row.key === 'before.name'),
    ).toBe(true)
  })

  it('metadata kosong/null = nol baris (renderer menampilkan strip)', () => {
    expect(auditMetadataDisplayRows({})).toEqual([])
    expect(auditMetadataDisplayRows(null)).toEqual([])
    expect(auditMetadataDisplayRows(undefined)).toEqual([])
  })
})
