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

import type { CreateVisitRequest, User } from '@/lib/api/types'

import { VisitForm } from './VisitForm'

/**
 * Scoping dropdown "Fasilitas Tujuan" pada sesi admin (SCR-03):
 * - datalist HANYA memuat cabang dalam cakupan sesi
 *   (`location_ids ?? [location_id]`);
 * - `super_admin` / `vendor` tetap katalog utuh (tak tersentuh);
 * - payload create membawa `location_id` TERPAKU cakupan — resolusi id/nama
 *   hanya terjadi di dalam katalog ter-scope.
 */

const { createVisitMock, sessionState } = vi.hoisted(() => ({
  createVisitMock:
    vi.fn<(variables: { body: CreateVisitRequest }) => Promise<{ id: string }>>(),
  sessionState: {
    user: {
      id: 'adm-1',
      role: 'admin',
      location_id: 'loc-1',
      location_ids: ['loc-1', 'loc-2'],
    } as Partial<User> | null,
  },
}))

const LOCATIONS = [
  {
    id: 'loc-1',
    name: 'POP Bandung',
    type: 'pop',
    address: 'Jl. Asia Afrika No. 1',
    city: 'Bandung',
    timezone: 'WIB',
  },
  {
    id: 'loc-2',
    name: 'Cabang Malang',
    type: 'cabang',
    address: 'Jl. Majapahit No. 2',
    city: 'Malang',
    timezone: 'WIB',
  },
  {
    id: 'loc-3',
    name: 'POP Singkawang',
    type: 'pop',
    address: 'Jl. Raya Singkawang No. 3',
    city: 'Singkawang',
    timezone: 'WIB',
  },
]

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({
    user: sessionState.user,
    status: 'authenticated',
  }),
}))

vi.mock('@/lib/api/hooks', () => ({
  useLocationsQuery: () => ({
    data: LOCATIONS,
    isPending: false,
    isError: false,
  }),
  usePurposesQuery: () => ({
    data: [{ id: 'pur-1', name: 'Survey' }],
    isPending: false,
    isError: false,
  }),
  useVendorsQuery: () => ({ data: [], isPending: false, isError: false }),
  useVendorAccountsQuery: () => ({ data: [], isPending: false, isError: false }),
  useVendorSuggestionsQuery: () => ({ data: [], isPending: false, isError: false }),
  useMemberSuggestionsQuery: () => ({ data: [], isPending: false, isError: false }),
  useMemberSuggestionQuery: () => ({ data: undefined, isPending: false, isError: false }),
  useVisitQuery: () => ({ data: undefined, isPending: false, isError: false }),
  useJabatanQuery: () => ({
    data: ['Mandor'],
    isPending: false,
    isError: false,
  }),
  useVisitsQuery: () => ({ data: { items: [] } }),
  useCreateVisitMutation: () => ({
    mutateAsync: createVisitMock,
    isPending: false,
  }),
  useUploadFileMutation: () => ({
    mutateAsync: vi.fn(async ({ file }: { file: File }) => ({
      file_url: `https://cdn.example/${file.name}`,
      file_name: file.name,
    })),
    isPending: false,
  }),
}))

const FACILITY_DATALIST_ID = 'visit-facility-datalist'
const LOCATION_ALIAS_DATALIST_ID = 'visit-location-datalist'

function facilityOptions(container: HTMLElement, listId: string): string[] {
  return Array.from(container.querySelectorAll(`#${listId} option`)).map(
    (option) => option.getAttribute('value') ?? '',
  )
}

function uploadInto(container: HTMLElement, anchorId: string, fileName: string): void {
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

/** Isi seluruh formulir sampai siap dikirim (pola VisitForm.test.tsx). */
async function fillVisitForm(facilityValue: string): Promise<HTMLElement> {
  const { container } = render(<VisitForm />)

  fireEvent.change(screen.getByLabelText(/Fasilitas Tujuan/), {
    target: { value: facilityValue },
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
  return container
}

function submitForm(): void {
  fireEvent.click(
    screen.getByRole('button', { name: /Kirim Permohonan Kunjungan/ }),
  )
}

beforeEach(() => {
  createVisitMock.mockReset()
  createVisitMock.mockResolvedValue({ id: 'visit-1' })
  sessionState.user = {
    id: 'adm-1',
    role: 'admin',
    location_id: 'loc-1',
    location_ids: ['loc-1', 'loc-2'],
  }
})

afterEach(cleanup)

describe('VisitForm - scoping dropdown Fasilitas Tujuan per sesi', () => {
  it('sesi admin: datalist HANYA memuat cabang cakupan (location_ids), cabang lain tak bocor', () => {
    const { container } = render(<VisitForm />)

    const options = facilityOptions(container, FACILITY_DATALIST_ID)
    expect(options).toEqual(['POP Bandung', 'Cabang Malang'])
    expect(options).not.toContain('POP Singkawang')

    // Alias datalist (saran kompatibilitas) memakai katalog yang sama.
    expect(facilityOptions(container, LOCATION_ALIAS_DATALIST_ID)).toEqual(options)
  })

  it('sesi admin tanpa location_ids -> fallback [location_id] (satu opsi)', () => {
    sessionState.user = { id: 'adm-1', role: 'admin', location_id: 'loc-2' }
    const { container } = render(<VisitForm />)

    expect(facilityOptions(container, FACILITY_DATALIST_ID)).toEqual(['Cabang Malang'])
  })

  it('sesi super_admin -> katalog utuh (tak tersentuh scoping)', () => {
    sessionState.user = { id: 'sup-1', role: 'super_admin', location_id: null }
    const { container } = render(<VisitForm />)

    expect(facilityOptions(container, FACILITY_DATALIST_ID)).toEqual([
      'POP Bandung',
      'Cabang Malang',
      'POP Singkawang',
    ])
  })

  it('sesi vendor -> katalog utuh (tak tersentuh scoping)', () => {
    sessionState.user = { id: 'vnd-1', role: 'vendor', location_id: null }
    const { container } = render(<VisitForm />)

    expect(facilityOptions(container, FACILITY_DATALIST_ID)).toHaveLength(3)
  })
})

describe('VisitForm - payload create membawa location_id dalam cakupan admin', () => {
  it('facility terpilih (nama dalam cakupan) -> body.location_id = id cabang cakupan', async () => {
    await fillVisitForm('Cabang Malang')
    submitForm()

    await waitFor(() => expect(createVisitMock).toHaveBeenCalledTimes(1))
    const body = createVisitMock.mock.calls[0]?.[0]?.body
    expect(body?.location_id).toBe('loc-2')
  })

  it('ketikan nama fasilitas LUAR cakupan -> tak pernah resolve ke id cabang lain', async () => {
    await fillVisitForm('POP Singkawang')
    submitForm()

    await waitFor(() => expect(createVisitMock).toHaveBeenCalledTimes(1))
    const body = createVisitMock.mock.calls[0]?.[0]?.body
    expect(body?.location_id).not.toBe('loc-3')
    expect(body?.location_id).toBe('POP Singkawang')
  })
})
