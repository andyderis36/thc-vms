import type { VisitDetail, VisitListParams } from '@/lib/api/types'

/**
 * Parameter query untuk badge "X Teknisi On-Site" di navbar kios.
 *
 * SENGAJA terpisah dari query tab antrean: angka teknisi yang sedang berada
 * di lokasi harus tetap tampil apa pun tab yang aktif dan apa pun filter
 * (pencarian/tanggal) yang sedang dipakai. Karena itu params ini tidak
 * membawa `q`, `date_from`, `date_to`, atau `page` — semuanya milik tab.
 *
 * `limit` 100 = cap API (backend meng-clamp di atas 100). Jumlah teknisi
 * on-site di satu gerbang jauh di bawah angka itu.
 */
export const ON_SITE_COUNT_PARAMS: VisitListParams = {
  status: 'visiting',
  page: 1,
  limit: 100,
  sort_by: 'start_date',
  order: 'asc',
}

/**
 * Jumlah teknisi yang sedang berada di lokasi.
 *
 * Yang dihitung adalah teknisi (pengiring kunjungan), bukan jumlah baris
 * kunjungan: satu kunjungan bisa membawa beberapa teknisi, sementara badge di
 * navbar berbunyi "X Teknisi On-Site". `visitors` sudah berisi nama wajib
 * (openapi: `required: [name, id_number, phone]`), jadi panjang array sama
 * dengan jumlah teknisi yang ditampilkan di daftar.
 */
export function countOnSiteTechnicians(visits: Pick<VisitDetail, 'visitors'>[]): number {
  return visits.reduce((total, visit) => total + (visit.visitors?.length ?? 0), 0)
}
