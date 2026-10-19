'use client'

import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'

export interface ConfirmModalProps {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onClose: () => void
  loading?: boolean
}

/**
 * Dialog konfirmasi hapus permanen — dipakai ulang fasilitas, users,
 * dan detail kunjungan (DRY). Tombol aksi memenuhi target sentuh 44px+.
 */
export function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = 'Hapus Permanen',
  onConfirm,
  onClose,
  loading = false,
}: ConfirmModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" className="min-h-touch" onClick={onClose}>
            Batal
          </Button>
          <Button
            variant="danger"
            className="min-h-touch"
            loading={loading}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm text-ink-secondary">{message}</p>
    </Modal>
  )
}
