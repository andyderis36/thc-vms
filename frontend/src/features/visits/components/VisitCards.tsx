'use client'

import Link from 'next/link'
import { CalendarDays, FileText, MapPin, Users, Wrench } from 'lucide-react'
import { StatusBadge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import type { VisitDetail } from '@/lib/api/types'
import { can } from '@/lib/auth/capabilities'
import { primaryVendorDisplay } from '@/lib/visits/vendor-display'
import { visitVendorUser } from '@/lib/visits/vendor-user'
import { isApprovableStatus, isRejectableStatus } from '@/lib/visits/visit-status'
import { TABLE_CARD_LIST_CLASS } from '@/lib/table-styles'
import { technicianDisplay, visitSchedule, type VisitTableProps } from './VisitTable'
import { SpkFileLink } from './SpkFileLink'

export type VisitCardsProps = VisitTableProps

/** Label tipe fasilitas dalam Bahasa Indonesia (bukan mentah `pusat`, `pop`, dst). */
const LOCATION_TYPE_LABEL: Record<VisitDetail['location']['type'], string> = {
  pusat: 'Kantor Pusat',
  cabang: 'Cabang',
  pop: 'POP',
  minipop: 'miniPOP',
}

/**
 * Kartu kunjungan mandiri SCR-02 — pasangan dari `VisitTable`.
 *
 * Tier responsif (design system §5.1 / §5.2):
 * - Ponsel (< 768px): tumpukan kartu vertikal 1 kolom — tabel dengan scroll
 *   horizontal DILARANG (AGENTS.md §6.5).
 * - Tablet (768px - 1023px): grid 2 kolom.
 * - Desktop (>= 1024px): sembunyi, digantikan `VisitTable`.
 *
 * Setiap kartu memuat ID + status badge + data Vendor/Mitra + aksi (§5.2 ayat 2),
 * dengan baris ikon: MapPin (fasilitas), Wrench (keperluan), CalendarDays
 * (jadwal). Teks panjang tanpa spasi dipatah via `wrap-anywhere`.
 *
 * Tombol Setujui dirender bila `can(role, 'approveVisit')` DAN status
 * `requested` ATAU `rescheduled` (transisi `rescheduled→approved` legal di
 * backend); Tolak HANYA untuk `requested` (`rescheduled→rejected` ilegal).
 * Peran `vendor`/`security` TIDAK PERNAH melihat kontrol approval (keamanan
 * RBAC, lihat PRD §4).
 */
export function VisitCards({ visits, role, onApprove, onReject }: VisitCardsProps) {
  const allowApproval = can(role, 'approveVisit')

  return (
    <ul className={TABLE_CARD_LIST_CLASS}>
      {visits.map((visit) => {
        const schedule = visitSchedule(visit)
        const purposes = visit.purposes.map((purpose) => purpose.name).join(', ')
        const vendorDisplay = primaryVendorDisplay(visit.visitors)
        const hasVendor = vendorDisplay !== '—'
        const vendorUser = visitVendorUser(visit)
        const technicians = technicianDisplay(visit)
        const spkUrl = visit.assignment_letter_url

        return (
          <li key={visit.id} className="card flex flex-col p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Link
                  href={`/visits/${visit.id}`}
                  aria-label={`Lihat detail kunjungan ${visit.visit_id}`}
                  title={visit.visit_id}
                  className="inline-flex min-h-touch max-w-full items-center font-mono text-sm font-semibold text-brand underline underline-offset-2 hover:text-brand-dark"
                >
                  <span className="min-w-0 truncate">{visit.visit_id}</span>
                </Link>
                <p
                  className="truncate text-xs sm:text-sm text-ink-secondary"
                  title={
                    hasVendor
                      ? `${vendorUser?.name} · ${vendorDisplay}`
                      : vendorUser?.name
                  }
                >
                  {vendorUser?.name}
                  {hasVendor ? ` · ${vendorDisplay}` : ''}
                </p>
              </div>
              <StatusBadge status={visit.status} className="shrink-0" />
            </div>

            <div className="mt-3 flex flex-1 flex-col gap-2 text-xs sm:text-sm text-ink-secondary">
              <p className="flex items-start gap-2">
                <MapPin className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block truncate text-ink" title={visit.location.name}>
                    {visit.location.name}
                  </span>
                  <span className="block text-xs text-ink-muted">
                    {LOCATION_TYPE_LABEL[visit.location.type]}
                  </span>
                </span>
              </p>
              <p className="flex items-start gap-2">
                <Wrench className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
                <span className="min-w-0 wrap-anywhere">{purposes}</span>
              </p>
              <p className="flex items-start gap-2">
                <Users className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
                <span className="min-w-0">
                  {technicians.count === 0 ? (
                    <span className="text-ink-muted">—</span>
                  ) : (
                    <>
                      <span className="block truncate text-ink" title={technicians.full}>
                        {technicians.short}
                      </span>
                      {technicians.count > 2 ? (
                        <span className="block text-xs text-ink-muted">
                          {technicians.count} orang
                        </span>
                      ) : null}
                    </>
                  )}
                </span>
              </p>
              <p className="flex items-start gap-2">
                <FileText className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
                <span className="min-w-0">
                  {spkUrl ? (
                    <SpkFileLink
                      visitId={visit.id}
                      className="inline-flex min-h-touch items-center font-medium text-brand underline underline-offset-2"
                      ariaLabel={`Lihat surat tugas SPK kunjungan ${visit.visit_id}`}
                      fallback={<span className="text-ink-muted">—</span>}
                    >
                      Lihat SPK
                    </SpkFileLink>
                  ) : (
                    <span className="text-ink-muted">—</span>
                  )}
                </span>
              </p>
              <p className="flex items-start gap-2">
                <CalendarDays className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block text-ink">{schedule.dateLabel}</span>
                  <span className="block text-xs text-ink-muted">{schedule.timeLabel}</span>
                </span>
              </p>
            </div>

            {/*
              Kartu hanya memuat aksi approval bila berhak + status
              `requested`/`rescheduled`; Tolak hanya untuk `requested`
              (`rescheduled→rejected` ilegal di backend). Tanpa aksi
              blok ini tidak dirender. Navigasi detail lewat link Visit ID
              di atas (target sentuh utama di ponsel, min-h-touch).
            */}
            {allowApproval && isApprovableStatus(visit.status) ? (
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  variant="success"
                  className="min-h-touch flex-1"
                  aria-label={`Setujui kunjungan ${visit.visit_id}`}
                  onClick={() => onApprove(visit)}
                >
                  Setujui
                </Button>
                {isRejectableStatus(visit.status) ? (
                  <Button
                    variant="danger"
                    className="min-h-touch flex-1"
                    aria-label={`Tolak kunjungan ${visit.visit_id}`}
                    onClick={() => onReject(visit)}
                  >
                    Tolak
                  </Button>
                ) : null}
              </div>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
