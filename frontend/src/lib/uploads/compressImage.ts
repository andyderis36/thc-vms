/**
 * Kompresi foto sisi-klien SEBELUM unggahan dikirim (PRD: S2 tepi ukuran
 * oversize + S5 bertahan pada uplink lemah).
 *
 * Foto JPEG/PNG diturunkan via canvas ke sisi terpanjang maksimum
 * `MAX_IMAGE_EDGE_PX` piksel, lalu dikodekan ulang sebagai JPEG kualitas
 * `JPEG_QUALITY`. Berkas non-gambar (PDF) dilewatkan apa adanya — byte-identik.
 *
 * Orientasi EXIF diterapkan oleh decoder browser (`imageOrientation:
 * 'from-image'`); hasil encode canvas tidak membawa metadata EXIF, sehingga
 * koreksi gambar tidak pernah bergantung pada parsing EXIF di sini.
 */

import { validateUpload } from '@/lib/uploads/validation'

/** Sisi terpanjang hasil kompresi (AGENTS.md: skala wajar untuk foto unggahan). */
export const MAX_IMAGE_EDGE_PX = 1600

/** Kualitas JPEG hasil encode ulang (0.8 = keseimbangan ukuran vs kejelasan). */
export const JPEG_QUALITY = 0.8

/** Satu-satunya tipe foto yang dikompres; selebihnya (PDF dkk.) dilewatkan. */
const PHOTO_MIME_TYPES: readonly string[] = ['image/jpeg', 'image/png']

export type PreparedUpload = { ok: true; file: File } | { ok: false; message: string }

/** Ekstensi `.png`/`.PNG` diganti `.jpg` agar nama berkas cocok dengan MIME hasil encode. */
function jpegName(name: string): string {
  return name.replace(/\.png$/i, '.jpg')
}

/**
 * Turunkan foto ke ≤1600px sisi terpanjang dan encode ulang JPEG q0.8.
 * Berkas yang bukan foto (PDF, dll.) dikembalikan apa adanya (byte-identik).
 */
export async function compressImage(file: File): Promise<File> {
  if (!PHOTO_MIME_TYPES.includes(file.type)) {
    return file
  }

  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  try {
    const longestEdge = Math.max(bitmap.width, bitmap.height)
    const scale = Math.min(1, MAX_IMAGE_EDGE_PX / longestEdge)
    const targetWidth = Math.max(1, Math.round(bitmap.width * scale))
    const targetHeight = Math.max(1, Math.round(bitmap.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = targetWidth
    canvas.height = targetHeight
    const context = canvas.getContext('2d')
    if (context === null) {
      throw new Error('canvas 2d context tidak tersedia')
    }
    context.drawImage(bitmap, 0, 0, targetWidth, targetHeight)

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => {
          if (result === null) {
            reject(new Error('encode JPEG gagal'))
            return
          }
          resolve(result)
        },
        'image/jpeg',
        JPEG_QUALITY,
      )
    })

    return new File([blob], jpegName(file.name), {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    })
  } finally {
    bitmap.close()
  }
}

/**
 * Validasi 5 MB + MIME sebelum DAN sesudah kompresi (pesan Indonesia dari
 * `validateUpload`), lalu kompresi foto. Dipakai `uploadFile` sebelum
 * FormData dibuat — berkas tidak pernah menyentuh jaringan dalam bentuk
 * mentahnya.
 */
export async function prepareUpload(file: File): Promise<PreparedUpload> {
  const before = validateUpload(file)
  if (!before.ok) {
    return before
  }

  let prepared: File
  try {
    prepared = await compressImage(file)
  } catch {
    return {
      ok: false,
      message: `Gambar "${file.name}" tidak dapat diproses. Coba unggah foto atau berkas lain.`,
    }
  }

  const after = validateUpload(prepared)
  if (!after.ok) {
    return after
  }
  return { ok: true, file: prepared }
}
