import { RotateCcw } from 'lucide-react'
import { Button } from './Button'

export interface FilterResetButtonProps {
  /** Mengembalikan SEMUA state filter pada bar ke nilai defaultnya. */
  onReset: () => void
  /** Nonaktif saat tidak ada filter yang aktif (tombol abu, tak bisa diklik). */
  disabled?: boolean
  /** Penambahan kelas tailwind tambahan (mis. margin) tanpa menghapus gaya bawaan. */
  className?: string
}

/**
 * FilterResetButton — SATU-satunya kontrol reset yang dibagikan ke SEMUA
 * bar filter (users, dashboard, approvals, facilities, audit, dst.). Satu
 * komponen = satu titik perubahan: label, ikon, dan tinggi tak akan pernah
 * menyimpang antar layar.
 *
 * Konstanta visual (kontrak untuk pemakai lain):
 * - `variant="secondary"` + `size="sm"` — menempel rapi di samping
 *   `Select`/`Input` pada wrapper `flex flex-wrap items-end` (dasar sejajar).
 * - Base `Button` sudah membawa `rounded-control`, `min-h-touch` (target
 *   sentuh 44px §6.5) dan `uppercase`, jadi TIDAK perlu kelas tambahan.
 * - Ikon `RotateCcw` dari lucide (satu-satunya ikon reset yang dipakai
 *   proyek ini; jangan ganti dengan Filter/FilterX/Eraser).
 *
 * `type="button"` dijamin terkirim sehingga tombol ini TIDAK PERNAH
 * meng-submit form induknya (filter bar bisa berada di dalam <form>).
 */
export function FilterResetButton({ onReset, disabled, className }: FilterResetButtonProps) {
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      disabled={disabled}
      onClick={onReset}
      className={className}
    >
      <RotateCcw aria-hidden="true" className="size-4 shrink-0" />
      Reset Filter
    </Button>
  )
}
