import type { VisitDetail } from '@/lib/api/types'

/**
 * Gabungkan antrean "Akan Hadir" (tab upcoming pada `/gate`): kunjungan
 * `approved` + `rescheduled` — keduanya layak check-in, jadi keduanya harus
 * tampil di antrean pos jaga tanpa refresh halaman.
 *
 * Kontrak:
 * - **Dedupe by `id`**: kunjungan yang muncul di kedua daftar disimpan
 *   sekali; versi dari daftar `approved` menang karena didahulukan.
 * - **Urut kronologis ASC** berdasarkan `start_date`. Keduanya ISO-8601
 *   dari backend yang sama, sehingga perbandingan leksikal = kronologis;
 *   sort stabil bawaan JS mempertahankan urutan asal saat `start_date`
 *   sama.
 * - Murni (tidak memutasi argumen) — daftar hasil baru setiap pemanggilan.
 */
export function mergeUpcomingQueue(
  approved: VisitDetail[],
  rescheduled: VisitDetail[],
): VisitDetail[] {
  const seen = new Set<string>()
  const merged: VisitDetail[] = []
  for (const visit of [...approved, ...rescheduled]) {
    if (seen.has(visit.id)) continue
    seen.add(visit.id)
    merged.push(visit)
  }
  merged.sort((a, b) => {
    if (a.start_date < b.start_date) return -1
    if (a.start_date > b.start_date) return 1
    return 0
  })
  return merged
}
