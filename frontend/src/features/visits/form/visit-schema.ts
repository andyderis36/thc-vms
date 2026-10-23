/**
 * Skema validasi SCR-03 — Formulir Pengajuan Kunjungan (zod).
 *
 * Kontrak mengikuti `docs/4. openapi.yaml` (CreateVisitRequest) termasuk
 * field `purpose_note` (tujuan lain, ≤200 karakter). Seluruh pesan galat
 * berbahasa Indonesia. Aturan urutan waktu (selesai setelah mulai) dan
 * "minimal satu tujuan" ditegakkan di `superRefine` di akhir rantai.
 */

import { z } from 'zod'

import { JABATAN_MAX_LENGTH } from '@/lib/visits/jabatan-input'
import { MAX_TECHNICIANS } from '@/lib/visits/vendor-input'

// Batas anggota tim dimiliki `lib/visits/vendor-input.ts` (modul `lib/` tidak
// boleh mengimpor `features/`); di-re-export di sini agar importir lama
// (`TechnicianList.tsx`, dll.) tetap berfungsi tanpa perubahan.
export { MAX_TECHNICIANS }

/**
 * Satu baris anggota: nama, identitas, HP, foto KTP, dan selfie WAJIB.
 * `jabatan` opsional (teks bebas + saran dari `GET /jabatan`).
 */
export const technicianSchema = z.object({
  name: z.string().trim().min(1, 'Nama lengkap anggota wajib diisi.'),
  id_number: z.string().trim().min(1, 'Nomor KTP/SIM anggota wajib diisi.'),
  phone: z.string().trim().min(1, 'Nomor HP anggota wajib diisi.'),
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
    .max(120, 'Nama vendor maksimal 120 karakter.')
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
    // Chip tujuan boleh kosong ASALKAN `purpose_note` terisi — divalidasi
    // bersama di `superRefine` di akhir rantai.
    purpose_ids: z.array(z.string()),
    // "Tujuan lain": teks bebas bila tujuan tidak ada di daftar chip.
    purpose_note: z
      .string()
      .trim()
      .max(200, 'Tujuan lain maksimal 200 karakter.')
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
    notes: z.string().trim().optional(),
    technicians: z
      .array(technicianSchema)
      .min(1, 'Minimal satu anggota wajib didaftarkan.')
      .max(
        MAX_TECHNICIANS,
        `Jumlah anggota maksimal ${MAX_TECHNICIANS} orang.`,
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
