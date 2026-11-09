/**
 * Batas input kanonik frontend — cermin `x-limits:` pada
 * `docs/4. openapi.yaml` (SSOT) dan `backend/internal/validation/limits.go`.
 *
 * Modul ini murni (tanpa React, tanpa impor `features/`) sehingga boleh dipakai
 * skema form, input UI, dan pengujian. Setiap perubahan nilai WAJIB
 * dilakukan serentak di ketiga tempat; `tests/limits-contract.test.ts` membaca
 * YAML OpenAPI langsung dan gagal bila ada selisih.
 *
 * Untuk konsep yang sudah punya modul pemilik, nilai TIDAK dideklarasikan ulang
 * di sini — modul tersebut tetap menjadi satu-satunya definisi dan di-re-export.
 */

// --- Identitas orang --------------------------------------------------------

/** Panjang maksimum nama orang (anggota/teknisi). */
export const NAME_MAX_LENGTH = 100

/** Identitas KTP/SIM: 8–20 huruf besar/kecil atau angka, tanpa spasi. */
export const ID_NUMBER_PATTERN = /^[A-Za-z0-9]{8,20}$/

/** Panjang maksimum identitas (implisit dari pola, dipakai untuk `maxLength`). */
export const ID_NUMBER_MAX_LENGTH = 20

/** Nomor HP Indonesia: diawali `62` atau `0`, 9–15 digit setelahnya (total 0-prefix 10–16 digit). */
export const PHONE_PATTERN = /^(?:62|0)[0-9]{9,15}$/

/** Panjang minimum nomor HP setelah normalisasi (digit saja). */
export const PHONE_MIN_LENGTH = 10

/** Panjang maksimum nomor HP setelah normalisasi (digit saja). */
export const PHONE_MAX_LENGTH = 16

/** Pesan validasi digit nomor HP. */
export const PHONE_DIGIT_MESSAGE = 'Nomor telepon harus 10–16 digit angka.'
export const PHONE_DIGITS_MESSAGE = PHONE_DIGIT_MESSAGE
export const PHONE_MESSAGE = PHONE_DIGIT_MESSAGE
export const PHONE_VALIDATION_MESSAGE = PHONE_DIGIT_MESSAGE
export const PHONE_ERROR_MESSAGE = PHONE_DIGIT_MESSAGE

/** Panjang minimum kata sandi dalam jumlah karakter (rune). */
export const PASSWORD_MIN_LENGTH = 8

/** Batas byte kata sandi — batas aman bcrypt di backend. */
export const PASSWORD_MAX_BYTES = 72

/** Panjang maksimum alamat email. */
export const EMAIL_MAX_LENGTH = 254

/** Panjang maksimum teks bebas (catatan, alasan, dsb.). */
export const TEXT_MAX_LENGTH = 1000

/** Panjang minimum alasan penolakan kunjungan. */
export const REJECT_REASON_MIN_LENGTH = 5

// --- Fasilitas --------------------------------------------------------------

/** Panjang maksimum nama fasilitas. */
export const FACILITY_NAME_MAX_LENGTH = 100

/** Panjang maksimum alamat fasilitas. */
export const FACILITY_ADDRESS_MAX_LENGTH = 255

/** Panjang maksimum kota fasilitas. */
export const FACILITY_CITY_MAX_LENGTH = 100

// --- Gerbang & kunjungan ----------------------------------------------------

/** Panjang maksimum input ID kunjungan manual pada scanner. */
export const VISIT_ID_INPUT_MAX_LENGTH = 64

/** Panjang maksimum kode badge tamu. */
export const BADGE_CODE_MAX_LENGTH = 64

/** Panjang maksimum catatan check-in/check-out. */
export const CHECKIN_NOTES_MAX_LENGTH = 500

/** Panjang maksimum kata kunci pencarian. */
export const SEARCH_QUERY_MAX_LENGTH = 100

/** Panjang maksimum nama tujuan kunjungan (katalog). */
export const PURPOSE_NAME_MAX_LENGTH = 100

/** Panjang maksimum teks bebas "Tujuan lain" (kontrak CreateVisitRequest). */
export const PURPOSE_NOTE_MAX_LENGTH = 200

// --- Transport HTTP ---------------------------------------------------------

/** Plafon body JSON (1 MiB) yang dijaga middleware backend; selain itu 413. */
export const JSON_BODY_MAX_BYTES = 1_048_576

// --- Re-export: satu definisi per konsep ------------------------------------

/** Panjang nama vendor manual (120) — didefinisikan di `lib/visits/vendor-input.ts`. */
export { VENDOR_NAME_MAX_LENGTH } from '@/lib/visits/vendor-input'

/** Batas ?q= saran isian (80) — didefinisikan di `lib/visits/suggestions.ts`. */
export { SUGGESTION_QUERY_MAX_LENGTH } from '@/lib/visits/suggestions'

/** Panjang jabatan (120) — didefinisikan di `lib/visits/jabatan-input.ts`. */
export { JABATAN_MAX_LENGTH } from '@/lib/visits/jabatan-input'

/** Panjang NIK (16) — didefinisikan di `lib/users/nik.ts`. */
export { NIK_LENGTH } from '@/lib/users/nik'

/** Batas anggota tim per kunjungan (10) — alias dari `MAX_TECHNICIANS`. */
export { MAX_TECHNICIANS as TECHNICIANS_MAX } from '@/lib/visits/vendor-input'

/**
 * Plafon STORED (5 MB) dan INGEST (20 MB) — didefinisikan di
 * `lib/uploads/validation.ts`, modul pemilik kebijakan unggah dua langkah.
 * Nilainya TIDAK dideklarasikan ulang di sini.
 */
export {
  MAX_UPLOAD_BYTES as UPLOAD_STORED_MAX_BYTES,
  MAX_UPLOAD_INGEST_BYTES as UPLOAD_INGEST_MAX_BYTES,
} from '@/lib/uploads/validation'

// --- Helper murni -----------------------------------------------------------

/**
 * Normalisasi nomor HP ke bentuk `0...`: buang semua non-digit lalu ubah awalan
 * `62` menjadi `0` (`+62 812-3456-7890` → `081234567890`).
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, '')
  return digits.startsWith('62') ? `0${digits.slice(2)}` : digits
}

/**
 * Sanitasi nilai input HP saat mengetik/tempel: buang semua non-digit lalu
 * potong ke `PHONE_MAX_LENGTH` digit (`+62 812-3456-7890` → `6281234567890`).
 *
 * Berbeda dengan `normalizePhone` (yang juga mengubah awalan `62` → `0`),
 * helper ini HANYA membuang karakter ilegal sehingga nilai form tetap apa
 * yang diketik pengguna; skema/zod-lah yang melakukan normalisasi akhir.
 * Dipakai onChange tiap input telepon agar huruf tak pernah bisa masuk.
 */
export function sanitizePhoneInput(raw: string): string {
  return raw.replace(/[^0-9]/g, '').slice(0, PHONE_MAX_LENGTH)
}

/** `true` bila nomor HP (setelah normalisasi) sesuai pola dan batas panjang. */
export function isValidPhone(raw: string): boolean {
  const digits = raw.replace(/[^0-9]/g, '')
  if (digits.length > PHONE_MAX_LENGTH) {
    return false
  }
  const normalized = normalizePhone(raw)
  return (
    normalized.length >= PHONE_MIN_LENGTH &&
    normalized.length <= PHONE_MAX_LENGTH &&
    PHONE_PATTERN.test(normalized)
  )
}

/** `true` bila identitas (spasi tepi diabaikan) 8–20 huruf/angka. */
export function isValidIdNumber(raw: string): boolean {
  return ID_NUMBER_PATTERN.test(raw.trim())
}

/**
 * Pemeriksaan format email satu-alamat yang wajar: tanpa bentuk display-name,
 * tepat satu `@`, local/domain tidak kosong, dan domain mengandung titik.
 */
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/

/** `true` bila email valid dan tidak melampaui `EMAIL_MAX_LENGTH`. */
export function isValidEmail(raw: string): boolean {
  const trimmed = raw.trim()
  return trimmed.length <= EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(trimmed)
}

/** Panjang kata sandi dalam byte UTF-8 (dasar batas bcrypt). */
export function passwordByteLength(pw: string): number {
  return new TextEncoder().encode(pw).length
}

/**
 * `true` bila jumlah karakter ≥ `PASSWORD_MIN_LENGTH` DAN byte UTF-8 tidak
 * melampaui `PASSWORD_MAX_BYTES`. Karakter multibyte bisa lolos hitungan
 * karakter tetapi melewati batas byte bcrypt — keduanya wajib diperiksa.
 */
export function isValidPassword(pw: string): boolean {
  const runeLength = [...pw].length
  return (
    runeLength >= PASSWORD_MIN_LENGTH &&
    passwordByteLength(pw) <= PASSWORD_MAX_BYTES
  )
}
