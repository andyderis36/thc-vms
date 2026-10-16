'use client'

import { Button } from '@/components/ui/Button'
import { useVisitFile } from '@/features/visits/hooks/useVisitFile'
import type { VisitorItem } from '@/lib/api/types'
import { VisitorPhoto, type VisitorPhotoVariant } from './VisitorPhoto'

interface VisitFilePhotoProps {
  /** UUID kunjungan — kunci endpoint `GET /visits/{id}/file?kind=...`. */
  visitId: string
  visitor: VisitorItem
  variant: VisitorPhotoVariant
  triggerLabel?: string
}

/**
 * Foto teknisi (selfie / KTP) yang dimuat lewat endpoint berkas kunjungan
 * → object URL lokal, bukan presigned MinIO/S3 (tahan lintas host).
 *
 * Selama memuat atau bila berkas gagal dimuat, `VisitorPhoto` menerima
 * `src` null → kotak placeholder netral yang sama persis dengan tampilan
 * "foto tidak ada" — tanpa perubahan visual. Bila gagal, pesan galat
 * Indonesia + tombol "Coba lagi" tampil di atas placeholder (kegagalan tidak
 * lagi sunyi seperti 400 yang tak terlihat).
 */
export function VisitFilePhoto({
  visitId,
  visitor,
  variant,
  triggerLabel,
}: VisitFilePhotoProps) {
  const { objectUrl, loading, error, retry } = useVisitFile({
    visitId,
    kind: variant === 'ktp' ? 'id_card' : 'selfie',
    // UUID baris visitor — endpoint berkas menolak id_number (400).
    visitorId: visitor.id,
  })

  return (
    <div className="flex flex-col gap-2">
      {error !== null && !loading ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-xs text-danger-text">
            {error}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-touch"
            onClick={retry}
          >
            Coba lagi
          </Button>
        </div>
      ) : null}
      <VisitorPhoto
        src={objectUrl}
        visitorName={visitor.name}
        variant={variant}
        triggerLabel={triggerLabel}
      />
    </div>
  )
}
