'use client'

import { useId, type InputHTMLAttributes, type ReactNode } from 'react'

/**
 * `default` 40px · `gate` 40px (mobile/desktop) → 48px (tablet 768–1023px).
 * Tinggi mengikuti design-system §4.2: 40px Desktop/Mobile, 48px Tablet.
 */
export type FieldSize = 'default' | 'gate'

export const FIELD_HEIGHT: Record<FieldSize, string> = {
  default: 'h-10',
  gate: 'h-10 md:h-12 lg:h-10',
}

/**
 * Permukaan field: `rounded-control` (4px, §3 "Border … Rounded 4px") +
 * `px-3 py-2` + `text-sm`, fokus biru (border brand + cincin lembut
 * `brand/12`, bukan garis outline). Radius memakai token, bukan skala
 * Tailwind, supaya seragam dengan `Button` dan pill kontrol lain.
 * `py-2` hanya berlaku pada field ber-tinggi-otomatis; `FIELD_HEIGHT` tetap
 * menang karena preflight memakai `box-sizing: border-box`.
 *
 * Sengaja TIDAK ada state tekan di sini: field teks tidak boleh berubah
 * latar saat ditekan (terbaca sebagai "field terpilih", bukan umpan balik
 * tekan) dan kelas ini dipakai bersama oleh Input, Select, Textarea, dan
 * SearchInput. Kontrol yang benar-benar ditekan (tombol, item menu, tab)
 * membawa `active:` masing-masing di primitifnya.
 */
export const FIELD_BASE_CLASS =
  'w-full rounded-control border border-border-mid bg-surface px-3 py-2 text-sm text-ink transition-colors placeholder:text-ink-muted focus:border-brand focus:ring-4 focus:ring-brand/12 focus:outline-none disabled:cursor-not-allowed disabled:bg-border-light'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  hint?: string
  fieldSize?: FieldSize
  trailing?: ReactNode
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
  trailing,
  ...rest
}: InputProps) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const errorId = `${inputId}-error`
  const hintId = `${inputId}-hint`
  const describedBy = error ? errorId : hint ? hintId : undefined

  return (
    <div className="flex flex-col gap-2">
      {label ? (
        <label htmlFor={inputId} className="text-label font-semibold text-ink">
          {label}
          {required ? <span className="text-brand"> *</span> : null}
        </label>
      ) : null}

      <div className="relative">
        <input
          {...rest}
          id={inputId}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={`${FIELD_BASE_CLASS} ${FIELD_HEIGHT[fieldSize]} ${error ? 'border-brand' : ''} ${trailing ? 'pr-12' : ''} ${className}`.trim()}
        />
        {trailing ? (
          <div className="absolute right-1 top-1/2 -translate-y-1/2">
            {trailing}
          </div>
        ) : null}
      </div>

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
