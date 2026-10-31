/**
 * Bentuk minimum yang dibaca helper ini dari objek kunjungan — sengaja
 * dilepas dari `VisitDetail` penuh agar bisa dipakai fixture/parameter
 * parsial tanpa memutar seluruh type. Generik supaya pemanggil cukup
 * membawa kunci yang dibaca (`name`, `vendor_name`, …), bukan seluruh `User`.
 */
interface VendorUserSource<T = { name?: unknown; vendor_name?: unknown }> {
  vendor_user?: T
  /** @deprecated Fase-1 rename `pic_user`→`vendor_user`: backend masih
   *  dual-emit kedua kunci dengan nilai sama sampai Fase 2. */
  pic_user?: T
}

/**
 * Pengguna Vendor/Mitra dari sebuah kunjungan — SATU-satunya jalur baca
 * di UI untuk field `vendor_user` / legacy `pic_user`.
 *
 * Kontrak backend (Fase 1): `vendor_user` adalah kunci baru, `pic_user`
 * masih di-emit dengan nilai sama sebagai masa transisi; setelah Fase 2
 * `pic_user` dihapus. Memanggil `visit.pic_user` secara langsung dilarang —
 * selalu lewat helper ini agar fallback tetap terpusat.
 *
 * - Utamakan `vendor_user` bila ada (non-null).
 * - Fallback ke `pic_user` bila `vendor_user` absen.
 * - `undefined` bila keduanya absen (fetcher memakai cast tanpa validasi
 *   runtime, jadi kunci hilang menjadi `undefined` — penjaga null di
 *   pemanggil wajib dipertahankan).
 */
export function visitVendorUser<T>(visit: VendorUserSource<T>): T | undefined {
  return visit.vendor_user ?? visit.pic_user
}
