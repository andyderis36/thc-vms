'use client'

import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Textarea } from '@/components/ui/Textarea'
import { ApiError } from '@/lib/api/fetcher'
import { useRescheduleVisitMutation } from '@/lib/api/hooks'

export interface RescheduleModalProps {
  /** ID rute `/visits/[id]` — agar invalidasi cache menyasar kunci detail yang sama. */
  visitId: string
  open: boolean
  onClose: () => void
  /** Jadwal berlaku saat ini (ISO 8601) sebagai nilai awal field. */
  initialStartDate: string
  initialEndDate: string
}

interface FieldErrors {
  start?: string
  end?: string
  reason?: string
}

/** ISO 8601 -> nilai `datetime-local` pada zona waktu perangkat. */
function toDateTimeLocal(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Pesan error aman tampil dari `ApiError` atau error tak dikenal. */
function toErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message
  }
  return 'Terjadi kesalahan. Silakan coba lagi.'
}

/**
 * Modal Ubah Jadwal Kunjungan (SCR-04): rentang tanggal baru + alasan wajib.
 * Komponen ini sengaja DIPASANG secara kondisional oleh layar pemiliknya
 * sehingga state form diinisialisasi ulang dari props tiap kali dibuka.
 */
export function RescheduleModal({
  visitId,
  open,
  onClose,
  initialStartDate,
  initialEndDate,
}: RescheduleModalProps) {
  const [startDate, setStartDate] = useState(() => toDateTimeLocal(initialStartDate))
  const [endDate, setEndDate] = useState(() => toDateTimeLocal(initialEndDate))
  const [reason, setReason] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const reschedule = useRescheduleVisitMutation()

  function validate(): FieldErrors {
    const next: FieldErrors = {}
    if (startDate === '') {
      next.start = 'Tanggal & waktu mulai wajib diisi.'
    }
    if (endDate === '') {
      next.end = 'Tanggal & waktu selesai wajib diisi.'
    }
    if (startDate !== '' && endDate !== '') {
      const startMs = new Date(startDate).getTime()
      const endMs = new Date(endDate).getTime()
      if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
        next.end = 'Tanggal selesai harus setelah tanggal mulai.'
      }
    }
    if (reason.trim() === '') {
      next.reason = 'Alasan perubahan jadwal wajib diisi.'
    }
    return next
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const nextErrors = validate()
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) {
      return
    }
    try {
      await reschedule.mutateAsync({
        visitId,
        body: {
          start_date: new Date(startDate).toISOString(),
          end_date: new Date(endDate).toISOString(),
          reason: reason.trim(),
        },
      })
      toast.success('Jadwal kunjungan berhasil diubah.')
      onClose()
    } catch {
      // Pesan gagal ditampilkan dari `reschedule.error` di bawah.
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Ubah Jadwal Kunjungan"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={reschedule.isPending}>
            Batal
          </Button>
          <Button type="submit" form="reschedule-form" loading={reschedule.isPending}>
            Simpan Jadwal Baru
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {reschedule.isError && (
          <p role="alert" className="rounded-control bg-danger-bg px-3 py-2 text-sm text-danger-text">
            {toErrorMessage(reschedule.error)}
          </p>
        )}

        <form id="reschedule-form" className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <Input
            label="Tanggal & Waktu Mulai"
            type="datetime-local"
            required
            value={startDate}
            error={errors.start}
            onChange={(event) => setStartDate(event.target.value)}
          />
          <Input
            label="Tanggal & Waktu Selesai"
            type="datetime-local"
            required
            value={endDate}
            error={errors.end}
            onChange={(event) => setEndDate(event.target.value)}
          />
          <Textarea
            label="Alasan Perubahan Jadwal"
            required
            value={reason}
            error={errors.reason}
            hint="Wajib diisi — alasan akan tercatat pada riwayat kunjungan."
            placeholder="Contoh: teknisi vendor berhalangan, digeser ke hari kerja berikutnya"
            onChange={(event) => setReason(event.target.value)}
          />
        </form>
      </div>
    </Modal>
  )
}
