import type { VisitDetail } from '@/lib/api/types'
import { CHECKIN_TOLERANCE_HOURS } from '@/lib/visits/tolerance'

const HOUR_MS = 3_600_000

/**
 * Grace check-in setelah `end_date` (ms). Sumber angkanya
 * `CHECKIN_TOLERANCE_HOURS` (2 jam, AGENTS.md §6.2) — jendela check-in
 * backend ditutup tepat `end_date + 2 jam`.
 */
export const CHECKIN_CLOSE_GRACE_MS = CHECKIN_TOLERANCE_HOURS * HOUR_MS

/**
 * `true` bila jendela check-in kunjungan MASIH terbuka pada `now`:
 * `now < end_date + CHECKIN_CLOSE_GRACE_MS`.
 *
 * Batas deterministik — `end_date + 2 jam == now` dianggap SUDAH TERTUTUP
 * (`<=` membuang baris), sehingga tab "Akan Hadir" tidak lagi menampilkan
 * kunjungan yang jendelanya lewat. `now` disuntikkan agar bisa diuji tanpa
 * jam dunia nyata. Tanggal `end_date` yang tidak terbaca TIDAK membuang
 * baris (galat parse tidak boleh menyembunyikan data dari petugas pos).
 */
export function isCheckinWindowOpen(visit: VisitDetail, now: Date = new Date()): boolean {
  const endMs = new Date(visit.end_date).getTime()
  if (Number.isNaN(endMs)) return true
  return now.getTime() < endMs + CHECKIN_CLOSE_GRACE_MS
}

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
 *
 * Penyaringan jendela (`isCheckinWindowOpen`) TIDAK dilakukan di sini:
 * pemanggil lain (dashboard, approvals) memakai penggabung ini untuk
 * antrean non-check-in, jadi filter waktu hanya dipasang oleh pemanggil
 * tab upcoming `/gate`.
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
