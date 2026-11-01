/**
 * Label shift petugas pos jaga berdasarkan jam dinding WIB.
 *
 * `Asia/Jakarta` (WIB, UTC+7 tanpa DST) membagi hari operasional menjadi
 * tiga shift 8 jam:
 * - [00:00, 08:00) → `Shift Malam`
 * - [08:00, 16:00) → `Shift Pagi`
 * - [16:00, 24:00) → `Shift Sore`
 *
 * Formatter dibuat sekali di level modul; `hourCycle: 'h23'` menjamin jam
 * 00–23 tanpa kasus `24:xx` tengah malam. Bukan tag `Location.timezone`
 * per lokasi: seluruh fasilitas THC beroperasi di WIB.
 */

export type GuardShiftLabel = 'Shift Malam' | 'Shift Pagi' | 'Shift Sore'

const WIB_HOUR_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Jakarta',
  hour: '2-digit',
  hourCycle: 'h23',
})

/** Ambil label shift untuk `date` (default: sekarang). */
export function getGuardShiftLabel(date: Date = new Date()): GuardShiftLabel {
  const hour = Number(WIB_HOUR_FORMATTER.format(date))
  if (hour < 8) return 'Shift Malam'
  if (hour < 16) return 'Shift Pagi'
  return 'Shift Sore'
}
