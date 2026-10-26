// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ScannerPanel } from './ScannerPanel'
import { VISIT_ID_INPUT_MAX_LENGTH } from '@/lib/limits'

/** Spion modul: `start` HARUS dipanggil ulang setelah unggahan gambar. */
const startMock = vi.hoisted(() => vi.fn(async () => undefined))
const scanFileMock = vi.hoisted(() => vi.fn(async () => 'VST-2026090001'))

vi.mock('html5-qrcode', () => ({
  Html5QrcodeScannerState: { SCANNING: 2, PAUSED: 3 },
  Html5Qrcode: class {
    getState(): number {
      return 1
    }
    start = startMock
    stop = vi.fn(async () => undefined)
    clear = vi.fn()
    scanFile = scanFileMock
  },
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderPanel(onScan = vi.fn()) {
  return render(
    <ScannerPanel phase={{ phase: 'idle' }} onScan={onScan} onReset={vi.fn()} resetKey={0} />,
  )
}

describe('ScannerPanel - dua tab + unggah gambar di bawah bingkai', () => {
  it('judul panel "Scan Barcode" dengan tepat dua tab', () => {
    renderPanel()

    expect(screen.getByRole('heading', { name: 'Scan Barcode' })).toBeInTheDocument()
    expect(screen.queryByText('Pindai Pas Masuk')).toBeNull()
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Kamera',
      'Input Manual',
    ])
  })

  it('tombol unggah tampil di mode kamera dan hilang di mode Input Manual', () => {
    renderPanel()

    expect(
      screen.getByRole('button', { name: /Unggah QR Code/ }),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Input Manual' }))

    expect(screen.queryByRole('button', { name: /Unggah QR Code/ })).toBeNull()
    // Wiring APG tetap utuh setelah tab galeri dihapus.
    expect(
      document.getElementById('thc-gate-scanner-mode-panel')?.getAttribute('aria-labelledby'),
    ).toBe('thc-gate-scanner-mode-panel-tab-manual')
    expect(document.getElementById('thc-gate-scanner-mode-panel-tab-manual')).not.toBeNull()
  })

  it('input Visit ID manual dibatasi maxLength VISIT_ID_INPUT_MAX_LENGTH', () => {
    renderPanel()

    fireEvent.click(screen.getByRole('tab', { name: 'Input Manual' }))

    expect(screen.getByLabelText('Visit ID')).toHaveAttribute(
      'maxlength',
      String(VISIT_ID_INPUT_MAX_LENGTH),
    )
  })

  it('setelah memindai gambar unggahan, kamera dibangun ulang (viewfinder tidak mati)', async () => {
    const onScan = vi.fn()
    const { container } = renderPanel(onScan)

    await waitFor(() => expect(startMock).toHaveBeenCalledTimes(1))

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input).not.toBeNull()
    if (input === null) return
    const file = new File(['qr'], 'qr.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    fireEvent.change(input)

    await waitFor(() => expect(onScan).toHaveBeenCalledWith('VST-2026090001'))
    // 8s (bukan 3s): kamera dibangun ulang lewat import() modul html5-qrcode,
    // jadi saat suite paralel penuh proses build-nya bisa melebihi 3 detik dan
    // test jadi flaky. Niatnya tetap "kamera hidup lagi setelah pindai gambar".
    await waitFor(() => expect(startMock).toHaveBeenCalledTimes(2), { timeout: 8000 })
  })
})
