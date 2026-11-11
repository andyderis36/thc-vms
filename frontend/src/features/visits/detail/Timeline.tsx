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
}: TimelineProps) {
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
    detail: `Diajukan ${formatTanggalWaktu(createdAt)}`,
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
      detail: gateDetail('Keluar', checkOutAt, endDate),
    },
  ]

  // Status terminal: hanya pengajuan yang pasti terjadi; sisanya tidak diketahui.
  const visibleSteps = terminal ? steps.slice(0, 1) : steps
  // Status non-terminal dengan riwayat: tahap yang sudah tercatat di riwayat
  // diwakili baris riwayatnya sendiri; tahap yang belum tercatat (termasuk
  // tahap aktif yang riwayatnya belum masuk) dirender sebagai langkah.
  // `requested` yang belum tercatat diwakili baris Pengajuan sintetis, jadi
  // tidak digandakan di sini.
  const historyStatuses = new Set(entries.map((entry) => entry.status))
  const futureSteps = steps.filter((step, index) => {
    if (index < activeIndex) return false
    if (historyStatuses.has(step.id as VisitStatus)) return false
    if (step.id === 'requested' && showSyntheticRequest) return false
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
    const label = VISIT_STATUS_META[entry.status].label
    return (
      <li key={`${entry.status}-${entry.at}-${index}`} className="relative min-w-0">
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
  }

  // Baris Pengajuan sintetis: teksnya identik dengan langkah turunan
  // ("Pengajuan" + "Diajukan …") agar panel terlihat sama sebelum dan
  // sesudah riwayat pertama tercatat.
  function renderSyntheticRequestRow() {
    return renderStepRow(requestedStep, 'requested-synthetic', 'done')
  }

  return (
    <ol className="relative ml-3 flex flex-col gap-6 border-l-2 border-border-light pl-6">
      {terminal ? (
        <>
          {entries.length > 0 ? (
            <>
              {showSyntheticRequest && renderSyntheticRequestRow()}
              {entries.map((entry, index) => renderEntryRow(entry, index))}
            </>
          ) : (
            visibleSteps.map((step) => renderStepRow(step, step.id, 'done'))
          )}
        </>
      ) : entries.length > 0 ? (
        <>
          {showSyntheticRequest && renderSyntheticRequestRow()}
          {entries.map((entry, index) => renderEntryRow(entry, index))}
          {futureSteps.map((step) => renderStepRow(step, `future-${step.id}`, 'future'))}
        </>
      ) : (
        visibleSteps.map((step, index) => {
          const state: StepState =
            index < activeIndex ? 'done' : index === activeIndex ? 'current' : 'future'
          return renderStepRow(step, step.id, state)
        })
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
  )
}
