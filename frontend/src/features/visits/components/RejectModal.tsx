'use client'

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Textarea } from '@/components/ui/Textarea'
import { useRejectVisitMutation } from '@/lib/api/hooks'
import { queryKeys } from '@/lib/api/query-keys'
import type { VisitDetail } from '@/lib/api/types'
import { apiErrorMessage, VisitSummary } from './ApproveModal'

/** Alasan wajib minimal 5 karakter — tombol Tolak tetap nonaktif di bawahnya. */
const MIN_REASON = 5

export interface RejectModalProps {
  open: boolean
  visit: VisitDetail | null
  onClose: () => void
}

/**
 * Modal penolakan kunjungan (SCR-02). Alasan WAJIB dan minimal 5 karakter
 * (PRD §4). Alasan antar-kunjungan tidak bocor karena setiap call site
 * me-mount modal secara KONDISIONAL (`target !== null ? … : null`), sehingga
 * `reason` ter-reset oleh unmount/remount — bukan oleh efek.
 */
export function RejectModal({ open, visit, onClose }: RejectModalProps) {
  const [reason, setReason] = useState('')
  const reject = useRejectVisitMutation()
  const queryClient = useQueryClient()

  const trimmed = reason.trim()
  const reasonValid = trimmed.length >= MIN_REASON

  const handleReject = (): void => {
    if (visit === null || !reasonValid) return
    reject.mutate(
      { visitId: visit.id, body: { reason: trimmed } },
      {
        onSuccess: () => {
          // Halaman detail bisa dibuka via UUID (`/visits/<uuid>` dari daftar)
          // ATAU kode bisnis (`/visits/VST-...`, direct-open). Hook mutasi sudah
          // meng-invalidate kunci UUID + daftar; invalidate juga kunci kode bisnis
          // (detail + QR) agar halaman direct-open tidak basi.
          void queryClient.invalidateQueries({ queryKey: queryKeys.visits.detail(visit.visit_id) })
          void queryClient.invalidateQueries({ queryKey: queryKeys.visits.qr(visit.visit_id) })
          toast.success(`Kunjungan ${visit.visit_id} ditolak`)
          onClose()
        },
        onError: (error) => {
          toast.error(apiErrorMessage(error))
        },
      },
    )
  }

  if (visit === null) return null

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Tolak Kunjungan"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Batal
          </Button>
          <Button
            variant="danger"
            className="min-h-touch"
            disabled={!reasonValid}
            loading={reject.isPending}
            onClick={handleReject}
          >
            Tolak
          </Button>
        </>
      }
    >
      <VisitSummary visit={visit} />
      <Textarea
        label="Alasan Penolakan"
        placeholder="Jelaskan alasan penolakan (min. 5 karakter)"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        error={reason.length > 0 && !reasonValid ? 'Alasan minimal 5 karakter.' : undefined}
        hint={`Minimal ${MIN_REASON} karakter.`}
        required
        rows={3}
      />
    </Modal>
  )
}
