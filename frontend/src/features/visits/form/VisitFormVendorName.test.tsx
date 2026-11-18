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
import { VENDOR_NAME_MAX_LENGTH } from '@/lib/limits'

import { VisitForm } from './VisitForm'

const { createVisitMock, uploadMock, accountsMock, sessionState } = vi.hoisted(() => ({
  createVisitMock:
    vi.fn<(variables: { body: CreateVisitRequest }) => Promise<{ id: string }>>(),
  uploadMock:
    vi.fn<
      (variables: {
        file: File
        category: string
      }) => Promise<{ file_url: string; file_name: string }>
    >(),
  accountsMock: vi.fn(),
  sessionState: {
    user: {
      id: 'admin-1',
      role: 'admin',
      location_id: 'loc-1',
      vendor_name: null,
    } as { id: string; role: string; location_id: string | null; vendor_name: string | null },
  },
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({
    user: sessionState.user,
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
    data: [{ id: 'pur-1', name: 'Survey' }],
    isPending: false,
    isError: false,
  }),
  useVendorsQuery: () => ({
    data: [
      { id: 'v-1', name: 'PT Lintas Fiber' },
      { id: 'v-2', name: 'PT Daya Power' },
    ],
    isPending: false,
    isError: false,
  }),
  useVendorAccountsQuery: () => accountsMock(),
  useVendorSuggestionsQuery: () => ({
    data: [
      { name: 'PT Lintas Fiber', source: 'master' },
      { name: 'PT Maju Jaya', source: 'history' },
    ],
    isPending: false,
    isError: false,
  }),
  useMemberSuggestionsQuery: () => ({ data: [], isPending: false, isError: false }),
  useMemberSuggestionQuery: () => ({ data: undefined, isPending: false, isError: false }),
  useVisitQuery: () => ({ data: undefined, isPending: false, isError: false }),
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

beforeEach(() => {
  createVisitMock.mockReset()
  uploadMock.mockReset()
  accountsMock.mockReset()
  accountsMock.mockReturnValue({
    data: [
      {
        id: 'acc-1',
        name: 'Budi Vendor',
        email: 'budi@vendor.test',
        company: 'PT Lensa Nusantara',
      },
      {
        id: 'acc-2',
        name: 'Sari Melati',
        email: 'sari@vendor.test',
        company: null,
      },
    ],
    isPending: false,
    isError: false,
  })
  sessionState.user = {
    id: 'admin-1',
    role: 'admin',
    location_id: 'loc-1',
    vendor_name: null,
  }
  uploadMock.mockImplementation(async ({ file }) => ({
    file_url: `https://cdn.example/${file.name}`,
    file_name: file.name,
  }))
  createVisitMock.mockResolvedValue({ id: 'visit-1' })
})

afterEach(cleanup)

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

async function fillVisitForm(container: HTMLElement): Promise<void> {
  fireEvent.change(screen.getByLabelText(/Fasilitas Tujuan/), {
    target: { value: 'loc-1' },
  })
  fireEvent.click(screen.getByRole('button', { name: /Keperluan Kunjungan/ }))
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Survey' }))

  fireEvent.change(screen.getByLabelText(/Waktu Mulai/), {
    target: { value: '2027-06-01T09:00' },
  })
  fireEvent.change(screen.getByLabelText(/Waktu Selesai/), {
    target: { value: '2027-06-01T17:00' },
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

  uploadInto(container, 'visit-assignment-letter', 'spk.jpg')
  await waitFor(() => expect(screen.getByText('spk.jpg')).toBeInTheDocument())

  uploadInto(container, 'visit-tech-0-selfie', 'selfie.jpg')
  await waitFor(() => expect(screen.getByText('selfie.jpg')).toBeInTheDocument())

  uploadInto(container, 'visit-tech-0-id_card_photo', 'ktp.jpg')
  await waitFor(() => expect(screen.getByText('ktp.jpg')).toBeInTheDocument())

  fireEvent.click(screen.getByRole('checkbox', { name: /Saya menyatakan/ }))
}

describe('VisitForm - Vendor/Mitra per kunjungan (admin/superadmin)', () => {
  it('menampilkan input Vendor/Mitra dengan saran feed + pelengkap katalog', () => {
    const { container } = render(<VisitForm />)

    const input = screen.getByLabelText<HTMLInputElement>(/Vendor Pengaju/)
    expect(input).toBeInTheDocument()
    expect(input).toHaveAttribute('maxlength', String(VENDOR_NAME_MAX_LENGTH))
    expect(input.getAttribute('list')).toBe('visit-company-datalist')

    // Feed `GET /vendors/suggestions` mendahului; nama katalog yang belum ada
    // di feed ikut melengkapi sehingga tidak pernah hilang (dedupe case-fold).
    const options = Array.from(
      container.querySelectorAll('#visit-company-datalist option'),
    ).map((option) => option.getAttribute('value'))
    expect(options).toEqual(['PT Lintas Fiber', 'PT Maju Jaya', 'PT Daya Power'])
  })

  it('mengirim vendor_name kunjungan yang diketik pada payload', async () => {
    const { container } = render(<VisitForm />)
    await fillVisitForm(container)

    fireEvent.change(screen.getByLabelText(/Vendor Pengaju/), {
      target: { value: 'PT Kunjungan Mandiri' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: /Kirim Permohonan Kunjungan/ }),
    )

    await waitFor(() => expect(createVisitMock).toHaveBeenCalledTimes(1))
    const body = createVisitMock.mock.calls[0]?.[0]?.body
    expect(body?.vendor_name).toBe('PT Kunjungan Mandiri')
  })

  it('vendor_name kosong → field tidak dikirim sama sekali', async () => {
    const { container } = render(<VisitForm />)
    await fillVisitForm(container)

    fireEvent.click(
      screen.getByRole('button', { name: /Kirim Permohonan Kunjungan/ }),
    )

    await waitFor(() => expect(createVisitMock).toHaveBeenCalledTimes(1))
    const body = createVisitMock.mock.calls[0]?.[0]?.body
    expect(body).not.toHaveProperty('vendor_name')
  })
})

describe('VisitForm - Akun Vendor (Pemilik Kunjungan)', () => {
  const ACCOUNT_LABEL = /Akun Vendor \(Pemilik Kunjungan\)/

  it('hanya tampil untuk admin/superadmin, bukan vendor', () => {
    const admin = render(<VisitForm />)
    expect(screen.getByLabelText(ACCOUNT_LABEL)).toBeInTheDocument()
    admin.unmount()

    sessionState.user = { ...sessionState.user, role: 'vendor' }
    render(<VisitForm />)
    expect(screen.queryByLabelText(ACCOUNT_LABEL)).not.toBeInTheDocument()
  })

  it('opsi memuat label perusahaan dan pilihan kosong yang dapat dipilih', () => {
    render(<VisitForm />)

    const select = screen.getByLabelText<HTMLSelectElement>(ACCOUNT_LABEL)
    const options = Array.from(select.options).map((option) => ({
      value: option.value,
      label: option.textContent,
    }))
    expect(options).toEqual([
      { value: '', label: '— Tanpa akun vendor —' },
      { value: 'acc-1', label: 'Budi Vendor — PT Lensa Nusantara' },
      { value: 'acc-2', label: 'Sari Melati' },
    ])
    expect(select.options[0]?.disabled).toBe(false)
  })

  it('memilih akun mengisi vendor_name dan mengirim vendor_user_id', async () => {
    const { container } = render(<VisitForm />)
    await fillVisitForm(container)

    fireEvent.change(screen.getByLabelText(ACCOUNT_LABEL), {
      target: { value: 'acc-1' },
    })
    expect(screen.getByLabelText(/Vendor Pengaju/)).toHaveValue(
      'PT Lensa Nusantara',
    )

    fireEvent.click(
      screen.getByRole('button', { name: /Kirim Permohonan Kunjungan/ }),
    )

    await waitFor(() => expect(createVisitMock).toHaveBeenCalledTimes(1))
    const body = createVisitMock.mock.calls[0]?.[0]?.body
    expect(body?.vendor_user_id).toBe('acc-1')
    expect(body?.vendor_name).toBe('PT Lensa Nusantara')
  })

  it('akun tanpa perusahaan memakai nama akun; melepas pilihan tidak menghapus vendor_name', async () => {
    render(<VisitForm />)

    fireEvent.change(screen.getByLabelText(ACCOUNT_LABEL), {
      target: { value: 'acc-2' },
    })
    const vendorInput = screen.getByLabelText(/Vendor Pengaju/)
    expect(vendorInput).toHaveValue('Sari Melati')

    fireEvent.change(screen.getByLabelText(ACCOUNT_LABEL), {
      target: { value: '' },
    })
    expect(screen.getByLabelText(ACCOUNT_LABEL)).toHaveValue('')
    expect(vendorInput).toHaveValue('Sari Melati')
  })
})
