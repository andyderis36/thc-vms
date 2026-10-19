import type { ReactNode } from 'react'

export interface EmptyStateProps {
  /** Ikon dekoratif dari `lucide-react` di call site. */
  icon?: ReactNode
  title: string
  description?: string
  /** Aksi opsional (mis. tombol `Button`) di bawah deskripsi. */
  action?: ReactNode
}

/**
 * Tampilan kosong untuk tab dashboard / antrean gerbang yang belum
 * memiliki baris data.
 */
export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-6 px-6 py-12 text-center">
      {icon && (
        <div className="inline-flex items-center justify-center rounded-card bg-muted p-3 text-ink-muted" aria-hidden="true">
          {icon}
        </div>
      )}
      <p className="text-base font-semibold text-ink">{title}</p>
      {description && <p className="max-w-xs md:max-w-md text-sm text-ink-secondary">{description}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  )
}
