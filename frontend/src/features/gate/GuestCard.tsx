'use client'

import { createContext, useContext } from 'react'
import { AlertTriangle, Building2, CircleCheck, Clock, LogIn, MapPin, Truck } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { StatusBadge } from '@/components/ui/Badge'
import { getCheckinBlockReason, isWithinCheckinWindow } from '@/lib/visits/tolerance'
import { primaryVendorDisplay } from '@/lib/visits/vendor-display'
import type { VisitDetail, VisitStatus } from '@/lib/api/types'
import { formatTanggalWaktu } from '@/features/visits/detail/Timeline'

/** Aksi utama yang ditawarkan satu kartu antrean gerbang (SCR-05). */
export type GateCardAction = 'check-in' | 'check-out' | 'completed' | 'none'

/**
 * Peta status kunjungan -> aksi kartu antrean gerbang (murni, tanpa DOM).
 *
 * Hanya `approved` yang menawarkan check-in dan hanya `visiting` yang
 * menawarkan check-out. `rescheduled` WAJIB disetujui ulang sebelum check-in
 * (backend menolak rescheduled->visiting), jadi kartunya tampil TANPA tombol
 * aksi apa pun — baris tetap terdaftar (badge "Jadwal Digeser" + Visit ID
 * yang bisa diklik membuka popup detail). `completed` menjadi readout netral
 * (tab Selesai).
 */
export function gateCardAction(status: VisitStatus): GateCardAction {
  if (status === 'approved') return 'check-in'
  if (status === 'visiting') return 'check-out'
  if (status === 'completed') return 'completed'
  return 'none'
}

/**
 * Kanal klik kartu -> halaman `/gate`.
 *
 * `GateQueue` (di luar cakupan berkas yang boleh diubah tugas ini) merender
 * kartu ini tanpa meneruskan props baru, jadi layar `/gate` menyuntikkan
 * handler lewat context ini. Prop `onSelect` menimpa nilai context bila
 * disediakan (pemakaian eksplisit / pengujian).
 */
export const GuestSelectContext = createContext<((visit: VisitDetail) => void) | null>(null)

export interface GuestCardProps {
  visit: VisitDetail
  /** Kartu ini sedang proses check-in/out - hanya ia yang tampil memuat. */
  pending: boolean
  onCheckIn: (visit: VisitDetail) => void
  onCheckOut: (visit: VisitDetail) => void
  /** Klik Visit ID -> tampilkan detail kunjungan. Opsional; fallback: `GuestSelectContext`. */
  onSelect?: (visit: VisitDetail) => void
}

/**
 * Satu kartu tamu untuk antrean gerbang.
 *
 * Aturan toleransi +/-2 jam (`AGENTS.md` §6.2) divalidasi DI SINI juga, bukan
 * hanya di backend: petugas harus melihat alasannya sebelum tombol mati,
 * bukan sekadar menemukan tombol yang tidak bisa ditekan.
 */
export function GuestCard({ visit, pending, onCheckIn, onCheckOut, onSelect }: GuestCardProps) {
  const selectFromContext = useContext(GuestSelectContext)
  const select = onSelect ?? selectFromContext
  const now = new Date()
  const blockReason = getCheckinBlockReason(now, visit.start_date, visit.end_date)
  const withinWindow = isWithinCheckinWindow(now, visit.start_date, visit.end_date)
  const action = gateCardAction(visit.status)
  const checkInAllowed = action === 'check-in' && withinWindow
  const checkOutAllowed = action === 'check-out'
  /** Tab `Selesai`: tidak ada aksi gerbang sama sekali — jangan menampilkan
   * dinding tombol check-in disabled (SCR-05 tab Selesai = readout netral). */
  const completed = action === 'completed'
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
            {select !== null ? (
              // Klik Visit ID = buka popup detail (data segar diambil halaman
              // /gate, sama seperti hasil pindai). Tampilan teks tidak berubah
              // selain kursor pointer + label aksesibel untuk pembaca layar.
              <button
                type="button"
                onClick={() => select(visit)}
                aria-label={`Lihat detail ${visit.visit_id}`}
                className="cursor-pointer text-left text-base font-bold text-ink"
              >
                {visit.visit_id}
              </button>
            ) : (
              <p className="text-base font-bold text-ink">{visit.visit_id}</p>
            )}
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

        {blockReason !== null && action === 'check-in' && checkInAllowed === false ? (
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
        ) : action === 'check-in' ? (
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
          // Cabang tanpa aksi (`rescheduled` menunggu persetujuan ulang,
          // requested/rejected/... di luar siklus gerbang): kartu tetap
          // terdaftar dengan badge status + Visit ID yang bisa diklik,
          // tanpa tombol aksi apa pun.
        ) : null}
      </div>
    </Card>
  )
}
