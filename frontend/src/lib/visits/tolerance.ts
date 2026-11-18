/**
 * Cerminan aturan toleransi check-in di backend (AGENTS.md §6.2).
 *
 * Backend (kontrak multi-entry) menegakkan `[start_date - 2 jam] .. [end_date]`
 * — tidak ada grace setelah jadwal selesai. Frontend hanya mencerminkannya
 * agar tombol check-in di layar gerbang bisa dinonaktifkan beserta alasan
 * yang dapat dibaca pengguna.
 *
 * Modul ini murni: tanpa library tanggal, tanpa akses jaringan.
 */

/** Toleransi check-in dalam jam. */
export const CHECKIN_TOLERANCE_HOURS = 2

const HOUR_MS = 3_600_000

/** Instan yang diterima: objek `Date`, string ISO 8601, atau epoch ms. */
type DateLike = Date | string | number

const toMs = (value: DateLike): number =>
  value instanceof Date ? value.getTime() : new Date(value).getTime()

const toleranceMs = (): number => CHECKIN_TOLERANCE_HOURS * HOUR_MS

/** `true` bila `now` berada di dalam jendela toleransi, inklusif di kedua tepi. */
export function isWithinCheckinWindow(
  now: DateLike,
  startDate: DateLike,
  endDate: DateLike,
): boolean {
  const nowMs = toMs(now)
  return nowMs >= toMs(startDate) - toleranceMs() && nowMs <= toMs(endDate)
}

/**
 * Alasan penolakan check-in dalam Bahasa Indonesia, atau `null` bila
 * check-in diizinkan saat ini.
 */
export function getCheckinBlockReason(
  now: DateLike,
  startDate: DateLike,
  endDate: DateLike,
): string | null {
  const nowMs = toMs(now)
  const window = toleranceMs()

  if (nowMs < toMs(startDate) - window) {
    return `Check-in belum dibuka. Jendela check-in dimulai ${CHECKIN_TOLERANCE_HOURS} jam sebelum jadwal kunjungan.`
  }
  if (nowMs > toMs(endDate)) {
    return 'Check-in sudah ditutup. Jendela check-in berakhir tepat pada jadwal selesai kunjungan.'
  }
  return null
}
