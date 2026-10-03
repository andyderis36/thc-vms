import type { VisitorItem } from '@/lib/api/types'

/**
 * Nama perusahaan utama dari daftar teknisi pengunjung.
 *
 * Daftar kunjungan membawa roster `visitors` (per teknisi, `vendor_name`
 * nullable) sementara `visit.vendor_name` tingkat kunjungan bisa kosong untuk
 * kunjungan baru — permukaan list/tabel/kartu/antrean wajib memakai helper
 * ini agar kolom vendor tidak blank.
 *
 * - Mengembalikan `vendor_name` non-blank pertama (urutan roster).
 * - Bila lebih dari satu perusahaan berbeda, tambah akhiran ` +N`
 *   (mis. `PT A +1`).
 * - `'—'` bila tidak ada perusahaan non-blank.
 */
export function primaryVendorDisplay(
  visitors: ReadonlyArray<Pick<VisitorItem, 'vendor_name'>> | null | undefined,
): string {
  const names: string[] = []
  if (visitors !== null && visitors !== undefined) {
    for (const visitor of visitors) {
      if (visitor === null || visitor === undefined) continue
      const name = visitor.vendor_name?.trim() ?? ''
      if (name !== '') names.push(name)
    }
  }
  if (names.length === 0) return '—'
  const distinct = [...new Set(names)]
  const suffix = distinct.length > 1 ? ` +${distinct.length - 1}` : ''
  return `${names[0]}${suffix}`
}
