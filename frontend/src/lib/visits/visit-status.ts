import type { VisitStatus } from '@/lib/api/types'

/**
 * Gerbang status approve/reject — SATU sumber kebenaran untuk detail
 * (SCR-04), VisitTable, dan VisitCards.
 *
 * Modul terpisah (bukan `status-badge.ts`) karena file badge tersebut secara
 * eksplisit "purely data" (label + nada presentasi) — predikat ini logika
 * keputusan, bukan data tampilan, sehingga dipisah agar separation of
 * concerns tetap utuh.
 *
 * Kontrak backend: `rescheduled→approved` legal (perlu persetujuan ulang
 * setelah jadwal digeser); `rescheduled→rejected` ILEGAL — jadi Tolak
 * hanya untuk `requested`.
 */
export function isApprovableStatus(status: VisitStatus): boolean {
  return status === 'requested' || status === 'rescheduled'
}

export function isRejectableStatus(status: VisitStatus): boolean {
  return status === 'requested'
}
