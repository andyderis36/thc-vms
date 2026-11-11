// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useVisitFile } from '@/features/visits/hooks/useVisitFile'
import { useWorkPhotoUpload } from '@/features/visits/hooks/useWorkPhotoUpload'
import type { WorkPhoto } from '@/lib/api/types'
import { WorkPhotoCard, type WorkPhotoCardProps } from './WorkPhotoCard'

vi.mock('@/features/visits/hooks/useVisitFile', () => ({
  useVisitFile: vi.fn(),
}))

vi.mock('@/features/visits/hooks/useWorkPhotoUpload', () => ({
  useWorkPhotoUpload: vi.fn(),
}))

const mockedUseVisitFile = vi.mocked(useVisitFile)
const mockedUseWorkPhotoUpload = vi.mocked(useWorkPhotoUpload)

const FILE_READY = {
  objectUrl: 'blob:http://localhost/foto-bukti',
  loading: false,
  error: null,
  retry: vi.fn(),
}

const UPLOAD_IDLE = {
  upload: vi.fn(),
  isPending: false,
  errorMessage: null,
}

const PHOTO: WorkPhoto = {
  url: 'https://storage.test/bukti/kerja.jpg',
  uploaded_at: '2026-11-05T10:00:00+07:00',
  uploaded_by_name: 'Budi Santoso',
}

function renderCard(overrides: Partial<WorkPhotoCardProps> = {}) {
  return render(
    <WorkPhotoCard
      visitId="visit-1"
      status="visiting"
      before={null}
      after={null}
      canEdit
      {...overrides}
    />,
  )
}

function fileInputs(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll('input[type="file"]'))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedUseVisitFile.mockReturnValue(FILE_READY)
  mockedUseWorkPhotoUpload.mockReturnValue(UPLOAD_IDLE)
})

describe('WorkPhotoCard — kartu terkunci sebelum check-in', () => {
  it('status approved: menampilkan petunjuk "Tersedia setelah check-in" dan menonaktifkan kontrol unggah', () => {
    renderCard({ status: 'approved', canEdit: true })

    expect(screen.getByText('Tersedia setelah check-in')).toBeInTheDocument()

    const uploadButtons = screen.getAllByRole('button', { name: /Unggah foto bukti/i })
    expect(uploadButtons).toHaveLength(2)
    for (const button of uploadButtons) {
      expect(button).toBeDisabled()
    }
    expect(fileInputs()).toHaveLength(2)
  })
})

describe('WorkPhotoCard — mengunggah saat kunjungan berlangsung', () => {
  it('status visiting + canEdit: kontrol unggah aktif, accept gambar, dan memilih berkas menjalankan hook', () => {
    renderCard({ status: 'visiting', canEdit: true })

    expect(screen.queryByText('Tersedia setelah check-in')).not.toBeInTheDocument()

    expect(screen.getByRole('heading', { level: 2, name: 'Bukti Kerja' })).toBeInTheDocument()
    expect(screen.getByText('Sebelum kerja')).toBeInTheDocument()
    expect(screen.getByText('Sesudah kerja')).toBeInTheDocument()

    const uploadButtons = screen.getAllByRole('button', { name: /Unggah foto bukti/i })
    expect(uploadButtons).toHaveLength(2)
    for (const button of uploadButtons) {
      expect(button).toBeEnabled()
    }

    const inputs = fileInputs()
    expect(inputs).toHaveLength(2)
    for (const input of inputs) {
      expect(input).toHaveAttribute('accept', 'image/jpeg,image/png')
      expect(input).toBeEnabled()
    }
    expect(screen.getAllByText('JPEG/PNG, maksimal 5 MB.')).toHaveLength(2)

    const firstInput = inputs[0]
    if (firstInput === undefined) {
      throw new Error('input file tidak ditemukan')
    }
    const file = new File(['isi'], 'bukti.jpg', { type: 'image/jpeg' })
    fireEvent.change(firstInput, { target: { files: [file] } })

    expect(UPLOAD_IDLE.upload).toHaveBeenCalledTimes(1)
    expect(UPLOAD_IDLE.upload).toHaveBeenCalledWith(file)
  })

  it('tanpa canEdit pada status visiting: kontrol tetap nonaktif dengan pesan hak akses', () => {
    renderCard({ status: 'visiting', canEdit: false })

    expect(
      screen.getByText('Anda tidak memiliki akses untuk mengunggah bukti kerja.'),
    ).toBeInTheDocument()
    for (const button of screen.getAllByRole('button', { name: /Unggah foto bukti/i })) {
      expect(button).toBeDisabled()
    }
  })
})

describe('WorkPhotoCard — slot terisi', () => {
  it('menampilkan pratinjau, metadata pengunggah, serta aksi Lihat dan Ganti', () => {
    renderCard({ status: 'visiting', canEdit: true, before: PHOTO })

    expect(screen.getByAltText('Foto bukti sebelum kerja')).toBeInTheDocument()
    expect(screen.getByText(/oleh Budi Santoso/)).toBeInTheDocument()

    expect(
      screen.getByRole('button', { name: 'Lihat foto bukti sebelum kerja' }),
    ).toBeEnabled()
    expect(
      screen.getByRole('button', { name: 'Ganti foto bukti sebelum kerja' }),
    ).toBeEnabled()

    // Slot sesudah kerja masih kosong → kontrol unggahnya tetap tersedia.
    expect(
      screen.getByRole('button', { name: 'Unggah foto bukti sesudah kerja' }),
    ).toBeEnabled()
  })

  it('tombol Lihat membuka dialog pratinjau modal, bukan tab baru', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    try {
      renderCard({ status: 'visiting', canEdit: true, before: PHOTO })

      fireEvent.click(screen.getByRole('button', { name: 'Lihat foto bukti sebelum kerja' }))

      expect(screen.getByText('Pratinjau foto bukti sebelum kerja')).toBeInTheDocument()
      expect(openSpy).not.toHaveBeenCalled()
    } finally {
      openSpy.mockRestore()
    }
  })
})

describe('WorkPhotoCard — terkunci setelah check-out', () => {
  it('status completed: petunjuk kunci tampil, foto tetap bisa dilihat, Ganti/Ganti dinonaktifkan', () => {
    renderCard({ status: 'completed', canEdit: true, before: PHOTO })

    expect(screen.getByText('Terkunci karena kunjungan sudah selesai')).toBeInTheDocument()

    expect(screen.getByAltText('Foto bukti sebelum kerja')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Lihat foto bukti sebelum kerja' }),
    ).toBeEnabled()
    expect(
      screen.getByRole('button', { name: 'Ganti foto bukti sebelum kerja' }),
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Unggah foto bukti sesudah kerja' }),
    ).toBeDisabled()
  })

  it('status cancelled: petunjuk pembatalan tampil tanpa kontrol unggah aktif', () => {
    renderCard({ status: 'cancelled', canEdit: true })

    expect(
      screen.getByText('Tidak tersedia untuk kunjungan yang dibatalkan'),
    ).toBeInTheDocument()
    for (const button of screen.getAllByRole('button', { name: /Unggah foto bukti/i })) {
      expect(button).toBeDisabled()
    }
  })
})

describe('WorkPhotoCard — jalur galat', () => {
  it('galat lampiran (pesan amplop backend) tampil inline sebagai alert pada slot yang bersangkutan', () => {
    mockedUseWorkPhotoUpload.mockImplementation(({ kind }) =>
      kind === 'before'
        ? {
            upload: vi.fn(),
            isPending: false,
            errorMessage: 'Kunjungan belum check-in sehingga bukti kerja belum dapat dilampirkan.',
          }
        : { upload: vi.fn(), isPending: false, errorMessage: null },
    )

    renderCard({ status: 'visiting', canEdit: true })

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Kunjungan belum check-in sehingga bukti kerja belum dapat dilampirkan.',
    )
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })

  it('saat unggahan berjalan: isPending menonaktifkan seluruh kontrol slot', () => {
    mockedUseWorkPhotoUpload.mockImplementation(({ kind }) =>
      kind === 'before'
        ? { upload: vi.fn(), isPending: true, errorMessage: null }
        : { upload: vi.fn(), isPending: false, errorMessage: null },
    )

    renderCard({ status: 'visiting', canEdit: true, before: PHOTO })

    expect(screen.getByRole('button', { name: 'Unggah foto bukti sesudah kerja' })).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Ganti foto bukti sebelum kerja' }),
    ).toBeDisabled()
  })
})
