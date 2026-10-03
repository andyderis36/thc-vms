/**
 * Helper murni validasi NIK (Nomor Induk Kependudukan).
 *
 * Kontrak BE: `users.nik TEXT NULL UNIQUE`, tepat 16 digit angka.
 * NIK wajib untuk `admin`/`vendor`, ditolak untuk `security`/`super_admin`.
 * Dipakai modal create/edit `/users`; diuji di `tests/nik.test.ts`.
 */

/** Panjang NIK sesuai kontrak BE (tepat 16 digit). */
export const NIK_LENGTH = 16

/** Tepat 16 digit angka ASCII — tanpa spasi/tanda baca. */
export const NIK_PATTERN = /^\d{16}$/

/** `true` iff nilai tepat 16 digit angka (spasi tepi diabaikan). */
export function isValidNik(value: string): boolean {
  return NIK_PATTERN.test(value.trim())
}

/**
 * Pesan error Bahasa Indonesia untuk field NIK, atau `null` bila valid.
 * `required` membedakan create (wajib) dari konteks opsional.
 */
export function validateNik(value: string, required = true): string | null {
  const trimmed = value.trim()
  if (trimmed === '') {
    return required ? 'NIK wajib diisi (16 digit angka).' : null
  }
  if (!NIK_PATTERN.test(trimmed)) {
    return 'NIK harus terdiri dari tepat 16 digit angka.'
  }
  return null
}

/** `true` iff peran memakai NIK (ditolak BE untuk security/superadmin). */
export function roleRequiresNik(role: string): boolean {
  return role === 'admin' || role === 'vendor'
}
