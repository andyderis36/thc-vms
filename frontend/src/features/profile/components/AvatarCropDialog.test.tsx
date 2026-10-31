// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, useEffect, type ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CropSource } from '@/lib/uploads/cropImage'

import { AvatarCropDialog } from './AvatarCropDialog'

const { prepareMock, cropAvatarMock, fixedAreaPixels } = vi.hoisted(() => ({
  prepareMock: vi.fn(),
  cropAvatarMock: vi.fn(),
  // Area potong tetap yang dilaporkan mock Cropper ke `onCropComplete`.
  fixedAreaPixels: { x: 8, y: 16, width: 200, height: 200 },
}))

vi.mock('@/lib/uploads/cropImage', () => ({
  prepareCropSource: prepareMock,
  cropAvatar: cropAvatarMock,
}))

// Cropper dimock sebagai stub ber-`useEffect` yang langsung melaporkan area
// potong tetap, sehingga tes tidak pernah menyentuh kanvas/decoder gambar
// nyata. `createElement` dipakai agar pabrik mock aman dari masalah hoisting.
vi.mock('react-easy-crop', () => ({
  __esModule: true,
  default: function CropperStub({
    image,
    onCropComplete,
  }: {
    image?: string
    onCropComplete?: (area: unknown, areaPixels: unknown) => void
  }) {
    useEffect(() => {
      onCropComplete?.({ x: 0, y: 0, width: 100, height: 100 }, fixedAreaPixels)
    }, [onCropComplete])
    return createElement('div', { 'data-testid': 'cropper-stub', 'data-image': image })
  },
}))

function makeSource(dispose: () => void = vi.fn()): CropSource {
  return {
    url: 'blob:crop-source',
    width: 512,
    height: 512,
    canvas: document.createElement('canvas'),
    dispose,
  }
}

function makeFile(name = 'foto.png'): File {
  return new File(['isi'], name, { type: 'image/png' })
}

function renderDialog(overrides: Partial<ComponentProps<typeof AvatarCropDialog>> = {}) {
  const props: ComponentProps<typeof AvatarCropDialog> = {
    open: true,
    file: makeFile(),
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
    ...overrides,
  }
  return { props, ...render(<AvatarCropDialog {...props} />) }
}

beforeEach(() => {
  prepareMock.mockReset()
  cropAvatarMock.mockReset()
})

afterEach(cleanup)

describe('AvatarCropDialog', () => {
  it('membuka dialog dan menyiapkan sumber pemotongan', async () => {
    prepareMock.mockResolvedValue(makeSource())

    renderDialog()

    await waitFor(() => expect(prepareMock).toHaveBeenCalledTimes(1))
    expect(prepareMock.mock.calls[0]?.[0]).toBeInstanceOf(File)

    expect(await screen.findByTestId('cropper-stub')).toHaveAttribute(
      'data-image',
      'blob:crop-source',
    )
    expect(screen.getByLabelText('Perbesaran foto')).toBeInTheDocument()
    // onCropComplete stub berjalan di useEffect setelah mount; tunggu sampai
    // area potong terisi sehingga tombol konfirmasi aktif.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Gunakan foto' })).toBeEnabled(),
    )
  })

  it('konfirmasi memotong dan meneruskan File hasil crop ke onConfirm', async () => {
    const source = makeSource()
    prepareMock.mockResolvedValue(source)
    const croppedFile = new File(['potongan'], 'foto.jpg', { type: 'image/jpeg' })
    cropAvatarMock.mockResolvedValue(croppedFile)
    const { props } = renderDialog()

    await screen.findByTestId('cropper-stub')
    // Tunggu onCropComplete stub mengisi area potong agar tombol aktif.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Gunakan foto' })).toBeEnabled(),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Gunakan foto' }))

    await waitFor(() => expect(props.onConfirm).toHaveBeenCalledTimes(1))
    expect(props.onConfirm).toHaveBeenCalledWith(croppedFile)

    expect(cropAvatarMock).toHaveBeenCalledTimes(1)
    const [cropSource, area, fileName] = cropAvatarMock.mock.calls[0] as [
      CropSource,
      typeof fixedAreaPixels,
      string,
    ]
    expect(cropSource).toBe(source)
    expect(area).toEqual(fixedAreaPixels)
    expect(fileName).toBe('foto.png')
  })

  it('membatalkan melepas sumber dan memanggil onCancel', async () => {
    const dispose = vi.fn()
    prepareMock.mockResolvedValue(makeSource(dispose))
    const { props } = renderDialog()

    await screen.findByTestId('cropper-stub')
    fireEvent.click(screen.getByRole('button', { name: 'Batal' }))

    expect(props.onCancel).toHaveBeenCalledTimes(1)
    // Tepat satu kali: cleanup efek berikutnya tidak boleh dispose ulang.
    await waitFor(() => expect(dispose).toHaveBeenCalledTimes(1))
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('cropper-stub')).not.toBeInTheDocument()
  })

  it('galat persiapan menampilkan alert dan konfirmasi nonaktif', async () => {
    prepareMock.mockRejectedValue(new Error('Gambar terlalu besar.'))
    const { props } = renderDialog()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Gambar terlalu besar.')
    expect(screen.getByRole('button', { name: 'Gunakan foto' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Batal' })).toBeEnabled()
    // Dialog tidak menutup dirinya sendiri saat galat.
    expect(props.onCancel).not.toHaveBeenCalled()
    expect(props.onConfirm).not.toHaveBeenCalled()
  })

  it('busy menonaktifkan tombol aksi', async () => {
    prepareMock.mockResolvedValue(makeSource())
    const { props } = renderDialog({ busy: true })

    await screen.findByTestId('cropper-stub')

    expect(screen.getByRole('button', { name: 'Batal' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Gunakan foto' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Batal' }))
    expect(props.onCancel).not.toHaveBeenCalled()
  })
})
