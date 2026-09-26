/**
 * Skema validasi SCR-03 — Formulir Pengajuan Kunjungan (zod).
 *
 * Kontrak mengikuti `docs/4. openapi.yaml` (CreateVisitRequest): tanpa field
 * tambahan. Seluruh pesan galat berbahasa Indonesia. Aturan urutan waktu
 * (selesai setelah mulai) ditegakkan di `superRefine` di akhir rantai.
 */

import { z } from 'zod'

/** Batas anggota tim per kunjungan — openapi `visitors.maxItems` = 10. */
export const MAX_TECHNICIANS = 10

/** Satu baris teknisi: nama, identitas, dan HP wajib; foto KTP opsional. */
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
})

/** Lampiran surat tugas / SPK: URL hasil unggahan + nama berkas untuk tampilan. */
export const assignmentLetterSchema = z.object({
  url: z.string().min(1),
  name: z.string().min(1),
})

export const visitFormSchema = z
  .object({
    location_id: z.string().min(1, 'Fasilitas tujuan wajib dipilih.'),
    purpose_ids: z
      .array(z.string())
      .min(1, 'Pilih minimal satu tujuan kunjungan.'),
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
