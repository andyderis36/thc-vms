import type { VisitStatus } from '@/lib/api/types'

/**
 * Gerbang status aksi — SATU sumber kebenaran untuk detail (SCR-04),
 * VisitTable, dan VisitCards.
 *
 * Modul terpisah (bukan `status-badge.ts`) karena file badge tersebut secara
 * eksplisit "purely data" (label + nada presentasi) — predikat ini logika
 * keputusan, bukan data tampilan, sehingga dipisah agar separation of
 * concerns tetap utuh.
 *
 * Kontrak backend: `rescheduled→approved` legal (perlu persetujuan ulang
 * setelah jadwal digeser); `rescheduled→rejected` ILEGAL — jadi Tolak
 * hanya untuk `requested`.
 *
 * Ubah Jadwal & Batal hanya legal dari `requested`, `approved`, dan
 * `rescheduled` (tabel transisi backend). Status `visiting` SENGAJA
 * dikecualikan: satu-satunya tujuan dari `visiting` adalah `completed`
 * (check-out / auto-complete), jadi tombol reschedule/cancel di sana pasti
 * ditolak 409 INVALID_TRANSITION.
 */
export function isApprovableStatus(status: VisitStatus): boolean {
  return status === 'requested' || status === 'rescheduled'
}

export function isRejectableStatus(status: VisitStatus): boolean {
  return status === 'requested'
}

export function isReschedulableStatus(status: VisitStatus): boolean {
  return status === 'requested' || status === 'approved' || status === 'rescheduled'
}

export function isCancelableStatus(status: VisitStatus): boolean {
  return status === 'requested' || status === 'approved' || status === 'rescheduled'
}
