'use client'

import { AlertTriangle, Building2, CircleCheck, Clock, LogIn, MapPin, Truck } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { StatusBadge } from '@/components/ui/Badge'
import { getCheckinBlockReason, isWithinCheckinWindow } from '@/lib/visits/tolerance'
import { primaryVendorDisplay } from '@/lib/visits/vendor-display'
import type { VisitDetail } from '@/lib/api/types'
import { formatTanggalWaktu } from '@/features/visits/detail/Timeline'

export interface GuestCardProps {
  visit: VisitDetail
  /** Kartu ini sedang proses check-in/out - hanya ia yang tampil memuat. */
  pending: boolean
  onCheckIn: (visit: VisitDetail) => void
  onCheckOut: (visit: VisitDetail) => void
}

/**
 * Satu kartu tamu untuk antrean gerbang.
 *
 * Aturan toleransi +/-2 jam (`AGENTS.md` §6.2) divalidasi DI SINI juga, bukan
 * hanya di backend: petugas harus melihat alasannya sebelum tombol mati,
 * bukan sekadar menemukan tombol yang tidak bisa ditekan.
 */
export function GuestCard({ visit, pending, onCheckIn, onCheckOut }: GuestCardProps) {
  const now = new Date()
  const blockReason = getCheckinBlockReason(now, visit.start_date, visit.end_date)
  const withinWindow = isWithinCheckinWindow(now, visit.start_date, visit.end_date)
  const checkInAllowed = visit.status === 'approved' && withinWindow
  const checkOutAllowed = visit.status === 'visiting'
  /** Tab `Selesai`: tidak ada aksi gerbang sama sekali — jangan menampilkan
   * dinding tombol check-in disabled (SCR-05 tab Selesai = readout netral). */
  const completed = visit.status === 'completed'
  const checkOutAtText =
    completed && visit.check_out_at != null && visit.check_out_at !== ''
      ? ` \u2014 keluar ${formatTanggalWaktu(visit.check_out_at)}`
      : ''

  const technicianNames = visit.visitors.map((visitor) => visitor.name).join(', ')
  const vendorDisplay = primaryVendorDisplay(visit.visitors)

  return (
    <Card>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-base font-bold text-ink">{visit.visit_id}</p>
            <p className="truncate text-sm text-ink">{technicianNames}</p>
          </div>
          <StatusBadge status={visit.status} />
        </div>

        <dl className="flex flex-col gap-1.5 text-sm text-ink-secondary">
          <div className="flex items-center gap-2">
            <Truck className="size-4 shrink-0" aria-hidden="true" />
            <dt className="sr-only">Vendor</dt>
            <dd className="truncate">{vendorDisplay}</dd>
          </div>
          <div className="flex items-center gap-2">
            <Building2 className="size-4 shrink-0" aria-hidden="true" />
            <dt className="sr-only">Fasilitas tujuan</dt>
            <dd className="truncate">{visit.location.name}</dd>
          </div>
          <div className="flex items-center gap-2">
            <Clock className="size-4 shrink-0" aria-hidden="true" />
            <dt className="sr-only">Jadwal</dt>
            <dd>
              {formatTanggalWaktu(visit.start_date)} - {formatTanggalWaktu(visit.end_date)}
            </dd>
          </div>
          {visit.check_in_at !== null &&
          visit.check_in_at !== undefined &&
          visit.check_in_at !== '' ? (
            <div className="flex items-center gap-2">
              <LogIn className="size-4 shrink-0" aria-hidden="true" />
              <dt className="sr-only">Waktu masuk aktual</dt>
              <dd>Masuk {formatTanggalWaktu(visit.check_in_at)}</dd>
            </div>
          ) : null}
        </dl>

        {blockReason !== null && checkInAllowed === false && visit.status === 'approved' ? (
          <p
            role="status"
            className="flex items-start gap-2 rounded-control bg-warning-bg px-3 py-2 text-xs font-semibold text-warning-text"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{blockReason}</span>
          </p>
        ) : null}

        {checkOutAllowed ? (
          <Button
            variant="danger"
            size="gate"
            loading={pending}
            onClick={() => onCheckOut(visit)}
            className="mt-1"
          >
            <MapPin className="size-5 shrink-0" aria-hidden="true" />
            Check-out Keluar
          </Button>
        ) : completed ? (
          // Cabang no-action: status readout netral, bukan tombol disabled.
          <p
            role="status"
            className="mt-1 flex items-start gap-2 rounded-control bg-neutral-bg px-3 py-2.5 text-sm font-semibold text-neutral-text"
          >
            <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>Kunjungan selesai{checkOutAtText}</span>
          </p>
        ) : (
          <Button
            variant="success"
            size="gate"
            loading={pending}
            disabled={!checkInAllowed}
            onClick={() => onCheckIn(visit)}
            className="mt-1"
          >
            Check-in Masuk
          </Button>
        )}
      </div>
    </Card>
  )
}
