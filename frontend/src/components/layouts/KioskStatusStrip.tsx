'use client'

import Link from 'next/link'
import { MapPin } from 'lucide-react'

import { Badge } from '@/components/ui/Badge'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { getGuardShiftLabel } from '@/lib/guard-shift'

export interface KioskStatusStripProps {
  /** Nama petugas dari sesi (pemanggil sudah memberi fallback). */
  guardName: string
  /** Nama pos jaga (mis. "Kantor Pusat THC (Pontianak)"). */
  locationName: string
  /** Foto profil petugas dari sesi; kosong → inisial. */
  avatarUrl?: string | null
  /** Label shift. Default dinamis dari jam dinding WIB, sama dengan SHELL-03. */
  shiftLabel?: string
  /** Kelas tambahan pada pembungkus (mis. `mb-3`). */
  className?: string
  /**
   * Opsional: bila diisi, seluruh pita menjadi tautan tap-to-profile
   * (mis. `/profile`) dengan target sentuh `min-h-touch`.
   */
  href?: string
}

/**
 * Pita identitas kios SHELL-03 untuk ponsel (< 768px).
 *
 * Geometri IDENTIK dengan `VendorIdentityCard` (K3): permukaan `.card`
 * (surface + 1px border + `--radius-card` + `--shadow-card`), padding
 * `p-4`, jarak avatar↔teks `gap-4`, dan slot avatar 48px (`size="lg"`).
 * Bentuknya baris `flex items-center` — avatar di kiri, kolom identitas
 * di kanan.
 *
 * Isinya HANYA identitas petugas + pos jaga dalam dua baris:
 * - Baris 1 = nama pengawas (`flex-1 min-w-0 truncate` + tooltip nama
 *   PENUH di elemen nama) + PILL SHIFT bersaudara di kanan
 *   (`ml-auto shrink-0 whitespace-nowrap`). Nama panjang hanya menyusut
 *   dirinya sendiri, sehingga label shift TIDAK PERNAH terpotong
 *   truncation nama.
 * - Baris 2 = chip lokasi rata KANAN di bawah baris 1 (`self-end`),
 *   lebih ringkas dari sebelumnya (`px-1.5 py-0`, ikon MapPin `size-2.5`).
 *
 * Chip lokasi tidak lagi di topbar ponsel karena di 320px ia terpangkas
 * jadi "Kantor Pusat THC (Pontiana..." sementara baris navbar ponsel
 * harus memuat jam + counter on-site.
 *
 * Saat `href` diberikan, seluruh pita menjadi `<Link>` ke profil petugas
 * (tap-to-profile, `min-h-touch`) — tanpa kontrol interaktif bersarang di
 * dalamnya.
 *
 * Jam live dan counter "X Teknisi On-Site" TIDAK ada di pita ini — keduanya
 * hidup di KOLOM TENGAH navbar (jam di atas, counter tepat di bawahnya),
 * sebagai status BERJALAN yang harus selalu terlihat petugas, bukan
 * identitas. Di >= md navbar sudah menampilkan avatar + nama petugas
 * sehingga pita disembunyikan (`md:hidden`).
 */
export function KioskStatusStrip({
  guardName,
  locationName,
  avatarUrl,
  shiftLabel = getGuardShiftLabel(),
  className,
  href,
}: KioskStatusStripProps) {
  const rootClassName = [
    // `.card` + `gap-4`/`p-4` = geometri kartu identitas vendor (K3).
    'card flex min-w-0 items-center gap-4 p-4 md:hidden',
    // Jangan tambahkan `block` di sini: root sudah `flex`, dan dua
    // utilitas display sekaligus hanya "menang" karena urutan emisi Tailwind.
    href
      ? 'w-full min-h-touch transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand'
      : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  const content = (
    <>
      <UserAvatar name={guardName} avatarUrl={avatarUrl} size="lg" />
      {/* Kolom identitas: baris 1 = nama (`flex-1` truncate, membawa
          tooltip nama penuh) + pill shift `ml-auto` yang tak ikut
          menyusut; baris 2 = chip lokasi `self-end` (rata kanan) di
          bawahnya. */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="flex min-w-0 items-center gap-2 text-label leading-tight">
          <span
            data-testid="kiosk-guard-name"
            className="min-w-0 flex-1 truncate font-bold text-ink"
            title={guardName}
          >
            {guardName}
          </span>
          {/* Pill shift = `<span>` polos dengan kelas token nada yang sama
              seperti `Badge` (komponen itu tidak meneruskan `data-testid`).
              `ml-auto` + `shrink-0` menepikkannya ke kanan tanpa ikut
              terpotong truncation nama. */}
          <span
            data-testid="kiosk-shift"
            className="status-badge bg-neutral-bg text-neutral-text ml-auto shrink-0 whitespace-nowrap px-1.5 py-0 text-badge"
          >
            {shiftLabel}
          </span>
        </p>
        <Badge
          tone="info"
          className="min-w-0 max-w-full gap-1 self-end px-1.5 py-0 text-badge"
        >
          <MapPin aria-hidden="true" className="size-2.5 shrink-0" />
          <span
            data-testid="kiosk-location"
            className="truncate"
            title={locationName}
          >
            {locationName}
          </span>
        </Badge>
      </div>
    </>
  )

  if (href) {
    return (
      <Link
        href={href}
        aria-label={`Buka profil ${guardName}`}
        data-testid="kiosk-status-strip"
        className={rootClassName}
      >
        {content}
      </Link>
    )
  }

  return (
    <div data-testid="kiosk-status-strip" className={rootClassName}>
      {content}
    </div>
  )
}
