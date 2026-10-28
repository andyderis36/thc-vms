'use client'

import { useEffect, useState } from 'react'

export type UserAvatarSize = 'sm' | 'md' | 'lg'

export interface UserAvatarProps {
  name: string
  avatarUrl?: string | null
  /** sm = 32px navbar, md = 40px mobile strip, lg = 48px vendor card. Default 'md'. */
  size?: UserAvatarSize
  /** 'brand' for light surfaces, 'onBrand' for the blue kiosk header. Default 'brand'. */
  tone?: 'brand' | 'onBrand'
  className?: string
}

const SIZE_CLASSES: Record<UserAvatarSize, string> = {
  sm: 'size-8 text-badge',
  md: 'size-10 text-sm',
  lg: 'size-12 text-lg',
}

const TONE_CLASSES: Record<'brand' | 'onBrand', string> = {
  brand: 'bg-brand text-brand-contrast',
  onBrand: 'bg-brand-soft text-brand',
}

/** Inisial maksimal 2 huruf — aman terhadap nama kosong. (Pola `initialsOf` ProfileMenu.) */
function initialsOf(name: string): string {
  const initials = name
    .split(/\s+/)
    .filter((part) => part !== '')
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('')
  return initials === '' ? '?' : initials
}

/** Avatar shared untuk navbar, strip kiosk, dan kartu vendor. Inisial bila foto kosong/gagal. */
export function UserAvatar({
  name,
  avatarUrl = null,
  size = 'md',
  tone = 'brand',
  className,
}: UserAvatarProps) {
  // Avatar presigned bisa kedaluwarsa: saat `<img>` gagal, jatuh ke inisial.
  // Reset saat `avatarUrl` berubah agar URL baru selalu dicoba ulang.
  const [imgError, setImgError] = useState(false)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset sengaja saat avatarUrl berubah; nilai sudah false pada mount, jadi React membatalkan re-render berlebihan.
    setImgError(false)
  }, [avatarUrl])

  const showImage = avatarUrl != null && avatarUrl !== '' && !imgError
  const wrapperClass = [
    'flex shrink-0 items-center justify-center overflow-hidden rounded-badge font-bold',
    SIZE_CLASSES[size],
    TONE_CLASSES[tone],
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <span
      aria-hidden="true"
      data-avatar-state={showImage ? 'image' : 'initials'}
      className={wrapperClass}
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- avatar dari host dinamis (avatarUrl presigned MinIO), di luar images.remotePatterns yang hanya memuat localhost:9000; next/image akan 400 untuk host lain.
        <img
          src={avatarUrl}
          alt=""
          aria-hidden="true"
          loading="eager"
          decoding="async"
          className="size-full object-cover"
          onError={() => setImgError(true)}
        />
      ) : (
        initialsOf(name)
      )}
    </span>
  )
}
