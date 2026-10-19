'use client'

import { FileText, Users } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { VisitSummary } from '@/features/visits/components/ApproveModal'
import { SpkFileLink } from '@/features/visits/components/SpkFileLink'
import { VisitorPhoto } from '@/features/visits/detail/VisitorPhoto'
import { VisitFilePhoto } from '@/features/visits/detail/VisitFilePhoto'
import type { VisitDetail } from '@/lib/api/types'
import { visitVendorUser } from '@/lib/visits/vendor-user'

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

      {/*
        CTA "Lihat SPK" — hanya bila berkas Surat Tugas tersedia
        (guard sama dengan VisitTable/VisitCards). Selama berkas dimuat,
        SpkFileLink menampilkan fallback netral "—".
      */}
      {visit.assignment_letter_url ? (
        <p className="mb-4 flex items-center gap-2">
          <FileText aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
          <SpkFileLink
            visitId={visit.id}
            className="inline-flex min-h-touch items-center text-sm font-medium text-brand underline underline-offset-2 hover:text-brand-dark"
            ariaLabel={`Lihat surat tugas SPK kunjungan ${visit.visit_id}`}
            fallback={<span className="text-xs sm:text-sm text-ink-muted">—</span>}
          >
            Lihat SPK
          </SpkFileLink>
        </p>
      ) : null}

      <p className="text-label font-semibold text-ink">
        Vendor/Mitra: {visitVendorUser(visit)?.name}
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
                {selfieUrl !== null && selfieUrl !== '' ? (
                  <VisitFilePhoto
                    visitId={visit.id}
                    visitor={visitor}
                    variant="selfie"
                  />
                ) : (
                  <VisitorPhoto
                    src={null}
                    visitorName={visitor.name}
                    variant="selfie"
                  />
                )}
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
                      <VisitFilePhoto
                        visitId={visit.id}
                        visitor={visitor}
                        variant="ktp"
                        triggerLabel="Lihat Foto KTP"
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
