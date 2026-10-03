'use client'

import { useId, type SelectHTMLAttributes } from 'react'
import { ChevronDown } from 'lucide-react'
import { FIELD_BASE_CLASS, FIELD_HEIGHT, type FieldSize } from './Input'

export interface SelectOption {
  value: string
  label: string
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  error?: string
  hint?: string
  fieldSize?: FieldSize
  options: SelectOption[]
  placeholder?: string
}

/**
 * Memakai `<select>` native, bukan listbox kustom: dengan begitu ponsel
 * mendapat picker platform yang benar dan aksesibilitas keyboard gratis.
 */
export function Select({
  label,
  error,
  hint,
  options,
  placeholder,
  fieldSize = 'default',
  id,
  className = '',
  required,
  ...rest
}: SelectProps) {
  const generatedId = useId()
  const selectId = id ?? generatedId
  const errorId = `${selectId}-error`
  const hintId = `${selectId}-hint`
  const describedBy = error ? errorId : hint ? hintId : undefined
  const height = FIELD_HEIGHT[fieldSize]

  return (
    <div className="flex flex-col gap-1.5">
      {label ? (
        <label htmlFor={selectId} className="text-label font-semibold text-ink">
          {label}
          {required ? <span className="text-brand"> *</span> : null}
        </label>
      ) : null}

      <div className="relative">
        <select
          {...rest}
          id={selectId}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={`${FIELD_BASE_CLASS} ${height} appearance-none pr-9 ${error ? 'border-brand' : ''} ${className}`.trim()}
        >
          {placeholder ? (
            <option value="" disabled>
              {placeholder}
            </option>
          ) : null}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown
          aria-hidden="true"
          className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-ink-muted"
        />
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
