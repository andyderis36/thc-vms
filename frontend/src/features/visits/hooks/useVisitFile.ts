'use client'

import { useCallback, useEffect, useState } from 'react'
import { fetchVisitFileBlob, type VisitFileKind } from '@/lib/api/files'
import { ApiError } from '@/lib/api/fetcher'

/** Parameter hook — `visitorId` wajib untuk berkas per-teknisi (`id_card`/`selfie`). */
export interface UseVisitFileParams {
  visitId: string
  kind: VisitFileKind
  visitorId?: string
}

/** Hasil hook — object URL siap pakai, status memuat, galat Indonesia, dan `retry`. */
export interface UseVisitFileResult {
  objectUrl: string | null
  loading: boolean
  error: string | null
  retry: () => void
}

/**
 * Pesan galat berbahasa Indonesia: 403/404 dipetakan eksplisit agar konsisten
 * di semua pemanggil; `TypeError` jaringan (mis. "Failed to fetch") tidak boleh
 * bocor ke UI; galat lain memakai pesan API bila tersedia, selain itu fallback.
 */
function mapVisitFileError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'Anda tidak memiliki akses untuk melihat berkas ini.'
    }
    if (error.status === 404) {
      return 'Berkas tidak tersedia.'
    }
  }
  if (error instanceof TypeError) {
    return 'Gagal memuat berkas. Silakan coba lagi.'
  }
  if (error instanceof Error && error.message !== '') {
    return error.message
  }
  return 'Gagal memuat berkas. Silakan coba lagi.'
}

/**
 * Muat berkas kunjungan sebagai blob → object URL lokal (tahan lintas host;
 * tidak pernah menempel URL presigned MinIO ke markup).
 *
 * - Sukses → `objectUrl` diawali `blob:`; dilepas (`revokeObjectURL`) saat
 *   unmount / berganti param agar tidak bocor memori.
 * - Galat → `error` berbahasa Indonesia, `objectUrl` tetap `null`
 *   (pemanggil menampilkan placeholder netral); TIDAK melempar ke pemanggil.
 * - `retry()` memicu pengambilan ulang.
 */
export function useVisitFile({
  visitId,
  kind,
  visitorId,
}: UseVisitFileParams): UseVisitFileResult {
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  const retry = useCallback((): void => {
    setAttempt((previous) => previous + 1)
  }, [])

  useEffect(() => {
    let active = true
    let createdUrl: string | null = null

    /* eslint-disable react-hooks/set-state-in-effect -- reset-on-retry: state lama
       harus dikosongkan sebelum fetch berikutnya, dan effect ini satu-satunya
       pemilik lifecycle object URL (cleanup yang membatalkan revoke). */
    setLoading(true)
    setError(null)
    setObjectUrl(null)

    // Berkas per-teknisi tanpa ID baris visitor (mis. echo create) tidak bisa
    // dimuat — langsung selesai tanpa request agar tidak membanjiri console
    // dengan 400 yang sudah pasti gagal.
    if ((kind === 'id_card' || kind === 'selfie') && !visitorId?.trim()) {
      setLoading(false)
      return
    }
    /* eslint-enable react-hooks/set-state-in-effect */

    fetchVisitFileBlob(visitId, kind, visitorId)
      .then((blob) => {
        if (!active) return
        const nextUrl = URL.createObjectURL(blob)
        createdUrl = nextUrl
        setObjectUrl(nextUrl)
      })
      .catch((cause: unknown) => {
        if (!active) return
        setError(mapVisitFileError(cause))
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
      if (createdUrl !== null) {
        URL.revokeObjectURL(createdUrl)
      }
    }
  }, [visitId, kind, visitorId, attempt])

  return { objectUrl, loading, error, retry }
}
