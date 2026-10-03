'use client'

import { useRef, type KeyboardEvent } from 'react'

export interface TabItem {
  id: string
  label: string
  count?: number
}

export interface TabsProps {
  tabs: TabItem[]
  value: string
  onChange: (id: string) => void
  /** `gate` menghasilkan tab setinggi 52px untuk kebutuhan petugas di tablet (SCR-05). */
  size?: 'default' | 'gate'
  className?: string
  /** Nama aksesibel tablist (WCAG 1.3.1). Pemanggil memberi label sesuai konteks. */
  ariaLabel?: string
  /**
   * ID tabpanel dinamis milik pemanggil. Bila diisi, seluruh tab memperoleh
   * `aria-controls` ke panel itu DAN id `${panelId}-tab-${tab.id}`, sehingga
   * pemanggil dapat menempatkan `role="tabpanel"` dengan `id={panelId}` dan
   * `aria-labelledby={`${panelId}-tab-${value}`}` (pola APG dynamic tab panels).
   */
  panelId?: string
}

/**
 * Tab terkontrol untuk antrean dashboard dan antrean gerbang.
 * Ikon tidak dipasang di sini — pemanggil mengimpornya dari `lucide-react`
 * bila diperlukan, agar komponen ini tetap bebas dari ketergantungan visual.
 *
 * Dua ukuran:
 *  - `default`  : tab filter dashboard setinggi 44px (`min-h-touch`, target
 *                 sentuh minimum WCAG §6.5) — padding & ukuran label dikompres
 *                 di layar < 640px agar scroll mendatar minim; label tetap
 *                 boleh menggulir bila melebihi lebar layar.
 *  - `gate`     : tab selebar-sempurna (50%+ target sentuh 52px) untuk
 *                 SCR-05. Ketiga tab PASTI muat di 375px tanpa scroll
 *                 mendatar — label boleh turun dua baris, tinggi tetap 52px.
 *
 * Aksesibilitas (pola APG Tabs penuh — WAI-ARIA Authoring Practices):
 *  - `role="tablist"` selalu bernama lewat `ariaLabel`.
 *  - Roving tabindex: hanya tab aktif yang dapat dijangkau Tab (tabIndex 0);
 *    tab lain tabIndex -1.
 *  - Panah (←/→/↑/↓), Home, dan End memindahkan fokus SEKALIGUS seleksi
 *    (activation automatic), membungkus di ujung.
 */
export function Tabs({
  tabs,
  value,
  onChange,
  size = 'default',
  className = '',
  ariaLabel = 'Navigasi tab',
  panelId,
}: TabsProps) {
  const isGate = size === 'gate'
  // Default 44px (min-h-touch) — bukan h-10/40px — agar filter dashboard
  // memenuhi target sentuh minimum 44px.
  const height = isGate ? 'min-h-touch-lg' : 'min-h-touch'
  /** Ref per tab — dipakai arrow navigation untuk memindahkan fokus. */
  const tabRefs = useRef(new Map<string, HTMLButtonElement | null>())

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (tabs.length === 0) return
    const currentIndex = tabs.findIndex((tab) => tab.id === value)
    let nextIndex: number
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = (currentIndex + 1) % tabs.length
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = (currentIndex - 1 + tabs.length) % tabs.length
        break
      case 'Home':
        nextIndex = 0
        break
      case 'End':
        nextIndex = tabs.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    const next = tabs[nextIndex]
    if (next === undefined) return
    onChange(next.id)
    tabRefs.current.get(next.id)?.focus()
  }

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      className={[
        'flex w-full gap-1 border-b border-border-light',
        isGate ? '' : 'overflow-x-auto',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {tabs.map((tab) => {
        const selected = tab.id === value
        return (
          <button
            key={tab.id}
            ref={(node) => {
              tabRefs.current.set(tab.id, node)
            }}
            id={panelId !== undefined ? `${panelId}-tab-${tab.id}` : undefined}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={[
              'flex items-center justify-center gap-2 border-b-2 text-sm font-semibold transition-colors',
              height,
              // Gate: `flex-1 min-w-0` membagi lebar rata dan mengizinkan
              // teks membungkus, sehingga tidak ada tab terpotong/scroll.
              isGate
                ? 'min-w-0 flex-1 whitespace-normal px-2 text-center leading-tight'
                : 'shrink-0 whitespace-nowrap px-2 sm:px-4 max-sm:text-xs',
              selected
                ? 'border-brand text-brand'
                : 'border-transparent text-ink-secondary hover:text-ink',
            ].join(' ')}
          >
            {tab.label}
            {tab.count !== undefined ? (
              <span
                className={`rounded-badge px-1.5 py-0.5 text-badge ${
                  selected ? 'bg-brand-soft text-brand' : 'bg-neutral-bg text-ink-secondary'
                }`}
              >
                {tab.count}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
