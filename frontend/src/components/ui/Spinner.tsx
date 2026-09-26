export interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg'
  /** Label aksesibilitas Bahasa Indonesia untuk pembaca layar. */
  label?: string
  className?: string
}

const SIZE_CLASSES: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'size-4',
  md: 'size-6',
  lg: 'size-8',
}

/**
 * Indikator loading yang dapat diakses: `role="status"` + `aria-label`
 * berbahasa Indonesia, dan menghormati preferensi `prefers-reduced-motion`.
 * Warna mengikuti `currentColor` dari induknya.
 */
export function Spinner({ size = 'md', label = 'Memuat…', className }: SpinnerProps) {
  const classes = ['inline-flex items-center justify-center', SIZE_CLASSES[size], className ?? '']
    .filter(Boolean)
    .join(' ')

  return (
    <span role="status" aria-label={label} className={classes}>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        className="size-full animate-spin motion-reduce:animate-none"
      >
        <circle
          cx="12"
          cy="12"
          r="9"
          stroke="currentColor"
          strokeWidth="3"
          className="opacity-25"
        />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
    </span>
  )
}
