/**
 * Skema validasi SCR-03 — Formulir Pengajuan Kunjungan (zod).
 *
 * Kontrak mengikuti `docs/4. openapi.yaml` (CreateVisitRequest) termasuk
 * field `purpose_note` (tujuan lain, ≤200 karakter). Seluruh pesan galat
 * berbahasa Indonesia. Aturan urutan waktu (selesai setelah mulai) dan
 * "minimal satu tujuan" ditegakkan di `superRefine` di akhir rantai.
 */

import { z } from 'zod'

import {
  ID_NUMBER_PATTERN,
  JABATAN_MAX_LENGTH,
  NAME_MAX_LENGTH,
  PURPOSE_NOTE_MAX_LENGTH,
  TECHNICIANS_MAX,
  TEXT_MAX_LENGTH,
  PHONE_DIGIT_MESSAGE,
  PHONE_MAX_LENGTH,
  PHONE_MIN_LENGTH,
  VENDOR_NAME_MAX_LENGTH,
  isValidPhone,
} from '@/lib/limits'

// Batas anggota tim dimiliki `lib/visits/vendor-input.ts` (modul `lib/` tidak
// boleh mengimpor `features/`); di-re-export di sini agar importir lama
// (`TechnicianList.tsx`, dll.) tetap berfungsi tanpa perubahan.
export { TECHNICIANS_MAX as MAX_TECHNICIANS }

/**
 * Satu baris anggota: nama, identitas, HP, foto KTP, dan selfie WAJIB.
 * `jabatan` opsional (teks bebas + saran dari `GET /jabatan`).
 */
export const technicianSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Nama lengkap anggota wajib diisi.')
    .max(
      NAME_MAX_LENGTH,
      `Nama lengkap anggota maksimal ${NAME_MAX_LENGTH} karakter.`,
    ),
  id_number: z
    .string()
    .trim()
    .min(1, 'Nomor KTP/SIM anggota wajib diisi.')
    .regex(
      ID_NUMBER_PATTERN,
      'Nomor KTP/SIM anggota harus terdiri dari 8-20 huruf atau angka tanpa spasi.',
    ),
  phone: z
    .string()
    .trim()
    .min(1, 'Nomor HP anggota wajib diisi.')
    .refine(
      (value) => !/[A-Za-z]/.test(value),
      'Nomor HP tidak boleh mengandung huruf.',
    )
    .refine(
      (value) => {
        const digits = value.replace(/[^0-9]/g, '')
        const normalized = digits.startsWith('62')
          ? `0${digits.slice(2)}`
          : digits
        if (
          !/[A-Za-z]/.test(value) &&
          normalized.startsWith('0') &&
          (normalized.length < PHONE_MIN_LENGTH ||
            normalized.length > PHONE_MAX_LENGTH)
        ) {
          return false
        }
        return true
      },
      PHONE_DIGIT_MESSAGE,
    )
    .refine(
      isValidPhone,
      'Nomor HP anggota tidak valid (10-16 digit angka, diawali 0 atau 62).',
    ),
  // Foto KTP WAJIB (keputusan pemilik produk): tanpa foto identitas, anggota
  // tak bisa diverifikasi pengawas pas. Bentuknya mirror `selfie` — baris baru
  // memakai sentinel kosong `{ url: '', name: '' }` agar galat tampil di level
  // `id_card_photo` (terbaca `rowError?.id_card_photo?.message`), bukan di
  // sub-path `url`/`name`.
  id_card_photo: z
    .object(
      {
        url: z.string().min(1, 'Foto KTP wajib diunggah.'),
        name: z.string().min(1, 'Foto KTP wajib diunggah.'),
      },
      {
        required_error: 'Foto KTP wajib diunggah.',
        invalid_type_error: 'Foto KTP wajib diunggah.',
      },
    )
    .refine(
      (value) => value.url !== '' && value.name !== '',
      'Foto KTP wajib diunggah.',
    ),
  selfie: z
    .object(
      {
        url: z.string().min(1, 'Foto selfie anggota wajib diunggah.'),
        name: z.string().min(1, 'Foto selfie anggota wajib diunggah.'),
      },
      {
        required_error: 'Foto selfie anggota wajib diunggah.',
        invalid_type_error: 'Foto selfie anggota wajib diunggah.',
      },
    )
    // Baris baru memakai sentinel kosong; tolak agar galat tampil di level
    // `selfie` (terbaca `rowError?.selfie?.message`) bukan di sub-path.
    .refine(
      (value) => value.url !== '' && value.name !== '',
      'Foto selfie anggota wajib diunggah.',
    ),
  // Jabatan/peran anggota di lokasi: TEKS BEBAS (bukan katalog) — nilai
  // baru bebas diketik; daftar `GET /jabatan` hanya saran isian.
  jabatan: z
    .string()
    .trim()
    .max(JABATAN_MAX_LENGTH, `Jabatan maksimal ${JABATAN_MAX_LENGTH} karakter.`)
    .optional(),
  // Teks bebas: boleh nama dari katalog vendor (dicocokkan case-insensitive
  // saat submit via `resolveVendorInput`) ATAU nama manual ≤120 karakter.
  vendor_name: z
    .string()
    .trim()
    .max(
      VENDOR_NAME_MAX_LENGTH,
      `Nama vendor maksimal ${VENDOR_NAME_MAX_LENGTH} karakter.`,
    )
    .optional(),
})

/** Lampiran surat tugas / SPK: URL hasil unggahan + nama berkas untuk tampilan. */
export const assignmentLetterSchema = z.object({
  url: z.string().min(1),
  name: z.string().min(1),
})

export const visitFormSchema = z
  .object({
    location_id: z.string().min(1, 'Fasilitas tujuan wajib dipilih.'),
    // Nama vendor/mitra per kunjungan (admin/superadmin): teks bebas +
    // saran `<datalist>` katalog; kosong = tanpa perusahaan kunjungan.
    vendor_name: z
      .string()
      .trim()
      .max(
        VENDOR_NAME_MAX_LENGTH,
        `Nama vendor/mitra maksimal ${VENDOR_NAME_MAX_LENGTH} karakter.`,
      )
      .optional(),
    // Chip tujuan boleh kosong ASALKAN `purpose_note` terisi — divalidasi
    // bersama di `superRefine` di akhir rantai.
    purpose_ids: z.array(z.string()),
    // "Tujuan lain": teks bebas bila tujuan tidak ada di daftar chip.
    purpose_note: z
      .string()
      .trim()
      .max(
        PURPOSE_NOTE_MAX_LENGTH,
        `Tujuan lain maksimal ${PURPOSE_NOTE_MAX_LENGTH} karakter.`,
      )
      .optional(),
    start_date: z.string().min(1, 'Waktu mulai wajib diisi.'),
    end_date: z.string().min(1, 'Waktu selesai wajib diisi.'),
    is_multi_day: z.boolean(),
    assignment_letter: assignmentLetterSchema
      .nullish()
      .refine(
        (value): boolean => value != null,
        'Surat Tugas / SPK wajib diunggah.',
      ),
    notes: z
      .string()
      .trim()
      .max(TEXT_MAX_LENGTH, `Catatan maksimal ${TEXT_MAX_LENGTH} karakter.`)
      .optional(),
    technicians: z
      .array(technicianSchema)
      .min(1, 'Minimal satu anggota wajib didaftarkan.')
      .max(
        TECHNICIANS_MAX,
        `Jumlah anggota maksimal ${TECHNICIANS_MAX} orang.`,
      ),
    is_nda_accepted: z
      .boolean()
      .refine(
        (accepted) => accepted,
        'Anda harus menyetujui pernyataan SOP keselamatan kerja sebelum mengirim permohonan.',
      ),
  })
  .superRefine((value, ctx) => {
    // Minimal satu tujuan: chip TERPILIH atau "Tujuan lain" terisi.
    if (value.purpose_ids.length === 0 && (value.purpose_note ?? '') === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['purpose_ids'],
        message:
          'Pilih minimal satu tujuan kunjungan atau isi kolom Tujuan lain.',
      })
    }

    // "Other" selalu memakai teks bebas purpose_note.
    if (
      value.purpose_ids.includes('Other') &&
      (value.purpose_note ?? '').trim() === ''
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['purpose_note'],
        message: 'Tujuan lain wajib diisi bila memilih "Other".',
      })
    }

    const start = new Date(value.start_date)
    const end = new Date(value.end_date)

    if (Number.isNaN(start.getTime())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['start_date'],
        message: 'Waktu mulai tidak valid.',
      })
      return
    }
    if (Number.isNaN(end.getTime())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['end_date'],
        message: 'Waktu selesai tidak valid.',
      })
      return
    }
    if (end.getTime() <= start.getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['end_date'],
        message: 'Waktu selesai harus setelah waktu mulai.',
      })
    }
  })

export type VisitFormValues = z.infer<typeof visitFormSchema>
export type TechnicianFormValues = z.infer<typeof technicianSchema>
export type AssignmentLetter = z.infer<typeof assignmentLetterSchema>
