/**
 * Aturan isian "Jabatan" pada form SCR-03.
 *
 * `jabatan` adalah peran/jabatan pengunjung di lokasi (mis. Teknisi, Mandor,
 * Supervisor) yang diketik BEBAS — bukan katalog. Nilai yang pernah
 * terdaftar hanya menjadi saran isian (`GET /jabatan`), jadi pengguna tetap
 * boleh mengetik jabatan baru.
 *
 * Konstanta batas diletakkan di `lib/` (bukan `features/`) karena dipakai
 * bersama oleh skema form, input UI, dan autosave roster.
 */

/** Batas kontrak BE untuk `jabatan` (openapi `VisitorItem.jabatan`, maks 120). */
export const JABATAN_MAX_LENGTH = 120
