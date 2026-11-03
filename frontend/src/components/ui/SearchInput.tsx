'use client'

import { Search } from 'lucide-react'
import { Input, type InputProps, FIELD_BASE_CLASS } from '@/components/ui/Input'

/**
 * Input pencarian dengan ikon `Search` dekoratif di kiri — satu sumber untuk
 * pola search ber-ikon (dashboard, dsb) agar penempatan ikon tidak diduplikasi.
 *
 * Pemosisian ikon mengikuti pola `trailing` di `Input.tsx`: `top-1/2`
 * + `-translate-y-1/2` (bukan `inset-y-0` + `my-auto`) supaya satu pola
 * pemusatan untuk semua ikon dalam-field di codebase ini. `z-10` WAJIB ada:
 * terukur E2E bahwa latar `bg-surface` milik `<input>` melukis DI ATAS ikon
 * tanpa itu (adu stacking konteks yang kalah oleh input) — tanpa `z-10`,
 * ikon 20px yang valid secara geometri tidak tampil sama sekali di screenshot.
 * Secara horizontal: ikon `left-3` (12px) + 20px = 32px, `pl-9` (36px)
 * memberi ruang agar teks tidak tertimpa ikon. Ikon `size-5` +
 * `text-ink-secondary` supaya selalu kasatmata di atas putih.
 *
 * `label` sengaja di-`omit`: pencarian cukup memakai `aria-label` (dan/atau
 * `placeholder`) sehingga wrapper field setinggi input dan ikon selalu
 * memusat tepat pada baris teks.
 */
export type SearchInputProps = Omit<InputProps, 'label'>

export function SearchInput({ className = '', ...rest }: SearchInputProps) {
  return (
    <div className="relative">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 z-10 size-5 -translate-y-1/2 text-ink-secondary"
      />
      <Input
        className={[FIELD_BASE_CLASS, 'pl-9 min-h-touch', className].filter(Boolean).join(' ')}
        {...rest}
      />
    </div>
  )
}
