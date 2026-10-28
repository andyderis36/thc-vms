'use client'

import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'

export interface ProfileBackLinkProps {
  href: string
  label: string
  className?: string
}

/**
 * Tautan kembali ringkas di atas form "Profil Saya" — dipakai hanya untuk
 * shell tanpa navigasi tetap (security & vendor) agar petugas/vendor punya
 * jalan kembali eksplisit ke alur utamanya.
 *
 * - `min-h-touch` + `rounded-control`: token radius semantik proyek
 *   (dilarang `rounded-lg/md/xl` mentah) dan target sentuh 44px.
 * - Tanpa padding horizontal: panah kiri rata dengan judul "Profil Saya".
 * - Hanya svg + teks di dalam link — tanpa keturunan interaktif bersarang.
 * - `className` pemanggil selalu dibelakang agar bisa menimpa gaya default.
 */
export function ProfileBackLink({ href, label, className }: ProfileBackLinkProps) {
  const rootClassName =
    'inline-flex min-h-touch w-fit items-center gap-1.5 rounded-control text-label font-semibold text-brand transition-colors hover:bg-brand-soft hover:text-brand-dark focus-visible:outline-brand'
      .concat(className === undefined ? '' : ` ${className}`)
      .trim()

  return (
    <Link href={href} className={rootClassName}>
      <ArrowLeft aria-hidden="true" className="size-4 shrink-0" />
      {label}
    </Link>
  )
}
