import { describe, expect, it } from 'vitest'

import type {
  MemberSuggestion,
  MemberSuggestionDetail,
  VendorSuggestion,
} from '@/lib/api/types'
import {
  MAX_MEMBER_SUGGESTION_OPTIONS,
  MAX_VENDOR_SUGGESTION_OPTIONS,
  SUGGESTION_QUERY_MAX_LENGTH,
  clampSuggestionQuery,
  memberSuggestionLabel,
  mergeSuggestionNames,
  toMemberSuggestionOptions,
  toMemberSuggestionPatch,
} from './suggestions'

describe('memberSuggestionLabel - baris saran anggota (nama, jabatan, email)', () => {
  const base: MemberSuggestion = {
    visitor_id: 'visitor-1',
    name: 'Budi Santoso',
    id_number: '3578010100000001',
    phone: '081234567890',
    email: 'budi@vendor.test',
    jabatan: 'Teknisi FO',
    last_visit_at: '2026-11-01T10:00:00+07:00',
    source_visit_id: 'visit-1',
  }

  it('menampilkan nama, jabatan, dan email berurutan', () => {
    expect(memberSuggestionLabel(base)).toBe('Budi Santoso · Teknisi FO · budi@vendor.test')
  })

  it('melewati atribut kosong yang tidak membantu pemilihan', () => {
    expect(memberSuggestionLabel({ ...base, jabatan: '', email: null })).toBe(
      'Budi Santoso · 081234567890',
    )
    expect(memberSuggestionLabel({ ...base, email: null })).toBe(
      'Budi Santoso · Teknisi FO',
    )
  })
})

describe('toMemberSuggestionOptions — opsi datalist anggota', () => {
  const base: MemberSuggestion = {
    visitor_id: 'visitor-1',
    name: 'Budi Santoso',
    id_number: '3578010100000001',
    phone: '081234567890',
    email: 'budi@vendor.test',
    jabatan: 'Teknisi FO',
    last_visit_at: '2026-11-01T10:00:00+07:00',
    source_visit_id: 'visit-1',
  }

  it('nama unik memakai nama apa adanya + membawa id visitor', () => {
    const options = toMemberSuggestionOptions([base])
    expect(options).toEqual([
      {
        visitorId: 'visitor-1',
        name: 'Budi Santoso',
        value: 'Budi Santoso',
        label: 'Budi Santoso · Teknisi FO · budi@vendor.test',
      },
    ])
  })

  it('nama duplikat diberi akhiran nomor HP agar bisa dipilih terpisah', () => {
    const options = toMemberSuggestionOptions([
      base,
      {
        ...base,
        visitor_id: 'visitor-2',
        phone: '089999999999',
        email: null,
        jabatan: null,
      },
    ])
    expect(options.map((option) => option.value)).toEqual([
      'Budi Santoso (081234567890)',
      'Budi Santoso (089999999999)',
    ])
    // Nama kanonis tetap tanpa akhiran — dipakai setelah autofill.
    expect(options.map((option) => option.name)).toEqual([
      'Budi Santoso',
      'Budi Santoso',
    ])
  })

  it('duplikat dideteksi case-insensitive dan setelah trim', () => {
    const options = toMemberSuggestionOptions([
      base,
      { ...base, visitor_id: 'visitor-2', name: '  budi SANTOSO ', phone: '0899' },
      { ...base, visitor_id: 'visitor-3', name: 'Orang Lain', phone: '0877' },
    ])
    expect(options.map((option) => option.value)).toEqual([
      'Budi Santoso (081234567890)',
      '  budi SANTOSO  (0899)',
      'Orang Lain',
    ])
  })

  it('feed kosong/undefined → tanpa opsi', () => {
    expect(toMemberSuggestionOptions(undefined)).toEqual([])
    expect(toMemberSuggestionOptions([])).toEqual([])
  })

  it('hasil dibatasi cap (cermin LIMIT 20 backend)', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      ...base,
      visitor_id: `visitor-${i}`,
      name: `Anggota ${i}`,
      phone: `0812000000${i}`,
    }))
    expect(toMemberSuggestionOptions(many)).toHaveLength(MAX_MEMBER_SUGGESTION_OPTIONS)
    expect(toMemberSuggestionOptions(many, 3)).toHaveLength(3)
  })
})

describe('clampSuggestionQuery — batas ?q= backend (80 rune)', () => {
  it('trim input dan kirim tanpa spasi tepi', () => {
    expect(clampSuggestionQuery('  Budi  ')).toBe('Budi')
  })

  it('nilai kosong/null/spasi menjadi string kosong', () => {
    expect(clampSuggestionQuery('')).toBe('')
    expect(clampSuggestionQuery(null)).toBe('')
    expect(clampSuggestionQuery(undefined)).toBe('')
    expect(clampSuggestionQuery('   ')).toBe('')
  })

  it('tepat 80 karakter dibiarkan utuh', () => {
    const value = 'a'.repeat(SUGGESTION_QUERY_MAX_LENGTH)
    expect(clampSuggestionQuery(value)).toBe(value)
  })

  it('81 karakter dipotong ke 80 (server menolak 81)', () => {
    expect(clampSuggestionQuery('a'.repeat(81))).toHaveLength(80)
  })

  it('dihitung per rune, bukan unit UTF-16 (selaras RuneLen Go)', () => {
    const runes = 'é'.repeat(81)
    expect(runes).toHaveLength(81)
    expect(Array.from(clampSuggestionQuery(runes))).toHaveLength(80)
  })
})

describe('mergeSuggestionNames — feed saran + pelengkap katalog', () => {
  const catalogue = [
    { id: 'v-1', name: 'PT Lintas Fiber' },
    { id: 'v-2', name: 'PT Daya Power' },
  ]

  it('feed mendahului katalog; nama katalog yang sudah ada tidak diduplikasi', () => {
    const suggestions: VendorSuggestion[] = [
      { name: 'PT Maju Jaya', source: 'history' },
      { name: 'PT Lintas Fiber', source: 'master' },
    ]
    expect(mergeSuggestionNames(suggestions, catalogue)).toEqual([
      'PT Maju Jaya',
      'PT Lintas Fiber',
      'PT Daya Power',
    ])
  })

  it('dedupe case-insensitive dengan casing saran menang', () => {
    const suggestions: VendorSuggestion[] = [{ name: 'PT lintas fiber', source: 'account' }]
    expect(mergeSuggestionNames(suggestions, catalogue)).toEqual([
      'PT lintas fiber',
      'PT Daya Power',
    ])
  })

  it('feed kosong/undefined → katalog tetap tampil (nama lama tidak hilang)', () => {
    expect(mergeSuggestionNames(undefined, catalogue)).toEqual([
      'PT Lintas Fiber',
      'PT Daya Power',
    ])
    expect(mergeSuggestionNames([], catalogue)).toEqual([
      'PT Lintas Fiber',
      'PT Daya Power',
    ])
  })

  it('nama kosong dibuang dan hasil dibatasi cap', () => {
    const suggestions: VendorSuggestion[] = [
      { name: '  ', source: 'master' },
      { name: 'PT Satu', source: 'master' },
      { name: 'PT Dua', source: 'master' },
      { name: 'PT Tiga', source: 'master' },
    ]
    expect(mergeSuggestionNames(suggestions, [], 2)).toEqual(['PT Satu', 'PT Dua'])
  })

  it('cap bawaan sama dengan plafon feed backend (50)', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      name: `PT ${i}`,
      source: 'master' as const,
    }))
    expect(mergeSuggestionNames(many, [])).toHaveLength(MAX_VENDOR_SUGGESTION_OPTIONS)
  })
})

describe('toMemberSuggestionPatch — autofill baris anggota', () => {
  const detail: MemberSuggestionDetail = {
    name: 'Budi Santoso',
    id_number: '3273010501900001',
    phone: '081234567890',
    email: 'budi@vendor.test',
    jabatan: 'Teknisi FO',
    vendor_name: 'PT Lintas Fiber',
    id_card_photo_url: 'https://minio.local/bucket/id_cards/1/ktp.jpg?X-Amz-Signature=abc',
    photo_url: 'https://minio.local/bucket/selfies/1/selfie.png?X-Amz-Signature=def',
    source_visit_id: 'visit-src-1',
  }

  it('memetakan seluruh field teks + kedua foto (URL verbatim, nama turunan)', () => {
    expect(toMemberSuggestionPatch(detail)).toEqual({
      name: 'Budi Santoso',
      id_number: '3273010501900001',
      phone: '081234567890',
      email: 'budi@vendor.test',
      jabatan: 'Teknisi FO',
      vendor_name: 'PT Lintas Fiber',
      id_card_photo: {
        url: 'https://minio.local/bucket/id_cards/1/ktp.jpg?X-Amz-Signature=abc',
        name: 'ktp.jpg',
      },
      selfie: {
        url: 'https://minio.local/bucket/selfies/1/selfie.png?X-Amz-Signature=def',
        name: 'selfie.png',
      },
    })
  })

  it('email/jabatan null → string kosong (field dianggap absen saat submit)', () => {
    const patch = toMemberSuggestionPatch({ ...detail, email: null, jabatan: null })
    expect(patch.email).toBe('')
    expect(patch.jabatan).toBe('')
  })

  it('foto null → sentinel kosong (galat wajib-isi tampil per baris)', () => {
    const patch = toMemberSuggestionPatch({
      ...detail,
      id_card_photo_url: null,
      photo_url: null,
    })
    expect(patch.id_card_photo).toEqual({ url: '', name: '' })
    expect(patch.selfie).toEqual({ url: '', name: '' })
  })

  it('vendor_name null/spasi → string kosong (properti tetap ada, menghapus perusahaan baris)', () => {
    expect(
      toMemberSuggestionPatch({ ...detail, vendor_name: null }),
    ).toHaveProperty('vendor_name', '')
    expect(
      toMemberSuggestionPatch({ ...detail, vendor_name: '   ' }),
    ).toHaveProperty('vendor_name', '')
  })

  it('vendor_name non-kosong di-trim sebelum diterapkan', () => {
    expect(
      toMemberSuggestionPatch({ ...detail, vendor_name: '  PT Daya Power  ' }),
    ).toHaveProperty('vendor_name', 'PT Daya Power')
  })
})
