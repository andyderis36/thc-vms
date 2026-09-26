import type { ReactNode } from 'react'
import type { VisitStatus } from '@/lib/api/types'
import { VISIT_STATUS_META, type StatusTone } from '@/lib/visits/status-badge'

/**
 * Pemetaan nada -> kelas Tail hidup DI SINI (bukan di `status-badge.ts`),
 * supaya file data tetap murni dan dapat diuji tanpa DOM.
 */
const TONE_CLASSES: Record<StatusTone, string> = {
  info: 'bg-info-bg text-info-text',
  success: 'bg-success-bg text-success-text',
  danger: 'bg-danger-bg text-danger-text',
  neutral: 'bg-neutral-bg text-neutral-text',
  warning: 'bg-warning-bg text-warning-text',
}

function badgeClassName(tone: StatusTone, className?: string): string {
  return ['status-badge', TONE_CLASSES[tone], className ?? ''].filter(Boolean).join(' ')
}

export interface StatusBadgeProps {
  status: VisitStatus
  className?: string
}

/** Badge status kunjungan — label & nada diambil dari `VISIT_STATUS_META`. */
export function StatusBadge({ status, className }: StatusBadgeProps) {
  const meta = VISIT_STATUS_META[status]
  return <span className={badgeClassName(meta.tone, className)}>{meta.label}</span>
}

export interface BadgeProps {
  children: ReactNode
  /** Nada warna; default `neutral` untuk chip generik (lokasi, timezone, dll). */
  tone?: StatusTone
  className?: string
}

/** Badge generik untuk chip non-status (jenis fasilitas, timezone, dsb.). */
export function Badge({ children, tone = 'neutral', className }: BadgeProps) {
  return <span className={badgeClassName(tone, className)}>{children}</span>
}
