'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Cropper, { type Area } from 'react-easy-crop'
import 'react-easy-crop/react-easy-crop.css'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import {
  cropAvatar,
  prepareCropSource,
  type CropArea,
  type CropSource,
} from '@/lib/uploads/cropImage'

export interface AvatarCropDialogProps {
  /** Status keterbukaan dialog — dimiliki penuh oleh induk. */
  open: boolean
  /** Berkas foto yang baru dipilih; `null` berarti tidak ada yang perlu dipotong. */
  file: File | null
  /** true bila induk sedang mengunggah hasil potongan (mengunci semua aksi). */
  busy?: boolean
  onCancel: () => void
  onConfirm: (file: File) => Promise<void> | void
}

/** Pesan galat aman untuk UI (pola sama dengan ProfileForm). */
function cropErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') {
    return error.message
  }
  return 'Terjadi kesalahan saat memproses foto. Silakan coba lagi.'
}

/**
 * Dialog pemotong avatar 1:1 berbentuk lingkaran.
 *
 * Berkas dipre-decode sekali oleh `prepareCropSource` (bitmap terorientasi
 * EXIF + object URL), lalu `react-easy-crop` menampilkan pratinjau dari URL
 * tersebut. Saat konfirmasi, `cropAvatar` memotong persegi dari kanvas
 * sumber dan mengodekannya sebagai JPEG — induk menerima File hasil lewat
 * `onConfirm` dan MENGONTROL sendiri status `open` (komponen ini tidak pernah
 * menutup dirinya sendiri).
 *
 * Siklus sumber: setiap sumber dilepas TEPAT SATU KALI, baik oleh handler
 * tutup/batal, efek cleanup (ganti berkas / tutup / unmount), maupun penolakan
 * resolusi `prepareCropSource` yang basi — `dispose` pada `CropSource` memang
 * idempoten, tetapi ref memastikan kami tidak memanggilnya dua kali dari
 * jalur berbeda.
 */
export function AvatarCropDialog({
  open,
  file,
  busy = false,
  onCancel,
  onConfirm,
}: AvatarCropDialogProps) {
  const [source, setSource] = useState<CropSource | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [areaPixels, setAreaPixels] = useState<CropArea | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Pegangan mutakhir agar cleanup selalu menyasar sumber yang benar tanpa
  // perlu menyertakan `source` di dependensi efek (yang akan memicu
  // prepare ulang setiap kali state berubah).
  const sourceRef = useRef<CropSource | null>(null)
  // Nomor urut untuk mengabaikan resolusi `prepareCropSource` yang basi
  // (berkas sudah diganti atau dialog sudah ditutup saat promise resolve).
  const prepareSeqRef = useRef(0)

  /** Lepas sumber aktif; aman dipanggil ganda (ref dinolkan lebih dulu). */
  const disposeSource = useCallback(() => {
    const current = sourceRef.current
    sourceRef.current = null
    current?.dispose()
    setSource(null)
  }, [])

  // Siapkan sumber saat dialog terbuka dengan berkas, dan lepaskan tepat
  // satu kali saat berkas berganti, dialog ditutup, atau komponen dilepas.
  useEffect(() => {
    if (!open || file === null) {
      return undefined
    }

    const sequence = ++prepareSeqRef.current
    /* eslint-disable react-hooks/set-state-in-effect -- reset-on-open: semua status pemotongan direset saat efek dimulai (dialog terbuka dengan berkas baru) */
    setPreparing(true)
    setError(null)
    setCrop({ x: 0, y: 0 })
    setZoom(1)
    setAreaPixels(null)
    /* eslint-enable react-hooks/set-state-in-effect */

    prepareCropSource(file).then(
      (next) => {
        if (sequence !== prepareSeqRef.current) {
          // Resolusi basi: sumber baru tidak boleh menggantikan yang aktif.
          next.dispose()
          return
        }
        sourceRef.current?.dispose()
        sourceRef.current = next
        setSource(next)
        setPreparing(false)
      },
      (reason: unknown) => {
        if (sequence !== prepareSeqRef.current) {
          return
        }
        setPreparing(false)
        setError(cropErrorMessage(reason))
      },
    )

    return () => {
      // Invalidasi promise yang masih melayang, lalu lepas sumber aktif.
      prepareSeqRef.current += 1
      disposeSource()
    }
  }, [open, file, disposeSource])

  const locked = busy || submitting
  // `Modal` memasang ulang listener/restore-focus setiap identitas `onClose`
  // berubah. Simpan nilai terbaru di ref agar `handleClose` stabil: status
  // sibuk dan callback induk yang berubah tidak boleh memicu focus restore
  // di tengah dialog.
  const lockedRef = useRef(locked)
  const onCancelRef = useRef(onCancel)
  useEffect(() => {
    lockedRef.current = locked
    onCancelRef.current = onCancel
  }, [locked, onCancel])

  // Dialog hanya boleh ditutup oleh pengguna saat tidak sedang sibuk; hasil
  // konfirmasi yang sukses ditutup oleh induk lewat prop `open`.
  const handleClose = useCallback(() => {
    if (lockedRef.current) {
      return
    }
    disposeSource()
    onCancelRef.current()
  }, [disposeSource])

  const handleCropComplete = useCallback((_area: Area, croppedAreaPixels: Area) => {
    setAreaPixels(croppedAreaPixels)
  }, [])

  const handleConfirm = useCallback(async () => {
    const current = sourceRef.current
    if (locked || current === null || areaPixels === null || file === null) {
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const croppedFile = await cropAvatar(current, areaPixels, file.name)
      await onConfirm(croppedFile)
    } catch (reason) {
      // Galat crop/kirim: dialog tetap terbuka dengan pesan inline.
      setError(cropErrorMessage(reason))
    } finally {
      setSubmitting(false)
    }
  }, [locked, areaPixels, file, onConfirm])

  if (!open || file === null) {
    return null
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Sesuaikan Foto Profil"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={handleClose} disabled={locked}>
            Batal
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleConfirm()}
            disabled={locked || source === null || areaPixels === null}
            loading={submitting}
          >
            Gunakan foto
          </Button>
        </>
      }
    >
      {error !== null ? (
        <p
          role="alert"
          className="mb-3 rounded-control bg-checkout/10 px-3 py-2 text-sm text-checkout"
        >
          {error}
        </p>
      ) : null}

      {source !== null ? (
        <div className="flex flex-col gap-3">
          {/* Viewport cropper: Cropper ter-position-absolute penuh di induk
              ber-`position: relative` (persyaratan react-easy-crop). */}
          <div className="relative h-64 w-full overflow-hidden rounded-card bg-neutral-bg sm:h-80">
            <Cropper
              image={source.url}
              crop={crop}
              zoom={zoom}
              aspect={1}
              cropShape="round"
              showGrid={false}
              minZoom={1}
              maxZoom={4}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={handleCropComplete}
            />
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-label font-semibold text-ink">Perbesaran</span>
            <input
              type="range"
              min={1}
              max={4}
              step={0.05}
              value={zoom}
              aria-label="Perbesaran foto"
              disabled={locked}
              onChange={(event) => setZoom(Number(event.target.value))}
              className="h-11 w-full cursor-pointer accent-brand"
            />
          </label>
        </div>
      ) : preparing ? (
        <div
          aria-live="polite"
          className="relative flex h-64 w-full items-center justify-center overflow-hidden rounded-card bg-neutral-bg sm:h-80"
        >
          <span className="flex flex-col items-center gap-2 text-ink-secondary">
            <Spinner size="sm" />
            <span className="text-sm">Memuat foto...</span>
          </span>
        </div>
      ) : null}
    </Modal>
  )
}
