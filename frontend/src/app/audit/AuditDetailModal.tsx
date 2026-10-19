'use client'

import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { formatTanggalWaktu } from '@/features/visits/detail/Timeline'
import type { AuditLog } from '@/lib/api/types'
import { auditActionLabel, auditActorLabel, auditEntityLabel } from './page'

// ---------------------------------------------------------------------------
// Helper murni (diekspor agar dapat diuji unit — lihat tests/audit-logs.test.ts)
// ---------------------------------------------------------------------------

/** Satu baris label→nilai pada daftar detail jejak audit. */
export interface AuditDetailRow {
  label: string
  value: string
  /** `true` = nilai panjang (kode aksi, UUID, user-agent) → wajib `wrap-anywhere`. */
  wrap?: boolean
}

export interface AuditDetail {
  /** Baris tetap: Waktu, Pelaku, Aksi, …, User Agent. */
  rows: AuditDetailRow[]
  /** Pasangan kunci→nilai metadata; kosong = renderer menampilkan strip. */
  metadata: Array<{ key: string; value: string }>
}

/**
 * Membangun model tampilan detail dari record yang SUDAH dimuat — tanpa fetch
 * tambahan, karena `GET /audit-logs` sudah mengembalikan baris penuh
 * (kontrak `AuditLog`, openapi §475). Label memakai helper halaman yang sama
 * dengan tabel/kartu agar konsisten satu sumber.
 */
export function auditDetail(
  log: AuditLog,
  usersById: ReadonlyMap<string, string>,
): AuditDetail {
  return {
    rows: [
      { label: 'Waktu', value: formatTanggalWaktu(log.timestamp) },
      { label: 'Pelaku', value: auditActorLabel(log.user_id, usersById) },
      { label: 'Aksi', value: auditActionLabel(log.action) },
      { label: 'Kode aksi', value: log.action, wrap: true },
      { label: 'Entitas', value: auditEntityLabel(log.entity) },
      { label: 'ID Entitas', value: log.entity_id ?? '—', wrap: true },
      { label: 'Alamat IP', value: log.ip !== '' ? log.ip : '—' },
      {
        label: 'User Agent',
        value: log.user_agent !== '' ? log.user_agent : '—',
        wrap: true,
      },
    ],
    metadata: Object.entries(log.metadata).map(([key, value]) => ({ key, value })),
  }
}

// ---------------------------------------------------------------------------
// Modal detail — komponen presentasional; state pemilihan baris diangkat ke
// halaman (`selectedLog`) sehingga tabel dan kartu berbagi satu modal.
// ---------------------------------------------------------------------------

export interface AuditDetailModalProps {
  /** Record terpilih; `null` = modal tertutup. */
  log: AuditLog | null
  usersById: ReadonlyMap<string, string>
  onClose: () => void
}

/**
 * Baris `<dt>/<dd>` mengikuti pola `InfoRow` di halaman detail kunjungan:
 * label tetap di kiri (sm+) dan nilai melipat ke bawah di ponsel.
 * Dipisah agar anatomy detail tidak bergantung pada ekspor halaman lain.
 */
function DetailRow({ row }: { row: AuditDetailRow }) {
  return (
    <div className="flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:gap-4">
      <dt className="shrink-0 text-label font-semibold text-ink-secondary sm:w-44">
        {row.label}
      </dt>
      <dd
        className={`min-w-0 flex-1 break-words text-sm text-ink ${
          row.wrap === true ? 'wrap-anywhere' : ''
        }`}
      >
        {row.value}
      </dd>
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
        <>
          <dl className="divide-y divide-border-light">
            {detail.rows.map((row) => (
              <DetailRow key={row.label} row={row} />
            ))}
          </dl>

          {/*
            Metadata dirender per entri (bukan ringkasan `auditMetadataSummary`)
            agar tiap kunci→nilai terbaca utuh. Wadah TIDAK pernah kosong:
            entri nol = strip sebagai isi satu-satunya baris.
          */}
          <section className="mt-5 overflow-hidden rounded-control border border-border-light">
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
        </>
      ) : null}
    </Modal>
  )
}
