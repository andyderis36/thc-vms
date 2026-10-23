'use client'

import { useId } from 'react'
import type { SelectOption } from '@/components/ui/Select'

export interface ManagedRoleFilterSelectProps {
  /** Opsi filter peran — satu sumber kebenaran untuk dua penempatan kontrol. */
  options: SelectOption[]
  /** Peran terpilih. */
  value: string
  onChange: (value: string) => void
  /** Label terlihat; di header tabel label diambil dari `aria-label`. */
  label?: string
  className?: string
}

/**
 * Kontrol filter peran — SATU komponen untuk dua penempatan: header kolom
 * "Peran" (tabel desktop) dan filter bar (ponsel/tablet). `<select>` native
 * supaya aksesibilitas keyboard dan picker platform phospholip gratis;
 * `aria-label` selalu ada karena nama aksesibel tak boleh bergantung pada
 * label terlihat yang hanya ada di filter bar.
 */
const ROLE_FILTER_SELECT_CLASS =
  'w-full rounded-control border border-border-mid bg-surface px-2 py-1.5 text-xs font-normal text-ink transition-colors focus:border-brand focus:ring-4 focus:ring-brand/12 focus:outline-none'

export function ManagedRoleFilterSelect({
  options,
  value,
  onChange,
  label,
  className = '',
}: ManagedRoleFilterSelectProps) {
  const generatedId = useId()

  return (
    <div className={label !== undefined ? 'flex flex-col gap-2' : undefined}>
      {label !== undefined ? (
        <label htmlFor={generatedId} className="text-label font-semibold text-ink">
          {label}
        </label>
      ) : null}
      <select
        id={generatedId}
        aria-label="Filter peran"
        className={`${ROLE_FILTER_SELECT_CLASS} ${className}`.trim()}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  )
}
