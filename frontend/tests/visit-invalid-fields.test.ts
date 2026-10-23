import { describe, expect, it, vi } from 'vitest'

import type { FieldErrors } from 'react-hook-form'

import {
  collectInvalidFields,
  formatInvalidMessage,
  revealInvalidField,
  technicianAnchorId,
  type InvalidField,
} from '@/features/visits/form/invalid-fields'
import type { VisitFormValues } from '@/features/visits/form/visit-schema'

type VisitErrors = FieldErrors<VisitFormValues>

/** Galat RHF selalu dibangun sebagai objek polos lalu di-cast. */
function errorsOf(value: Record<string, unknown>): VisitErrors {
  return value as unknown as VisitErrors
}

/** Label manifest asli, dipakai untuk menyusun kasus `formatInvalidMessage`. */
const LABELS = [
  'Fasilitas Tujuan',
  'Waktu Mulai',
  'Waktu Selesai',
  'Daftar Anggota/Pengunjung',
  'Catatan Tambahan',
] as const

/** Daftar field sintetis berurutan berisi `count` label pertama. */
function fieldList(count: number): InvalidField[] {
  return LABELS.slice(0, count).map((label, index) => ({
    path: `field-${index}`,
    label,
    anchorId: `anchor-${index}`,
  }))
}

describe('collectInvalidFields — manifest berurutan', () => {
  it('mengembalikan [] untuk objek galat kosong', () => {
    expect(collectInvalidFields(errorsOf({}))).toEqual([])
  })

  it('mengembalikan satu entri untuk galat assignment_letter saja', () => {
    const result = collectInvalidFields(
      errorsOf({ assignment_letter: { message: 'Surat Tugas / SPK wajib diunggah.' } }),
    )

    expect(result).toEqual([
      {
        path: 'assignment_letter',
        label: 'Surat Tugas / SPK Vendor',
        anchorId: 'visit-assignment-letter',
      },
    ])
  })

  it('mengembalikan urutan DOM walau kunci objek galat terbalik', () => {
    const result = collectInvalidFields(
      errorsOf({
        is_nda_accepted: { message: 'Anda harus menyetujui SOP.' },
        end_date: { message: 'Waktu selesai wajib diisi.' },
        location_id: { message: 'Fasilitas tujuan wajib dipilih.' },
      }),
    )

    expect(result.map((field) => field.path)).toEqual([
      'location_id',
      'end_date',
      'is_nda_accepted',
    ])
  })

  it('mengurutkan galat baris anggota naik per indeks lalu per sub-kunci', () => {
    const result = collectInvalidFields(
      errorsOf({
        technicians: [
          { phone: { message: 'Nomor HP anggota wajib diisi.' } },
          {
            name: { message: 'Nama lengkap anggota wajib diisi.' },
            selfie: { message: 'Foto selfie anggota wajib diunggah.' },
          },
        ],
      }),
    )

    expect(result).toEqual([
      {
        path: 'technicians.0.phone',
        label: 'Nomor HP anggota (Anggota 1)',
        anchorId: 'visit-tech-0-phone',
      },
      {
        path: 'technicians.1.name',
        label: 'Nama lengkap anggota (Anggota 2)',
        anchorId: 'visit-tech-1-name',
      },
      {
        path: 'technicians.1.selfie',
        label: 'Foto selfie anggota (Anggota 2)',
        anchorId: 'visit-tech-1-selfie',
      },
    ])
    expect(technicianAnchorId(0, 'phone')).toBe('visit-tech-0-phone')
  })

  it('memлови galat foto KTP (kini wajib) di baris yang sama', () => {
    const result = collectInvalidFields(
      errorsOf({
        technicians: [
          { id_card_photo: { message: 'Foto KTP wajib diunggah.' } },
        ],
      }),
    )

    expect(result).toEqual([
      {
        path: 'technicians.0.id_card_photo',
        label: 'Foto KTP anggota (Anggota 1)',
        anchorId: 'visit-tech-0-id_card_photo',
      },
    ])
  })

  it('menghasilkan entri Daftar Anggota/Pengunjung untuk galat level array tanpa melempar', () => {
    const result = collectInvalidFields(
      errorsOf({
        technicians: { message: 'Minimal satu anggota wajib didaftarkan.' },
      }),
    )

    expect(result).toEqual([
      {
        path: 'technicians',
        label: 'Daftar Anggota/Pengunjung',
        anchorId: 'visit-technicians',
      },
    ])
  })

  it('melewati galat dengan pesan string kosong', () => {
    const result = collectInvalidFields(
      errorsOf({ assignment_letter: { message: '' } }),
    )

    expect(result).toEqual([])
  })

  it('tidak melempar untuk array teknisi sparse (baris undefined)', () => {
    const sparse: unknown[] = []
    sparse[1] = { name: { message: 'Nama lengkap teknisi wajib diisi.' } }

    const result = collectInvalidFields(errorsOf({ technicians: sparse }))

    expect(result.map((field) => field.path)).toEqual([
      'technicians.1.name',
    ])
  })
})

describe('formatInvalidMessage', () => {
  it('mengembalikan pesan fallback untuk nol field', () => {
    expect(formatInvalidMessage([])).toBe(
      'Lengkapi field wajib sebelum mengirim permohonan.',
    )
  })

  it('menyusun pesan untuk satu field', () => {
    expect(formatInvalidMessage(fieldList(1))).toBe(
      'Lengkapi Fasilitas Tujuan sebelum mengirim permohonan.',
    )
  })

  it('menyusun pesan untuk dua field', () => {
    expect(formatInvalidMessage(fieldList(2))).toBe(
      'Lengkapi Fasilitas Tujuan dan Waktu Mulai sebelum mengirim permohonan.',
    )
  })

  it('menyusun pesan untuk tiga field', () => {
    expect(formatInvalidMessage(fieldList(3))).toBe(
      'Lengkapi Fasilitas Tujuan, Waktu Mulai, dan Waktu Selesai sebelum mengirim permohonan.',
    )
  })

  it('memotong pada max default dan menambahkan jumlah sisanya', () => {
    expect(formatInvalidMessage(fieldList(5))).toBe(
      'Lengkapi Fasilitas Tujuan, Waktu Mulai, dan Waktu Selesai dan 2 lainnya sebelum mengirim permohonan.',
    )
  })
})

describe('revealInvalidField', () => {
  it('menambahkan kelas field-attention lalu menghapusnya setelah 1600ms', () => {
    vi.useFakeTimers()
    const added: string[] = []
    const removed: string[] = []
    const el = {
      scrollIntoView: vi.fn(),
      focus: vi.fn(),
      classList: {
        add: (token: string) => added.push(token),
        remove: (token: string) => removed.push(token),
      },
    } as unknown as HTMLElement

    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false }),
      setTimeout: (handler: () => void, timeout: number) =>
        setTimeout(handler, timeout),
    })

    revealInvalidField(el)

    expect(added).toEqual(['field-attention'])
    expect(el.scrollIntoView).toHaveBeenCalledTimes(1)
    expect(el.focus).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1600)
    expect(removed).toEqual(['field-attention'])

    vi.unstubAllGlobals()
    vi.useRealTimers()
  })
})
