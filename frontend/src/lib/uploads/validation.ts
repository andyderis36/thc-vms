/**
 * Validasi berkas unggahan (Surat Tugas / Foto KTP / Bukti Check-in).
 * Cerminan aturan AGENTS.md §6.4: maksimal 5 MB dan hanya PDF/JPG/PNG.
 *
 * Urutan pemeriksaan disengaja: ukuran lebih dulu, lalu tipe MIME, agar pesan
 * yang tampil ke pengguna menyebut penyebab utama penolakan.
 */

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

export const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
] as const

export type UploadValidation = { ok: true } | { ok: false; message: string }

/** Lebar ke `string` agar `includes` menerima nilai `string` apa pun tanpa cast. */
const ACCEPTED_MIME_TYPES: readonly string[] = ALLOWED_MIME_TYPES

export function validateUpload(file: {
  name: string
  type: string
  size: number
}): UploadValidation {
  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      message: `Ukuran berkas "${file.name}" melebihi batas 5 MB.`,
    }
  }

  if (!ACCEPTED_MIME_TYPES.includes(file.type)) {
    return {
      ok: false,
      message: `Format berkas "${file.name}" tidak didukung. Gunakan PDF, JPG, atau PNG.`,
    }
  }

  return { ok: true }
}
