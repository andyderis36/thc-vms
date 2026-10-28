'use client'

import { useUserAvatar } from './useUserAvatar'

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

/**
 * Avatar shared untuk navbar, strip kiosk, dan kartu vendor.
 *
 * `avatar_url` dari API adalah path terautentikasi, bukan URL storage — foto
 * diambil sebagai blob lewat `useUserAvatar`, lalu dirender sebagai object URL.
 * Selama memuat / saat gagal, yang tampil adalah inisial (tanpa galat UI).
 */
export function UserAvatar({
  name,
  avatarUrl = null,
  size = 'md',
  tone = 'brand',
  className,
}: UserAvatarProps) {
  const { objectUrl } = useUserAvatar(avatarUrl)

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
      data-avatar-state={objectUrl !== null ? 'image' : 'initials'}
      className={wrapperClass}
    >
      {objectUrl !== null ? (
        // eslint-disable-next-line @next/next/no-img-element -- src berupa object URL `blob:`, di luar jangkauan optimizer next/image (dan tidak butuh host di images.remotePatterns).
        <img
          src={objectUrl}
          alt=""
          aria-hidden="true"
          loading="eager"
          decoding="async"
          className="size-full object-cover"
        />
      ) : (
        initialsOf(name)
      )}
    </span>
  )
}
