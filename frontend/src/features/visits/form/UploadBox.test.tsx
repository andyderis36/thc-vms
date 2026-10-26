// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { UploadBox } from './UploadBox'

const { mutateAsync } = vi.hoisted(() => ({ mutateAsync: vi.fn() }))

vi.mock('@/lib/api/hooks', () => ({
  useUploadFileMutation: () => ({ mutateAsync, isPending: false }),
}))

const ERROR_MESSAGE = 'Surat Tugas / SPK wajib diunggah.'
const HINT = 'PDF/JPG/PNG, maksimal 5 MB.'
const MB = 1024 * 1024

function makeFile(size: number, name: string, type: string): File {
  return new File([new Uint8Array(size)], name, { type })
}

function pickFile(container: HTMLElement, file: File): void {
  const input = container.querySelector('input[type="file"]')
  if (input === null) {
    throw new Error('input file tidak ditemukan')
  }
  fireEvent.change(input, { target: { files: [file] } })
}

beforeEach(() => {
  mutateAsync.mockReset()
  mutateAsync.mockResolvedValue({ file_url: 'http://x/f', file_name: 'f.jpg' })
})

function renderBox(overrides: Partial<Parameters<typeof UploadBox>[0]> = {}) {
  return render(
    <UploadBox
      label="Surat Tugas / SPK"
      value={null}
      onChange={() => {}}
      {...overrides}
    />,
  )
}

describe('UploadBox', () => {
  it('mode penuh: menampilkan pesan galat, border merah, id, dan tabIndex={-1} pada dropzone saat error', () => {
    const { container } = renderBox({ error: ERROR_MESSAGE, id: 'upload-spk' })

    expect(screen.getByRole('alert')).toHaveTextContent(ERROR_MESSAGE)

    const dropzone = container.querySelector('[id="upload-spk"]')
    expect(dropzone).not.toBeNull()
    expect(dropzone).toHaveClass('border-danger-text')
    expect(dropzone).toHaveAttribute('tabindex', '-1')
    expect(dropzone).not.toHaveClass('hover:border-brand')
  })

  it('mode ringkas: TIDAK ada ring/outline galat (baris penuh sel), hanya pesan merah; wrapper punya id + tabIndex={-1}', () => {
    const { container } = renderBox({
      compact: true,
      error: ERROR_MESSAGE,
      id: 'upload-ktp',
      idleButtonLabel: 'Unggah Foto KTP',
    })

    // Notifikasi tetap ada dan berupa teks merah (satu-satunya penanda galat).
    expect(screen.getByRole('alert')).toHaveTextContent(ERROR_MESSAGE)

    const wrapper = container.querySelector('[id="upload-ktp"]')
    expect(wrapper).not.toBeNull()
    expect(wrapper).toHaveClass('flex', 'flex-col', 'gap-2')
    expect(wrapper).toHaveAttribute('tabindex', '-1')

    // Baris melebar penuh sel grid: TIDAK boleh ada cincin/outline galat yang
    // melampaui tombol (regresi visual yang dilaporkan user).
    const row = wrapper?.querySelector('.flex-wrap')
    expect(row).not.toBeNull()
    expect(container.querySelector('[class*="ring-danger-text"]')).toBeNull()
    expect(container.querySelector('[class*="border-danger-text"]')).toBeNull()
  })

  it('tanpa prop error: tidak ada kelas galat di mana pun dan hint tetap dirender', () => {
    const { container } = renderBox({ hint: HINT })

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText(HINT)).toBeInTheDocument()

    const dropzone = container.querySelector('.border-dashed')
    expect(dropzone).not.toBeNull()
    expect(dropzone).not.toHaveClass('border-danger-text')

    expect(container.querySelector('[class*="ring-danger-text"]')).toBeNull()
  })

  it('prop id opsional: render tanpa id tidak crash dan tidak menghasilkan id="undefined"', () => {
    const { container } = renderBox({ error: ERROR_MESSAGE })

    expect(screen.getByRole('alert')).toHaveTextContent(ERROR_MESSAGE)
    expect(container.querySelector('[id="undefined"]')).toBeNull()
    expect(container.querySelector('[id]')).toBeNull()
  })
})

describe('UploadBox — plafon ingest 20 MB di pemilih berkas', () => {
  it('mengirim foto 6 MB (di atas plafon stored) karena kompresi terjadi setelah pemilihan', async () => {
    const { container } = renderBox()
    const photo = makeFile(6 * MB, 'foto-besar.jpg', 'image/jpeg')

    pickFile(container, photo)

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1))
    expect(mutateAsync).toHaveBeenCalledWith({ file: photo, category: 'assignment_letter' })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('mengirim PDF 8 MB — plafon stored PDF ditangguhkan ke server', async () => {
    const { container } = renderBox()
    const pdf = makeFile(8 * MB, 'spk-besar.pdf', 'application/pdf')

    pickFile(container, pdf)

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1))
    expect(mutateAsync).toHaveBeenCalledWith({ file: pdf, category: 'assignment_letter' })
  })

  it('menolak foto 21 MB dengan pesan 20 MB dan tidak menyentuh jaringan', () => {
    const { container } = renderBox()

    pickFile(container, makeFile(21 * MB, 'raksasa.jpg', 'image/jpeg'))

    expect(screen.getByRole('alert')).toHaveTextContent('20 MB')
    expect(screen.getByRole('alert')).toHaveTextContent('raksasa.jpg')
    expect(mutateAsync).not.toHaveBeenCalled()
  })

  it('menolak PDF 21 MB dengan pesan 20 MB, bukan 5 MB', () => {
    const { container } = renderBox()

    pickFile(container, makeFile(21 * MB, 'spk-raksasa.pdf', 'application/pdf'))

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('20 MB')
    expect(alert).not.toHaveTextContent('5 MB')
    expect(mutateAsync).not.toHaveBeenCalled()
  })
})
