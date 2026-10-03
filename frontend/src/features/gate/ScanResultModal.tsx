'use client'

import { Users } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { VisitSummary } from '@/features/visits/components/ApproveModal'
import { VisitorPhoto } from '@/features/visits/detail/VisitorPhoto'
import type { VisitDetail } from '@/lib/api/types'

export interface ScanResultModalProps {
  visit: VisitDetail | null
  open: boolean
  pending: boolean
  /** Galat konfirmasi check-in/out terakhir — ditampilkan di dalam modal. */
  error?: string | null
  onClose: () => void
  onConfirm: () => void
}

/**
 * Popup hasil pindaian QR gerbang (SCR-05): Vendor/Mitra + tim teknisi beserta
 * perusahaan per teknisi, foto KTP & selfie. Keduanya diberi caption terlihat
 * ("Foto KTP" / "Foto selfie") agar pengawas tahu mana yang mana. Foto yang
 * null tampil sebagai teks pengganti berbahasa Indonesia — tidak pernah
 * merusak layout.
 *
 * Galat konfirmasi (`error`) dirender sebagai `role="alert"` di bagian atas
 * isi modal, dan tombol "Tutup" dinonaktifkan selama mutasi berjalan
 * (`pending`) sehingga hasil tidak tertutup sebelum proses selesai.
 */
export function ScanResultModal({
  visit,
  open,
  pending,
  error = null,
  onClose,
  onConfirm,
}: ScanResultModalProps) {
  if (visit === null) return null

  const canCheckIn = visit.status === 'approved'
  const canCheckOut = visit.status === 'visiting'
  const confirmLabel = canCheckIn
    ? 'Check-in Masuk'
    : canCheckOut
      ? 'Check-out Keluar'
      : null

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Hasil Pindaian — ${visit.visit_id}`}
      size="lg"
      footer={
        <>
          <Button
            variant="ghost"
            className="min-h-touch"
            disabled={pending}
            onClick={onClose}
          >
            Tutup
          </Button>
          {confirmLabel !== null ? (
            <Button
              variant={canCheckOut ? 'danger' : 'success'}
              className="min-h-touch"
              loading={pending}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
          ) : null}
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

      <VisitSummary visit={visit} hideVendor />

      <p className="text-label font-semibold text-ink">
        Vendor/Mitra: {visit.pic_user.name}
      </p>

      <h3 className="mt-4 flex items-center gap-2 text-label font-semibold text-ink">
        <Users aria-hidden="true" className="size-4 shrink-0 text-brand" />
        {`Tim Teknisi (${visit.visitors.length} orang)`}
      </h3>
      {visit.visitors.length > 0 ? (
        <ul className="mt-2 flex max-h-72 flex-col gap-3 overflow-y-auto">
          {visit.visitors.map((visitor, index) => {
            const ktpUrl = visitor.id_card_photo_url ?? null
            const selfieUrl = visitor.photo_url ?? null
            return (
              <li
                key={`${index}-${visitor.id_number}`}
                className="flex items-start gap-3 rounded-control border border-border-light p-3"
              >
                <VisitorPhoto
                  src={selfieUrl}
                  visitorName={visitor.name}
                  variant="selfie"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-ink">
                    {visitor.name}
                  </p>
                  <p className="text-label text-ink-secondary">
                    {`No. Identitas: ${visitor.id_number}`}
                  </p>
                  <p className="text-label text-ink-secondary">
                    {`Perusahaan: ${(visitor.vendor_name ?? '').trim() !== '' ? visitor.vendor_name : '—'}`}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    {ktpUrl !== null && ktpUrl !== '' ? (
                      <VisitorPhoto
                        src={ktpUrl}
                        visitorName={visitor.name}
                        variant="ktp"
                      />
                    ) : (
                      <span className="text-badge text-ink-muted">
                        Foto KTP tidak tersedia
                      </span>
                    )}
                    {selfieUrl === null || selfieUrl === '' ? (
                      <span className="text-badge text-ink-muted">
                        Selfie tidak tersedia
                      </span>
                    ) : null}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="mt-2 rounded-control bg-neutral-bg px-4 py-3 text-sm text-neutral-text">
          Belum ada data teknisi pada kunjungan ini.
        </p>
      )}
    </Modal>
  )
}
