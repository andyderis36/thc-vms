import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Spinner } from './Spinner'

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'danger'
  | 'ghost'
  | 'success'
  | 'gradient'
  | 'glass'
  | 'outline'
  | 'icon'
  | 'soft'
export type ButtonSize = 'sm' | 'md' | 'lg' | 'gate'

/**
 * Status TEKAN (`:active`) — umpan balik tekan untuk perangkat sentuh.
 *
 * Aturan main untuk SELURUH primitif interaktif di folder ini:
 *  1. Tekan harus TERLIHAT BERBEDA dari hover, bukan mengulanginya:
 *     hover = wash terang → tekan = satu langkah lebih pekat di keluarga
 *     warna yang sama (`bg-neutral-bg` → `bg-ink/10`, `bg-brand-soft` →
 *     `bg-brand/20`). Varian isi solid memakai `active:opacity-*` karena
 *     palet tidak punya langkah pekat ketiga untuk brand.
 *  2. HANYA background/warna/opacity yang boleh berubah — border-width,
 *     padding, dan ukuran tidak, karena itu = layout shift saat ditekan.
 *  3. Di Tailwind v4 urutan varian CSS yang dicetak: `hover` → `focus` →
 *     `focus-visible` → `active` → `enabled` → `disabled`. Maka `active:`
 *     mengalahkan `hover:` saat ditekan, dan `disabled:opacity-60` tetap
 *     mengalahkan `active:opacity-*`.
 *  4. Di layar sentuh `hover:` dibungkus `@media (hover: hover)` sehingga
 *     tidak pernah aktif di ponsel; bersama `-webkit-tap-highlight-color:
 *     transparent` (globals.css) itu membuat tekan tanpa umpan balik sama
 *     sekali. Karena itu `active:` wajib ada.
 */
const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-brand-contrast hover:bg-brand-dark active:bg-brand-dark active:opacity-90',
  secondary:
    'border border-brand text-brand hover:bg-brand-soft active:bg-brand-soft active:opacity-90',
  danger: 'bg-checkout text-brand-contrast hover:opacity-90 active:opacity-70',
  ghost: 'text-ink-secondary hover:bg-neutral-bg active:bg-ink/10',
  success: 'bg-checkin text-brand-contrast hover:opacity-90 active:opacity-70',
  /* --- Varian Jokoui (palet THC biru) --- */
  gradient:
    'bg-gradient-to-r from-brand via-brand-dark to-brand text-brand-contrast hover:from-brand-dark hover:to-brand-dark active:opacity-90',
  glass: 'bg-brand/10 backdrop-blur-sm border border-brand/20 text-brand hover:bg-brand/20 active:bg-brand/30',
  outline: 'border border-brand text-brand hover:bg-brand/10 active:bg-brand/20',
  soft: 'bg-brand/10 text-brand-dark hover:bg-brand/20 active:bg-brand/30',
  icon: 'px-2 active:bg-ink/10',
}

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-9 text-xs',
  md: 'h-10 text-label',
  lg: 'h-12',
  gate: 'h-touch-lg w-full text-base font-bold',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  fullWidth?: boolean
  loading?: boolean
}

/**
 * Tombol atomik. `type="button"` adalah default agar tidak pernah
 * tidak sengaja submit form; `loading` menjaga lebar label tetap stabil
 * (label disamarkan, spinner menimpa tanpa menggeser layout).
 *
 * Base carries `min-h-touch` (target sentuh 44px, §6.5 AGENTS.md) +
 * `uppercase`; varian legacy (primary/secondary/danger/ghost/success)
 * dipertahankan, varian jokoui (gradient/glass/outline/icon/soft) ditambahkan.
 */
export function Button({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  loading = false,
  disabled,
  type,
  className,
  children,
  ...rest
}: ButtonProps) {
  const classes = [
    'relative inline-flex items-center justify-center gap-2 rounded-control px-4 min-h-touch font-semibold uppercase tracking-wide transition duration-150 cursor-pointer disabled:cursor-not-allowed disabled:opacity-60',
    VARIANT_CLASSES[variant],
    SIZE_CLASSES[size],
    fullWidth ? 'w-full' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      {...rest}
      type={type ?? 'button'}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={classes}
    >
      {loading && (
        <span className="absolute inset-0 flex items-center justify-center">
          <Spinner size="sm" />
        </span>
      )}
      {/* Ikon + label selalu sebaris & terpusat vertikal (§4.1):
          tanpa `inline-flex` anak span ini jatuh ke alur inline biasa
          sehingga ikon block-level lucide tidak sejajar baseline teks. */}
      <span
        className={
          loading ? 'invisible inline-flex items-center gap-2' : 'inline-flex items-center gap-2'
        }
      >
        {children}
      </span>
    </button>
  )
}

export type ButtonContent = ReactNode
