'use client'

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import type { Html5Qrcode } from 'html5-qrcode'
import { CircleCheck, RotateCcw, ScanLine, TriangleAlert, Upload } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Spinner } from '@/components/ui/Spinner'
import { Tabs, type TabItem } from '@/components/ui/Tabs'

/**
 * SCR-05 — Panel Pemindai Triple-Mode (kamera langsung, gambar galeri/chat,
 * input Visit ID manual).
 *
 * Aturan html5-qrcode (v2.3.8, mebjas/html5-qrcode):
 * - Pustaka menyentuh `window`/`navigator.mediaDevices` saat konstruksi, jadi
 *   diimpor HANYA lewat `await import('html5-qrcode')` di dalam `useEffect`.
 *   Tidak ada static import runtime — import bertipe di atas ikut terhapus
 *   oleh TypeScript dan tidak pernah dieksekusi saat render server.
 * - Memakai kelas rendah `Html5Qrcode` (bukan `Html5QrcodeScanner` yang
 *   menyuntikkan UI bawaan dan bertarung dengan layout kios).
 * - Cleanup wajib idempoten: cek `getState()` ke `SCANNING`/`PAUSED`, `stop()`
 *   hanya bila perlu, baru `clear()` (`clear()` melempar bila masih memindai).
 *   Flag `cancelled` menahan konstruksi setelah unmount sehingga StrictMode
 *   (dev) tidak menggandakan kamera dan memicu `NotReadableError`.
 */
const SCANNER_VIEW_ID = 'thc-gate-scanner-view'

type ScanMode = 'camera' | 'image' | 'manual'

const MODE_TABS: TabItem[] = [
  { id: 'camera', label: 'Kamera Langsung' },
  { id: 'image', label: 'Galeri / Chat' },
  { id: 'manual', label: 'Input Manual' },
]

function isScanMode(value: string): value is ScanMode {
  return value === 'camera' || value === 'image' || value === 'manual'
}

/** Status proses pindai yang dimiliki layar gerbang, bukan panel ini. */
export type ScanPhase =
  | { phase: 'idle' }
  | { phase: 'processing' }
  | { phase: 'feedback'; tone: 'success' | 'error'; title: string; message: string }

export interface ScannerPanelProps {
  /** Dipunya layar `/gate` hasil olahan kode yang dipindai. */
  phase: ScanPhase
  /** Dipanggil saat kode terbaca (kamera/gambar) atau Visit ID dikirim (manual). */
  onScan: (raw: string) => void
  /** Dipanggil saat petugas menutup hasil / ganti mode — kunci dipasang ulang. */
  onReset: () => void
}

interface FeedbackBlockProps {
  phase: Exclude<ScanPhase, { phase: 'idle' }>
  onAcknowledge: () => void
}

/**
 * Blok umum untuk fase `processing` dan `feedback`. Tombol "Pindai Lagi"
 * adalah satu-satunya cara membuka kunci mode kamera setelah hasil muncul,
 * sehingga QR yang sama tidak langsung diproses ulang (check-in kemudian
 * check-out dalam hitungan frame).
 */
function FeedbackBlock({ phase, onAcknowledge }: FeedbackBlockProps) {
  if (phase.phase === 'processing') {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <Spinner size="md" label="Memproses kunjungan…" />
        <p className="text-sm font-semibold text-ink">Memproses kunjungan…</p>
      </div>
    )
  }

  const success = phase.tone === 'success'
  return (
    <div className="flex max-w-sm flex-col items-center gap-3 text-center">
      {success ? (
        <CircleCheck aria-hidden="true" className="size-9 shrink-0 text-success-text" />
      ) : (
        <TriangleAlert aria-hidden="true" className="size-9 shrink-0 text-danger-text" />
      )}
      <p className="text-base font-bold text-ink">{phase.title}</p>
      <p className="text-sm text-ink-secondary">{phase.message}</p>
      <Button
        variant={success ? 'success' : 'secondary'}
        size="lg"
        className="px-6"
        onClick={onAcknowledge}
      >
        <RotateCcw aria-hidden="true" className="size-4 shrink-0" />
        Pindai Lagi
      </Button>
    </div>
  )
}

export function ScannerPanel({ phase, onScan, onReset }: ScannerPanelProps) {
  const [mode, setMode] = useState<ScanMode>('camera')
  const [manual, setManual] = useState('')
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [imageBusy, setImageBusy] = useState(false)
  const [imageError, setImageError] = useState<string | null>(null)

  /** Kunci anti-duplikat: `onSuccess` html5-qrcode membara tiap frame. */
  const lockRef = useRef(false)
  /** Kode terakhir yang diproses mode kamera — cegah check-in lalu check-out instan. */
  const lastCodeRef = useRef<string | null>(null)
  /** Instance kamera yang sedang/sedang dihentikan — dibutuhkan mode gambar. */
  const cameraRef = useRef<Html5Qrcode | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const onScanRef = useRef(onScan)
  const onResetRef = useRef(onReset)

  // Callback dari layar gerbang boleh berubah tiap render; kamera hanya boleh
  // dibuat ulang saat mode berubah, jadi simpan lewat ref.
  useEffect(() => {
    onScanRef.current = onScan
  })
  useEffect(() => {
    onResetRef.current = onReset
  })

  const handleCameraDecode = useCallback((decodedText: string): void => {
    if (lockRef.current) return
    const code = decodedText.trim()
    // QR yang sama tidak boleh memicu proses kedua selama hasil terakhir
    // masih relevan; kode baru selalu diterima.
    if (code === lastCodeRef.current) return
    lockRef.current = true
    lastCodeRef.current = code
    onScanRef.current(decodedText)
  }, [])

  // ---------------------------------------------------------------------------
  // Mode 1 — kamera langsung (dynamic import + cleanup idempoten)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (mode !== 'camera') return undefined

    setCameraReady(false)
    setCameraError(null)

    let cancelled = false
    let startFinished = false
    let localInstance: Html5Qrcode | null = null

    const teardown = async (): Promise<void> => {
      const target = localInstance
      localInstance = null
      if (cameraRef.current === target) {
        cameraRef.current = null
      }
      if (target === null) return
      try {
        const mod = await import('html5-qrcode')
        const state = target.getState()
        if (
          state === mod.Html5QrcodeScannerState.SCANNING ||
          state === mod.Html5QrcodeScannerState.PAUSED
        ) {
          await target.stop()
        }
      } catch {
        // Kamera sudah berhenti atau belum sempat mulai — aman diabaikan.
      }
      try {
        target.clear()
      } catch {
        // clear() melempar bila proses pemindaian masih berjalan.
      }
    }

    const finishStart = (): void => {
      startFinished = true
      if (cancelled) void teardown()
    }

    void (async (): Promise<void> => {
      try {
        const mod = await import('html5-qrcode')
        if (cancelled) return
        const target = new mod.Html5Qrcode(SCANNER_VIEW_ID, { verbose: false })
        localInstance = target
        cameraRef.current = target
        try {
          await target.start(
            { facingMode: 'environment' },
            { fps: 10, qrbox: { width: 250, height: 250 } },
            handleCameraDecode,
            undefined,
          )
          if (!cancelled) setCameraReady(true)
        } catch {
          if (!cancelled) {
            setCameraError(
              'Kamera tidak dapat diakses. Izinkan akses kamera atau gunakan mode Galeri / Input Manual.'
            )
          }
        }
      } catch {
        if (!cancelled) {
          setCameraError('Modul pemindai gagal dimuat. Muat ulang halaman atau gunakan mode lain.')
        }
      } finally {
        finishStart()
      }
    })()

    return () => {
      cancelled = true
      if (startFinished) void teardown()
    }
  }, [mode, handleCameraDecode])

  // ---------------------------------------------------------------------------
  // Mode 2 — pindai dari gambar galeri / tangkapan layar chat WhatsApp
  // ---------------------------------------------------------------------------
  const handleFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const input = event.target
    const file = input.files?.[0]
    // Reset supaya berkas yang sama bisa dipilih lagi tanpa klik ganda.
    input.value = ''
    if (file === undefined) return

    setImageError(null)
    setImageBusy(true)
    void (async (): Promise<void> => {
      try {
        const mod = await import('html5-qrcode')

        // Kamera dan pemindaian gambar saling eksklusif: hentikan kamera dulu.
        const running = cameraRef.current
        if (running !== null) {
          try {
            const state = running.getState()
            if (
              state === mod.Html5QrcodeScannerState.SCANNING ||
              state === mod.Html5QrcodeScannerState.PAUSED
            ) {
              await running.stop()
            }
          } catch {
            // Sudah berhenti — abaikan.
          }
        }

        const target = new mod.Html5Qrcode(SCANNER_VIEW_ID, { verbose: false })
        try {
          const text = await target.scanFile(file, true)
          onScanRef.current(text)
        } catch {
          setImageError('Gambar tidak terbaca. Ambil ulang atau ketik Visit ID secara manual.')
        } finally {
          try {
            target.clear()
          } catch {
            // clear() melempar bila masih memindai — abaikan.
          }
        }
      } catch {
        setImageError('Modul pemindai gagal dimuat. Muat ulang halaman atau gunakan mode lain.')
      } finally {
        setImageBusy(false)
      }
    })()
  }

  // ---------------------------------------------------------------------------
  // Mode 3 — input manual Visit ID (fallback QR rusak)
  // ---------------------------------------------------------------------------
  const submitManual = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const code = manual.trim()
    if (code === '') return
    onScanRef.current(code)
  }

  // ---------------------------------------------------------------------------
  // Mode switch & acknowledge — melepas kunci + membersihkan feedback layar
  // ---------------------------------------------------------------------------
  const changeMode = (value: string): void => {
    if (!isScanMode(value) || value === mode) return
    setMode(value)
    setManual('')
    setCameraError(null)
    setImageError(null)
    lockRef.current = false
    lastCodeRef.current = null
    onResetRef.current()
  }

  const handleAcknowledge = (): void => {
    lockRef.current = false
    if (phase.phase === 'feedback' && phase.tone === 'success') {
      setManual('')
    }
    onResetRef.current()
  }

  const showFeedback = phase.phase !== 'idle'

  return (
    <section aria-label="Pemindai pas masuk" className="card min-w-0 self-start md:sticky md:top-24">
      <div className="flex flex-col gap-4 p-4 md:p-5">
        <div className="flex items-start gap-2">
          <ScanLine aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-brand" />
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink">Pindai Pas Masuk</h2>
            <p className="text-label text-ink-muted">
              Triple-mode: kamera langsung, gambar galeri, atau Visit ID manual.
            </p>
          </div>
        </div>

        <Tabs tabs={MODE_TABS} value={mode} onChange={changeMode} size="gate" />

        {mode === 'manual' ? (
          showFeedback ? (
            <FeedbackBlock phase={phase} onAcknowledge={handleAcknowledge} />
          ) : (
            <form onSubmit={submitManual} className="flex flex-col gap-3">
              <Input
                label="Visit ID"
                fieldSize="gate"
                placeholder="VST-2026090001"
                value={manual}
                onChange={(event) => setManual(event.target.value)}
                hint="Format: VST-2026090001. Gunakan bila QR rusak atau kamera bermasalah."
                autoComplete="off"
                className="font-mono uppercase"
              />
              <Button type="submit" size="gate" disabled={manual.trim() === ''}>
                Proses Visit ID
              </Button>
            </form>
          )
        ) : (
          <div className="flex flex-col gap-3">
            {/*
              Wadah sengaja kosong di JSX: html5-qrcode menanam video/pratinjau
              sebagai anak DOM di sini, jadi React tidak boleh menguasainya.
            */}
            <div className="relative">
              <div
                id={SCANNER_VIEW_ID}
                className="aspect-square w-full overflow-hidden rounded-control bg-sidebar-dark"
              />

              {showFeedback ? (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface/95 p-4">
                  <FeedbackBlock phase={phase} onAcknowledge={handleAcknowledge} />
                </div>
              ) : cameraError !== null ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-sidebar-dark p-4 text-center">
                  <TriangleAlert aria-hidden="true" className="size-7 shrink-0 text-warning-text" />
                  <p className="text-sm font-semibold text-brand-contrast">{cameraError}</p>
                </div>
              ) : mode === 'camera' && !cameraReady ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-sidebar-dark text-brand-contrast">
                  <Spinner size="md" label="Mengaktifkan kamera…" />
                  <p className="text-label">Mengaktifkan kamera…</p>
                </div>
              ) : mode === 'image' && !imageBusy ? (
                <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
                  <p className="text-label text-ink-muted">
                    Pratinjau gambar QR akan tampil di sini.
                  </p>
                </div>
              ) : null}
            </div>

            {mode === 'camera' && !showFeedback ? (
              <p className="text-label text-ink-secondary">
                Arahkan kamera ke QR Code pas masuk teknisi. Pemindaian aktif otomatis.
              </p>
            ) : null}

            {mode === 'image' && !showFeedback ? (
              <div className="flex flex-col gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  tabIndex={-1}
                  aria-hidden="true"
                  className="sr-only"
                  onChange={handleFileChange}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="lg"
                  fullWidth
                  loading={imageBusy}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload aria-hidden="true" className="size-4 shrink-0" />
                  Pilih Gambar dari Galeri / Chat
                </Button>
                <p className="text-label text-ink-secondary">
                  Untuk QR yang dikirim teknisi lewat WhatsApp, unduh gambarnya lalu pilih di sini.
                </p>
                {imageError !== null ? (
                  <p
                    role="alert"
                    className="rounded-control bg-danger-bg px-3 py-2 text-label text-danger-text"
                  >
                    {imageError}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </section>
  )
}
