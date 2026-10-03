'use client'

import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { Download, Maximize2, QrCode, X } from 'lucide-react'
import QRCodeGraphic from 'react-qr-code'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { useVisitQrQuery } from '@/lib/api/hooks'

export interface QrCardProps {
  /** ID rute `/visits/[id]` — kunci query QR harus sama dengan query detail. */
  visitId: string
  /** Kode kunjungan untuk ditampilkan (mis. `VST-2026090001`). */
  visitCode: string
  /** QR diminta bila status `approved` (check-in) atau `visiting`
   * (check-out, QR yang SAMA). Status lain tidak memicu fetch. */
  qrVisible: boolean
}

/**
 * Kartu Pas Masuk QR (SCR-04) — elemen PALING ATAS pada urutan dokumen
 * halaman detail agar kartu QR berada di above-the-fold ponsel tanpa
 * mengandalkan pengurutan CSS.
 *
 * API mengembalikan `qr_code_payload` sebagai STRING opak; grafiknya
 * dirender di klien via `react-qr-code` (SVG tajam, terpindai kamera pos).
 * Teks payload tetap ditampilkan di bawahnya sebagai cadangan yang dapat
 * diseleksi (mode input manual scanner).
 */
export function QrCard({ visitId, visitCode, qrVisible }: QrCardProps) {
  const [expanded, setExpanded] = useState(false)
  const qrQuery = useVisitQrQuery(visitId, qrVisible)
  const payload = qrQuery.data?.qr_code_payload ?? null
  /** Tombol "Perbesar" pembuka — fokus dikembalikan ke sini saat dialog ditutup. */
  const openerRef = useRef<HTMLButtonElement | null>(null)
  /** Wadah SVG QR — sumber rasterisasi untuk tombol "Unduh QR". */
  const qrWrapRef = useRef<HTMLDivElement | null>(null)

  /*
   * Unduh QR (SCR-04): rasterisasi SVG react-qr-code -> PNG lewat canvas
   * bawaan browser (TANPA dependensi baru). Latar diisi putih murni dan
   * modul tetap hitam pekat (#000/#FFF) agar kontras pemindaian tidak turun.
   */
  const downloadQr = (): void => {
    const svg = qrWrapRef.current?.querySelector('svg')
    if (svg === null || svg === undefined) return

    const clone = svg.cloneNode(true) as SVGSVGElement
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    // Dimensi intrinsik dari atribut `width` react-qr-code (bukan lebar CSS
    // yang bisa menyusut di ponsel) — PNG dirender 4x agar tajam.
    const intrinsic = Number(svg.getAttribute('width'))
    const dimension = Number.isFinite(intrinsic) && intrinsic > 0 ? intrinsic : 192
    const scale = 4

    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = dimension * scale
      canvas.height = dimension * scale
      const ctx = canvas.getContext('2d')
      if (ctx === null) return
      ctx.fillStyle = '#FFFFFF'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height)

      const anchor = document.createElement('a')
      anchor.href = canvas.toDataURL('image/png')
      anchor.download = `${visitCode}-qr.png`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
    }
    const source = new XMLSerializer().serializeToString(clone)
    // encodeURIComponent meng-escape `#` warna sehingga data URI tidak terpotong.
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`
  }

  const openExpanded = (event: MouseEvent<HTMLButtonElement>): void => {
    openerRef.current = event.currentTarget
    setExpanded(true)
  }

  const closeExpanded = (): void => {
    setExpanded(false)
    openerRef.current?.focus()
    openerRef.current = null
  }

  /*
   * Layar penuh: Escape menutup (WCAG 2.1.1) dan scroll latar belakang
   * dikunci selama dialog terbuka agar sentuhan teknisi tidak menggeser
   * halaman di balik QR.
   */
  useEffect(() => {
    if (!expanded) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setExpanded(false)
      openerRef.current?.focus()
      openerRef.current = null
    }
    document.addEventListener('keydown', onKeyDown)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return (): void => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [expanded])

  return (
    <section aria-label="Kartu QR akses fasilitas" className="card border-2 border-brand">
      <div className="flex flex-col gap-3 p-4 sm:gap-4 sm:p-5">
        <div className="flex items-center gap-2">
          <QrCode aria-hidden="true" className="size-5 shrink-0 text-brand" />
          <h2 className="text-base font-semibold text-ink">Pas Masuk QR Code</h2>
        </div>

        <div className="rounded-control border border-border-light bg-page px-3 py-2">
          <p className="text-badge uppercase text-ink-muted">Visit ID</p>
          <p className="mt-0.5 select-all break-all text-sm font-bold text-ink">{visitCode}</p>
        </div>

        {!qrVisible ? (
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
            <div
              ref={qrWrapRef}
              className="flex flex-col items-center gap-3 rounded-control border border-border-light bg-white p-4 text-center"
            >
              {/*
                Kontras maksimal (design-system §5.2): modul hitam pekat di
                atas putih murni + quiet zone putih p-4 di sekelilingnya agar
                kamera pos membaca QR pada cahaya shelter yang rendah.
              */}
              <QRCodeGraphic
                value={payload}
                size={192}
                bgColor="#FFFFFF"
                fgColor="#000000"
                aria-label={`QR Code ${visitCode}`}
                className="h-auto w-full max-w-48"
              />
              <div>
                <p className="text-badge uppercase text-ink-muted">Kode Akses</p>
                <p className="mt-1 select-all break-all font-mono text-sm font-bold text-ink">
                  {payload}
                </p>
              </div>
            </div>

            <Button
              variant="secondary"
              fullWidth
              className="min-h-touch"
              onClick={openExpanded}
            >
              <Maximize2 aria-hidden="true" className="size-4 shrink-0" />
              Perbesar Layar Penuh
            </Button>

            <Button
              variant="secondary"
              fullWidth
              className="min-h-touch"
              onClick={downloadQr}
            >
              <Download aria-hidden="true" className="size-4 shrink-0" />
              Unduh QR
            </Button>

            <p className="text-label text-ink-secondary">
              Tunjukkan QR Code ini kepada petugas jaga / security saat masuk atau keluar lokasi.
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
            <Button
              variant="ghost"
              size="sm"
              className="min-h-touch"
              autoFocus
              onClick={closeExpanded}
            >
              <X aria-hidden="true" className="size-4 shrink-0" />
              Tutup
            </Button>
          </div>

          <div className="flex flex-1 flex-col items-center justify-center gap-5 py-8 text-center">
            <div className="rounded-modal bg-white p-4">
              <QRCodeGraphic
                value={payload}
                size={288}
                bgColor="#FFFFFF"
                fgColor="#000000"
                aria-label={`QR Code ${visitCode} layar penuh`}
                className="h-auto w-full max-w-72"
              />
            </div>
            <p className="select-all break-all font-mono text-xl font-bold text-ink md:text-2xl">
              {payload}
            </p>
            <p className="max-w-xl text-sm text-ink-secondary">
              Tunjukkan QR Code ini kepada petugas jaga / security saat masuk atau keluar lokasi.
            </p>
          </div>
        </div>
      )}
    </section>
  )
}
