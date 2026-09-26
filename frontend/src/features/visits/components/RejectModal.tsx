'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Textarea } from '@/components/ui/Textarea'
import { useRejectVisitMutation } from '@/lib/api/hooks'
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
 * (PRD §4); reset state alasan setiap kali modal dibuka agar alasan
 * kunjungan sebelumnya tidak bocor ke kunjungan berikutnya.
 */
export function RejectModal({ open, visit, onClose }: RejectModalProps) {
  const [reason, setReason] = useState('')
  const reject = useRejectVisitMutation()

  useEffect(() => {
    if (open) setReason('')
  }, [open])

  const trimmed = reason.trim()
  const reasonValid = trimmed.length >= MIN_REASON

  const handleReject = (): void => {
    if (visit === null || !reasonValid) return
    reject.mutate(
      { visitId: visit.id, body: { reason: trimmed } },
      {
        onSuccess: () => {
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
