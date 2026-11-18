'use client'

import { useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { Camera, Eye, Upload } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { Modal } from '@/components/ui/Modal'
import { useVisitFile } from '@/features/visits/hooks/useVisitFile'
import {
  useWorkPhotoUpload,
  type WorkPhotoKind,
} from '@/features/visits/hooks/useWorkPhotoUpload'
import type { VisitStatus, WorkPhoto } from '@/lib/api/types'
import { formatTanggalWaktu } from './Timeline'

export interface WorkPhotoCardProps {
  /** UUID kunjungan — kunci endpoint unggah/lampiran & `GET /visits/{id}/file`. */
  visitId: string
  status: VisitStatus
  /** Slot "Sebelum kerja" — `null` bila belum pernah dilampirkan. */
  before: WorkPhoto | null
  /** Slot "Sesudah kerja" — `null` bila belum pernah dilampirkan. */
  after: WorkPhoto | null
  /** Izin unggah milik pemanggil (peran + kepemilikan) — gerbang status tetap di sini. */
  canEdit: boolean
  /**
   * Siklus check-in/out aktif (id baris `visit_logs` arah `in` terakhir yang
   * belum ditutup `out`); lampiran membawa id ini sebagai `visit_log_id`.
   * Absen = server memakai siklus `in` terakhir.
   */
  activeVisitLogId?: string | null
}

/** Teks per slot: label kartu, `alt` pratinjau, dan aria-label tombol aksi. */
const SLOT_META: Record<
  WorkPhotoKind,
  { label: string; alt: string; short: string }
> = {
  before: { label: 'Sebelum kerja', alt: 'Foto bukti sebelum kerja', short: 'sebelum kerja' },
  after: { label: 'Sesudah kerja', alt: 'Foto bukti sesudah kerja', short: 'sesudah kerja' },
}

/** Kind endpoint berkas `GET /visits/{id}/file?kind=...` per slot. */
const FILE_KIND: Record<WorkPhotoKind, 'work_before' | 'work_after'> = {
  before: 'work_before',
  after: 'work_after',
}

/** Pemilih berkas gambar — accept + plafon 5 MB dikomunikasikan lewat teks hint. */
const ACCEPTED_TYPES = 'image/jpeg,image/png'

/**
 * Pesan kunci kartu per status. Saat terkunci, KARTU TETAP MERENDER foto yang
 * sudah ada untuk dilihat — hanya kontrol unggah/ganti yang dinonaktifkan.
 * `visiting` tanpa `canEdit` (gerbang status lolos, izin pemanggil tidak)
 * memakai pesan hak akses tersendiri.
 */
function lockedHint(status: VisitStatus, canEdit: boolean): string | null {
  if (status === 'visiting') {
    return canEdit ? null : 'Anda tidak memiliki akses untuk mengunggah bukti kerja.'
  }
  switch (status) {
    case 'completed':
      return 'Terkunci karena kunjungan sudah selesai'
    case 'cancelled':
    case 'not_visit':
      return 'Tidak tersedia untuk kunjungan yang dibatalkan'
    case 'rejected':
      return 'Tidak tersedia untuk kunjungan yang ditolak'
    default:
      // requested / approved / rescheduled — bukti baru baru boleh saat check-in.
      return 'Tersedia setelah check-in'
  }
}

/** Apakah slot benar-benar punya foto yang bisa dilihat (url terisi). */
function hasPhoto(photo: WorkPhoto | null): photo is WorkPhoto {
  return photo !== null && typeof photo.url === 'string' && photo.url !== ''
}

interface FilePickerProps {
  label: string
  /** Nama aksesibilitas membedakan slot (dua tombol serupa dalam satu kartu). */
  ariaLabel: string
  disabled: boolean
  loading: boolean
  onPick: (file: File) => void
}

/**
 * Tombol pilih berkas + `<input type="file">` tersembunyi (pola `UploadBox`):
 * input di-reset setelah tiap pilihan agar berkas yang sama bisa dipilih ulang.
 */
function FilePicker({ label, ariaLabel, disabled, loading, onPick }: FilePickerProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file !== undefined) {
      onPick(file)
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        className="hidden"
        tabIndex={-1}
        disabled={disabled}
        onChange={handleChange}
      />
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="min-h-touch"
        aria-label={ariaLabel}
        disabled={disabled}
        loading={loading}
        onClick={() => inputRef.current?.click()}
      >
        <Upload aria-hidden="true" className="size-4 shrink-0" />
        {label}
      </Button>
    </>
  )
}

interface SlotShellProps {
  label: string
  children: ReactNode
}

/** Kotak satu slot — permukaan ber-tint lembut, sama seperti baris anggota. */
function SlotShell({ label, children }: SlotShellProps) {
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-control bg-neutral-bg p-3">
      <p className="text-label font-semibold text-ink">{label}</p>
      {children}
    </div>
  )
}

interface SlotBodyProps {
  visitId: string
  kind: WorkPhotoKind
  photo: WorkPhoto
  editable: boolean
  /** `true` bila ada unggahan berjalan (slot mana pun) — seluruh kontrol nonaktif. */
  busy: boolean
  /** `true` bila SLOT INI yang sedang mengunggah — spinner tombolnya menyala. */
  pending: boolean
  errorMessage: string | null
  onUpload: (file: File) => void
}

/**
 * Slot terisi: pratinjau lewat endpoint berkas kunjungan (object URL lokal,
 * bukan presigned — pola `VisitFilePhoto`), metadata lampiran, serta aksi
 * "Lihat" (dialog pratinjau modal, sama seperti foto selfie/KTP — tidak
 * membuka tab baru) dan "Ganti" (unggah ulang ke slot yang sama).
 * Foto tetap bisa dilihat saat kartu terkunci; hanya "Ganti" yang nonaktif.
 */
function FilledSlot({
  visitId,
  kind,
  photo,
  editable,
  busy,
  pending,
  errorMessage,
  onUpload,
}: SlotBodyProps) {
  const meta = SLOT_META[kind]
  const file = useVisitFile({ visitId, kind: FILE_KIND[kind] })
  const viewable = file.objectUrl !== null
  const [previewOpen, setPreviewOpen] = useState(false)

  return (
    <SlotShell label={meta.label}>
      <div className="flex items-start gap-3">
        {file.loading ? (
          <span
            aria-hidden="true"
            className="flex size-14 shrink-0 items-center justify-center rounded-control bg-page text-ink-muted"
          >
            <Camera className="size-6 shrink-0" />
          </span>
        ) : file.error !== null ? (
          <span
            role="img"
            aria-label={`${meta.alt} tidak dapat dimuat`}
            className="flex size-14 shrink-0 items-center justify-center rounded-control bg-page text-ink-muted"
          >
            <Camera className="size-6 shrink-0" />
          </span>
        ) : file.objectUrl !== null ? (
          // eslint-disable-next-line @next/next/no-img-element -- src berupa object URL `blob:` dari useVisitFile, di luar jangkauan optimizer next/image (pola UserAvatar/ProfileMenu).
          <img
            src={file.objectUrl}
            alt={meta.alt}
            className="size-14 shrink-0 rounded-control border border-border-light object-cover"
          />
        ) : (
          <span
            role="img"
            aria-label={`${meta.alt} tidak tersedia`}
            className="flex size-14 shrink-0 items-center justify-center rounded-control bg-page text-ink-muted"
          >
            <Camera className="size-6 shrink-0" />
          </span>
        )}
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-ink-secondary">
            {file.loading ? 'Memuat foto…' : `Diunggah ${formatTanggalWaktu(photo.uploaded_at)}`}
          </span>
          {photo.uploaded_by_name != null && photo.uploaded_by_name !== '' ? (
            <span className="text-xs text-ink-muted">oleh {photo.uploaded_by_name}</span>
          ) : null}
        </div>
      </div>

      {file.error !== null && !file.loading ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-xs text-danger-text">
            {file.error}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-touch"
            onClick={file.retry}
          >
            Coba lagi
          </Button>
        </div>
      ) : null}

      {errorMessage !== null ? (
        <p role="alert" className="text-xs text-danger-text">
          {errorMessage}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="min-h-touch"
          aria-label={`Lihat foto bukti ${meta.short}`}
          disabled={!viewable || file.loading}
          onClick={() => setPreviewOpen(true)}
        >
          <Eye aria-hidden="true" className="size-3 shrink-0" />
          Lihat
        </Button>
        <FilePicker
          label="Ganti"
          ariaLabel={`Ganti foto bukti ${meta.short}`}
          disabled={!editable || busy}
          loading={pending}
          onPick={onUpload}
        />
      </div>
      <Modal
        open={previewOpen && file.objectUrl !== null}
        onClose={() => setPreviewOpen(false)}
        title={`Pratinjau foto bukti ${meta.short}`}
        size="lg"
      >
        {file.objectUrl !== null ? (
          // eslint-disable-next-line @next/next/no-img-element -- src berupa object URL `blob:` dari useVisitFile, di luar jangkauan optimizer next/image (pola thumbnail di atas).
          <img
            src={file.objectUrl}
            alt={meta.alt}
            className="max-h-[60vh] w-full rounded-control border border-border-light object-contain"
          />
        ) : null}
        <p className="mt-3 text-ink-muted">{meta.alt}</p>
      </Modal>
    </SlotShell>
  )
}

interface EmptySlotProps {
  label: string
  short: string
  editable: boolean
  busy: boolean
  pending: boolean
  errorMessage: string | null
  onUpload: (file: File) => void
}

/** Slot kosong: hint format + plafon, lalu kontrol unggah (nonaktif saat terkunci). */
function EmptySlot({ label, short, editable, busy, pending, errorMessage, onUpload }: EmptySlotProps) {
  return (
    <SlotShell label={label}>
      <p className="text-sm text-neutral-text">Belum ada foto.</p>
      <p className="text-xs text-ink-secondary">JPEG/PNG, maksimal 5 MB.</p>
      {errorMessage !== null ? (
        <p role="alert" className="text-xs text-danger-text">
          {errorMessage}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <FilePicker
          label="Unggah Foto"
          ariaLabel={`Unggah foto bukti ${short}`}
          disabled={!editable || busy}
          loading={pending}
          onPick={onUpload}
        />
      </div>
    </SlotShell>
  )
}

interface WorkPhotoSlotProps extends Omit<SlotBodyProps, 'photo'> {
  photo: WorkPhoto | null
}

/**
 * Pilih tampilan slot: terisi → pratinjau + Lihat/Ganti; kosong → kontrol
 * unggah. Pemisahan jadi komponen tersendiri agar `useVisitFile` hanya ter-mount
 * saat slot benar-benar punya foto (tanpa fetch 404 untuk slot kosong).
 */
function WorkPhotoSlot({ photo, ...rest }: WorkPhotoSlotProps) {
  const meta = SLOT_META[rest.kind]
  if (hasPhoto(photo)) {
    return <FilledSlot {...rest} photo={photo} />
  }
  return (
    <EmptySlot
      label={meta.label}
      short={meta.short}
      editable={rest.editable}
      busy={rest.busy}
      pending={rest.pending}
      errorMessage={rest.errorMessage}
      onUpload={rest.onUpload}
    />
  )
}

/**
 * Kartu "Bukti Kerja" — dua slot foto bukti pengerjaan (Sebelum/Sesudah kerja)
 * pada detail kunjungan.
 *
 * Baris bukti terikat ke satu siklus check-in/out via `visit_log_id`
 * (migrasi 000034, nullable untuk baris lama). Tampilan per-siklus dihitung
 * di klien oleh `VisitLogsTimeline` (filter `visit_log_id`, fallback jarak
 * waktu untuk baris lama tanpa binding).
 *
 * - Gerbang status: hanya `visiting` + `canEdit` yang boleh mengunggah/mengganti;
 *   status lain menampilkan petunjuk kunci berbahasa Indonesia dan KARTU TETAP
 *   merender foto yang sudah ada untuk dilihat.
 * - Unggah memakai `useWorkPhotoUpload` (dua langkah: `POST /uploads` kategori
 *   `work_photos` → `POST /visits/{id}/work-photos`), sukses menginvalidasi
 *   detail sehingga tampilan langsung baru; galat tampil inline `role="alert"`
 *   memakai pesan amplop backend.
 * - Pratinjau/"Lihat" memakai endpoint berkas kunjungan (object URL lokal).
 *
 * Komponen murni terkendali lewat props — integrasi ke halaman detail
 * (penerusan `work_photos` + `canEdit`) dilakukan pemanggil.
 */
export function WorkPhotoCard({ visitId, status, before, after, canEdit, activeVisitLogId }: WorkPhotoCardProps) {
  const beforeUpload = useWorkPhotoUpload({ visitId, kind: 'before', visitLogId: activeVisitLogId })
  const afterUpload = useWorkPhotoUpload({ visitId, kind: 'after', visitLogId: activeVisitLogId })

  const editable = status === 'visiting' && canEdit
  const busy = beforeUpload.isPending || afterUpload.isPending
  const hint = lockedHint(status, canEdit)

  const slotProps = {
    visitId,
    editable,
    busy,
  } as const

  return (
    <Card>
      <CardBody>
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex min-w-0 items-center gap-3 text-base font-semibold text-ink">
            <span
              aria-hidden="true"
              className="flex size-9 shrink-0 items-center justify-center rounded-control bg-brand-soft text-brand"
            >
              <Camera className="size-4 shrink-0" />
            </span>
            <span>Bukti Kerja</span>
          </h2>
        </div>

        {hint !== null ? (
          <p className="mt-3 rounded-control bg-neutral-bg px-4 py-3 text-sm text-neutral-text">
            {hint}
          </p>
        ) : null}

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <WorkPhotoSlot
            {...slotProps}
            kind="before"
            photo={before}
            pending={beforeUpload.isPending}
            errorMessage={beforeUpload.errorMessage}
            onUpload={beforeUpload.upload}
          />
          <WorkPhotoSlot
            {...slotProps}
            kind="after"
            photo={after}
            pending={afterUpload.isPending}
            errorMessage={afterUpload.errorMessage}
            onUpload={afterUpload.upload}
          />
        </div>
      </CardBody>
    </Card>
  )
}
