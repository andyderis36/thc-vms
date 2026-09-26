import type { VisitStatus } from '@/lib/api/types'

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
  completed: { label: 'Selesai', tone: 'success' },
  not_visit: { label: 'Tidak Hadir', tone: 'danger' },
  rejected: { label: 'Ditolak', tone: 'danger' },
  cancelled: { label: 'Dibatalkan', tone: 'neutral' },
  rescheduled: { label: 'Jadwal Digeser', tone: 'warning' },
}
