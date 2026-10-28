'use client'

import { useEffect, useId, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

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
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/35 backdrop-blur-sm p-4"
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
        className={`my-auto flex max-h-[calc(100dvh-2rem)] w-full ${SIZE_CLASSES[size]} flex-col rounded-modal bg-surface border border-border-light/60 p-6 shadow-modal`}
      >
        <header className="mb-4 flex shrink-0 items-start justify-between gap-4">
          <h2 id={titleId} className="text-lg font-semibold text-ink">
            {title}
          </h2>
          {/*
            Target sentuh 44×44px (§5.2.1) tetap di tombol (`size-11` + `p-1`).
            Sorotan hover dipasang pada span dalam `size-7` (28×28, seukuran
            tombol lama) yang dipatok ke sudut kanan-atas lewat `items-start
            justify-end`, sehingga ikon X tetap di posisi visual semula dan
            sorotan hover rapat/konsentris di sekelilingnya - bukan kotak 44px
            yang membuat sudutnya tampak tidak presisi.
            `group-active:` memberi status tekan pada span yang sama: satu
            langkah lebih pekat dari `group-hover:bg-neutral-bg` (kontrak tekan
            ada di `Button.tsx`). Tanpa ini, di layar sentuh tombol tutup tidak
            bereaksi sama sekali.
          */}
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup"
            className="group -m-1 flex size-11 items-start justify-end rounded-control p-1 text-ink-secondary"
          >
            <span className="flex size-7 items-center justify-center rounded-control transition-colors group-hover:bg-neutral-bg group-active:bg-ink/10">
              <X aria-hidden="true" className="size-5 shrink-0" />
            </span>
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto text-sm text-ink">{children}</div>

        {footer ? (
          <footer className="mt-6 flex shrink-0 items-center justify-end gap-2">{footer}</footer>
        ) : null}
      </div>
    </div>
  )
}
