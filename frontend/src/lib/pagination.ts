export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const

export const DEFAULT_PAGE_SIZE = 10

export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number]

export interface Page<T> {
  /** Baris pada halaman saat ini (sudah di-slice). */
  items: T[]
  /** Halaman TERKLAMP (bukan input mentah) — pemanggil harus merender nilai ini. */
  page: number
  /** Total halaman, minimal 1. */
  totalPages: number
}

/**
 * Memotong `rows` menjadi satu halaman secara murni (tidak memutasi input).
 *
 * `page` yang dikembalikan sudah di-clamp ke rentang `[1, totalPages]`.
 * Pemanggil WAJIB merender `page` hasil clamp ini, bukan state mentah dari
 * komponen — sehingga halaman basi / di luar rentang (mis. setelah data
 * ter-refetch dan total baris berkurang) tidak pernah menampilkan slice kosong.
 */
export function paginate<T>(rows: readonly T[], page: number, pageSize: number): Page<T> {
  const size = Number.isFinite(pageSize) ? Math.max(1, pageSize) : 1
  const totalPages = Math.max(1, Math.ceil(rows.length / size))
  const safePage = Number.isFinite(page) ? page : 1
  const clamped = Math.min(Math.max(1, safePage), totalPages)
  const items = rows.slice((clamped - 1) * size, clamped * size)

  return { items, page: clamped, totalPages }
}
