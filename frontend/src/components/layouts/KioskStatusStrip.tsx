'use client'

import { MapPin } from 'lucide-react'

import { Badge } from '@/components/ui/Badge'

export interface KioskStatusStripProps {
  /** Nama petugas dari sesi (pemanggil sudah memberi fallback). */
  guardName: string
  /** Nama pos jaga (mis. "Kantor Pusat THC (Pontianak)"). */
  locationName: string
  /** Label shift. Default `Shift Pagi`, sama dengan SHELL-03. */
  shiftLabel?: string
  /** Kelas tambahan pada pembungkus (mis. `mb-3`). */
  className?: string
}

/**
 * Pita identitas kios SHELL-03 untuk ponsel (< 768px).
 *
 * Isinya HANYA identitas petugas + pos jaga: nama pengawas di baris 1,
 * badge lokasi TEPAT DI BAWAHNYA. Badge lokasi tidak lagi di topbar
 * ponsel karena di 320px ia terpangkas jadi "Kantor Pusat THC
 * (Pontiana..." sementara baris navbar ponsel harus memuat jam +
 * counter on-site.
 *
 * Jam live dan counter "X Teknisi On-Site" TIDAK ada di pita ini — keduanya
 * hidup di KOLOM TENGAH navbar (jam di atas, counter tepat di bawahnya),
 * sebagai status BERJALAN yang harus selalu terlihat petugas, bukan
 * identitas. Di >= md navbar sudah menampilkan keduanya (jam + counter
 * sebaris) sehingga pita disembunyikan (`md:hidden`).
 */
export function KioskStatusStrip({
  guardName,
  locationName,
  shiftLabel = 'Shift Pagi',
  className,
}: KioskStatusStripProps) {
  return (
    <div
      data-testid="kiosk-status-strip"
      className={[
        'flex flex-col gap-1.5 rounded-card border border-border-light bg-surface px-3 py-2 text-ink md:hidden',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <p className="truncate text-label leading-tight" title={`${guardName} · ${shiftLabel}`}>
        <span className="font-bold text-ink">{guardName}</span>
        <span className="text-badge text-ink-secondary"> · {shiftLabel}</span>
      </p>
      <Badge tone="info" className="min-w-0 max-w-full gap-1.5 self-start">
        <MapPin aria-hidden="true" className="size-3 shrink-0" />
        <span className="truncate" title={locationName}>{locationName}</span>
      </Badge>
    </div>
  )
}
