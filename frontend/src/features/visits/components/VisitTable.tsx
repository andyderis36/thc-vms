'use client'

import Link from 'next/link'
import { ArrowDown, ArrowUp, ArrowUpDown, Check, X } from 'lucide-react'
import { StatusBadge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import type { Role, VisitDetail, VisitOrder, VisitSortField } from '@/lib/api/types'
import { can } from '@/lib/auth/capabilities'
import { primaryVendorDisplay } from '@/lib/visits/vendor-display'
import { visitVendorUser } from '@/lib/visits/vendor-user'
import { isApprovableStatus, isRejectableStatus } from '@/lib/visits/visit-status'
import { SpkFileLink } from './SpkFileLink'

export interface VisitTableProps {
  visits: VisitDetail[]
  role: Role
  onApprove: (visit: VisitDetail) => void
  onReject: (visit: VisitDetail) => void
  /** Sorting header "Tanggal & Jam" — opsional; state sorting hidup di halaman pemanggil. */
  sortBy?: VisitSortField
  order?: VisitOrder
  onSortChange?: (field: VisitSortField, order: VisitOrder) => void
}

export interface VisitSchedule {
  dateLabel: string
  timeLabel: string
}

/**
 * Kolom tabel SCR-02. Lebar dipaksa proporsional via `table-fixed`.
 *
 * Tier responsif (design system §5.1): tabel hanya tampil di desktop
 * (>= 1024px); tablet 768px - 1023px memakai grid 2 kolom dan ponsel
 * (< 768px) memakai tumpukan kartu — keduanya dari `VisitCards`.
 */
const HEADERS: Array<{ label: string; width: string; sortField?: VisitSortField }> = [
  { label: 'Visit ID', width: 'w-[11%]' },
  { label: 'Vendor/Mitra', width: 'w-[15%]' },
  { label: 'Fasilitas', width: 'w-[12%]' },
  { label: 'Teknisi', width: 'w-[16%]' },
  { label: 'SPK', width: 'w-[9%]' },
  { label: 'Tanggal & Jam', width: 'w-[14%]', sortField: 'start_date' },
  { label: 'Status', width: 'w-[11%]' },
  { label: 'Aksi', width: 'w-[12%]' },
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

/** Nama teknisi per kunjungan — dipakai tabel desktop & kartu mobile. */
export interface TechnicianDisplay {
  full: string
  short: string
  count: number
}

/** Gabung nama teknisi dari `visitors` (nullable-safe, bisa []). */
export function technicianDisplay(
  visit: Pick<VisitDetail, 'visitors'>,
): TechnicianDisplay {
  const names = (visit.visitors ?? [])
    .map((visitor) => visitor.name.trim())
    .filter((name) => name.length > 0)
  const count = names.length
  const full = names.join(', ')
  const short = count > 2 ? `${names.slice(0, 2).join(', ')} +${count - 2} lainnya` : full
  return { full, short, count }
}

/** Satu baris ringkas "26 Sep 2026, 08.00 - 16.00" untuk modal & ringkasan. */
export function formatVisitSchedule(
  visit: Pick<VisitDetail, 'start_date' | 'end_date'>,
): string {
  const schedule = visitSchedule(visit)
  return `${schedule.dateLabel}, ${schedule.timeLabel}`
}

/**
 * Tabel kunjungan desktop (>= 1024px). Pasangan dari `VisitCards`
 * yang menangani ponsel (< 768px) dan tablet (768px - 1023px, 2 kolom).
 *
 * Tombol Setujui dirender bila `can(role, 'approveVisit')` DAN status
 * `requested` ATAU `rescheduled` (transisi `rescheduled→approved` legal di
 * backend); Tolak HANYA untuk `requested` (`rescheduled→rejected` ilegal).
 * Peran `vendor`/`security` TIDAK PERNAH melihat kontrol approval (keamanan
 * RBAC, lihat PRD §4).
 */
export function VisitTable({
  visits,
  role,
  onApprove,
  onReject,
  sortBy,
  order,
  onSortChange,
}: VisitTableProps) {
  const allowApproval = can(role, 'approveVisit')

  const toggleSort = (field: VisitSortField): void => {
    if (onSortChange === undefined) return
    onSortChange(field, sortBy === field && order === 'asc' ? 'desc' : 'asc')
  }

  return (
    <div className="card hidden overflow-hidden lg:block">
      <table className="w-full table-fixed border-collapse text-left">
        <thead>
          <tr>
            {HEADERS.map((header) => {
              const sortField = header.sortField
              const isActiveSort = sortField !== undefined && sortBy === sortField
              const ariaSort = !isActiveSort
                ? undefined
                : order === 'asc'
                  ? 'ascending'
                  : 'descending'
              return (
                <th
                  key={header.label}
                  scope="col"
                  aria-sort={ariaSort}
                  className={`${header.width} border-b border-border-light bg-brand/5 px-2 sm:px-3 lg:px-4 py-3 text-xs sm:text-sm font-semibold text-ink-secondary`}
                >
                  {sortField !== undefined && onSortChange !== undefined ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(sortField)}
                      className="inline-flex items-center gap-1 rounded-control hover:text-ink focus-visible:outline-2 focus-visible:outline-brand"
                    >
                      {header.label}
                      {isActiveSort ? (
                        order === 'asc' ? (
                          <ArrowUp className="size-3.5" aria-hidden="true" />
                        ) : (
                          <ArrowDown className="size-3.5" aria-hidden="true" />
                        )
                      ) : (
                        <ArrowUpDown className="size-3.5 opacity-50" aria-hidden="true" />
                      )}
                    </button>
                  ) : (
                    header.label
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-border-light">
          {visits.map((visit) => {
            const schedule = visitSchedule(visit)
            const vendorDisplay = primaryVendorDisplay(visit.visitors)
            const vendorUser = visitVendorUser(visit)
            const technicians = technicianDisplay(visit)
            const spkUrl = visit.assignment_letter_url

            return (
              <tr
                key={visit.id}
                className="transition-colors hover:bg-brand/5"
              >
                <td className="truncate px-2 sm:px-3 lg:px-4 py-3 font-mono text-xs sm:text-sm" title={visit.visit_id}>
                  <Link
                    href={`/visits/${visit.id}`}
                    aria-label={`Lihat detail kunjungan ${visit.visit_id}`}
                    className="font-semibold text-brand underline underline-offset-2 hover:text-brand-dark"
                  >
                    {visit.visit_id}
                  </Link>
                </td>
                <td className="px-2 sm:px-3 lg:px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-xs sm:text-sm font-medium text-ink" title={vendorUser?.name}>
                      {vendorUser?.name}
                    </p>
                    <p className="truncate text-xs text-ink-muted" title={vendorDisplay}>
                      {vendorDisplay}
                    </p>
                  </div>
                </td>
                <td className="px-2 sm:px-3 lg:px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-xs sm:text-sm text-ink" title={visit.location.name}>
                      {visit.location.name}
                    </p>
                    <p className="truncate text-xs text-ink-muted">
                      {LOCATION_TYPE_LABEL[visit.location.type]}
                    </p>
                  </div>
                </td>
                <td className="px-2 sm:px-3 lg:px-4 py-3">
                  {technicians.count === 0 ? (
                    <span className="text-xs sm:text-sm text-ink-muted">—</span>
                  ) : (
                    <div className="min-w-0">
                      <p className="truncate text-xs sm:text-sm text-ink" title={technicians.full}>
                        {technicians.short}
                      </p>
                      {technicians.count > 2 ? (
                        <p className="truncate text-xs text-ink-muted">
                          {technicians.count} orang
                        </p>
                      ) : null}
                    </div>
                  )}
                </td>
                <td className="px-2 sm:px-3 lg:px-4 py-3">
                  {spkUrl ? (
                    <SpkFileLink
                      visitId={visit.id}
                      className="inline-flex min-h-touch items-center text-sm font-medium text-brand underline underline-offset-2 hover:text-brand-dark"
                      ariaLabel={`Lihat surat tugas SPK kunjungan ${visit.visit_id}`}
                      fallback={<span className="text-xs sm:text-sm text-ink-muted">—</span>}
                    >
                      Lihat SPK
                    </SpkFileLink>
                  ) : (
                    <span className="text-xs sm:text-sm text-ink-muted">—</span>
                  )}
                </td>
                <td className="px-2 sm:px-3 lg:px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-xs sm:text-sm text-ink" title={schedule.dateLabel}>
                      {schedule.dateLabel}
                    </p>
                    <p className="truncate text-xs text-ink-secondary" title={schedule.timeLabel}>
                      {schedule.timeLabel}
                    </p>
                  </div>
                </td>
                <td className="px-2 sm:px-3 lg:px-4 py-3">
                  <StatusBadge status={visit.status} className="max-w-full" />
                </td>
                <td className="px-2 sm:px-3 lg:px-4 py-3">
                  {/*
                    Sel Aksi 12% (~86px di 1024px, ~117px di 1280px) tak muat
                    menampung ikon + label sekaligus (Setujui+ikon ~110px).
                    Pola: ikon-saja di lg–xl (48px, muat di sel sempit),
                    label teks kembali di xl+ tanpa ikon; nama aksi tetap
                    terbaca screen reader lewat aria-label di kedua mode.
                    Tanpa hak approval / status di luar `requested`+`rescheduled`:
                    sel diisi strip "—" (bukan sel kosong). Tolak hanya untuk
                    `requested` — `rescheduled→rejected` ilegal di backend.
                    Navigasi detail lewat link Visit ID.
                  */}
                  {allowApproval && isApprovableStatus(visit.status) ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="success"
                        className="min-h-touch px-3"
                        aria-label={`Setujui kunjungan ${visit.visit_id}`}
                        onClick={() => onApprove(visit)}
                      >
                        <Check className="size-4 xl:hidden" aria-hidden="true" />
                        <span className="hidden xl:inline">Setujui</span>
                      </Button>
                      {isRejectableStatus(visit.status) ? (
                        <Button
                          size="sm"
                          variant="danger"
                          className="min-h-touch px-3"
                          aria-label={`Tolak kunjungan ${visit.visit_id}`}
                          onClick={() => onReject(visit)}
                        >
                          <X className="size-4 xl:hidden" aria-hidden="true" />
                          <span className="hidden xl:inline">Tolak</span>
                        </Button>
                      ) : null}
                    </div>
                  ) : (
                    <span className="text-xs sm:text-sm text-ink-muted">—</span>
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
