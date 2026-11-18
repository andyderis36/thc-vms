import type { Role } from '@/lib/auth/capabilities'
import { isSuperAdminRole } from '@/lib/auth/capabilities'
import type { VisitStatus } from '@/lib/api/types'
import { VISIT_STATUS_META } from '@/lib/visits/status-badge'

/** Arah mutasi gerbang: `in` = check-in, `out` = check-out. */
export type GateDirection = 'in' | 'out'

/** Keputusan pindai untuk satu status kunjungan. */
export type GateScanAction =
  | { kind: 'confirm'; direction: GateDirection }
  | { kind: 'disabled'; reason: string }

/** Label tampilan satu status, memakai ulang peta status yang sudah ada. */
export function gateStatusLabel(status: VisitStatus): string {
  return VISIT_STATUS_META[status].label
}

/**
 * Cabang aksi gerbang berdasarkan status permit (plan §5):
 * `approved`/`offsite` -> check-in (`offsite` = re-entry dengan QR yang sama),
 * `visiting` -> check-out, sisanya tidak dapat diproses beserta alasannya.
 * Switch ekshaustif tanpa `default`.
 */
export function gateScanAction(status: VisitStatus): GateScanAction {
  switch (status) {
    case 'approved':
    case 'offsite':
      return { kind: 'confirm', direction: 'in' }
    case 'visiting':
      return { kind: 'confirm', direction: 'out' }
    case 'completed':
      return {
        kind: 'disabled',
        reason: 'Kunjungan sudah selesai. Tidak ada aksi gerbang yang tersedia.',
      }
    case 'cancelled':
    case 'not_visit':
    case 'rejected':
      return {
        kind: 'disabled',
        reason: `Status ${gateStatusLabel(status)} tidak dapat diproses di gerbang.`,
      }
    case 'requested':
    case 'rescheduled':
      return {
        kind: 'disabled',
        reason: 'Kunjungan belum disetujui. Tidak dapat diproses di gerbang.',
      }
  }
}

/** Jendela debounce arah-sama: 5 menit (plan §5). */
export const SAME_DIRECTION_DEBOUNCE_MS = 5 * 60 * 1000

/** Satu hasil mutasi gerbang terakhir untuk sebuah kunci (visit + arah). */
export interface ScanResultRecord {
  /** Epoch ms saat mutasi berhasil. */
  at: number
  /** Teks hasil yang ditampilkan ulang saat scan ganda. */
  message: string
}

/** Peta debounce yang disimpan di state halaman gerbang. */
export type ScanResultMap = Record<string, ScanResultRecord>

/** Kunci debounce: pasangan (visitId, direction). */
export function scanResultKey(visitId: string, direction: GateDirection): string {
  return `${visitId}:${direction}`
}

/**
 * Hasil terakhir untuk (visitId, direction) bila masih dalam jendela 5 menit.
 * `null` berarti scan boleh melanjutkan ke konfirmasi/mutasi.
 */
export function recentScanResult(
  map: ScanResultMap,
  visitId: string,
  direction: GateDirection,
  nowMs: number = Date.now(),
): ScanResultRecord | null {
  const entry = map[scanResultKey(visitId, direction)]
  if (entry === undefined) return null
  return nowMs - entry.at < SAME_DIRECTION_DEBOUNCE_MS ? entry : null
}

/** Catat hasil sukses (murni) — mengganti entri kunci yang sama. */
export function withScanResult(
  map: ScanResultMap,
  visitId: string,
  direction: GateDirection,
  message: string,
  nowMs: number = Date.now(),
): ScanResultMap {
  return { ...map, [scanResultKey(visitId, direction)]: { at: nowMs, message } }
}

/**
 * Teks konfirmasi direction-aware, mis. `Catat check-in 14:32?`.
 * Jam diformat manual (bukan `toLocaleTimeString`) agar memakai titik dua
 * dan nol di depan secara deterministik di browser maupun pengujian.
 */
export function confirmScanMessage(direction: GateDirection, now: Date = new Date()): string {
  const hours = String(now.getHours()).padStart(2, '0')
  const minutes = String(now.getMinutes()).padStart(2, '0')
  return `Catat check-${direction} ${hours}:${minutes}?`
}

/** Tombol "Selesaikan" hanya untuk admin/super_admin pada permit masih aktif. */
export function canCompleteVisit(status: VisitStatus, role: Role): boolean {
  if (role !== 'admin' && !isSuperAdminRole(role)) return false
  return status === 'visiting' || status === 'offsite'
}
