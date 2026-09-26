'use client'

import { useId, type TextareaHTMLAttributes } from 'react'
import { FIELD_BASE_CLASS, type FieldSize } from './Input'

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  error?: string
  hint?: string
  fieldSize?: FieldSize
}

export function Textarea({
  label,
  error,
  hint,
  id,
  className = '',
  required,
  ...rest
}: TextareaProps) {
  const generatedId = useId()
  const textareaId = id ?? generatedId
  const errorId = `${textareaId}-error`
  const hintId = `${textareaId}-hint`
  const describedBy = error ? errorId : hint ? hintId : undefined

  return (
    <div className="flex flex-col gap-1.5">
      {label ? (
        <label htmlFor={textareaId} className="text-label font-semibold text-ink">
          {label}
          {required ? <span className="text-brand"> *</span> : null}
        </label>
      ) : null}

      <textarea
        {...rest}
        id={textareaId}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`${FIELD_BASE_CLASS} min-h-[120px] resize-y py-2 ${error ? 'border-brand' : ''} ${className}`.trim()}
      />

      {error ? (
        <p id={errorId} className="text-xs text-danger-text">
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
