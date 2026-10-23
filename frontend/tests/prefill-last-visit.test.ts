import { describe, expect, it } from 'vitest'

import type { VisitDetail } from '@/lib/api/types'
import {
  selectLatestVisit,
  toTechnicianRows,
} from '@/lib/visits/prefill-last-visit'

/** Kunjungan lengkap — dasar setiap kasus; kasus kosong me-override field. */
function makeVisit(overrides: Partial<VisitDetail> = {}): VisitDetail {
  return {
    id: 'e6b1d5a0-0000-4000-8000-000000000001',
    visit_id: 'VST-2026-0001',
    status: 'completed',
    location: {
      id: 'loc-bandung',
      name: 'POP Bandung',
      type: 'pop',
      address: 'Jl. Asia Afrika No. 1',
      city: 'Bandung',
      timezone: 'WIB',
    },
    purposes: [
      { id: 'pur-splicing', name: 'Splicing FO' },
      { id: 'pur-genset', name: 'Maintenance Genset' },
    ],
    vendor_user: {
      id: 'usr-vendor-1',
      name: 'Andi Vendor',
      email: 'andi@vendor.id',
      phone: '08111111111',
      nik: '3273010501900001',
      role: 'vendor',
      location_id: null,
      location_name: null,
      status: 'active',
      type: 'external',
      vendor_name: 'PT Lintas Fiber',
    },
    vendor_name: 'PT Lintas Fiber',
    start_date: '2026-09-26T08:00:00+07:00',
    end_date: '2026-09-26T17:00:00+07:00',
    assignment_letter_url:
      'https://minio.local/bucket/assignment_letters/e6b1/Surat%20Tugas.pdf?X-Amz-Signature=abc123',
    notes: 'Bawa splicer dan OTDR.',
    purpose_note: 'Perbaikan kabel putus gangguan',
    visitors: [
      {
        name: 'Budi Santoso',
        id_number: '3273010501900001',
        phone: '081234567890',
        id_card_photo_url:
          'https://minio.local/bucket/id_cards/1/ktp-budi.jpg?X-Amz-Signature=ktp',
        photo_url:
          'https://minio.local/bucket/id_cards/1/selfie%20budi.jpg?X-Amz-Signature=selfie',
        vendor_name: 'PT Lintas Fiber',
        jabatan: 'Mandor',
      },
      {
        name: 'Siti Aminah',
        id_number: '3273020602900002',
        phone: '0899887766',
        id_card_photo_url: null,
        photo_url: null,
        vendor_name: null,
        jabatan: null,
      },
    ],
    created_at: '2026-09-20T10:00:00Z',
    ...overrides,
  }
}

describe('toTechnicianRows', () => {
  it('kunjungan lengkap → HANYA baris roster terisi (nama/ID/HP, foto, teks vendor)', () => {
    const visit = makeVisit()
    const rows = toTechnicianRows(visit)

    expect(rows).toHaveLength(2)
    const first = rows[0]
    expect(first?.name).toBe('Budi Santoso')
    expect(first?.id_number).toBe('3273010501900001')
    expect(first?.phone).toBe('081234567890')
    expect(first?.vendor_name).toBe('PT Lintas Fiber')
    expect(first?.jabatan).toBe('Mandor')
    // Foto: URL VERBATIM (query presigned ikut; backend yang membersihkan).
    expect(first?.id_card_photo).toEqual({
      url: visit.visitors[0]?.id_card_photo_url,
      name: 'ktp-budi.jpg',
    })
    expect(first?.selfie).toEqual({
      url: visit.visitors[0]?.photo_url,
      name: 'selfie budi.jpg',
    })

    const second = rows[1]
    expect(second?.name).toBe('Siti Aminah')
    // Tanpa foto lama → sentinel kosong (bukan null): foto KTP wajib, jadi
    // baris harus tetap bisa dirender sambil ditandai belum diunggah.
    expect(second?.id_card_photo).toEqual({ url: '', name: '' })
    // Tanpa foto lama → selfie sentinel kosong (bukan nama berkas).
    expect(second?.selfie).toEqual({ url: '', name: '' })
    expect(second?.vendor_name).toBe('')
    expect(second?.jabatan).toBe('')
  })

  it('foto hilang → sentinel kosong; selfie pakai sentinel kosong', () => {
    const rows = toTechnicianRows(
      makeVisit({
        visitors: [
          {
            name: 'Tanpa Foto',
            id_number: '1',
            phone: '0812',
            id_card_photo_url: null,
            photo_url: null,
            vendor_name: null,
          },
        ],
      }),
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.id_card_photo).toEqual({ url: '', name: '' })
    expect(rows[0]?.selfie).toEqual({ url: '', name: '' })
    expect(rows[0]?.vendor_name).toBe('')
  })

  it('nama berkas dari segmen URL terakhir: encoded chars di-decode, query presigned digugurkan, kosong → "berkas"', () => {
    const rows = toTechnicianRows(
      makeVisit({
        visitors: [
          {
            name: 'Budi Santoso',
            id_number: '1',
            phone: '0812',
            id_card_photo_url: 'https://minio.local/bucket/ktp/foto%20ktp%20budi.jpg',
            photo_url: 'https://minio.local/bucket/selfie/selfie%20%281%29.jpg',
            vendor_name: '',
          },
        ],
      }),
    )

    expect(rows[0]?.id_card_photo?.name).toBe('foto ktp budi.jpg')
    expect(rows[0]?.selfie?.name).toBe('selfie (1).jpg')

    // Tanpa segmen terakhir / bukan URL valid → fallback "berkas";
    // `photo_url` kosong → selfie sentinel (bukan nama berkas).
    const fallback = toTechnicianRows(
      makeVisit({
        visitors: [
          {
            name: 'Budi Santoso',
            id_number: '1',
            phone: '0812',
            id_card_photo_url: 'bukan-url-valid',
            photo_url: '',
            vendor_name: '',
          },
        ],
      }),
    )
    expect(fallback[0]?.id_card_photo?.name).toBe('berkas')
    expect(fallback[0]?.selfie).toEqual({ url: '', name: '' })
  })
})

describe('selectLatestVisit', () => {
  it('memilih created_at paling baru apa pun urutan input (backend mengurut start_date DESC)', () => {
    const older = makeVisit({
      id: 'older',
      created_at: '2026-09-01T08:00:00Z',
    })
    const newest = makeVisit({
      id: 'newest',
      created_at: '2026-09-20T10:00:00Z',
    })
    const middle = makeVisit({
      id: 'middle',
      created_at: '2026-09-10T09:00:00Z',
    })

    expect(selectLatestVisit([older, middle, newest])?.id).toBe('newest')
    expect(selectLatestVisit([newest, older, middle])?.id).toBe('newest')
    expect(selectLatestVisit([middle, newest, older])?.id).toBe('newest')
  })

  it('daftar kosong atau absen → undefined', () => {
    expect(selectLatestVisit([])).toBeUndefined()
    expect(selectLatestVisit(undefined)).toBeUndefined()
  })
})
