'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { uploadFile } from '@/lib/api/client'
import { apiFetch } from '@/lib/api/fetcher'
import { queryKeys } from '@/lib/api/query-keys'
import type { WorkPhoto } from '@/lib/api/types'

/**
 * Slot bukti pengerjaan pada `POST /visits/{id}/work-photos`
 * (kontrak `kind` di `docs/4. openapi.yaml`).
 */
export type WorkPhotoKind = 'before' | 'after'

export interface UseWorkPhotoUploadParams {
  /** UUID kunjungan — tujuan lampiran + kunci invalidasi detail. */
  visitId: string
  /** Slot yang diurus instance ini: `before` (sebelum kerja) / `after` (sesudah kerja). */
  kind: WorkPhotoKind
}

export interface UseWorkPhotoUploadResult {
  /**
   * Jalankan dua langkah dalam SATU mutasi: unggah berkas (kategori
   * `work_photos`) lalu lampirkan URL hasilnya ke slot kunjungan.
   * Galat diteruskan ke `errorMessage` — pemanggil cukup memanggil tanpa
   * `try/catch`.
   */
  upload: (file: File) => void
  /** `true` selama unggahan + lampiran berjalan — kontrol wajib dinonaktifkan. */
  isPending: boolean
  /**
   * Pesan galat berbahasa Indonesia. `ApiError` dari `apiFetch` sudah membawa
   * pesan amplop backend `{ success: false, error: { message } }` apa adanya
   * (mis. 409 "bukti hanya dapat dilampirkan saat status visiting"), jadi
   * pesan server tidak pernah tertimpa.
   */
  errorMessage: string | null
}

/**
 * Peta pesan galat mutasi: pesan API (amplop backend) dipertahankan; galat
 * tanpa pesan memakai fallback Indonesia — "Failed to fetch" atau stack tidak
 * boleh bocor ke UI.
 */
function workPhotoUploadErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') {
    return error.message
  }
  return 'Mengunggah bukti kerja gagal. Silakan coba lagi.'
}

/**
 * Mutasi lampiran bukti kerja (Sebelum/Sesudah kerja) — dua langkah:
 *
 * 1. `POST /uploads` dengan kategori `work_photos` lewat helper bersama
 *    `uploadFile` (kompresi + validasi MIME/ukuran + FormData sudah berjalan
 *    di sana — TIDAK ada logika fetch yang diduplikasi di sini).
 * 2. `POST /visits/{id}/work-photos` dengan `{ kind, url }` memakai transport
 *    `apiFetch` (amplop `{ success, data }` / galat sudah ditangani di sana).
 *
 * Sukses → invalidasi `queryKeys.visits.detail(visitId)` sehingga kartu
 * "Bukti Kerja" dan seluruh konsumen detail kunjungan langsung menampilkan
 * foto terbaru tanpa reload. Galat → `errorMessage` membawa pesan amplop
 * backend. Kategori cache lain tidak disentuh (unggahan tidak mengubah
 * daftar/QR/notifikasi).
 */
export function useWorkPhotoUpload({
  visitId,
  kind,
}: UseWorkPhotoUploadParams): UseWorkPhotoUploadResult {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async (file: File): Promise<void> => {
      const uploaded = await uploadFile(file, 'work_photos')
      await apiFetch<WorkPhoto>(`/visits/${visitId}/work-photos`, {
        method: 'POST',
        body: JSON.stringify({ kind, url: uploaded.file_url }),
      })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.visits.detail(visitId) })
    },
  })

  return {
    upload: (file: File) => mutation.mutate(file),
    isPending: mutation.isPending,
    errorMessage: mutation.error !== null ? workPhotoUploadErrorMessage(mutation.error) : null,
  }
}
