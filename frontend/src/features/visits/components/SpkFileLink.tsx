'use client'

import type { ReactNode } from 'react'
import { useVisitFile } from '@/features/visits/hooks/useVisitFile'

interface SpkFileLinkProps {
  /** UUID kunjungan — kunci endpoint `GET /visits/{id}/file?kind=assignment_letter`. */
  visitId: string
  /** Class anchor pemanggil — dipertahankan persis agar visual identik. */
  className: string
  /** `aria-label` pemanggil — dipertahankan persis. */
  ariaLabel: string
  /** Elemen pengganti selama berkas dimuat / bila tidak tersedia (netral). */
  fallback: ReactNode
  children: ReactNode
}

/**
 * Tautan "Lihat SPK" yang diambil lewat endpoint berkas kunjungan sebagai
 * object URL lokal — bukan presigned MinIO (tahan lintas host: localhost,
 * LAN kantor, tunnel, produksi; tidak ada query `X-Amz-*`).
 *
 * Selama berkas dimuat atau bila tidak tersedia, tampilkan `fallback`
 * milik pemanggil — markup netral yang sama persis dengan kondisi tanpa
 * dokumen, sehingga tidak ada perubahan visual/a11y.
 */
export function SpkFileLink({
  visitId,
  className,
  ariaLabel,
  fallback,
  children,
}: SpkFileLinkProps) {
  const { objectUrl } = useVisitFile({ visitId, kind: 'assignment_letter' })

  if (objectUrl === null) {
    return <>{fallback}</>
  }

  return (
    <a
      href={objectUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={ariaLabel}
      className={className}
    >
      {children}
    </a>
  )
}
