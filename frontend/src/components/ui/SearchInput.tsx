'use client'

import { Search } from 'lucide-react'
import { Input, type InputProps } from '@/components/ui/Input'

/**
 * Input pencarian dengan ikon `Search` dekoratif di kiri — satu sumber untuk
 * pola search ber-ikon (dashboard, dsb) agar penempatan ikon tidak diduplikasi.
 *
 * Pusatkan ikon terhadap TINGGI FIELD (`inset-y-0` + `my-auto`), bukan offset
 * rem hardcode, sehingga sejajar vertikal dengan teks placeholder untuk semua
 * `fieldSize` (`h-10` default maupun `h-12` gate). Secara horizontal: ikon
 * `left-3` (12px) + 16px = 28px, `pl-9` (36px) memberi ruang agar teks tidak
 * tertimpa ikon.
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
        className="pointer-events-none absolute inset-y-0 left-3 my-auto size-4 text-ink-muted"
      />
      <Input className={`pl-9 ${className}`.trim()} {...rest} />
    </div>
  )
}
