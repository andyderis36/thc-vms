'use client'

import { LogIn, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { VisitFilePhoto } from '@/features/visits/detail/VisitFilePhoto'
import { VisitorPhoto } from '@/features/visits/detail/VisitorPhoto'
import type { VisitDetail } from '@/lib/api/types'
import { visitVendorUser } from '@/lib/visits/vendor-user'
import { confirmScanMessage, type GateDirection } from '@/lib/visits/gate-status'

export interface ScanConfirmModalProps {
  visit: VisitDetail | null
  direction: GateDirection
  open: boolean
  pending: boolean
  error: string | null
  onClose: () => void
  onConfirm: () => void
}

/**
 * Konfirmasi gerbang SCR-05. Pertanyaan memakai arah yang sudah diputuskan
 * halaman (`confirmScanMessage`), bukan status mentah — sehingga QR yang sama
 * tidak pernah salah menyebut "check-in" saat petugas akan check-out.
 *
 * Modal hanya ditutup oleh pemanggil setelah mutasi sukses. Galat disimpan
 * di dalam modal (`role="alert"`) dan tombol Tutup/Escape dikunci saat
 * `pending` agar hasil tidak tertutup sebelum selesai.
 */
export function ScanConfirmModal({
  visit,
  direction,
  open,
  pending,
  error,
  onClose,
  onConfirm,
}: ScanConfirmModalProps) {
  if (visit === null) return null

  const isIn = direction === 'in'
  const close = (): void => {
    if (!pending) onClose()
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={`Konfirmasi gerbang — ${visit.visit_id}`}
      size="lg"
      footer={
        <>
          <Button variant="ghost" className="min-h-touch" disabled={pending} onClick={close}>
            Batal
          </Button>
          <Button
            variant={isIn ? 'success' : 'danger'}
            className="min-h-touch"
            loading={pending}
            onClick={onConfirm}
          >
            {isIn ? (
              <LogIn aria-hidden="true" className="size-4 shrink-0" />
            ) : (
              <LogOut aria-hidden="true" className="size-4 shrink-0" />
            )}
            {isIn ? 'Ya, Catat check-in' : 'Ya, Catat check-out'}
          </Button>
        </>
      }
    >
      {error !== null ? (
        <p
          role="alert"
          className="mb-4 rounded-control bg-danger-bg px-3 py-2 text-sm font-semibold text-danger-text"
        >
          {error}
        </p>
      ) : null}

      <p className="text-base font-bold text-ink">{confirmScanMessage(direction)}</p>
      <p className="mt-1 text-label text-ink-secondary">
        {visit.visit_id} · {visitVendorUser(visit)?.name ?? '—'} · {visit.location.name}
      </p>

      <h3 className="mt-4 text-label font-semibold text-ink">
        {`Tim Teknisi (${visit.visitors.length} orang)`}
      </h3>
      {visit.visitors.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-2">
          {visit.visitors.map((visitor, index) => (
            <li
              key={`${index}-${visitor.id_number}`}
              className="flex items-center gap-3 rounded-control bg-neutral-bg/70 p-2"
            >
              {visitor.photo_url ? (
                <VisitFilePhoto visitId={visit.id} visitor={visitor} variant="selfie" />
              ) : (
                <VisitorPhoto src={null} visitorName={visitor.name} variant="selfie" />
              )}
              <span className="min-w-0 truncate text-sm font-semibold text-ink">
                {visitor.name}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 rounded-control bg-neutral-bg px-3 py-2 text-sm text-neutral-text">
          Belum ada data teknisi pada kunjungan ini.
        </p>
      )}
    </Modal>
  )
}
