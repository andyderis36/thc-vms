'use client'

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { ChevronDown } from 'lucide-react'

import { Badge } from '@/components/ui/Badge'

export interface BranchMultiSelectOption {
  id: string
  name: string
}

export interface BranchMultiSelectProps {
  /** Label terlihat + dasar nama aksesibel kontrol. */
  label: string
  /** Tampilkan penanda wajib ` *` pada label. */
  required?: boolean
  /** Opsi cabang (sumber daftar, sudah difilter sesuai cakupan pemanggil). */
  options: BranchMultiSelectOption[]
  /** Nilai terpilih — URUT PILIHAN; elemen pertama = cabang utama. */
  value: string[]
  onChange: (next: string[]) => void
  /** Teks tombol saat belum ada pilihan. */
  placeholder?: string
  /**
   * Bila true dan opsi tepat satu saat nilai kosong: pilih otomatis saat
   * opsi tiba (bukan setelah pengguna melepas). Mempertahankan UX terkunci
   * lama untuk admin cabang tunggal; multi-opsi tetap eksplisit-required.
   */
  autoSelectSingle?: boolean
  /** Galat validasi submit kosong — dirender `role="alert"` di bawah kontrol. */
  error?: string
  /** Bantuan singkat; tersembunyi saat `error` tampil (pola `Select`). */
  hint?: string
}

/** Maksimum pill nama cabang di tombol trigger; sisanya menjadi `+N lainnya`. */
const MAX_VISIBLE_PILLS = 2

/** Estimasi geometri panel untuk flip: baris 44px + chrome border/padding. */
const ROW_HEIGHT = 44
const PANEL_CHROME = 10
const MAX_PANEL_HEIGHT = 256 + PANEL_CHROME

/**
 * Perambas overflow vertikal TERDEKAT (mis. scrollbox body modal) — batas
 * nyata yang memotong panel absolut, bukan hanya viewport. Tanpa ancestor
 * scroll (mis. di jsdom/halaman tanpa scroll container) → null.
 */
function nearestScrollBox(element: HTMLElement): DOMRect | null {
  let node: HTMLElement | null = element
  while (node !== null) {
    const overflowY = window.getComputedStyle(node).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') {
      return node.getBoundingClientRect()
    }
    node = node.parentElement
  }
  return null
}

/**
 * Multi-select cabang/POP berbentuk dropdown (bukan daftar checkbox inline):
 * tertutup saat idle sehingga hemat vertikal berapa pun jumlah lokasi;
 * opsi berada di panel popover dengan baris `min-h-touch` penuh.
 *
 * Kontrak interaksi:
 * - trigger: pill `Badge` (maks 2 + `+N lainnya`) atau placeholder;
 * - baris = `<label>` pembungkus checkbox native → KLIK SATU BARIS penuh
 *   men-toggle; wash hover/focus dipasang PERSIS pada label (kotak identik
 *   di setiap state — tanpa blok abu yang meleset dari baris);
 * - Escape (di panel/trigger) menutup & mengembalikan fokus ke trigger;
 *   klik di luar menutup; panah berpindah baris; Space men-toggle;
 * - submit kosong ditolak pemilik form lewat `error` (role=alert).
 */
export function BranchMultiSelect({
  label,
  required = false,
  options,
  value,
  onChange,
  placeholder = 'Pilih cabang / POP',
  error,
  hint,
  autoSelectSingle = false,
}: BranchMultiSelectProps) {
  const generatedId = useId()
  const labelId = `${generatedId}-label`
  const triggerId = `${generatedId}-trigger`
  const summaryId = `${generatedId}-summary`
  const panelId = `${generatedId}-panel`
  const errorId = `${generatedId}-error`
  const hintId = `${generatedId}-hint`

  const [open, setOpen] = useState(false)
  // Flip seperti ActionMenu: panel dibuka ke BAWAH bila muat di viewport,
  // selain itu ke ATAS — mencegah panel terpotong scrollbox modal.
  const [placement, setPlacement] = useState<'below' | 'above'>('below')
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // Identitas tunggal opsi: hanya terdefinisi bila daftar tepat 1 entri.
  // Dipakai sebagai pemicu kedatangan data (bukan identitas larik yang
  // berubah tiap render turunan).
  const singleOptionId = options.length === 1 ? options[0]?.id : undefined
  // Pelepasan manual lewat toggle baris — selama menyala, auto-select TIDAK
  // menembak ulang supaya centang yang dilepas user bertahan sampai submit
  // (→ error `required`), bukan langsung terisi kembali. Reset ulang tiap
  // identitas tunggal berganti (= kedatangan data baru).
  const userDeselectedRef = useRef(false)

  useEffect(() => {
    userDeselectedRef.current = false
  }, [singleOptionId])

  // Pilih-otomatis opsi satu-satunya saat ia TIBA dan nilai masih kosong.
  // Sengaja bergantung identitas `value` (bukan panjangnya): reset form
  // pemilik (`onClose` → `setValue([])`) yang menimpa tembakan dalam commit
  // yang sama tetap memicu putaran ulang efek dan tembakan susulan — tanpa
  // ini nilai macet kosong. Pelepasan user lewat `toggleOption` menaikkan
  // penjaga di atas sehingga tidak pernah dilawan balik.
  useEffect(() => {
    if (!autoSelectSingle) return
    if (singleOptionId === undefined) return
    if (value.length > 0) return
    if (userDeselectedRef.current) return
    onChange([singleOptionId])
  }, [autoSelectSingle, singleOptionId, value, onChange])

  const describedBy = error ? errorId : hint ? hintId : undefined

  // Klik di luar trigger & panel menutup popover (pola ActionMenu).
  useEffect(() => {
    if (!open) return
    function handlePointerDown(event: PointerEvent) {
      const target = event.target
      if (!(target instanceof Node)) return
      if (rootRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [open])

  // Membuka dropdown (lewat klik maupun keyboard): tentukan sisi panel lalu
  // fokuskan baris pertama.
  useEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    if (trigger !== null) {
      const rect = trigger.getBoundingClientRect()
      const box = nearestScrollBox(trigger)
      const panelHeight = Math.min(
        options.length * ROW_HEIGHT + PANEL_CHROME,
        MAX_PANEL_HEIGHT,
      )
      const spaceBelow =
        (box !== null ? Math.min(box.bottom, window.innerHeight) : window.innerHeight) -
        rect.bottom
      const spaceAbove = rect.top - (box !== null ? Math.max(box.top, 0) : 0)
      setPlacement(
        spaceBelow < panelHeight && spaceAbove > spaceBelow ? 'above' : 'below',
      )
    }
    const first = panelRef.current?.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )
    first?.focus()
  }, [open, options.length])

  function closeAndRefocusTrigger(): void {
    setOpen(false)
    triggerRef.current?.focus()
  }

  function panelInputs(): HTMLInputElement[] {
    const panel = panelRef.current
    if (panel === null) return []
    return Array.from(panel.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
  }

  function toggleOption(id: string, checked: boolean): void {
    if (!checked) userDeselectedRef.current = true
    onChange(checked ? [...value, id] : value.filter((item) => item !== id))
  }

  function handleTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'Escape') {
      // Hanya serap saat TERBUKA; saat tertutup biarkan modal induk
      // (listener document-level-nya) menutup seperti biasa.
      if (open) {
        event.stopPropagation()
        event.preventDefault()
        setOpen(false)
      }
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        setOpen(true) // efek di atas memfokuskan baris (pertama/…)
        return
      }
      const inputs = panelInputs()
      if (inputs.length === 0) return
      const target =
        event.key === 'ArrowDown' ? inputs[0] : inputs[inputs.length - 1]
      target?.focus()
    }
  }

  function handlePanelKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.stopPropagation()
      event.preventDefault()
      closeAndRefocusTrigger()
      return
    }
    const inputs = panelInputs()
    if (inputs.length === 0) return
    const active = document.activeElement
    const currentIndex = inputs.findIndex((input) => input === active)

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % inputs.length
      inputs[nextIndex]?.focus()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      const prevIndex =
        currentIndex <= 0 ? inputs.length - 1 : currentIndex - 1
      inputs[prevIndex]?.focus()
    } else if (event.key === 'Home') {
      event.preventDefault()
      inputs[0]?.focus()
    } else if (event.key === 'End') {
      event.preventDefault()
      inputs[inputs.length - 1]?.focus()
    } else if (event.key === ' ') {
      // Space pada checkbox: batalkan aktivasi native lalu toggle TERPROGRAM
      // sekali — perilaku identik di browser nyata dan jsdom.
      if (active instanceof HTMLInputElement && active.type === 'checkbox') {
        event.preventDefault()
        active.click()
      }
    }
  }

  const selectedNames = value.map(
    (id) => options.find((option) => option.id === id)?.name ?? id,
  )
  const visibleNames = selectedNames.slice(0, MAX_VISIBLE_PILLS)
  const overflowCount = selectedNames.length - visibleNames.length

  return (
    <div className="flex flex-col gap-2">
      <span id={labelId} className="text-label font-semibold text-ink">
        {label}
        {required ? <span className="text-brand"> *</span> : null}
      </span>

      <div ref={rootRef} className="relative">
        <button
          ref={triggerRef}
          id={triggerId}
          type="button"
          aria-labelledby={`${labelId} ${summaryId}`}
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          aria-describedby={describedBy}
          onClick={() => setOpen((current) => !current)}
          onKeyDown={handleTriggerKeyDown}
          className={`flex min-h-touch w-full flex-wrap items-center gap-1.5 rounded-control border bg-surface px-3 py-1.5 text-left text-sm text-ink transition-colors focus:border-brand focus:ring-4 focus:ring-brand/12 focus:outline-none ${
            error ? 'border-brand' : 'border-border-mid'
          }`}
        >
          <span id={summaryId} className="flex flex-wrap items-center gap-1.5">
            {value.length === 0 ? (
              <span className="text-ink-muted">{placeholder}</span>
            ) : (
              <>
                {visibleNames.map((name) => (
                  <Badge key={name} tone="info">
                    {name}
                  </Badge>
                ))}
                {overflowCount > 0 ? (
                  <span className="text-xs text-ink-secondary">
                    +{overflowCount} lainnya
                  </span>
                ) : null}
              </>
            )}
          </span>
          <ChevronDown
            aria-hidden="true"
            className="ml-auto size-4 shrink-0 text-ink-muted"
          />
        </button>

        {open ? (
          <div
            ref={panelRef}
            id={panelId}
            role="group"
            aria-labelledby={labelId}
            onKeyDown={handlePanelKeyDown}
            className={`absolute inset-x-0 z-30 max-h-64 overflow-y-auto rounded-card border border-border-mid bg-surface p-1 shadow-dropdown ${
              placement === 'above' ? 'bottom-full mb-1' : 'top-full mt-1'
            }`}
          >
            {options.length === 0 ? (
              <p className="px-2.5 py-3 text-sm text-ink-muted">
                Tidak ada cabang / POP tersedia.
              </p>
            ) : (
              options.map((option) => (
                <label
                  key={option.id}
                  className="flex min-h-touch w-full cursor-pointer items-center gap-3 rounded-control px-2.5 transition-colors hover:bg-neutral-bg focus-within:bg-neutral-bg"
                >
                  <input
                    type="checkbox"
                    checked={value.includes(option.id)}
                    onChange={(event) => toggleOption(option.id, event.target.checked)}
                    className="h-5 w-5 shrink-0 cursor-pointer accent-brand focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                  />
                  <span className="text-sm text-ink">{option.name}</span>
                </label>
              ))
            )}
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
