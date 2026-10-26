'use client'

import { useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import { FileText, Upload } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { ApiError } from '@/lib/api/fetcher'
import { useUploadFileMutation } from '@/lib/api/hooks'
import type { UploadCategory } from '@/lib/api/types'
import { ALLOWED_MIME_TYPES, validateUploadIngest } from '@/lib/uploads/validation'

/** Berkas hasil unggahan: URL object storage + nama berkas untuk tampilan. */
export interface UploadedFile {
  url: string
  name: string
}

export interface UploadBoxProps {
  label: string
  /** Id elemen wrapper; dipakai form untuk scroll + focus saat galat validasi. */
  id?: string
  hint?: string
  error?: string
  value: UploadedFile | null
  onChange: (next: UploadedFile | null) => void
  /** Kategori API `/uploads`; surat tugas memakai 'assignment_letter'. */
  category?: UploadCategory
  /** Mode ringkas untuk kartu teknisi: tombol pilih + chip nama berkas. */
  compact?: boolean
  /** Label tombol saat belum ada berkas (mode ringkas + mode penuh). */
  idleButtonLabel?: string
  /** Label tombol saat berkas sudah ada (mode ringkas + mode penuh). */
  changeButtonLabel?: string
}

const ACCEPT_TYPES = ALLOWED_MIME_TYPES.join(',')

/**
 * Dropzone + pemilih berkas untuk lampiran (PDF/JPG/PNG).
 *
 * Aturan ukuran/MIME TIDAK ditulis ulang di sini: pemilih berkas memakai
 * plafon INGEST 20 MB (`validateUploadIngest`, sudah berunit test) karena
 * berkas mentah belum dikompresi — foto disusutkan peramban di
 * `prepareUpload` lalu diperiksa terhadap plafon stored 5 MB, dan PDF
 * disusutkan server yang juga menegakkan plafon stored. Memakai plafon stored
 * di sini akan menolak foto 6 MB yang sebenarnya bisa dikompresi. Validasi
 * berjalan sebelum `useUploadFileMutation`, sehingga berkas tak valid tidak
 * pernah menyentuh jaringan. Seret-lepas memakai event drag HTML asli; tombol
 * pilih berkas tetap tersedia sebagai jalur akses keyboard.
 */
export function UploadBox({
  label,
  id,
  hint,
  error,
  value,
  onChange,
  category = 'assignment_letter',
  compact = false,
  idleButtonLabel = 'Unggah Foto KTP',
  changeButtonLabel = 'Ganti Foto KTP',
}: UploadBoxProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const upload = useUploadFileMutation()

  const message = error ?? uploadError ?? ''
  const hasError = message !== ''

  function pickFile(): void {
    inputRef.current?.click()
  }

  function clearFile(): void {
    setUploadError(null)
    onChange(null)
  }

  async function processFile(file: File | undefined | null): Promise<void> {
    if (file === undefined || file === null || upload.isPending) {
      return
    }
    // Validasi lokal wajib sebelum jaringan dan memakai plafon ingest 20 MB:
    // foto baru diperiksa terhadap plafon stored 5 MB setelah dikompresi, PDF
    // setelah server mengompresinya. Pesan penolakan datang dari validator di
    // validation.ts.
    const verdict = validateUploadIngest(file)
    if (!verdict.ok) {
      setUploadError(verdict.message)
      return
    }
    setUploadError(null)
    try {
      const result = await upload.mutateAsync({ file, category })
      onChange({ url: result.file_url, name: result.file_name })
    } catch (err: unknown) {
      setUploadError(
        err instanceof ApiError
          ? err.message
          : 'Mengunggah berkas gagal. Silakan coba lagi.',
      )
    }
  }

  function handleInputChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0]
    // Kosongkan agar berkas yang sama dapat dipilih ulang.
    event.target.value = ''
    void processFile(file)
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    setDragging(true)
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    if (
      event.relatedTarget instanceof Node &&
      event.currentTarget.contains(event.relatedTarget)
    ) {
      return
    }
    setDragging(false)
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    setDragging(false)
    void processFile(event.dataTransfer.files[0])
  }

  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      accept={ACCEPT_TYPES}
      className="hidden"
      tabIndex={-1}
      onChange={handleInputChange}
    />
  )

  const chip =
    value !== null ? (
      <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full bg-neutral-bg px-2.5 py-1.5 text-xs text-ink-secondary">
        <FileText aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="truncate">{value.name}</span>
      </span>
    ) : null

  const clearButton =
    value !== null ? (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="min-h-touch"
        onClick={clearFile}
        disabled={upload.isPending}
      >
        Hapus
      </Button>
    ) : null

  const messages = (
    <>
      {hint !== undefined && !hasError ? (
        <p className="text-xs text-ink-secondary">{hint}</p>
      ) : null}
      {hasError ? (
        <p role="alert" className="text-xs text-danger-text">
          {message}
        </p>
      ) : null}
    </>
  )

  if (compact) {
    return (
      <div id={id} tabIndex={-1} className="flex flex-col gap-2">
        <p className="text-label font-semibold text-ink">{label}</p>
        {/*
         * Mode ringkas: TIDAK memakai cincin/outline galat. Baris ini melebar
         * penuh satu sel grid, jadi ring merah melingkupi area kosong di kanan
         * tombol dan terbaca "melebihi" tombol. Pesan galat merah di bawah
         * (`role="alert"`) sudah cukup jelas. Outline merah tetap dipakai di
         * dropzone mode penuh, karena di sana area itu sendiri adalah target
         * unggahan.
         */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="min-h-touch"
            onClick={pickFile}
            loading={upload.isPending}
          >
            {value === null ? idleButtonLabel : changeButtonLabel}
          </Button>
          {chip}
          {clearButton}
        </div>
        {fileInput}
        {messages}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-label font-semibold text-ink">{label}</p>
      <div
        id={id}
        tabIndex={-1}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={[
          'flex flex-col items-center justify-center gap-3 rounded-control border-2 border-dashed px-6 py-8 text-center transition-colors',
          hasError
            ? 'border-danger-text bg-danger-bg/30'
            : dragging
              ? 'border-brand bg-brand-soft'
              : 'border-border-mid bg-page hover:border-brand hover:bg-brand-soft/60',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {upload.isPending ? (
          <span className="inline-flex items-center gap-2 text-sm text-ink-secondary">
            <Spinner size="sm" />
            Mengunggah berkas…
          </span>
        ) : (
          <>
            <span className="inline-flex size-11 items-center justify-center rounded-full bg-brand-soft text-brand">
              <Upload aria-hidden="true" className="size-5" />
            </span>
            <p className="max-w-sm text-sm text-ink-secondary">
              {value === null
                ? 'Seret berkas ke sini, atau pilih dari galeri, kamera, maupun berkas perangkat Anda.'
                : 'Seret berkas baru ke sini, atau pilih dari galeri untuk mengganti lampiran.'}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button
                type="button"
                variant="secondary"
                className="min-h-touch px-4"
                onClick={pickFile}
              >
                <Upload aria-hidden="true" className="size-4 shrink-0" />
                {value === null ? idleButtonLabel : changeButtonLabel}
              </Button>
              {clearButton}
            </div>
            {chip}
          </>
        )}
        {fileInput}
      </div>
      {messages}
    </div>
  )
}
