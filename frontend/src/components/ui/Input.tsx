'use client'

import { useId, type InputHTMLAttributes } from 'react'

/**
 * `default` 40px · `gate` 40px (mobile/desktop) → 48px (tablet 768–1023px).
 * Tinggi mengikuti design-system §4.2: 40px Desktop/Mobile, 48px Tablet.
 */
export type FieldSize = 'default' | 'gate'

export const FIELD_HEIGHT: Record<FieldSize, string> = {
  default: 'h-10',
  gate: 'h-10 md:h-12 lg:h-10',
}

export const FIELD_BASE_CLASS =
  'w-full rounded-control border border-border-mid bg-surface px-3 text-sm text-ink placeholder:text-ink-muted focus:border-brand focus:ring-2 focus:ring-brand-soft focus:outline-none disabled:bg-border-light'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  hint?: string
  fieldSize?: FieldSize
}

/**
 * Field teks berlabel. `useId` dipakai agar id error/hint stabil antar render
 * sehingga `aria-describedby` selalu menunjuk elemen yang benar.
 */
export function Input({
  label,
  error,
  hint,
  fieldSize = 'default',
  id,
  className = '',
  required,
  ...rest
}: InputProps) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const errorId = `${inputId}-error`
  const hintId = `${inputId}-hint`
  const describedBy = error ? errorId : hint ? hintId : undefined

  return (
    <div className="flex flex-col gap-1.5">
      {label ? (
        <label htmlFor={inputId} className="text-label font-semibold text-ink">
          {label}
          {required ? <span className="text-brand"> *</span> : null}
        </label>
      ) : null}

      <input
        {...rest}
        id={inputId}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`${FIELD_BASE_CLASS} ${FIELD_HEIGHT[fieldSize]} ${error ? 'border-brand' : ''} ${className}`.trim()}
      />

      {error ? (
        <p id={errorId} role="alert" className="text-xs text-danger-text">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-ink-secondary">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
