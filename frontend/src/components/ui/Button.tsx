import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Spinner } from './Spinner'

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success'
export type ButtonSize = 'sm' | 'md' | 'lg' | 'gate'

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-brand-contrast hover:bg-brand-dark',
  secondary: 'border border-brand text-brand hover:bg-brand-soft',
  danger: 'bg-checkout text-brand-contrast hover:opacity-90',
  ghost: 'text-ink-secondary hover:bg-neutral-bg',
  success: 'bg-checkin text-brand-contrast hover:opacity-90',
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
    'relative inline-flex items-center justify-center gap-2 rounded-control px-4 font-semibold uppercase tracking-wide transition duration-150 cursor-pointer disabled:cursor-not-allowed disabled:opacity-60',
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
      <span className={loading ? 'invisible' : undefined}>{children}</span>
    </button>
  )
}

export type ButtonContent = ReactNode
