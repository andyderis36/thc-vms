'use client'

import { useEffect, useState } from 'react'
import { ImageOff, Users } from 'lucide-react'

import { Modal } from '@/components/ui/Modal'

/** Varian foto teknisi — menentukan bentuk kotak & label tampilan. */
export type VisitorPhotoVariant = 'selfie' | 'ktp'

interface VisitorPhotoProps {
  /** URL presigned dari backend; `null` / string kosong dianggap tidak ada berkas. */
  src: string | null | undefined
  /** Nama teknisi — dipakai untuk `alt` dan teks galat yang dapat diakses. */
  visitorName: string
  variant: VisitorPhotoVariant
}

/** Bentuk kotak: selfie persegi 56px, KTP lanskap 80×56 (di atas baris teks). */
const SHAPE_CLASS: Record<VisitorPhotoVariant, string> = {
  selfie: 'size-14',
  ktp: 'h-14 w-20',
}

/** Label Indonesia yang terlihat — pengawas harus bisa membedakan KTP vs selfie. */
const VARIANT_LABEL: Record<VisitorPhotoVariant, string> = {
  selfie: 'Foto selfie',
  ktp: 'Foto KTP',
}

/**
 * Teks `alt` Indonesia ("Foto selfie Andi") — dipakai thumbnail maupun gambar
 * pratinjau besar agar keduanya konsisten bagi pembaca layar.
 */
export function photoAltText(variant: VisitorPhotoVariant, visitorName: string): string {
  return `${VARIANT_LABEL[variant]} ${visitorName}`
}

/**
 * `aria-label` tombol thumbnail: pengguna pembaca layar harus tahu bahwa
 * klik / Enter pada foto membuka pratinjau yang lebih besar.
 */
export function photoPreviewAriaLabel(variant: VisitorPhotoVariant, visitorName: string): string {
  return `Lihat foto ${VARIANT_LABEL[variant]} ${visitorName} lebih besar`
}

/**
 * Pratinjau foto teknisi (selfie / KTP) dengan penanganan penuh:
 *
 * - `src` kosong / `null` → kotak netral + ikon (bukan gambar rusak); teks
 *   "tidak tersedia" tetap ditampilkan pemanggil lewat badge-nya. Status ini
 *   TIDAK interaktif — tidak ada tombol, tidak ada dialog.
 * - URL kedaluwarsa / ditolak storage (respons XML `AccessDenied`) → `onError`
 *   mengganti gambar dengan ikon + caption Bahasa Indonesia; layout tidak
 *   berubah karena ukuran kotak dikunci. Kegagalan yang terjadi DI DALAM
 *   dialog pratinjau memakai fallback yang sama persis — tidak pernah
 *   menampilkan gambar rusak.
 * - Thumbnail dapat diklik (tombol `type="button"` yang dapat difokus keyboard)
 *   untuk membuka dialog `Modal` berisi foto besar + caption + `alt` Indonesia;
 *   Esc / klik backdrop / tombol Tutup menutup dialog dan fokus kembali ke
 *   thumbnail (ditangani `Modal`).
 * - `alt` & `aria-label` selalu berbahasa Indonesia, caption terlihat membedakan
 *   "Foto KTP" dan "Foto selfie".
 *
 * URL tidak pernah diubah di sini — backend yang menerbitkan presigned URL.
 */
export function VisitorPhoto({ src, visitorName, variant }: VisitorPhotoProps) {
  const [loadFailed, setLoadFailed] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const rawSrc = typeof src === 'string' ? src.trim() : ''
  const hasImage = rawSrc !== '' && !loadFailed
  const label = VARIANT_LABEL[variant]
  const altText = photoAltText(variant, visitorName)

  let caption: string | null = null
  if (hasImage) {
    caption = label
  } else if (loadFailed) {
    caption = `${label} tidak dapat dimuat`
  }

  /*
   * Modal pratinjau ini & Modal induk (ScanResultModal di popup gerbang)
   * sama-sama memasang listener Esc fase bubble di `document`, sehingga satu
   * Esc akan menutup KEDUA dialog sekaligus — popup gerbang ikut hilang.
   * Menangkap fase capture di `document` + `stopPropagation` memastikan hanya
   * pratinjau yang tertutup; listener `Modal` induk tidak sempat berjalan.
   */
  useEffect(() => {
    if (!previewOpen) return
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setPreviewOpen(false)
    }
    document.addEventListener('keydown', handleEscape, true)
    return () => document.removeEventListener('keydown', handleEscape, true)
  }, [previewOpen])

  return (
    <figure className="shrink-0">
      {hasImage ? (
        <button
          type="button"
          onClick={() => setPreviewOpen(true)}
          aria-label={photoPreviewAriaLabel(variant, visitorName)}
          className="block cursor-zoom-in"
        >
          <img
            src={rawSrc}
            alt={altText}
            loading="lazy"
            onError={() => setLoadFailed(true)}
            className={`${SHAPE_CLASS[variant]} rounded-control border border-border-light object-cover`}
          />
        </button>
      ) : (
        <span
          role="img"
          aria-label={
            loadFailed
              ? `${label} ${visitorName} tidak dapat dimuat`
              : `${label} ${visitorName} tidak tersedia`
          }
          className={`flex ${SHAPE_CLASS[variant]} shrink-0 items-center justify-center rounded-control bg-neutral-bg text-ink-muted`}
        >
          {variant === 'selfie' && !loadFailed ? (
            <Users aria-hidden="true" className="size-6 shrink-0" />
          ) : (
            <ImageOff aria-hidden="true" className="size-6 shrink-0" />
          )}
        </span>
      )}
      <Modal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title={`Pratinjau ${label}`}
        size="lg"
      >
        {loadFailed ? (
          /* Fallback sama dengan thumbnail: ikon + caption, bukan gambar rusak. */
          <span
            role="img"
            aria-label={`${label} ${visitorName} tidak dapat dimuat`}
            className="flex h-64 w-full items-center justify-center rounded-control bg-neutral-bg text-ink-muted"
          >
            <ImageOff aria-hidden="true" className="size-12 shrink-0" />
          </span>
        ) : (
          <img
            src={rawSrc}
            alt={altText}
            onError={() => setLoadFailed(true)}
            className="max-h-[60vh] w-full rounded-control border border-border-light object-contain"
          />
        )}
        <p className="mt-3 text-ink-muted">
          {loadFailed ? `${label} tidak dapat dimuat` : altText}
        </p>
      </Modal>
      {caption !== null ? (
        <figcaption className="mt-1 text-badge text-ink-muted">{caption}</figcaption>
      ) : null}
    </figure>
  )
}
