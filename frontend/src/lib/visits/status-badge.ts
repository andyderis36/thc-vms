import type { User, VisitStatus } from '@/lib/api/types'
import { isSuperAdminRole } from '@/lib/auth/capabilities'

/**
 * purely data: pemetaan status kunjungan ke label Bahasa Indonesia dan
 * nada visual. Kelas Tailwind sengaja TIDAK disertakan — komponen
 * `StatusBadge` yang memetakan nada ke kelas (separation of concerns).
 */

export type StatusTone = 'info' | 'success' | 'danger' | 'neutral' | 'warning'

export const VISIT_STATUS_META: Record<
  VisitStatus,
  { label: string; tone: StatusTone }
> = {
  requested: { label: 'Diminta', tone: 'info' },
  approved: { label: 'Disetujui', tone: 'success' },
  visiting: { label: 'Sedang di Lokasi', tone: 'info' },
  // Permit masih aktif di luar lokasi (check-out multi-entry, siap re-entry).
  offsite: { label: 'Check-out — di luar lokasi', tone: 'warning' },
  completed: { label: 'Selesai', tone: 'success' },
  not_visit: { label: 'Tidak Hadir', tone: 'warning' },
  rejected: { label: 'Ditolak', tone: 'danger' },
  cancelled: { label: 'Dibatalkan', tone: 'neutral' },
  rescheduled: { label: 'Jadwal Digeser', tone: 'warning' },
}

/** Nada badge per peran user — dipakai tabel users dan modal edit (satu sumber). */
export function managedRoleTone(role: User['role']): StatusTone {
  if (isSuperAdminRole(role)) return 'danger'
  if (role === 'admin') return 'info'
  if (role === 'security') return 'warning'
  return 'neutral'
}
