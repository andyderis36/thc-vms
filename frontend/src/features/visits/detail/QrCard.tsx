'use client'

import { useEffect, useState } from 'react'
import { Maximize2, QrCode, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { useVisitQrQuery } from '@/lib/api/hooks'

export interface QrCardProps {
  /** ID rute `/visits/[id]` — kunci query QR harus sama dengan query detail. */
  visitId: string
  /** Kode kunjungan untuk ditampilkan (mis. `VST-2026090001`). */
  visitCode: string
  /** QR hanya diminta bila status persis `approved` (status lain membalas 404). */
  approved: boolean
}

/**
 * Kartu Pas Masuk QR (SCR-04) — elemen PALING ATAS pada urutan dokumen
 * halaman detail agar kartu QR berada di above-the-fold ponsel tanpa
 * mengandalkan pengurutan CSS.
 *
 * API mengembalikan `qr_code_payload` sebagai STRING opak, bukan URL gambar,
 * dan tidak ada pustaka QR yang terpasang — karena itu payload dirender
 * sebagai teks yang dapat diseleksi (bukan grafik QR palsu yang bisa
 * mengecoh petugas pos jaga). Backend Go akan menyajikan gambar QR yang
 * sudah dirender pada endpoint ini nanti.
 */
export function QrCard({ visitId, visitCode, approved }: QrCardProps) {
  const [expanded, setExpanded] = useState(false)
  const qrQuery = useVisitQrQuery(visitId, approved)
  const payload = qrQuery.data?.qr_code_payload ?? null

  // Tutup tampilan layar penuh dengan Escape (aksesibilitas WCAG).
  useEffect(() => {
    if (!expanded) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setExpanded(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return (): void => document.removeEventListener('keydown', onKeyDown)
  }, [expanded])

  return (
    <section aria-label="Kartu QR akses fasilitas" className="card border-2 border-brand">
      <div className="flex flex-col gap-4 p-5">
        <div className="flex items-center gap-2">
          <QrCode aria-hidden="true" className="size-5 shrink-0 text-brand" />
          <h2 className="text-base font-semibold text-ink">Pas Masuk QR Code</h2>
        </div>

        <div className="rounded-control border border-border-light bg-page px-3 py-2">
          <p className="text-badge uppercase text-ink-muted">Visit ID</p>
          <p className="mt-0.5 select-all break-all text-sm font-bold text-ink">{visitCode}</p>
        </div>

        {!approved ? (
          <div className="rounded-control bg-neutral-bg px-4 py-6 text-center">
            <p className="text-sm font-semibold text-neutral-text">
              QR Code terbit setelah izin disetujui
            </p>
            <p className="mt-1 text-label text-ink-muted">
              Kartu QR akan muncul di sini setelah admin cabang menyetujui kunjungan Anda.
            </p>
          </div>
        ) : qrQuery.isPending ? (
          <div className="flex items-center justify-center gap-2 py-6 text-label text-ink-secondary">
            <Spinner size="sm" />
            Memuat QR Code…
          </div>
        ) : qrQuery.isError ? (
          <p role="alert" className="rounded-control bg-danger-bg px-4 py-3 text-sm text-danger-text">
            QR Code tidak dapat dimuat. Muat ulang halaman untuk mencoba lagi.
          </p>
        ) : payload !== null ? (
          <>
            <div className="rounded-control border border-border-light bg-page p-4 text-center">
              <p className="text-badge uppercase text-ink-muted">Kode Akses</p>
              {/*
                CATATAN: backend Go akan menyajikan gambar QR yang sudah
                dirender pada endpoint ini. Sampai saat itu, API hanya
                mengembalikan string payload — kami menampilkan teks yang
                dapat diseleksi, bukan grafik QR buatan yang menyesatkan
                petugas di gerbang.
              */}
              <p className="mt-2 select-all break-all font-mono text-lg font-bold text-ink">
                {payload}
              </p>
            </div>

            <Button variant="secondary" fullWidth onClick={() => setExpanded(true)}>
              <Maximize2 aria-hidden="true" className="size-4" />
              Perbesar Layar Penuh
            </Button>

            <p className="text-label text-ink-secondary">
              Tunjukkan QR Code ini kepada petugas jaga / security saat masuk ke lokasi.
            </p>
          </>
        ) : null}
      </div>

      {expanded && payload !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="QR Code layar penuh"
          className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-surface p-4 md:p-8"
        >
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-badge uppercase text-ink-muted">Visit ID</p>
              <p className="truncate text-base font-bold text-ink">{visitCode}</p>
            </div>
            <Button variant="ghost" size="sm" autoFocus onClick={() => setExpanded(false)}>
              <X aria-hidden="true" className="size-4" />
              Tutup
            </Button>
          </div>

          <div className="flex flex-1 flex-col items-center justify-center gap-5 py-8 text-center">
            <p className="select-all break-all font-mono text-2xl font-bold text-ink md:text-4xl">
              {payload}
            </p>
            <p className="max-w-xl text-sm text-ink-secondary">
              Tunjukkan QR Code ini kepada petugas jaga / security saat masuk ke lokasi.
            </p>
          </div>
        </div>
      )}
    </section>
  )
}
