'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { StatusBadge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Textarea } from '@/components/ui/Textarea'
import { useApproveVisitMutation } from '@/lib/api/hooks'
import type { VisitDetail } from '@/lib/api/types'
import { formatVisitSchedule } from './VisitTable'

/**
 * Pesan kesalahan aman untuk UI — pesan API dipertahankan bila tersedia,
 * selain itu fallback Bahasa Indonesia. Dipakai modal approve, reject,
 * dan layar dashboard supaya satu gaya penulisan error di SCR-02.
 */
export function apiErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') {
    return error.message
  }
  return 'Terjadi kesalahan. Silakan coba lagi.'
}

export interface VisitSummaryProps {
  visit: VisitDetail
}

/** Ringkasan kunjungan di dalam modal — ID, PIC, fasilitas, keperluan, jadwal. */
export function VisitSummary({ visit }: VisitSummaryProps) {
  const purposes = visit.purposes.map((purpose) => purpose.name).join(', ')

  return (
    <div className="mb-4 flex flex-col gap-2 rounded-control bg-neutral-bg p-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono font-semibold text-ink">{visit.visit_id}</span>
        <StatusBadge status={visit.status} />
      </div>
      <p className="text-ink-secondary">
        <span className="text-ink">{visit.pic_user.name}</span>
        {visit.vendor_name !== '' ? ` · ${visit.vendor_name}` : ''}
      </p>
      <p className="text-ink-secondary">{visit.location.name}</p>
      <p className="text-ink-secondary">{purposes}</p>
      <p className="text-ink-secondary">{formatVisitSchedule(visit)}</p>
    </div>
  )
}

export interface ApproveModalProps {
  open: boolean
  visit: VisitDetail | null
  onClose: () => void
}

/**
 * Modal persetujuan kunjungan (SCR-02). Catatan persetujuan bersifat opsional.
 * Reset state catatan setiap kali modal dibuka agar catatan kunjungan sebelumnya
 * tidak bocor ke kunjungan berikutnya.
 */
export function ApproveModal({ open, visit, onClose }: ApproveModalProps) {
  const [notes, setNotes] = useState('')
  const approve = useApproveVisitMutation()

  useEffect(() => {
    if (open) setNotes('')
  }, [open])

  const handleApprove = (): void => {
    if (visit === null) return
    approve.mutate(
      { visitId: visit.id, body: notes.trim() !== '' ? { notes: notes.trim() } : undefined },
      {
        onSuccess: () => {
          toast.success(`Kunjungan ${visit.visit_id} disetujui`)
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
      title="Setujui Kunjungan"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Batal
          </Button>
          <Button variant="success" className="min-h-touch" loading={approve.isPending} onClick={handleApprove}>
            Setujui
          </Button>
        </>
      }
    >
      <VisitSummary visit={visit} />
      <Textarea
        label="Catatan Persetujuan"
        placeholder="Catatan untuk petugas pos (opsional)"
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
        rows={3}
      />
    </Modal>
  )
}
