import { StatusBadge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import type { Role, VisitDetail } from '@/lib/api/types'
import { can } from '@/lib/auth/capabilities'

export interface VisitTableProps {
  visits: VisitDetail[]
  role: Role
  onApprove: (visit: VisitDetail) => void
  onReject: (visit: VisitDetail) => void
}

export interface VisitSchedule {
  dateLabel: string
  timeLabel: string
}

/**
 * Kolom tabel SCR-02 (desktop). Lebar dipaksa proporsional via `table-fixed`
 * agar layar 768px - 1023px TIDAK perlu scroll horizontal (larangan desain).
 */
const HEADERS: Array<{ label: string; width: string }> = [
  { label: 'Visit ID', width: 'w-[11%]' },
  { label: 'PIC / Vendor', width: 'w-[16%]' },
  { label: 'Fasilitas', width: 'w-[13%]' },
  { label: 'Keperluan', width: 'w-[12%]' },
  { label: 'Tanggal & Jam', width: 'w-[15%]' },
  { label: 'Status', width: 'w-[16%]' },
  { label: 'Aksi', width: 'w-[17%]' },
]

/** Label tipe fasilitas dalam Bahasa Indonesia (bukan mentah `pusat`, `pop`, dst). */
const LOCATION_TYPE_LABEL: Record<VisitDetail['location']['type'], string> = {
  pusat: 'Kantor Pusat',
  cabang: 'Cabang',
  pop: 'POP',
  minipop: 'miniPOP',
}

/**
 * Jadwal kunjungan terformat (Bahasa Indonesia) — dipakai tabel, kartu mobile,
 * dan modal approve/reject supaya satu gaya penulisan tanggal di seluruh SCR-02.
 */
export function visitSchedule(
  visit: Pick<VisitDetail, 'start_date' | 'end_date'>,
): VisitSchedule {
  const start = new Date(visit.start_date)
  const end = new Date(visit.end_date)
  const sameDay = start.toDateString() === end.toDateString()
  const dayMonth = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short' })
  const fullDate = new Intl.DateTimeFormat('id-ID', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
  const time = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit' })
  return {
    dateLabel: sameDay ? fullDate.format(start) : `${dayMonth.format(start)} - ${fullDate.format(end)}`,
    timeLabel: `${time.format(start)} - ${time.format(end)}`,
  }
}

/** Satu baris ringkas "26 Sep 2026, 08.00 - 16.00" untuk modal & ringkasan. */
export function formatVisitSchedule(
  visit: Pick<VisitDetail, 'start_date' | 'end_date'>,
): string {
  const schedule = visitSchedule(visit)
  return `${schedule.dateLabel}, ${schedule.timeLabel}`
}

/**
 * Tabel kunjungan desktop (>= 768px). Pasangan dari `VisitCards`.
 *
 * Tombol Setujui/Tolak hanya dirender bila `can(role, 'approveVisit')` DAN
 * status masih `requested` — peran `pic`/`security` TIDAK PERNAH melihat
 * kontrol approval (keamanan RBAC, lihat PRD §4).
 */
export function VisitTable({ visits, role, onApprove, onReject }: VisitTableProps) {
  const allowApproval = can(role, 'approveVisit')

  return (
    <div className="card hidden overflow-hidden md:block">
      <table className="w-full table-fixed border-collapse text-left">
        <thead>
          <tr>
            {HEADERS.map((header) => (
              <th
                key={header.label}
                scope="col"
                className={`${header.width} border-b border-border-light bg-neutral-bg px-4 py-3 text-label font-semibold text-ink-secondary`}
              >
                {header.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visits.map((visit) => {
            const schedule = visitSchedule(visit)
            const purposes = visit.purposes.map((purpose) => purpose.name).join(', ')

            return (
              <tr
                key={visit.id}
                className="border-b border-border-light transition-colors last:border-b-0 hover:bg-page"
              >
                <td className="truncate px-4 py-3 font-mono text-sm font-semibold text-ink">
                  {visit.visit_id}
                </td>
                <td className="px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{visit.pic_user.name}</p>
                    <p className="truncate text-xs text-ink-muted">{visit.vendor_name}</p>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink" title={visit.location.name}>
                      {visit.location.name}
                    </p>
                    <p className="truncate text-xs text-ink-muted">
                      {LOCATION_TYPE_LABEL[visit.location.type]}
                    </p>
                  </div>
                </td>
                <td className="truncate px-4 py-3 text-sm text-ink-secondary" title={purposes}>
                  {purposes}
                </td>
                <td className="px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink">{schedule.dateLabel}</p>
                    <p className="truncate text-xs text-ink-secondary">{schedule.timeLabel}</p>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={visit.status} className="max-w-full" />
                </td>
                <td className="px-4 py-3">
                  {allowApproval && visit.status === 'requested' ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="success"
                        className="min-h-touch px-3"
                        aria-label={`Setujui kunjungan ${visit.visit_id}`}
                        onClick={() => onApprove(visit)}
                      >
                        Setujui
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        className="min-h-touch px-3"
                        aria-label={`Tolak kunjungan ${visit.visit_id}`}
                        onClick={() => onReject(visit)}
                      >
                        Tolak
                      </Button>
                    </div>
                  ) : (
                    <span className="text-ink-muted" aria-hidden="true">
                      —
                    </span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
