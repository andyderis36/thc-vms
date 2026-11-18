'use client'

import { useState, type ReactNode } from 'react'
import { Check, X } from 'lucide-react'
import { StatusBadge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import type { VisitHistoryEntry, VisitStatus } from '@/lib/api/types'
import { VISIT_STATUS_META } from '@/lib/visits/status-badge'

/**
 * Batas node riwayat yang dirender inline. Izin multi-entry membuat
 * `history` tumbuh tanpa batas (siklus visiting/offsite berulang); panel
 * SCR-04 dipotong agar tetap terbaca. Dipilih 10 node PERTAMA sesuai urutan
 * existing (tertua -> terbaru, append-only) supaya "Pengajuan" selalu
 * terlihat; sisanya dibuka lewat modal "Lihat Semua".
 */

/**
 * Format timestamp ISO 8601 menjadi tampilan ringkas Bahasa Indonesia.
 * Nilai yang tidak valid dikembalikan apa adanya agar tidak pernah
 * menghasilkan `Invalid Date` di layar petugas pos.
 */
export function formatTanggalWaktu(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return iso
  }
  return date.toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  })
}

type StepState = 'done' | 'current' | 'future'

interface TimelineStep {
  id: string
  label: string
  detail: string
}

/**
 * Status terminal: pengajuan pasti terjadi, tetapi tahap berikutnya tidak
 * pernah dicapai — karena itu hanya tahap pertama yang dirender, lalu
 * ditutup dengan baris "Status akhir".
 */
const TERMINAL_STATUSES: ReadonlySet<VisitStatus> = new Set<VisitStatus>([
  'rejected',
  'cancelled',
  'not_visit',
])

/**
 * Indeks tahap yang SEDANG dijalani kunjungan pada tiap status
 * (requested/rescheduled -> pengajuan, approved -> persetujuan,
 * visiting -> kedatangan, completed -> selesai).
 */
const ACTIVE_INDEX_BY_STATUS: Record<VisitStatus, number> = {
  requested: 0,
  rescheduled: 0,
  approved: 1,
  visiting: 2,
  // Permit masih aktif (tamu di luar lokasi, siap re-entry): tahap aktif
  // tetap kedatangan, sama seperti visiting; langkah timeline tidak berubah.
  offsite: 2,
  completed: 4,
  rejected: 0,
  cancelled: 0,
  not_visit: 0,
}

const DOT_CLASS: Record<StepState, string> = {
  done: 'bg-success-bg text-success-text',
  current: 'bg-brand text-brand-contrast ring-4 ring-brand-soft',
  future: 'bg-border-mid text-ink-muted',
}

const TEXT_CLASS: Record<StepState, { label: string; detail: string }> = {
  done: { label: 'font-semibold text-ink', detail: 'text-ink-secondary' },
  current: { label: 'font-bold text-ink', detail: 'text-ink-secondary' },
  future: { label: 'font-medium text-ink-muted', detail: 'text-ink-muted' },
}

export const TIMELINE_MAX_VISIBLE_NODES = 10

export interface TimelineProps {
  status: VisitStatus
  createdAt: string
  startDate: string
  endDate: string
  /** Stempel gerbang aktual dari GET /visits/{id}; null/absen = belum terjadi. */
  checkInAt?: string | null
  checkOutAt?: string | null
  /**
   * Nama tampilan pengaju (`VisitDetail.created_by_name`) untuk keterangan
   * node Pengajuan ("Diajukan oleh <nama> · <stempel>"). Null/absen =
   * fallback ke "Diajukan <stempel>" agar panel daftar tanpa enrichmen
   * tidak pernah mencetak nama kosong.
   */
  createdByName?: string | null
  /** Alasan status akhir (`status_note`); hanya tampil pada status terminal. */
  statusNote?: string | null
  /**
   * Jejak status berpelaku dari `VisitDetail.history` (urut tertua ->
   * terbaru). Bila berisi, panel merender baris riwayat ini; kosong/absen
   * (item daftar, kunjungan tanpa riwayat) = fallback ke langkah turunan.
   */
  history?: VisitHistoryEntry[] | null
}

/**
 * Satu baris teks riwayat: `oleh <nama> (<peran>) · <stempel>` untuk
 * transisi berpelaku, dan hanya stempelnya untuk transisi sistem
 * (`actor_name` null) sehingga klause "oleh" tidak pernah mengarang aktor.
 * Klause peran dilewati bila nama sudah membawanya — data seed menaruh
 * "Hendra Wijaya (Super Admin)" di kolom nama, sehingga tanpa dedupe ini
 * layar mencetak peran dua kali. Murni (pure) agar terkunci oleh unit test.
 */
export function historyDetail(entry: VisitHistoryEntry): string {
  const stamp = formatTanggalWaktu(entry.at)
  if (entry.actor_name === null || entry.actor_name === '') {
    return stamp
  }
  const roleLabel = entry.actor_role_label ?? ''
  const by =
    roleLabel !== '' && !roleAlreadyInName(entry.actor_name, roleLabel)
      ? `oleh ${entry.actor_name} (${roleLabel})`
      : `oleh ${entry.actor_name}`
  return `${by} · ${stamp}`
}

/**
 * Keterangan node gerbang (check-in/out): sama seperti `historyDetail`,
 * tetapi klause pelaku memakai prefix "diverifikasi oleh" — penegasan bahwa
 * stempel dicatat pengawas di gerbang, bukan aksi tamu. Tanpa pelaku
 * (transisi sistem) dikembalikan apa adanya (hanya stempel). Murni (pure)
 * agar terkunci oleh unit test.
 */
export function verifiedGateDetail(entry: VisitHistoryEntry): string {
  const base = historyDetail(entry)
  return base.replace(/^oleh /, 'diverifikasi oleh ')
}

/**
 * True bila `<nama>` sudah diakhiri tanda kurung yang isinya sama dengan
 * label peran (perbandingan tanpa spasi & huruf besar-kecil), mis.
 * "Hendra Wijaya (Super Admin)" vs label "Superadmin".
 */
function roleAlreadyInName(name: string, roleLabel: string): boolean {
  const match = name.match(/\(([^()]*)\)\s*$/)
  if (match === null) {
    return false
  }
  const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, '')
  return normalize(match[1] ?? '') === normalize(roleLabel)
}

/**
 * Satu baris teks tahap gerbang dalam Bahasa Indonesia: stempel aktual
 * (`Masuk 26 Sep 2026, 14.30`) bila gerbang sudah dilewati, jika tidak teks
 * jadwal (`Jadwal mulai …`). Murni (pure) agar terkunci oleh unit test.
 */
export function gateDetail(
  action: 'Masuk' | 'Keluar',
  at: string | null | undefined,
  scheduleIso: string,
): string {
  if (at !== null && at !== undefined && at !== '') {
    return `${action} ${formatTanggalWaktu(at)}`
  }
  const scheduleWord = action === 'Masuk' ? 'mulai' : 'selesai'
  return `Jadwal ${scheduleWord} ${formatTanggalWaktu(scheduleIso)}`
}

/**
 * Panel Riwayat Status (timeline vertikal) untuk SCR-04.
 *
 * Tahap kedatangan/selesai memakai stempel gerbang aktual (`check_in_at` /
 * `check_out_at` dari VisitDetail) bila ada, jika tidak mundur ke teks jadwal —
 * sehingga teknisi melihat "Masuk 26 Sep 2026, 14.30" persis seperti yang
 * dicatat pengawas di gerbang (QA GATE-01/02/09).
 */
export function Timeline({
  status,
  createdAt,
  startDate,
  endDate,
  checkInAt,
  checkOutAt,
  statusNote,
  history,
  createdByName,
}: TimelineProps) {
  const [fullOpen, setFullOpen] = useState(false)
  const activeIndex = ACTIVE_INDEX_BY_STATUS[status]
  const terminal = TERMINAL_STATUSES.has(status)
  const entries = history ?? []
  const hasRequestedEntry = entries.some((entry) => entry.status === 'requested')
  // Backend hanya mencatat status_history saat transisi, bukan saat
  // pembuatan — riwayat produksi tak pernah berisi `requested`. Tanpa
  // penambalan ini panel menyusut saat kunjungan disetujui; riwayat harus
  // append-only. Riwayat kosong = fallback langkah turunan sudah
  // menampilkan Pengajuan, jadi tak perlu ditambal.
  const showSyntheticRequest = entries.length > 0 && !hasRequestedEntry

  const requestedStep: TimelineStep = {
    id: 'requested',
    label: 'Pengajuan',
    detail:
      createdByName !== null && createdByName !== undefined && createdByName !== ''
        ? `Diajukan oleh ${createdByName} · ${formatTanggalWaktu(createdAt)}`
        : `Diajukan ${formatTanggalWaktu(createdAt)}`,
  }
  const steps: TimelineStep[] = [
    requestedStep,
    {
      id: 'approved',
      label: 'Persetujuan',
      detail: activeIndex >= 1 ? 'Disetujui oleh admin' : 'Menunggu persetujuan',
    },
    {
      id: 'visiting',
      label: 'Kedatangan di Lokasi',
      detail: gateDetail('Masuk', checkInAt, startDate),
    },
    {
      id: 'completed',
      label: 'Selesai',
      // Selama permit masih aktif (visiting/offsite) jangan tampilkan jam
      // check-out pertama sebagai "Keluar <jam>" pada node Selesai — itu
      // membingungkan karena Selesai belum terjadi; tampilkan jadwal. Hanya
      // setelah benar-benar completed baru tampilkan stempel aktual.
      detail:
        status === 'completed'
          ? gateDetail('Keluar', checkOutAt, endDate)
          : `Jadwal selesai ${formatTanggalWaktu(endDate)}`,
    },
  ]

  // Status terminal: hanya pengajuan yang pasti terjadi; sisanya tidak diketahui.
  const visibleSteps = terminal ? steps.slice(0, 1) : steps
  // Status non-terminal dengan riwayat: tahap yang sudah tercatat di riwayat
  // diwakili baris riwayatnya sendiri; tahap yang belum tercatat (termasuk
  // tahap aktif yang riwayatnya belum masuk) dirender sebagai langkah.
  // `requested` yang belum tercatat diwakili baris Pengajuan sintetis, jadi
  // tidak digandakan di sini.
  // Izin multi-entry ringkas: node gerbang (Sedang/Di Luar) hanya relevan
  // bila tamu sudah pernah check-in — ditandai entri `visiting` di riwayat
  // atau stempel `checkInAt`. Belum check-in = belum ada log gerbang, panel
  // berhenti di Disetujui; sudah check-in = Sedang saja; sudah check-out
  // (offsite/completed) = Sedang + Di Luar sesuai riwayat.
  const hasCheckIn =
    entries.some((entry) => entry.status === 'visiting') ||
    (checkInAt !== null && checkInAt !== undefined && checkInAt !== '')
  const shownEntries = hasCheckIn
    ? entries
    : entries.filter((entry) => entry.status !== 'visiting' && entry.status !== 'offsite')
  const historyStatuses = new Set(shownEntries.map((entry) => entry.status))
  const futureSteps = steps.filter((step, index) => {
    if (index < activeIndex) return false
    if (historyStatuses.has(step.id as VisitStatus)) return false
    if (step.id === 'requested' && showSyntheticRequest) return false
    // Belum check-in: tahap gerbang (Kedatangan/Selesai) disembunyikan agar
    // panel berhenti di Disetujui; jadwal lengkap tetap di panel Informasi.
    if (!hasCheckIn && (step.id === 'visiting' || step.id === 'completed')) return false
    return true
  })

  function renderStepRow(step: TimelineStep, key: string, state: StepState) {
    const text = TEXT_CLASS[state]
    return (
      <li
        key={key}
        aria-current={state === 'current' ? 'step' : undefined}
        className="relative min-w-0"
      >
        <span
          aria-hidden="true"
          className={`absolute -left-8 top-0 flex size-4 items-center justify-center rounded-full ${DOT_CLASS[state]}`}
        >
          {state === 'done' && (
            <Check aria-hidden="true" className="size-3 shrink-0" strokeWidth={3} />
          )}
        </span>
        <p className={`text-sm ${text.label}`}>{step.label}</p>
        <p className={`mt-0.5 text-label ${text.detail}`}>{step.detail}</p>
      </li>
    )
  }

  function renderEntryRow(entry: VisitHistoryEntry, index: number) {
    const isGate = entry.status === 'visiting' || entry.status === 'offsite'
    // Node gerbang ringkas: tanpa prefix "Check-out — ".
    const label =
      entry.status === 'offsite' ? 'Di Luar Lokasi' : VISIT_STATUS_META[entry.status].label
    const detail = isGate ? verifiedGateDetail(entry) : historyDetail(entry)
    return (
      <li key={`${entry.status}-${entry.at}-${index}`} className="relative min-w-0">
        <span
          aria-hidden="true"
          className={`absolute -left-8 top-0 flex size-4 items-center justify-center rounded-full ${DOT_CLASS.done}`}
        >
          <Check aria-hidden="true" className="size-3 shrink-0" strokeWidth={3} />
        </span>
        <p className="text-sm font-semibold text-ink">{label}</p>
        <p className="mt-0.5 text-label text-ink-secondary">{detail}</p>
      </li>
    )
  }

  // Baris Pengajuan sintetis: teksnya identik dengan langkah turunan
  // ("Pengajuan" + "Diajukan …") agar panel terlihat sama sebelum dan
  // sesudah riwayat pertama tercatat.
  function renderSyntheticRequestRow() {
    return renderStepRow(requestedStep, 'requested-synthetic', 'done')
  }

  // Daftar node riwayat penuh sesuai urutan existing (tertua -> terbaru).
  // `null` = mode fallback langkah turunan (tanpa history, <= 4 langkah,
  // tak perlu dipotong). Baris "Status akhir" adalah penutup struktural dan
  // selalu dirender di luar cap.
  let historyNodes: ReactNode[] | null = null
  if (terminal) {
    if (entries.length > 0) {
      historyNodes = [
        ...(showSyntheticRequest ? [renderSyntheticRequestRow()] : []),
        ...shownEntries.map((entry, index) => renderEntryRow(entry, index)),
      ]
    }
  } else if (entries.length > 0) {
    historyNodes = [
      ...(showSyntheticRequest ? [renderSyntheticRequestRow()] : []),
      ...shownEntries.map((entry, index) => renderEntryRow(entry, index)),
      ...futureSteps.map((step) => renderStepRow(step, `future-${step.id}`, 'future')),
    ]
  }
  const visibleNodes =
    historyNodes === null
      ? null
      : historyNodes.slice(0, TIMELINE_MAX_VISIBLE_NODES)
  const hiddenCount =
    historyNodes === null ? 0 : historyNodes.length - (visibleNodes?.length ?? 0)

  return (
    <>
      <ol className="relative ml-3 flex flex-col gap-6 border-l-2 border-border-light pl-6">
        {visibleNodes !== null ? (
          visibleNodes
        ) : (
          <>
            {terminal
              ? visibleSteps.map((step) => renderStepRow(step, step.id, 'done'))
              : visibleSteps.map((step, index) => {
                  const state: StepState =
                    index < activeIndex
                      ? 'done'
                      : index === activeIndex
                        ? 'current'
                        : 'future'
                  return renderStepRow(step, step.id, state)
                })}
          </>
        )}

        {terminal && (
          <li className="relative min-w-0">
            <span
              aria-hidden="true"
              className="absolute -left-8 top-0 flex size-4 items-center justify-center rounded-full bg-neutral-bg text-neutral-text"
            >
              <X aria-hidden="true" className="size-3 shrink-0" strokeWidth={3} />
            </span>
            <p className="text-sm font-bold text-ink">Status akhir</p>
            <div className="mt-1">
              <StatusBadge status={status} />
            </div>
            {statusNote != null && statusNote.trim() !== '' && (
              <p className="mt-1 break-words text-label text-ink-secondary">{statusNote}</p>
            )}
          </li>
        )}
      </ol>

      {hiddenCount > 0 && historyNodes !== null ? (
        <div className="mt-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="min-h-touch"
            onClick={() => setFullOpen(true)}
          >
            Lihat Semua ({historyNodes.length})
          </Button>
        </div>
      ) : null}

      <Modal
        open={fullOpen && historyNodes !== null}
        onClose={() => setFullOpen(false)}
        title="Riwayat Status Lengkap"
        size="lg"
      >
        <ol className="relative ml-3 flex flex-col gap-6 border-l-2 border-border-light pl-6">
          {historyNodes}
        </ol>
      </Modal>
    </>
  )
}
