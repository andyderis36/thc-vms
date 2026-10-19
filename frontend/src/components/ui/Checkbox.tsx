'use client'

import { useId, type ChangeEvent } from 'react'

export interface CheckboxProps {
  id?: string
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  name?: string
  value?: string
  required?: boolean
  error?: string
  disabled?: boolean
}

/**
 * Checkbox persetujuan SOP keselamatan pada formulir pengajuan.
 * Memakai `<input type="checkbox">` sungguhan agar keyboard dan screen reader
 * bekerja; baris entirety setinggi 44px agar ramah jempol di lapangan.
 */
export function Checkbox({
  id,
  label,
  checked,
  onChange,
  name,
  value,
  required = false,
  error,
  disabled = false,
}: CheckboxProps) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const errorId = `${inputId}-error`

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    onChange(event.target.checked)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-h-touch items-start gap-3">
        <input
          id={inputId}
          name={name}
          value={value}
          type="checkbox"
          checked={checked}
          required={required}
          disabled={disabled}
          onChange={handleChange}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer accent-brand focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 disabled:cursor-not-allowed"
        />
        <label htmlFor={inputId} className="cursor-pointer text-sm leading-snug text-ink">
          {label}
        </label>
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-danger-text">
          {error}
        </p>
      ) : null}
    </div>
  )
}
