// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { UploadBox } from './UploadBox'

vi.mock('@/lib/api/hooks', () => ({
  useUploadFileMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

const ERROR_MESSAGE = 'Surat Tugas / SPK wajib diunggah.'
const HINT = 'PDF/JPG/PNG, maksimal 5 MB.'

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
