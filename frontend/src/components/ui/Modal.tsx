'use client'

import { useEffect, useId, useRef, type ReactNode } from 'react'

export type ModalSize = 'sm' | 'md' | 'lg'

const SIZE_CLASSES: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
}

export interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  size?: ModalSize
}

/**
 * Dialog modal. Sengaja TIDAK memakai elemen `<dialog>` native karena
 * perilaku focus-trimming-nya berbenturan dengan implementasi sederhana ini.
 *
 * `document` hanya diakses di dalam effect — tidak pernah saat render — agar
 * aman ketika komponen ini dirender di server.
 */
export function Modal({ open, onClose, title, children, footer, size = 'md' }: ModalProps) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreFocusTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return

    const active = document.activeElement
    restoreFocusTo.current = active instanceof HTMLElement ? active : null

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      restoreFocusTo.current?.focus()
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/40 p-4"
      onClick={(event) => {
        // Hanya tutup bila klik mendarat pada overlay, bukan isi panel.
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`w-full ${SIZE_CLASSES[size]} rounded-modal bg-surface p-6 shadow-modal`}
      >
        <header className="mb-4 flex items-start justify-between gap-4">
          <h2 id={titleId} className="text-lg font-semibold text-ink">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup"
            className="-m-1 rounded-control p-1 text-xl leading-none text-ink-secondary hover:bg-neutral-bg"
          >
            &times;
          </button>
        </header>

        <div className="text-sm text-ink">{children}</div>

        {footer ? (
          <footer className="mt-6 flex items-center justify-end gap-2">{footer}</footer>
        ) : null}
      </div>
    </div>
  )
}
