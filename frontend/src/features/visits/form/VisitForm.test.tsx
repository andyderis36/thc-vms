// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CreateVisitRequest } from '@/lib/api/types'

import { VisitForm } from './VisitForm'

const { createVisitMock, uploadMock } = vi.hoisted(() => ({
  createVisitMock:
    vi.fn<(variables: { body: CreateVisitRequest }) => Promise<{ id: string }>>(),
  uploadMock:
    vi.fn<
      (variables: {
        file: File
        category: string
      }) => Promise<{ file_url: string; file_name: string }>
    >(),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({
    user: { id: 'u1', role: 'vendor', vendor_name: 'PT Uji' },
    status: 'authenticated',
  }),
}))

vi.mock('@/lib/api/hooks', () => ({
  useLocationsQuery: () => ({
    data: [
      {
        id: 'loc-1',
        name: 'POP Bandung',
        type: 'pop',
        address: 'Jl. Asia Afrika No. 1',
        city: 'Bandung',
        timezone: 'WIB',
      },
    ],
    isPending: false,
    isError: false,
  }),
  usePurposesQuery: () => ({
    data: [{ id: 'pur-1', name: 'Splicing FO' }],
    isPending: false,
    isError: false,
  }),
  useVendorsQuery: () => ({ data: [], isPending: false, isError: false }),
  useJabatanQuery: () => ({
    data: ['Mandor', 'Teknisi'],
    isPending: false,
    isError: false,
  }),
  useVisitsQuery: () => ({ data: { items: [] } }),
  useCreateVisitMutation: () => ({
    mutateAsync: createVisitMock,
    isPending: false,
  }),
  useUploadFileMutation: () => ({ mutateAsync: uploadMock, isPending: false }),
}))

/** id <datalist> yang dipakai input Jabatan (satu untuk seluruh baris). */
const JABATAN_DATALIST_ID = 'visit-jabatan-datalist'

beforeEach(() => {
  createVisitMock.mockReset()
  uploadMock.mockReset()
  uploadMock.mockImplementation(async ({ file }) => ({
    file_url: `https://cdn.example/${file.name}`,
    file_name: file.name,
  }))
  createVisitMock.mockResolvedValue({ id: 'visit-1' })
})

afterEach(cleanup)

/** Pilih berkas pada input unggahan yang berada di dalam anchor `anchorId`. */
function uploadInto(
  container: HTMLElement,
  anchorId: string,
  fileName: string,
): void {
  const input = container.querySelector(`#${anchorId} input[type="file"]`)
  if (input === null) {
    throw new Error(`input berkas tidak ditemukan di #${anchorId}`)
  }
  fireEvent.change(input, {
    target: {
      files: [new File(['binary'], fileName, { type: 'image/jpeg' })],
    },
  })
}

/**
 * Isi seluruh formulir sampai siap dikirim; `ktp` menentukan apakah foto KTP
 * anggota ikut diunggah (foto WAJIB — tanpanya submit diblokir).
 */
async function fillVisitForm(options: {
  ktp: boolean
  jabatan?: string
}): Promise<HTMLElement> {
  const { container } = render(<VisitForm />)

  fireEvent.change(screen.getByLabelText(/Fasilitas Tujuan/), {
    target: { value: 'loc-1' },
  })
  fireEvent.click(screen.getByRole('button', { name: /Tujuan Kunjungan/ }))
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Splicing FO' }))

  fireEvent.change(screen.getByLabelText(/Waktu Mulai/), {
    target: { value: '2026-09-01T09:00' },
  })
  fireEvent.change(screen.getByLabelText(/Waktu Selesai/), {
    target: { value: '2026-09-01T17:00' },
  })

  fireEvent.change(screen.getByLabelText(/Nama Lengkap/), {
    target: { value: 'Budi Santoso' },
  })
  fireEvent.change(screen.getByLabelText(/Nomor KTP \/ SIM/), {
    target: { value: '3273010501900001' },
  })
  fireEvent.change(screen.getByLabelText(/Nomor HP/), {
    target: { value: '081234567890' },
  })
  if (options.jabatan !== undefined) {
    fireEvent.change(screen.getByLabelText('Jabatan'), {
      target: { value: options.jabatan },
    })
  }

  uploadInto(container, 'visit-assignment-letter', 'spk.jpg')
  await waitFor(() => expect(screen.getByText('spk.jpg')).toBeInTheDocument())

  uploadInto(container, 'visit-tech-0-selfie', 'selfie.jpg')
  await waitFor(() => expect(screen.getByText('selfie.jpg')).toBeInTheDocument())

  if (options.ktp) {
    uploadInto(container, 'visit-tech-0-id_card_photo', 'ktp.jpg')
    await waitFor(() => expect(screen.getByText('ktp.jpg')).toBeInTheDocument())
  }

  fireEvent.click(screen.getByRole('checkbox', { name: /Saya menyatakan/ }))
  return container
}

/** Tekan tombol kirim; tunggu createVisit dipanggil (atau tidak). */
function submitForm(): void {
  fireEvent.click(
    screen.getByRole('button', { name: /Kirim Permohonan Kunjungan/ }),
  )
}

describe('VisitForm - bilah kirim tidak lengket', () => {
  it('tombol kirim berada di akhir form, SETELAH kartu SOP, tanpa sticky', () => {
    render(<VisitForm />)

    const submit = screen.getByRole('button', { name: /Kirim Permohonan Kunjungan/i })
    const bar = submit.closest('div')
    const form = submit.closest('form')

    expect(bar).not.toBeNull()
    expect(form?.lastElementChild).toBe(bar)
    expect(bar?.className).not.toContain('sticky')
    expect(bar?.className).not.toContain('bottom-')
    expect(bar?.className).toContain('border-t')
    expect(bar?.className).toContain('pt-4')
    expect(form?.className).not.toContain('pb-28')

    const sop = screen.getByText('Persetujuan SOP Keselamatan')
    expect(sop.compareDocumentPosition(bar as Element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('VisitForm - roster anggota/pengunjung', () => {
  it('memakai judul roster "Daftar Anggota/Pengunjung" dan penamaan anggota', () => {
    render(<VisitForm />)

    expect(screen.getByText('Daftar Anggota/Pengunjung')).toBeInTheDocument()
    expect(screen.getByText('Anggota 1')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Tambah Anggota$/ }),
    ).toBeInTheDocument()
    expect(screen.queryByText('Daftar Tim Teknisi')).not.toBeInTheDocument()
  })

  it('menampilkan input Jabatan dengan saran jabatan yang pernah terdaftar', () => {
    const { container } = render(<VisitForm />)

    const jabatan = screen.getByLabelText<HTMLInputElement>('Jabatan')
    expect(jabatan).toBeInTheDocument()
    expect(jabatan.getAttribute('list')).toBe(JABATAN_DATALIST_ID)

    const options = Array.from(
      container.querySelectorAll(`#${JABATAN_DATALIST_ID} option`),
    ).map((option) => option.getAttribute('value'))
    expect(options).toEqual(['Mandor', 'Teknisi'])
  })

  it('mengirim jabatan yang diketik pada payload visitors[]', async () => {
    await fillVisitForm({ ktp: true, jabatan: 'Mandor' })
    submitForm()

    await waitFor(() => expect(createVisitMock).toHaveBeenCalledTimes(1))
    const body = createVisitMock.mock.calls[0]?.[0]?.body
    expect(body?.visitors[0]?.jabatan).toBe('Mandor')
  })

  it('jabatan kosong → field jabatan tidak dikirim sama sekali', async () => {
    await fillVisitForm({ ktp: true, jabatan: '   ' })
    submitForm()

    await waitFor(() => expect(createVisitMock).toHaveBeenCalledTimes(1))
    const body = createVisitMock.mock.calls[0]?.[0]?.body
    expect(body?.visitors[0]).not.toHaveProperty('jabatan')
  })
})

describe('VisitForm - foto KTP wajib diunggah', () => {
  it('submit tanpa foto KTP diblokir: galat tampil dan permohonan tidak terkirim', async () => {
    await fillVisitForm({ ktp: false, jabatan: 'Mandor' })
    submitForm()

    expect(await screen.findByText('Foto KTP wajib diunggah.')).toBeInTheDocument()
    expect(createVisitMock).not.toHaveBeenCalled()
  })

  it('submit dengan foto KTP terkirim: rule foto KTP lolos', async () => {
    await fillVisitForm({ ktp: true })
    submitForm()

    await waitFor(() => expect(createVisitMock).toHaveBeenCalledTimes(1))
    const body = createVisitMock.mock.calls[0]?.[0]?.body
    expect(body?.visitors[0]?.id_card_photo_url).toBe(
      'https://cdn.example/ktp.jpg',
    )
    expect(screen.queryByText('Foto KTP wajib diunggah.')).not.toBeInTheDocument()
  })
})
