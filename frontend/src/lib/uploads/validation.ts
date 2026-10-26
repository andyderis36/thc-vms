/**
 * Validasi berkas unggahan (Surat Tugas / Foto KTP / Bukti Check-in) dengan
 * model DUA LANGKAH:
 *
 * 1. Langkah INGEST (transport) — plafon 20 MB untuk berkas mentah yang
 *    dikirim: PDF dikompresi server sebelum disimpan, foto dikompresi lebih
 *    dulu di peramban, jadi berkas mentah yang besar justru boleh masuk.
 * 2. Langkah STORED (penyimpanan) — plafon 5 MB (AGENTS.md §6.4) untuk hasil
 *    akhir yang benar-benar disimpan: foto hasil kompresi peramban; untuk PDF,
 *    plafon stored ditangguhkan ke server (kompresi + pemeriksaan di sana).
 *
 * Urutan pemeriksaan disengaja: ukuran lebih dulu, lalu tipe MIME, agar pesan
 * yang tampil ke pengguna menyebut penyebab utama penolakan.
 */

/** Plafon STORED: 5 MB — hasil akhir yang disimpan (AGENTS.md §6.4). */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

/**
 * Plafon INGEST (transport): 20 MB — berkas mentah SEBELUM kompresi.
 * PDF dikompresi server dan foto dikompresi peramban, keduanya menyusut tajam,
 * sehingga plafon 5 MB hanya boleh diterapkan pada hasil kompresi, bukan pada
 * berkas mentah yang belum diproses.
 */
export const MAX_UPLOAD_INGEST_BYTES = 20 * 1024 * 1024

export const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
] as const

export type UploadValidation = { ok: true } | { ok: false; message: string }

/** Lebar ke `string` agar `includes` menerima nilai `string` apa pun tanpa cast. */
const ACCEPTED_MIME_TYPES: readonly string[] = ALLOWED_MIME_TYPES

type UploadFile = { name: string; type: string; size: number }

/** Pemeriksaan bersama: plafon ukuran (dengan label pesan) lalu tipe MIME. */
function checkUpload(
  file: UploadFile,
  ceilingBytes: number,
  ceilingLabel: string,
): UploadValidation {
  if (file.size > ceilingBytes) {
    return {
      ok: false,
      message: `Ukuran berkas "${file.name}" melebihi batas ${ceilingLabel}.`,
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

/**
 * Langkah STORED: plafon 5 MB + MIME untuk hasil akhir yang disimpan
 * (foto hasil kompresi; PDF hanya dicek server).
 */
export function validateStoredUpload(file: UploadFile): UploadValidation {
  return checkUpload(file, MAX_UPLOAD_BYTES, '5 MB')
}

/**
 * Langkah INGEST: plafon 20 MB + MIME untuk berkas mentah yang akan dikirim.
 * Dipakai sebelum kompresi, sehingga PDF besar lolos dan diserahkan ke server.
 */
export function validateUploadIngest(file: UploadFile): UploadValidation {
  return checkUpload(file, MAX_UPLOAD_INGEST_BYTES, '20 MB')
}

/**
 * Alias lama dengan semantik plafon stored (5 MB) + MIME — identik dengan
 * `validateStoredUpload`. Dipertahankan agar kontrak pemanggil sedia-nya dan
 * uji kontrak tidak berubah.
 */
export function validateUpload(file: UploadFile): UploadValidation {
  return validateStoredUpload(file)
}
