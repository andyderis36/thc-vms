'use client'

export interface TabItem {
  id: string
  label: string
  count?: number
}

export interface TabsProps {
  tabs: TabItem[]
  value: string
  onChange: (id: string) => void
  /** `gate` menghasilkan pil setinggi 52px untuk annumgan petugas di tablet. */
  size?: 'default' | 'gate'
  className?: string
}

/**
 * Tab terkontrol untuk antrean dashboard dan antrean gerbang.
 * Ikon tidak dipasang di sini — pemanggil mengimpornya dari `lucide-react`
 * bila diperlukan, agar komponen ini tetap bebas dari ketergantungan visual.
 */
export function Tabs({ tabs, value, onChange, size = 'default', className = '' }: TabsProps) {
  const height = size === 'gate' ? 'min-h-touch-lg' : 'h-10'

  return (
    <div
      role="tablist"
      className={`flex w-full gap-1 overflow-x-auto border-b border-border-light ${className}`.trim()}
    >
      {tabs.map((tab) => {
        const selected = tab.id === value
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(tab.id)}
            className={[
              'flex shrink-0 items-center justify-center gap-2 whitespace-nowrap border-b-2 px-4 text-sm font-semibold transition-colors',
              height,
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
