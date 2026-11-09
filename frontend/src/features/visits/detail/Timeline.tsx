import { Check, X } from 'lucide-react'
import { StatusBadge } from '@/components/ui/Badge'
import type { VisitHistoryEntry, VisitStatus } from '@/lib/api/types'
import { VISIT_STATUS_META } from '@/lib/visits/status-badge'

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

export interface TimelineProps {
  status: VisitStatus
  createdAt: string
  startDate: string
  endDate: string
  /** Stempel gerbang aktual dari GET /visits/{id}; null/absen = belum terjadi. */
  checkInAt?: string | null
  checkOutAt?: string | null
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
 * Murni (pure) agar terkunci oleh unit test.
 */
export function historyDetail(entry: VisitHistoryEntry): string {
  const stamp = formatTanggalWaktu(entry.at)
  if (entry.actor_name === null || entry.actor_name === '') {
    return stamp
  }
  const by =
    entry.actor_role_label !== null && entry.actor_role_label !== ''
      ? `oleh ${entry.actor_name} (${entry.actor_role_label})`
      : `oleh ${entry.actor_name}`
  return `${by} · ${stamp}`
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
}: TimelineProps) {
  const activeIndex = ACTIVE_INDEX_BY_STATUS[status]
  const terminal = TERMINAL_STATUSES.has(status)
  const entries = history ?? []

  const steps: TimelineStep[] = [
    { id: 'requested', label: 'Pengajuan', detail: `Diajukan ${formatTanggalWaktu(createdAt)}` },
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
      detail: gateDetail('Keluar', checkOutAt, endDate),
    },
  ]

  // Status terminal: hanya pengajuan yang pasti terjadi; sisanya tidak diketahui.
  const visibleSteps = terminal ? steps.slice(0, 1) : steps

  return (
    <ol className="relative ml-3 flex flex-col gap-6 border-l-2 border-border-light pl-6">
      {entries.length > 0
        ? entries.map((entry, index) => {
            const label = VISIT_STATUS_META[entry.status].label
            return (
              <li
                key={`${entry.status}-${entry.at}-${index}`}
                className="relative min-w-0"
              >
                <span
                  aria-hidden="true"
                  className={`absolute -left-8 top-0 flex size-4 items-center justify-center rounded-full ${DOT_CLASS.done}`}
                >
                  <Check aria-hidden="true" className="size-3 shrink-0" strokeWidth={3} />
                </span>
                <p className="text-sm font-semibold text-ink">{label}</p>
                <p className="mt-0.5 text-label text-ink-secondary">{historyDetail(entry)}</p>
              </li>
            )
          })
        : visibleSteps.map((step, index) => {
            const state: StepState = terminal
              ? 'done'
              : index < activeIndex
                ? 'done'
                : index === activeIndex
                  ? 'current'
                  : 'future'
            const text = TEXT_CLASS[state]

            return (
              <li
                key={step.id}
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
          })}

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
  )
}
