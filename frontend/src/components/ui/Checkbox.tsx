'use client'

import { useId, type ChangeEvent } from 'react'

export interface CheckboxProps {
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
  const errorId = `${generatedId}-error`

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    onChange(event.target.checked)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-h-touch items-start gap-3">
        <input
          id={generatedId}
          name={name}
          value={value}
          type="checkbox"
          checked={checked}
          required={required}
          disabled={disabled}
          onChange={handleChange}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer accent-brand disabled:cursor-not-allowed"
        />
        <label htmlFor={generatedId} className="cursor-pointer text-sm leading-snug text-ink">
          {label}
        </label>
      </div>
      {error ? (
        <p id={errorId} className="text-xs text-danger-text">
          {error}
        </p>
      ) : null}
    </div>
  )
}
