import { CalendarDays, MapPin, Wrench } from 'lucide-react'
import { StatusBadge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import type { Role, VisitDetail } from '@/lib/api/types'
import { can } from '@/lib/auth/capabilities'
import { visitSchedule, type VisitTableProps } from './VisitTable'

export type VisitCardsProps = VisitTableProps

/** Label tipe fasilitas dalam Bahasa Indonesia (bukan mentah `pusat`, `pop`, dst). */
const LOCATION_TYPE_LABEL: Record<VisitDetail['location']['type'], string> = {
  pusat: 'Kantor Pusat',
  cabang: 'Cabang',
  pop: 'POP',
  minipop: 'miniPOP',
}

/**
 * Tumpukan kartu vertikal SCR-02 (mobile < 768px) — pasangan dari `VisitTable`.
 *
 * Tabel dengan scroll horizontal DILARANG di ponsel (AGENTS.md §6.5), jadi
 * setiap kunjungan menjadi satu kartu dengan baris ikon: MapPin (fasilitas),
 * Wrench (keperluan), CalendarDays (jadwal).
 *
 * Tombol Setujui/Tolak hanya dirender bila `can(role, 'approveVisit')` DAN
 * status masih `requested` — peran `pic`/`security` TIDAK PERNAH melihat
 * kontrol approval (keamanan RBAC, lihat PRD §4).
 */
export function VisitCards({ visits, role, onApprove, onReject }: VisitCardsProps) {
  const allowApproval = can(role, 'approveVisit')

  return (
    <ul className="flex flex-col gap-3 md:hidden">
      {visits.map((visit) => {
        const schedule = visitSchedule(visit)
        const purposes = visit.purposes.map((purpose) => purpose.name).join(', ')

        return (
          <li key={visit.id} className="card p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-mono text-sm font-semibold text-ink">
                  {visit.visit_id}
                </p>
                <p className="truncate text-sm text-ink-secondary">
                  {visit.pic_user.name}
                  {visit.vendor_name !== '' ? ` · ${visit.vendor_name}` : ''}
                </p>
              </div>
              <StatusBadge status={visit.status} className="shrink-0" />
            </div>

            <div className="mt-3 flex flex-col gap-2 text-sm text-ink-secondary">
              <p className="flex items-start gap-2">
                <MapPin className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block truncate text-ink">{visit.location.name}</span>
                  <span className="block text-xs text-ink-muted">
                    {LOCATION_TYPE_LABEL[visit.location.type]}
                  </span>
                </span>
              </p>
              <p className="flex items-start gap-2">
                <Wrench className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
                <span className="min-w-0 break-words">{purposes}</span>
              </p>
              <p className="flex items-start gap-2">
                <CalendarDays className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block text-ink">{schedule.dateLabel}</span>
                  <span className="block text-xs text-ink-muted">{schedule.timeLabel}</span>
                </span>
              </p>
            </div>

            {allowApproval && visit.status === 'requested' ? (
              <div className="mt-4 flex gap-2">
                <Button
                  variant="success"
                  className="min-h-touch flex-1"
                  aria-label={`Setujui kunjungan ${visit.visit_id}`}
                  onClick={() => onApprove(visit)}
                >
                  Setujui
                </Button>
                <Button
                  variant="danger"
                  className="min-h-touch flex-1"
                  aria-label={`Tolak kunjungan ${visit.visit_id}`}
                  onClick={() => onReject(visit)}
                >
                  Tolak
                </Button>
              </div>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
