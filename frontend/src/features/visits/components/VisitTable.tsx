'use client'

import Link from 'next/link'
import { Check, X } from 'lucide-react'
import { StatusBadge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import type { Role, VisitDetail } from '@/lib/api/types'
import { can } from '@/lib/auth/capabilities'
import { primaryVendorDisplay } from '@/lib/visits/vendor-display'

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
 * Kolom tabel SCR-02. Lebar dipaksa proporsional via `table-fixed`.
 *
 * Tier responsif (design system §5.1): tabel hanya tampil di desktop
 * (>= 1024px); tablet 768px - 1023px memakai grid 2 kolom dan ponsel
 * (< 768px) memakai tumpukan kartu — keduanya dari `VisitCards`.
 */
const HEADERS: Array<{ label: string; width: string }> = [
  { label: 'Visit ID', width: 'w-[10%]' },
  { label: 'Vendor/Mitra', width: 'w-[13%]' },
  { label: 'Fasilitas', width: 'w-[11%]' },
  { label: 'Keperluan', width: 'w-[10%]' },
  { label: 'Teknisi', width: 'w-[14%]' },
  { label: 'SPK', width: 'w-[8%]' },
  { label: 'Tanggal & Jam', width: 'w-[12%]' },
  { label: 'Status', width: 'w-[10%]' },
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
 * Tombol Setujui/Tolak hanya dirender bila `can(role, 'approveVisit')` DAN
 * status masih `requested` — peran `vendor`/`security` TIDAK PERNAH melihat
 * kontrol approval (keamanan RBAC, lihat PRD §4).
 */
export function VisitTable({ visits, role, onApprove, onReject }: VisitTableProps) {
  const allowApproval = can(role, 'approveVisit')

  return (
    <div className="card hidden overflow-hidden lg:block">
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
            const vendorDisplay = primaryVendorDisplay(visit.visitors)
            const technicians = technicianDisplay(visit)
            const spkUrl = visit.assignment_letter_url

            return (
              <tr
                key={visit.id}
                className="border-b border-border-light transition-colors last:border-b-0 hover:bg-page"
              >
                <td className="truncate px-4 py-3 font-mono text-sm" title={visit.visit_id}>
                  <Link
                    href={`/visits/${visit.id}`}
                    aria-label={`Lihat detail kunjungan ${visit.visit_id}`}
                    className="font-semibold text-brand underline underline-offset-2 hover:text-brand-strong"
                  >
                    {visit.visit_id}
                  </Link>
                </td>
                <td className="px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink" title={visit.pic_user.name}>
                      {visit.pic_user.name}
                    </p>
                    <p className="truncate text-xs text-ink-muted" title={vendorDisplay}>
                      {vendorDisplay}
                    </p>
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
                  {technicians.count === 0 ? (
                    <span className="text-sm text-ink-muted">—</span>
                  ) : (
                    <div className="min-w-0">
                      <p className="truncate text-sm text-ink" title={technicians.full}>
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
                <td className="px-4 py-3">
                  {spkUrl ? (
                    <a
                      href={spkUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Lihat surat tugas SPK kunjungan ${visit.visit_id}`}
                      className="inline-flex min-h-touch items-center text-sm font-medium text-brand underline underline-offset-2 hover:text-brand-strong"
                    >
                      Lihat SPK
                    </a>
                  ) : (
                    <span className="text-sm text-ink-muted">—</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink" title={schedule.dateLabel}>
                      {schedule.dateLabel}
                    </p>
                    <p className="truncate text-xs text-ink-secondary" title={schedule.timeLabel}>
                      {schedule.timeLabel}
                    </p>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={visit.status} className="max-w-full" />
                </td>
                <td className="px-4 py-3">
                  {/*
                    Sel Aksi 12% (~86px di 1024px, ~117px di 1280px) tak muat
                    menampung ikon + label sekaligus (Setujui+ikon ~110px).
                    Pola: ikon-saja di lg–xl (48px, muat di sel sempit),
                    label teks kembali di xl+ tanpa ikon; nama aksi tetap
                    terbaca screen reader lewat aria-label di kedua mode.
                    Tanpa hak approval / status bukan `requested`: sel diisi
                    strip "—" (bukan sel kosong). Navigasi detail lewat link
                    Visit ID.
                  */}
                  {allowApproval && visit.status === 'requested' ? (
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
                    </div>
                  ) : (
                    <span className="text-sm text-ink-muted">—</span>
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
