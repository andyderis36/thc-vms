/**
 * Token kelas tabel back-office.
 *
 * Dasar tampilan tabel (Antrean Approval, Fasilitas, Pengawas, Users,
 * Jejak Audit) sebelumnya disalin-tempel sebagai string mentah di lima file
 * dan sudah berbeda-beda — `VisitTable` memakai padding `lg:px-4` sedangkan
 * empat halaman lain `lg:px-6`. Menyatukannya di sini membuat keseragaman
 * ditegakkan oleh kode, bukan oleh INGATAN.
 */

/** Pembungkus tabel desktop: kartu, disembunyikan di bawah 1024px. */
export const TABLE_WRAPPER_CLASS = 'card hidden overflow-hidden lg:block'

/** Elemen `<table>`: lebar penuh + `table-fixed` agar kolom tak meluber. */
export const TABLE_CLASS = 'w-full table-fixed border-collapse text-left'

/** Sel header `<th>`. `scope="col"` tetap dipasang manual di tiap tabel. */
export const TABLE_TH_CLASS =
  'border-b border-border-light bg-brand/5 px-2 sm:px-3 lg:px-6 py-3 text-xs sm:text-sm font-semibold text-ink-secondary'

/** Sel body `<td>`; padanan vertikal `TABLE_TH_CLASS`. */
export const TABLE_TD_CLASS = 'px-2 sm:px-3 lg:px-6 py-3'

/** Daftar kartu pengganti tabel di bawah 1024px. */
export const TABLE_CARD_LIST_CLASS = 'grid grid-cols-1 gap-3 md:grid-cols-2 lg:hidden'

/** Placeholder sel Aksi saat baris tidak punya aksi yang sah. */
export const TABLE_NO_ACTION_CLASS = 'text-xs sm:text-sm text-ink-muted'