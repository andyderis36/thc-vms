'use client'

import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Textarea } from '@/components/ui/Textarea'
import { ApiError } from '@/lib/api/fetcher'
import { useCancelVisitMutation } from '@/lib/api/hooks'
import { TEXT_MAX_LENGTH } from '@/lib/limits'

export interface CancelModalProps {
  /** ID rute `/visits/[id]` — agar invalidasi cache menyasar kunci detail yang sama. */
  visitId: string
  open: boolean
  onClose: () => void
}

/** Pesan error aman tampil dari `ApiError` atau error tak dikenal. */
function toErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message
  }
  return 'Terjadi kesalahan. Silakan coba lagi.'
}

/**
 * Modal Batalkan Kunjungan (SCR-04): konfirmasi eksplisit + alasan
 * opsional. Komponen ini dipasang secara kondisional oleh layar pemiliknya,
 * sehingga state form bersih setiap kali modal dibuka.
 */
export function CancelModal({ visitId, open, onClose }: CancelModalProps) {
  const [reason, setReason] = useState('')
  const cancel = useCancelVisitMutation()

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const trimmed = reason.trim()
    try {
      if (trimmed === '') {
        await cancel.mutateAsync({ visitId })
      } else {
        await cancel.mutateAsync({ visitId, body: { reason: trimmed } })
      }
      toast.success('Kunjungan berhasil dibatalkan.')
      onClose()
    } catch {
      // Pesan gagal ditampilkan dari `cancel.error` di bawah.
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Batalkan Kunjungan"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={cancel.isPending}>
            Kembali
          </Button>
          <Button
            type="submit"
            form="cancel-form"
            variant="danger"
            loading={cancel.isPending}
          >
            Ya, Batalkan Kunjungan
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="rounded-control bg-warning-bg px-4 py-3 text-sm text-warning-text">
          Pembatalan izin ini bersifat permanen dan tidak dapat dibatalkan kembali. Status
          kunjungan akan berubah menjadi <strong className="font-bold">Dibatalkan</strong>, dan
          kartu QR tidak akan berlaku lagi di pos jaga.
        </div>

        {cancel.isError && (
          <p role="alert" className="rounded-control bg-danger-bg px-3 py-2 text-sm text-danger-text">
            {toErrorMessage(cancel.error)}
          </p>
        )}

        <form id="cancel-form" className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <Textarea
            label="Alasan Pembatalan"
            value={reason}
            hint="Opsional. Alasan akan tercatat pada riwayat kunjungan."
            placeholder="Contoh: pekerjaan dibatalkan oleh pelanggan"
            maxLength={TEXT_MAX_LENGTH}
            onChange={(event) => setReason(event.target.value)}
          />
        </form>
      </div>
    </Modal>
  )
}
