'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Camera, LogIn, LogOut, ScanLine } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Modal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { useVisitFile } from '@/features/visits/hooks/useVisitFile'
import { formatTanggalWaktu } from '@/features/visits/detail/Timeline'
import type { VisitLog, WorkPhoto } from '@/lib/api/types'

export const VISIT_LOGS_MAX_VISIBLE = 6

export interface VisitLogsTimelineProps {
  logs: VisitLog[]
  isPending: boolean
  isError: boolean
  onRetry: () => void
  /** UUID kunjungan — kunci endpoint berkas foto siklus di modal. */
  visitId: string
  /** Slot foto bukti (dari detail kunjungan) untuk client-side join per siklus. */
  before?: WorkPhoto | null
  after?: WorkPhoto | null
  /**
   * Batas baris inline. Default `VISIT_LOGS_MAX_VISIBLE` (6); isi `null`
   * untuk menampilkan semua log (dipakai halaman `/visits/[id]/riwayat`).
   */
  limit?: number | null
  /** Sembunyikan tautan "Lihat Semua" (dipakai di halaman riwayat penuh). */
  hideViewAllLink?: boolean
}

function actorLabel(log: VisitLog): string {
  const name = log.actor_name?.trim() ?? ''
  if (name !== '') return name
  const role = log.actor_role?.trim() ?? ''
  return role !== '' ? role : 'Sistem'
}

/**
 * Foto satu siklus check-in/out: slot `before` yang `visit_log_id`-nya sama
 * dengan baris log `in`, dan slot `after` yang sama dengan pasangan `out`.
 * Baris lama tanpa binding (`visit_log_id` null di kedua slot) jatuh ke
 * heuristic waktu lama — slot yang `uploaded_at`-nya PALING DEKAT dengan
 * `created_at` baris log yang diklik.
 */
function hasPhoto(photo: WorkPhoto | null | undefined): photo is WorkPhoto {
  return photo != null && typeof photo.url === 'string' && photo.url !== ''
}

function isBound(
  before: WorkPhoto | null | undefined,
  after: WorkPhoto | null | undefined,
): boolean {
  return (
    (before?.visit_log_id != null && before.visit_log_id !== '') ||
    (after?.visit_log_id != null && after.visit_log_id !== '')
  )
}

function nearestPhoto(
  log: VisitLog,
  before: WorkPhoto | null | undefined,
  after: WorkPhoto | null | undefined,
): WorkPhoto | null {
  const target = Date.parse(log.created_at)
  if (Number.isNaN(target)) return null
  const candidates = [before, after].filter(hasPhoto)
  let best: WorkPhoto | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const photo of candidates) {
    const at = Date.parse(photo.uploaded_at)
    if (Number.isNaN(at)) continue
    const distance = Math.abs(at - target)
    if (distance < bestDistance) {
      bestDistance = distance
      best = photo
    }
  }
  return best
}

/** Pasangan satu siklus untuk baris log terpilih: `in` + `out` berikutnya. */
function cyclePair(logs: VisitLog[], selected: VisitLog): { inLog: VisitLog; outLog: VisitLog | null } {
  if (selected.direction === 'in') {
    const outLog =
      logs.find(
        (log) =>
          log.direction === 'out' &&
          (log.created_at > selected.created_at ||
            (log.created_at === selected.created_at && log.id > selected.id)),
      ) ?? null
    return { inLog: selected, outLog }
  }
  const inLog =
    [...logs]
      .reverse()
      .find(
        (log) =>
          log.direction === 'in' &&
          (log.created_at < selected.created_at ||
            (log.created_at === selected.created_at && log.id < selected.id)),
      ) ?? selected
  return { inLog, outLog: selected }
}

interface CyclePhotoModalProps {
  visitId: string
  /** Seluruh baris log — untuk memasangkan baris terpilih ke siklusnya. */
  logs: VisitLog[]
  log: VisitLog
  before: WorkPhoto | null | undefined
  after: WorkPhoto | null | undefined
  onClose: () => void
}

interface CycleSlotBlockProps {
  /** Foto terikat siklus ini; `null` = slot kosong pada siklus ini. */
  photo: WorkPhoto | null
  /** Label slot: "Sebelum kerja" / "Sesudah kerja". */
  label: string
  loading: boolean
  objectUrl: string | null
  error: string | null
  onRetry: () => void
}

/** Satu slot foto dalam modal siklus: kosong, memuat, tampil, atau galat. */
function CycleSlotBlock({ photo, label, loading, objectUrl, error, onRetry }: CycleSlotBlockProps) {
  if (photo === null) {
    return (
      <p className="mt-2 rounded-control bg-neutral-bg px-4 py-3 text-sm text-neutral-text">
        {`Belum ada foto ${label.toLowerCase()} pada siklus ini.`}
      </p>
    )
  }
  if (loading) {
    return (
      <div className="mt-2 flex min-h-24 items-center justify-center">
        <Spinner label={`Memuat foto ${label.toLowerCase()}…`} />
      </div>
    )
  }
  if (objectUrl !== null) {
    return (
      <figure className="mt-2">
        {/* eslint-disable-next-line @next/next/no-img-element -- src berupa object URL `blob:` dari useVisitFile, di luar jangkauan optimizer next/image. */}
        <img
          src={objectUrl}
          alt={`Foto bukti ${label.toLowerCase()} pada siklus ini`}
          className="max-h-[60vh] w-full rounded-control border border-border-light object-contain"
        />
        <figcaption className="mt-3 text-sm text-ink-muted">
          {label} — diunggah {formatTanggalWaktu(photo.uploaded_at)}
          {photo.uploaded_by_name != null && photo.uploaded_by_name !== ''
            ? ` oleh ${photo.uploaded_by_name}`
            : null}
        </figcaption>
      </figure>
    )
  }
  return (
    <div className="mt-2 flex flex-col items-start gap-2">
      <span
        role="img"
        aria-label={`Foto bukti ${label.toLowerCase()} tidak dapat dimuat`}
        className="flex size-14 items-center justify-center rounded-control bg-page text-ink-muted"
      >
        <Camera className="size-6 shrink-0" />
      </span>
      <p role="alert" className="text-xs text-danger-text">
        {error ?? 'Foto bukti tidak tersedia.'}
      </p>
      <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
        Coba lagi
      </Button>
    </div>
  )
}

/**
 * Modal foto satu siklus gerbang — ter-mount HANYA saat terbuka sehingga
 * `useVisitFile` tidak menembak endpoint berkas untuk slot kosong/tak dibuka.
 * `before` diambil dari baris log `in` siklus ini, `after` dari pasangan
 * `out`-nya; baris lama tanpa binding memakai heuristic waktu lama.
 */
function CyclePhotoModal({ visitId, logs, log, before, after, onClose }: CyclePhotoModalProps) {
  const beforeFile = useVisitFile({ visitId, kind: 'work_before' })
  const afterFile = useVisitFile({ visitId, kind: 'work_after' })
  const title = `Foto bukti — ${log.direction === 'in' ? 'Check-in' : 'Check-out'} ${formatTanggalWaktu(log.created_at)}`

  if (!isBound(before, after)) {
    const photo = nearestPhoto(log, before, after)
    const isAfter = photo !== null && photo === after
    const file = isAfter ? afterFile : beforeFile
    const label = isAfter ? 'Sesudah kerja' : 'Sebelum kerja'
    return (
      <Modal open onClose={onClose} title={title} size="lg">
        <p className="text-sm text-ink-secondary">
          {actorLabel(log)} · {formatTanggalWaktu(log.created_at)}
        </p>
        {photo === null ? (
          <p className="mt-4 rounded-control bg-neutral-bg px-4 py-3 text-sm text-neutral-text">
            Belum ada foto bukti pada siklus ini.
          </p>
        ) : (
          <CycleSlotBlock
            photo={photo}
            label={label}
            loading={file.loading}
            objectUrl={file.objectUrl}
            error={file.error}
            onRetry={file.retry}
          />
        )}
      </Modal>
    )
  }

  const { inLog, outLog } = cyclePair(logs, log)
  const cycleBefore = hasPhoto(before) && before.visit_log_id === inLog.id ? before : null
  const cycleAfter =
    outLog !== null && hasPhoto(after) && after.visit_log_id === outLog.id ? after : null

  return (
    <Modal open onClose={onClose} title={title} size="lg">
      <p className="text-sm text-ink-secondary">
        {actorLabel(log)} · {formatTanggalWaktu(log.created_at)}
      </p>
      <h3 className="mt-4 text-sm font-semibold text-ink">
        {`Sebelum kerja — check-in ${formatTanggalWaktu(inLog.created_at)}`}
      </h3>
      <CycleSlotBlock
        photo={cycleBefore}
        label="Sebelum kerja"
        loading={beforeFile.loading}
        objectUrl={beforeFile.objectUrl}
        error={beforeFile.error}
        onRetry={beforeFile.retry}
      />
      <h3 className="mt-4 text-sm font-semibold text-ink">
        {outLog !== null
          ? `Sesudah kerja — check-out ${formatTanggalWaktu(outLog.created_at)}`
          : 'Sesudah kerja — belum check-out'}
      </h3>
      <CycleSlotBlock
        photo={cycleAfter}
        label="Sesudah kerja"
        loading={afterFile.loading}
        objectUrl={afterFile.objectUrl}
        error={afterFile.error}
        onRetry={afterFile.retry}
      />
    </Modal>
  )
}

interface LogRowProps {
  log: VisitLog
  onSelect: (id: string) => void
}

/** Satu baris log yang bisa diklik untuk membuka modal foto bukti siklusnya. */
function LogRow({ log, onSelect }: LogRowProps) {
  const isIn = log.direction === 'in'
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(log.id)}
        aria-label={`Lihat foto bukti siklus ${isIn ? 'check-in' : 'check-out'} ${formatTanggalWaktu(log.created_at)}`}
        className="flex w-full items-start gap-3 rounded-control bg-neutral-bg/70 p-3 text-left transition-colors hover:bg-neutral-bg"
      >
        <span
          aria-hidden="true"
          className={`flex size-8 shrink-0 items-center justify-center rounded-control ${
            isIn ? 'bg-success-bg text-success-text' : 'bg-brand-soft text-brand'
          }`}
        >
          {isIn ? (
            <LogIn className="size-4 shrink-0" />
          ) : (
            <LogOut className="size-4 shrink-0" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-ink">
            {isIn ? 'Check-in' : 'Check-out'}
          </span>
          <span className="block text-label text-ink-secondary">{actorLabel(log)}</span>
          <span className="block text-label tabular-nums text-ink-muted">
            {formatTanggalWaktu(log.created_at)}
          </span>
        </span>
      </button>
    </li>
  )
}

/**
 * Timeline per-entry gerbang dari `visit_logs` (check-in/check-out), terpisah
 * dari "Riwayat Status" yang berisi transisi status. Urutan diambil apa adanya
 * dari API (tertua -> terbaru sesuai query repository).
 *
 * Tiap baris bisa diklik untuk membuka modal foto bukti siklus tersebut
 * (client-side join `visit_log_id` — lihat `isBound`/`cyclePair`).
 *
 * MVP cap: daftar inline dipotong `limit` baris pertama sesuai urutan API
 * (default 6); selengkapnya dibuka lewat halaman `/visits/[id]/riwayat`
 * memakai `next/link` "Lihat Semua".
 */
export function VisitLogsTimeline({
  logs,
  isPending,
  isError,
  onRetry,
  visitId,
  before = null,
  after = null,
  limit = VISIT_LOGS_MAX_VISIBLE,
  hideViewAllLink = false,
}: VisitLogsTimelineProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = logs.find((log) => log.id === selectedId) ?? null
  const visibleLogs = limit === null ? logs : logs.slice(0, limit)
  const hiddenCount = logs.length - visibleLogs.length

  return (
    <Card>
      <CardBody>
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex min-w-0 items-center gap-3 text-base font-semibold text-ink">
            <span
              aria-hidden="true"
              className="flex size-9 shrink-0 items-center justify-center rounded-control bg-brand-soft text-brand"
            >
              <ScanLine className="size-4 shrink-0" />
            </span>
            Riwayat Kunjungan
          </h2>
        </div>

        <div className="mt-4">
          {isPending ? (
            <div className="flex min-h-24 items-center justify-center">
              <Spinner label="Memuat riwayat kunjungan…" />
            </div>
          ) : isError ? (
            <EmptyState
              title="Riwayat kunjungan gagal dimuat"
              description="Riwayat check-in/check-out tidak dapat diambil. Periksa koneksi lalu coba lagi."
              action={
                <Button variant="secondary" onClick={onRetry}>
                  Coba Lagi
                </Button>
              }
            />
          ) : logs.length === 0 ? (
            <p className="rounded-control bg-neutral-bg px-4 py-3 text-sm text-neutral-text">
              Belum ada riwayat check-in atau check-out pada kunjungan ini.
            </p>
          ) : (
            <>
              <ol className="flex flex-col gap-2">
                {visibleLogs.map((log) => (
                  <LogRow key={log.id} log={log} onSelect={setSelectedId} />
                ))}
              </ol>
              {hiddenCount > 0 && !hideViewAllLink ? (
                <div className="mt-3">
                  <Link
                    href={`/visits/${visitId}/riwayat`}
                    className="inline-flex min-h-touch items-center justify-center gap-2 rounded-control border border-brand px-4 text-xs font-semibold uppercase tracking-wide text-brand transition duration-150 hover:bg-brand-soft active:bg-brand-soft active:opacity-90"
                  >
                    Lihat Semua ({logs.length})
                  </Link>
                </div>
              ) : null}
            </>
          )}
        </div>
      </CardBody>
      {selected !== null ? (
        <CyclePhotoModal
          visitId={visitId}
          logs={logs}
          log={selected}
          before={before}
          after={after}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </Card>
  )
}
