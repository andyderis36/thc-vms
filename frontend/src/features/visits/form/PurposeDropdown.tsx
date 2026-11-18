'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { FIELD_BASE_CLASS, FIELD_HEIGHT } from '@/components/ui/Input'
import { Spinner } from '@/components/ui/Spinner'

/**
 * Opsi "Keperluan Kunjungan" — keputusan produk: empat label hardcoded.
 * Katalog `GET /purposes` tetap dipakai `VisitForm` untuk pemetaan
 * label -> purpose_id saat submit, tetapi dropdown TIDAK merender katalog.
 */
export const PURPOSE_OPTIONS = [
  'Survey',
  'Operation & Maintenance',
  'Project',
  'Other',
] as const

export type PurposeOption = (typeof PURPOSE_OPTIONS)[number]

export interface PurposeDropdownProps {
  id?: string
  label: string
  /** Nama keperluan yang dipilih (label hardcoded, dicocokkan ke katalog saat submit). */
  selectedIds: readonly string[]
  onToggle: (purposeName: string) => void
  placeholder: string
  isLoading?: boolean
  isError?: boolean
  error?: string
  required?: boolean
}

/**
 * Multi-select "Keperluan Kunjungan" yang divisualkan sebagai dropdown — sama
 * seperti "Fasilitas Tujuan" (`components/ui/Select.tsx`) pada label, tinggi
 * field, dan bahasa galatnya. Katalog keperluan tidak muat sebagai `<select>`
 * native maupun chip, jadi panel memakai checkbox asli: satu baris
  * `Checkbox` 44px per keperluan, persis seperti blok chip yang digantikan.
 *
 * SEMANTIK ARIA: tombol pemicu memakai `aria-haspopup="listbox"` +
 * `aria-expanded` + `aria-controls`, panel memakai `role="listbox"` +
 * `aria-multiselectable`, dan tiap baris `role="option"` dengan
 * `aria-selected` yang mencerminkan centang. Checkbox asli di dalam baris
 *_option_ tetap menjadi target fokus sungguhan (Tab → Spasi), sehingga tidak
  * diperlukan roving `aria-activedescendant` yang mudah rusak saat daftar
  * keperluan berubah.
 *
 * Dokumen hanya diakses di dalam effect — tidak pernah saat render — mengikuti
 * pola `components/ui/Modal.tsx`.
 */
export function PurposeDropdown({
  id,
  label,
  selectedIds,
  onToggle,
  placeholder,
  isLoading = false,
  isError = false,
  error,
  required = false,
}: PurposeDropdownProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const generatedId = useId()
  const buttonId = id ?? `${generatedId}-button`
  const panelId = `${generatedId}-panel`
  const errorId = `${generatedId}-error`

  const disabled = isLoading || isError
  const selectedCount = selectedIds.length
  const summary = isLoading
    ? 'Memuat keperluan kunjungan…'
    : selectedCount === 0
      ? placeholder
      : `${selectedCount} keperluan dipilih`

  // Tutup saat klik/tap di luar field, atau saat Escape ditekan; Escape
  // mengembalikan fokus ke tombol pemicu (pola `Modal.tsx`).
  useEffect(() => {
    if (!open) return

    function handlePointerDown(event: PointerEvent) {
      const target = event.target
      if (target instanceof Node && !containerRef.current?.contains(target)) {
        setOpen(false)
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={buttonId} className="text-label font-semibold text-ink">
        {label}
        {required ? <span className="text-brand"> *</span> : null}
      </label>

      <div ref={containerRef} className="relative">
        <button
          ref={buttonRef}
          id={buttonId}
          type="button"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          aria-describedby={error ? errorId : undefined}
          onClick={() => setOpen((previous) => !previous)}
          onKeyDown={(event) => {
            // Enter/Space sudah memicu onClick; panah membuka panel tanpa
            // harus menekan Tab untuk masuk ke checkbox pertama.
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              setOpen(true)
            }
          }}
          className={`${FIELD_BASE_CLASS} ${FIELD_HEIGHT.gate} flex min-h-touch items-center justify-between gap-2 text-left ${error ? 'border-brand' : ''}`.trim()}
        >
          <span className="flex min-w-0 items-center gap-2">
            {isLoading ? <Spinner size="sm" className="text-ink-muted" /> : null}
            <span className={selectedCount === 0 ? 'truncate text-ink-muted' : 'truncate'}>
              {summary}
            </span>
          </span>
          <ChevronDown
            aria-hidden="true"
            className={`pointer-events-none size-4 shrink-0 text-ink-muted transition-transform ${open ? 'rotate-180' : ''}`.trim()}
          />
        </button>

        {open ? (
          <div
            id={panelId}
            role="listbox"
            aria-multiselectable="true"
            aria-labelledby={buttonId}
            className="absolute inset-x-0 top-full z-40 mt-1 flex max-h-64 flex-col gap-0.5 overflow-y-auto overscroll-contain rounded-card border border-border-mid bg-surface p-1.5 shadow-dropdown"
          >
            {PURPOSE_OPTIONS.map((option, index) => {
              const optionInputId = `${panelId}-option-${index}`
              const checked = selectedIds.includes(option)
              return (
                <div
                  key={option}
                  role="option"
                  aria-selected={checked}
                  className="flex min-h-touch cursor-pointer items-center gap-3 rounded-control px-2.5 py-1.5 hover:bg-neutral-bg"
                >
                  <input
                    id={optionInputId}
                    name="purpose_ids"
                    value={option}
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggle(option)}
                    className="h-5 w-5 shrink-0 cursor-pointer accent-brand focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                  />
                  <label
                    htmlFor={optionInputId}
                    className="flex-1 cursor-pointer text-sm leading-snug text-ink"
                  >
                    {option}
                  </label>
                </div>
              )
            })}
          </div>
        ) : null}
      </div>

      {isError ? (
        <p role="alert" className="text-xs text-danger-text">
          Gagal memuat daftar keperluan kunjungan. Silakan muat ulang halaman.
        </p>
      ) : null}
      {error !== undefined ? (
        <p id={errorId} role="alert" className="text-xs text-danger-text">
          {error}
        </p>
      ) : null}
    </div>
  )
}
