'use client'

import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { formatTanggalWaktu } from '@/features/visits/detail/Timeline'
import { Copy } from 'lucide-react'
import type { AuditLog } from '@/lib/api/types'
import { toast } from 'sonner'
import { auditActionLabel, auditActorLabel, auditEntityLabel } from './page'

// ---------------------------------------------------------------------------
// Helper murni (diekspor agar dapat diuji unit — lihat tests/audit-logs.test.ts)
// ---------------------------------------------------------------------------

/** Identitas pelaku yang tersedia untuk tabel, kartu, dan modal detail. */
export interface AuditActorInfo {
  name: string
  email: string | null
}

/** Satu baris label→nilai pada daftar detail jejak audit. */
export interface AuditDetailRow {
  label: string
  value: string
  /** `true` = nilai panjang (kode aksi, UUID, user-agent) → wajib `wrap-anywhere`. */
  wrap?: boolean
  /** `true` = nilai penanda unik yang nantinya boleh disalin operator. */
  copyable?: boolean
}

/** Kelompok baris detail: Aksi, Aktor, Entitas, Konteks. */
export interface AuditDetailSection {
  title: string
  rows: AuditDetailRow[]
}

export interface AuditDetail {
  sections: AuditDetailSection[]
  /** Semua baris dari `sections`, berurutan — dipakai pencarian/uji cepat. */
  rows: AuditDetailRow[]
  /** Pasangan kunci→nilai metadata; kosong = renderer menampilkan strip. */
  metadata: Array<{ key: string; value: string }>
}

/**
 * Waktu relatif singkat untuk jejak audit: detik, menit, jam, lalu hari.
 * Di luar 7 hari (atau stempel waktu rusak/di masa depan) memakai format
 * absolut yang sama dengan tabel agar tidak menyesatkan.
 */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) return formatTanggalWaktu(iso)
  const diffMs = now - timestamp
  if (diffMs < 0) return formatTanggalWaktu(iso)
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return 'baru saja'
  if (minutes < 60) return `${minutes} menit lalu`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} jam lalu`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} hari lalu`
  return formatTanggalWaktu(iso)
}

/** Email pelaku dari peta user; baris sistem/user terhapus/tanpa email = strip. */
export function auditActorEmail(
  userId: string | null,
  usersById: ReadonlyMap<string, AuditActorInfo>,
): string {
  if (userId === null) return '—'
  const email = usersById.get(userId)?.email
  return email !== undefined && email !== null && email !== '' ? email : '—'
}

/**
 * Membangun model tampilan detail dari record yang SUDAH dimuat — tanpa fetch
 * tambahan, karena `GET /audit-logs` sudah mengembalikan baris penuh
 * (kontrak `AuditLog`, openapi §571). Label memakai helper halaman yang sama
 * dengan tabel/kartu agar konsisten satu sumber.
 *
 * `id` dan `user_id` mentah ikut ditampilkan karena baris audit tidak membawa
 * foto profil; UUID adalah satu-satunya penanda yang bisa dicocokkan operator
 * dengan basis data saat menelusuri insiden.
 */
export function auditDetail(
  log: AuditLog,
  usersById: ReadonlyMap<string, AuditActorInfo>,
): AuditDetail {
  const sections: AuditDetailSection[] = [
    {
      title: 'Aksi',
      rows: [
        { label: 'Aksi', value: auditActionLabel(log.action) },
        { label: 'Kode aksi', value: log.action, wrap: true },
      ],
    },
    {
      title: 'Aktor',
      rows: [
        { label: 'Pelaku', value: auditActorLabel(log.user_id, usersById) },
        { label: 'ID Pelaku', value: log.user_id ?? '—', wrap: true, copyable: true },
        { label: 'Email Pelaku', value: auditActorEmail(log.user_id, usersById), wrap: true },
      ],
    },
    {
      title: 'Entitas',
      rows: [
        { label: 'Entitas', value: auditEntityLabel(log.entity) },
        { label: 'ID Entitas', value: log.entity_id ?? '—', wrap: true },
      ],
    },
    {
      title: 'Konteks',
      rows: [
        { label: 'Waktu', value: formatTanggalWaktu(log.timestamp) },
        { label: 'Waktu relatif', value: formatRelativeTime(log.timestamp) },
        { label: 'Alamat IP', value: log.ip !== '' ? log.ip : '—' },
        {
          label: 'User Agent',
          value: log.user_agent !== '' ? log.user_agent : '—',
          wrap: true,
        },
        { label: 'ID Jejak', value: log.id, wrap: true, copyable: true },
      ],
    },
  ]

  return {
    sections,
    rows: sections.flatMap((section) => section.rows),
    // Backend mengirim `null` bila metadata kosong (DTO tanpa literal `{}`),
    // jadi jangan andalkan field ini selalu berupa objek.
    metadata: Object.entries(log.metadata ?? {}).map(([key, value]) => ({ key, value })),
  }
}

// ---------------------------------------------------------------------------
// Modal detail — komponen presentasional; state pemilihan baris diangkat ke
// halaman (`selectedLog`) sehingga tabel dan kartu berbagi satu modal.
// ---------------------------------------------------------------------------

export interface AuditDetailModalProps {
  /** Record terpilih; `null` = modal tertutup. */
  log: AuditLog | null
  usersById: ReadonlyMap<string, AuditActorInfo>
  onClose: () => void
}

/**
 * Hanya baris ID (ID Pelaku, ID Jejak) yang copyable — itu penanda unik yang
 * dicocokkan operator dengan basis data saat menelusuri insiden. Field teks
 * bebas (kode aksi, user-agent, metadata) tidak diberi tombol salin karena
 * isinya sudah terbaca langsung dan bisa sangat panjang.
 */
async function copyToClipboard(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value)
    toast.success('Disalin ke papan klip')
  } catch {
    toast.error('Gagal menyalin. Silakan salin manual.')
  }
}

/**
 * Baris `<dt>/<dd>` mengikuti pola `InfoRow` di halaman detail kunjungan:
 * label tetap di kiri (sm+) dan nilai melipat ke bawah di ponsel.
 * Dipisah agar anatomy detail tidak bergantung pada ekspor halaman lain.
 */
function DetailRow({ row }: { row: AuditDetailRow }) {
  const canCopy = row.copyable === true && row.value !== '—'
  return (
    <div className="flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:gap-4">
      <dt className="shrink-0 text-label font-semibold text-ink-secondary sm:w-44">
        {row.label}
      </dt>
      {canCopy ? (
        <dd className="flex min-w-0 flex-1 items-baseline gap-2 text-sm text-ink">
          <span className="min-w-0 flex-1 break-all">{row.value}</span>
          <button
            type="button"
            aria-label={`Salin ${row.label}`}
            title="Salin"
            className="relative inline-flex size-8 shrink-0 items-center justify-center rounded-control text-ink-muted transition-colors hover:bg-brand/5 hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand before:absolute before:-inset-1.5 before:content-['']"
            onClick={() => void copyToClipboard(row.value)}
          >
            <Copy aria-hidden="true" className="size-3.5" />
          </button>
        </dd>
      ) : (
        <dd
          className={`min-w-0 flex-1 break-words text-sm text-ink ${
            row.wrap === true ? 'wrap-anywhere' : ''
          }`}
        >
          {row.value}
        </dd>
      )}
    </div>
  )
}

export function AuditDetailModal({ log, usersById, onClose }: AuditDetailModalProps) {
  const detail = log !== null ? auditDetail(log, usersById) : null
  const title =
    log !== null ? `Detail Jejak Audit — ${auditActionLabel(log.action)}` : 'Detail Jejak Audit'

  return (
    <Modal
      open={log !== null}
      onClose={onClose}
      title={title}
      size="lg"
      footer={
        <Button variant="secondary" className="min-h-touch" onClick={onClose}>
          Tutup
        </Button>
      }
    >
      {detail !== null ? (
        <div className="flex flex-col gap-4">
          {detail.sections.map((section) => (
            <section
              key={section.title}
              className="overflow-hidden rounded-control border border-border-light"
            >
              <h3 className="bg-brand/5 px-3 py-2 text-xs font-semibold text-ink-secondary">
                {section.title}
              </h3>
              <dl className="divide-y divide-border-light px-3">
                {section.rows.map((row) => (
                  <DetailRow key={row.label} row={row} />
                ))}
              </dl>
            </section>
          ))}

          {/*
            Metadata dirender per entri (bukan ringkasan `auditMetadataSummary`)
            agar tiap kunci→nilai terbaca utuh. Wadah TIDAK pernah kosong:
            entri nol = strip sebagai isi satu-satunya baris.
          */}
          <section className="overflow-hidden rounded-control border border-border-light">
            <h3 className="bg-brand/5 px-3 py-2 text-xs font-semibold text-ink-secondary">
              Metadata
            </h3>
            {detail.metadata.length > 0 ? (
              <dl className="divide-y divide-border-light">
                {detail.metadata.map((entry) => (
                  <div
                    key={entry.key}
                    className="flex flex-col gap-1 px-3 py-3 sm:flex-row sm:items-baseline sm:gap-4"
                  >
                    <dt className="shrink-0 text-label font-semibold text-ink-secondary wrap-anywhere sm:w-44">
                      {entry.key}
                    </dt>
                    <dd className="min-w-0 flex-1 break-words text-sm text-ink wrap-anywhere">
                      {entry.value}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="px-3 py-3 text-sm text-ink-muted">—</p>
            )}
          </section>
        </div>
      ) : null}
    </Modal>
  )
}
