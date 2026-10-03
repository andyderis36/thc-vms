/**
 * Skema validasi SCR-03 — Formulir Pengajuan Kunjungan (zod).
 *
 * Kontrak mengikuti `docs/4. openapi.yaml` (CreateVisitRequest) termasuk
 * field `purpose_note` (tujuan lain, ≤200 karakter). Seluruh pesan galat
 * berbahasa Indonesia. Aturan urutan waktu (selesai setelah mulai) dan
 * "minimal satu tujuan" ditegakkan di `superRefine` di akhir rantai.
 */

import { z } from 'zod'

import { MAX_TECHNICIANS } from '@/lib/visits/vendor-input'

// Batas anggota tim dimiliki `lib/visits/vendor-input.ts` (modul `lib/` tidak
// boleh mengimpor `features/`); di-re-export di sini agar importir lama
// (`TechnicianList.tsx`, dll.) tetap berfungsi tanpa perubahan.
export { MAX_TECHNICIANS }

/** Satu baris teknisi: nama, identitas, HP, dan selfie wajib; foto KTP opsional. */
export const technicianSchema = z.object({
  name: z.string().trim().min(1, 'Nama lengkap teknisi wajib diisi.'),
  id_number: z.string().trim().min(1, 'Nomor KTP/SIM teknisi wajib diisi.'),
  phone: z.string().trim().min(1, 'Nomor HP teknisi wajib diisi.'),
  id_card_photo: z
    .object({
      url: z.string().min(1),
      name: z.string().min(1),
    })
    .nullish(),
  selfie: z
    .object(
      {
        url: z.string().min(1, 'Foto selfie teknisi wajib diunggah.'),
        name: z.string().min(1, 'Foto selfie teknisi wajib diunggah.'),
      },
      {
        required_error: 'Foto selfie teknisi wajib diunggah.',
        invalid_type_error: 'Foto selfie teknisi wajib diunggah.',
      },
    )
    // Baris baru memakai sentinel kosong; tolak agar galat tampil di level
    // `selfie` (terbaca `rowError?.selfie?.message`) bukan di sub-path.
    .refine(
      (value) => value.url !== '' && value.name !== '',
      'Foto selfie teknisi wajib diunggah.',
    ),
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
    assignment_letter: assignmentLetterSchema.nullish(),
    notes: z.string().trim().optional(),
    technicians: z
      .array(technicianSchema)
      .min(1, 'Minimal satu teknisi wajib didaftarkan.')
      .max(
        MAX_TECHNICIANS,
        `Jumlah teknisi maksimal ${MAX_TECHNICIANS} orang.`,
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
