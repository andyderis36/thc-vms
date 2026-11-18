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

import type {
  CreateVisitRequest,
  MemberSuggestion,
  MemberSuggestionDetail,
  User,
  VendorSuggestion,
} from '@/lib/api/types'

import { VisitForm } from './VisitForm'

/**
 * SCR-03 + saran anggota (T11) & saran vendor (T9):
 * - peran vendor memilih saran anggota → autofill baris + KEDUA foto;
 * - admin/superadmin: Vendor Pengaju menyempitkan feed saran anggota
 *   (`vendor` diteruskan ke hook);
 * - ketikan manual tetap tanpa saran dan payload tidak pernah membawa id saran.
 *
 * Hook API di-mock pada batas modul (pola VisitFormVendorName.test.tsx);
 * debounce/clamp/gate peran diuji terpisah di hooks.suggestions.test.tsx.
 */

const {
  createVisitMock,
  uploadMock,
  vendorSuggestionsMock,
  memberSuggestionsMock,
  memberDetailMock,
  sessionState,
} = vi.hoisted(() => ({
  createVisitMock:
    vi.fn<(variables: { body: CreateVisitRequest }) => Promise<{ id: string }>>(),
  uploadMock:
    vi.fn<
      (variables: {
        file: File
        category: string
      }) => Promise<{ file_url: string; file_name: string }>
    >(),
  vendorSuggestionsMock:
    vi.fn<() => { data: VendorSuggestion[]; isPending: boolean; isError: boolean }>(),
  memberSuggestionsMock:
    vi.fn<
      (params: {
        q?: string
        vendor?: string
      }) => { data: MemberSuggestion[]; isPending: boolean; isError: boolean }
    >(),
  memberDetailMock:
    vi.fn<
      (visitorId: string | null) => {
        data: MemberSuggestionDetail | undefined
        isPending: boolean
        isError: boolean
      }
    >(),
  sessionState: {
    user: { id: 'u-vendor', role: 'vendor', vendor_name: null } as Partial<User> | null,
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
    data: [{ id: 'v-1', name: 'PT Katalog Lama' }],
    isPending: false,
    isError: false,
  }),
  useVendorAccountsQuery: () => ({ data: [], isPending: false, isError: false }),
  useVendorSuggestionsQuery: () => vendorSuggestionsMock(),
  useMemberSuggestionsQuery: (params: { q?: string; vendor?: string }) =>
    memberSuggestionsMock(params),
  useMemberSuggestionQuery: (visitorId: string | null) => memberDetailMock(visitorId),
  useJabatanQuery: () => ({
    data: ['Teknisi'],
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

const MEMBER: MemberSuggestion = {
  visitor_id: 'visitor-9',
  name: 'Budi Santoso',
  id_number: '3273010501900001',
  phone: '081234567890',
  email: 'budi@vendor.test',
  jabatan: 'Teknisi FO',
  last_visit_at: '2026-10-01T09:00:00+07:00',
  source_visit_id: 'visit-src-1',
}

const MEMBER_DETAIL: MemberSuggestionDetail = {
  name: MEMBER.name,
  id_number: MEMBER.id_number,
  phone: MEMBER.phone,
  email: MEMBER.email,
  jabatan: MEMBER.jabatan,
  vendor_name: 'PT Lintas Fiber',
  id_card_photo_url:
    'https://cdn.example/id_cards/1/ktp-budi.jpg?X-Amz-Signature=abc',
  photo_url: 'https://cdn.example/selfies/1/selfie-budi.jpg?X-Amz-Signature=def',
  source_visit_id: MEMBER.source_visit_id,
}

const MEMBER_B: MemberSuggestion = {
  visitor_id: 'visitor-11',
  name: 'Sari Wijaya',
  id_number: '3273010501900101',
  phone: '081298765432',
  email: 'sari@vendor.test',
  jabatan: 'Supervisor',
  last_visit_at: '2026-10-02T09:00:00+07:00',
  source_visit_id: 'visit-src-3',
}

/** Anggota kedua TANPA perusahaan + tanpa foto — harus mengosongkan baris. */
const MEMBER_B_DETAIL: MemberSuggestionDetail = {
  name: MEMBER_B.name,
  id_number: MEMBER_B.id_number,
  phone: MEMBER_B.phone,
  email: MEMBER_B.email,
  jabatan: MEMBER_B.jabatan,
  vendor_name: null,
  id_card_photo_url: null,
  photo_url: null,
  source_visit_id: MEMBER_B.source_visit_id,
}

beforeEach(() => {
  createVisitMock.mockReset()
  uploadMock.mockReset()
  vendorSuggestionsMock.mockReset()
  memberSuggestionsMock.mockReset()
  memberDetailMock.mockReset()
  sessionState.user = { id: 'u-vendor', role: 'vendor', vendor_name: null }

  uploadMock.mockImplementation(async ({ file }) => ({
    file_url: `https://cdn.example/${file.name}`,
    file_name: file.name,
  }))
  createVisitMock.mockResolvedValue({ id: 'visit-1' })
  vendorSuggestionsMock.mockReturnValue({ data: [], isPending: false, isError: false })
  memberSuggestionsMock.mockReturnValue({ data: [], isPending: false, isError: false })
  memberDetailMock.mockReturnValue({ data: undefined, isPending: false, isError: false })
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

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

/** Isi bagian non-anggota (fasilitas, tujuan, jadwal, SPK, SOP) sampai siap kirim. */
async function fillBaseVisitForm(container: HTMLElement): Promise<void> {
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

  uploadInto(container, 'visit-assignment-letter', 'spk.jpg')
  await waitFor(() => expect(screen.getByText('spk.jpg')).toBeInTheDocument())

  fireEvent.click(screen.getByRole('checkbox', { name: /Saya menyatakan/ }))
}

function submitForm(): void {
  fireEvent.click(
    screen.getByRole('button', { name: /Kirim Permohonan Kunjungan/ }),
  )
}

function nameInput(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(/Nama Lengkap/)
}

function memberDatalistOptions(): string[] {
  return Array.from(
    document.querySelectorAll('#visit-tech-0-name-datalist option'),
  ).map((option) => option.getAttribute('value') ?? '')
}

describe('VisitForm - pilihan saran anggota (peran vendor)', () => {
  it('memilih saran mengisi seluruh data baris, KEDUA foto, dan perusahaan anggota', async () => {
    memberSuggestionsMock.mockReturnValue({
      data: [MEMBER],
      isPending: false,
      isError: false,
    })
    memberDetailMock.mockReturnValue({
      data: MEMBER_DETAIL,
      isPending: false,
      isError: false,
    })

    render(<VisitForm />)
    expect(memberDatalistOptions()).toEqual([MEMBER.name])

    // Ketikan parsial (insertText) — belum memilih apa pun.
    fireEvent.input(nameInput(), {
      target: { value: 'Budi' },
      inputType: 'insertText',
    })
    expect(
      memberDetailMock.mock.calls.every(([visitorId]) => visitorId === null),
    ).toBe(true)

    // Pilihan datalist → `insertReplacementText` (kontrak peramban).
    fireEvent.input(nameInput(), {
      target: { value: MEMBER.name },
      inputType: 'insertReplacementText',
    })

    // Detail dipanggil langsung dengan id visitor dari daftar saran.
    await waitFor(() => expect(memberDetailMock).toHaveBeenCalledWith('visitor-9'))

    expect(nameInput()).toHaveValue(MEMBER.name)
    expect(screen.getByLabelText(/Nomor KTP \/ SIM/)).toHaveValue(MEMBER.id_number)
    expect(screen.getByLabelText(/Nomor HP/)).toHaveValue(MEMBER.phone)
    expect(screen.getByLabelText('Email')).toHaveValue(MEMBER.email ?? '')
    expect(screen.getByLabelText('Jabatan')).toHaveValue(MEMBER.jabatan ?? '')
    expect(screen.getByLabelText('Perusahaan Vendor')).toHaveValue('PT Lintas Fiber')
    // Chip UploadBox = pratinjau foto (nama berkas turunan dari URL presigned).
    expect(screen.getByText('ktp-budi.jpg')).toBeInTheDocument()
    expect(screen.getByText('selfie-budi.jpg')).toBeInTheDocument()

    // Hasil autofill tetap dapat diedit manual dan tidak ditimpa ulang.
    fireEvent.change(screen.getByLabelText('Perusahaan Vendor'), {
      target: { value: 'PT Manual' },
    })
    expect(screen.getByLabelText('Perusahaan Vendor')).toHaveValue('PT Manual')
  })

  it('Chrome/Edge: pilihan datalist (inputType kosong) tetap memicu autofill', async () => {
    memberSuggestionsMock.mockReturnValue({
      data: [MEMBER],
      isPending: false,
      isError: false,
    })
    memberDetailMock.mockReturnValue({
      data: MEMBER_DETAIL,
      isPending: false,
      isError: false,
    })

    render(<VisitForm />)

    // Chrome/Edge tidak mengirim `insertReplacementText` saat opsi datalist
    // dipilih; yang menentukan adalah nilai PERSIS salah satu opsi.
    fireEvent.input(nameInput(), { target: { value: MEMBER.name } })

    await waitFor(() => expect(memberDetailMock).toHaveBeenCalledWith('visitor-9'))
    expect(screen.getByLabelText(/Nomor KTP \/ SIM/)).toHaveValue(MEMBER.id_number)
    expect(screen.getByLabelText(/Nomor HP/)).toHaveValue(MEMBER.phone)
    expect(screen.getByLabelText('Email')).toHaveValue(MEMBER.email ?? '')
    expect(screen.getByLabelText('Jabatan')).toHaveValue(MEMBER.jabatan ?? '')
    expect(screen.getByLabelText('Perusahaan Vendor')).toHaveValue('PT Lintas Fiber')
  })

  it('mengetik nama lengkap persis opsi (insertText) tidak memicu autofill', () => {
    memberSuggestionsMock.mockReturnValue({
      data: [MEMBER],
      isPending: false,
      isError: false,
    })

    render(<VisitForm />)

    // Ketikan manual yang kebetulan sama dengan nama saran bukan pemilihan.
    fireEvent.input(nameInput(), {
      target: { value: MEMBER.name },
      inputType: 'insertText',
    })

    expect(
      memberDetailMock.mock.calls.every(([visitorId]) => visitorId === null),
    ).toBe(true)
    expect(screen.getByLabelText(/Nomor KTP \/ SIM/)).toHaveValue('')
    expect(screen.getByLabelText(/Nomor HP/)).toHaveValue('')
  })

  it('dua anggota bernama sama dapat dipilih terpisah lewat akhiran nomor HP', async () => {
    const other: MemberSuggestion = {
      ...MEMBER,
      visitor_id: 'visitor-10',
      phone: '089999999999',
      email: null,
      jabatan: null,
      source_visit_id: 'visit-src-2',
    }
    const otherDetail: MemberSuggestionDetail = {
      name: other.name,
      id_number: '3273010501900002',
      phone: other.phone,
      email: null,
      jabatan: null,
      vendor_name: 'PT Daya Power',
      id_card_photo_url: null,
      photo_url: null,
      source_visit_id: other.source_visit_id,
    }
    memberSuggestionsMock.mockReturnValue({
      data: [MEMBER, other],
      isPending: false,
      isError: false,
    })
    memberDetailMock.mockImplementation((visitorId) => ({
      data: visitorId === other.visitor_id ? otherDetail : MEMBER_DETAIL,
      isPending: false,
      isError: false,
    }))

    render(<VisitForm />)
    expect(memberDatalistOptions()).toEqual([
      'Budi Santoso (081234567890)',
      'Budi Santoso (089999999999)',
    ])

    fireEvent.input(nameInput(), {
      target: { value: 'Budi Santoso (089999999999)' },
      inputType: 'insertReplacementText',
    })

    await waitFor(() => expect(memberDetailMock).toHaveBeenCalledWith('visitor-10'))
    // Nama kembali kanonis (tanpa akhiran) dan data orang kedua yang terisi.
    expect(nameInput()).toHaveValue('Budi Santoso')
    expect(screen.getByLabelText(/Nomor HP/)).toHaveValue('089999999999')
    expect(screen.getByLabelText('Perusahaan Vendor')).toHaveValue('PT Daya Power')
  })

  it('detail gagal dimuat → nama kanonis dipulihkan, akhiran HP tidak terkirim', async () => {
    const other: MemberSuggestion = {
      ...MEMBER,
      visitor_id: 'visitor-10',
      phone: '089999999999',
    }
    memberSuggestionsMock.mockReturnValue({
      data: [MEMBER, other],
      isPending: false,
      isError: false,
    })
    memberDetailMock.mockImplementation((visitorId) => ({
      data: undefined,
      isPending: visitorId !== null,
      isError: visitorId !== null,
    }))

    render(<VisitForm />)

    // Pilih opsi berakhiran HP: nilai datalist != nama kanonis.
    fireEvent.input(nameInput(), {
      target: { value: 'Budi Santoso (089999999999)' },
      inputType: 'insertReplacementText',
    })

    await waitFor(() => expect(memberDetailMock).toHaveBeenCalledWith('visitor-10'))
    await waitFor(() => expect(nameInput()).toHaveValue('Budi Santoso'))
  })

  it('payload membawa foto VERBATIM tanpa id saran apa pun', async () => {
    memberSuggestionsMock.mockReturnValue({
      data: [MEMBER],
      isPending: false,
      isError: false,
    })
    memberDetailMock.mockReturnValue({
      data: MEMBER_DETAIL,
      isPending: false,
      isError: false,
    })

    const { container } = render(<VisitForm />)
    fireEvent.input(nameInput(), {
      target: { value: MEMBER.name },
      inputType: 'insertReplacementText',
    })
    await waitFor(() => expect(memberDetailMock).toHaveBeenCalledWith('visitor-9'))

    await fillBaseVisitForm(container)
    submitForm()

    await waitFor(() => expect(createVisitMock).toHaveBeenCalledTimes(1))
    const visitor = createVisitMock.mock.calls[0]?.[0]?.body.visitors[0]
    expect(visitor).toMatchObject({
      name: MEMBER.name,
      id_number: MEMBER.id_number,
      phone: MEMBER.phone,
      email: MEMBER.email,
      jabatan: MEMBER.jabatan,
      vendor_name: 'PT Lintas Fiber',
      id_card_photo_url: MEMBER_DETAIL.id_card_photo_url,
      photo_url: MEMBER_DETAIL.photo_url,
    })
    expect(visitor).not.toHaveProperty('visitor_id')
    expect(visitor).not.toHaveProperty('source_visit_id')
    expect(visitor).not.toHaveProperty('member_suggestion_id')
  })
})

describe('VisitForm - formulir baru selalu kosong', () => {
  it('tidak memakai vendor akun maupun roster autosave yang tersisa di localStorage', () => {
    sessionState.user = {
      id: 'u-vendor-roster',
      role: 'vendor',
      vendor_name: 'PT Uji',
    }
    window.localStorage.setItem(
      'thc-vms:technicians:u-vendor-roster',
      JSON.stringify({
        version: 2,
        rows: [
          {
            name: 'Roster Lama',
            phone: '081200001111',
            vendor_name: 'PT Uji',
            jabatan: 'Teknisi',
          },
        ],
      }),
    )

    const { container } = render(<VisitForm />)

    expect(nameInput()).toHaveValue('')
    expect(screen.getByLabelText(/Nomor KTP \/ SIM/)).toHaveValue('')
    expect(screen.getByLabelText(/Nomor HP/)).toHaveValue('')
    expect(screen.getByLabelText('Email')).toHaveValue('')
    expect(screen.getByLabelText('Jabatan')).toHaveValue('')
    expect(screen.getByLabelText('Perusahaan Vendor')).toHaveValue('')
    // Kedua foto mulai pada sentinel kosong (tombol unggah, bukan chip berkas).
    expect(
      screen.getByRole('button', { name: 'Unggah Foto KTP' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Unggah Foto Selfie' }),
    ).toBeInTheDocument()
    expect(container.querySelectorAll('#visit-technicians > div')).toHaveLength(1)
  })
})

describe('VisitForm - memilih saran mengganti seluruh baris', () => {
  it('saran kedua menimpa semua field dan mengosongkan Perusahaan Vendor', async () => {
    memberSuggestionsMock.mockReturnValue({
      data: [MEMBER, MEMBER_B],
      isPending: false,
      isError: false,
    })
    memberDetailMock.mockImplementation((visitorId) => ({
      data: visitorId === MEMBER_B.visitor_id ? MEMBER_B_DETAIL : MEMBER_DETAIL,
      isPending: false,
      isError: false,
    }))

    render(<VisitForm />)

    // Pilih anggota A — baris terisi lengkap termasuk perusahaan + kedua foto.
    fireEvent.input(nameInput(), {
      target: { value: MEMBER.name },
      inputType: 'insertReplacementText',
    })
    await waitFor(() =>
      expect(memberDetailMock).toHaveBeenCalledWith(MEMBER.visitor_id),
    )
    await waitFor(() =>
      expect(screen.getByLabelText('Perusahaan Vendor')).toHaveValue(
        'PT Lintas Fiber',
      ),
    )
    expect(screen.getByText('ktp-budi.jpg')).toBeInTheDocument()
    expect(screen.getByText('selfie-budi.jpg')).toBeInTheDocument()

    // Pilih anggota B — seluruh baris diganti, bukan digabung.
    fireEvent.input(nameInput(), {
      target: { value: MEMBER_B.name },
      inputType: 'insertReplacementText',
    })
    await waitFor(() =>
      expect(memberDetailMock).toHaveBeenCalledWith(MEMBER_B.visitor_id),
    )
    await waitFor(() => expect(nameInput()).toHaveValue(MEMBER_B.name))

    expect(screen.getByLabelText(/Nomor KTP \/ SIM/)).toHaveValue(
      MEMBER_B.id_number,
    )
    expect(screen.getByLabelText(/Nomor HP/)).toHaveValue(MEMBER_B.phone)
    expect(screen.getByLabelText('Email')).toHaveValue(MEMBER_B.email ?? '')
    expect(screen.getByLabelText('Jabatan')).toHaveValue(MEMBER_B.jabatan ?? '')
    // B tidak punya perusahaan → perusahaan A harus hilang (string kosong).
    expect(screen.getByLabelText('Perusahaan Vendor')).toHaveValue('')
    // B tidak punya foto → kedua foto A diganti sentinel kosong.
    expect(screen.queryByText('ktp-budi.jpg')).not.toBeInTheDocument()
    expect(screen.queryByText('selfie-budi.jpg')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Unggah Foto KTP' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Unggah Foto Selfie' }),
    ).toBeInTheDocument()
  })
})

describe('VisitForm - saran anggota disempitkan Vendor Pengaju (admin)', () => {
  beforeEach(() => {
    sessionState.user = {
      id: 'adm-1',
      role: 'admin',
      location_id: 'loc-1',
      vendor_name: null,
    }
    memberSuggestionsMock.mockReturnValue({
      data: [MEMBER],
      isPending: false,
      isError: false,
    })
  })

  it('tanpa vendor: feed cabang dikirim tanpa param vendor', () => {
    render(<VisitForm />)

    expect(memberSuggestionsMock).toHaveBeenCalledWith({ q: '', vendor: '' })
    expect(memberDatalistOptions()).toEqual([MEMBER.name])
  })

  it('Vendor Pengaju diisi → feed anggota ikut membawa ?vendor=', () => {
    render(<VisitForm />)

    fireEvent.change(screen.getByLabelText(/Vendor Pengaju/), {
      target: { value: 'PT Lintas Fiber' },
    })

    expect(memberSuggestionsMock).toHaveBeenLastCalledWith({
      q: '',
      vendor: 'PT Lintas Fiber',
    })
    // Ketikan nama anggota ikut diteruskan sebagai q.
    fireEvent.input(nameInput(), { target: { value: 'Budi' }, inputType: 'insertText' })
    expect(memberSuggestionsMock).toHaveBeenLastCalledWith({
      q: 'Budi',
      vendor: 'PT Lintas Fiber',
    })
  })

  it('feed saran vendor + katalog melengkapi datalist Vendor Pengaju', () => {
    vendorSuggestionsMock.mockReturnValue({
      data: [
        { name: 'PT Lintas Fiber', source: 'master' },
        { name: 'PT Saran Baru', source: 'history' },
      ],
      isPending: false,
      isError: false,
    })
    const { container } = render(<VisitForm />)

    const options = Array.from(
      container.querySelectorAll('#visit-company-datalist option'),
    ).map((option) => option.getAttribute('value'))
    expect(options).toEqual([
      'PT Lintas Fiber',
      'PT Saran Baru',
      'PT Katalog Lama',
    ])
  })
})

describe('VisitForm - ketikan manual anggota tetap berjalan tanpa saran', () => {
  it('nama tanpa kecocokan saran tidak memicu rantai detail dan tetap terkirim', async () => {
    memberSuggestionsMock.mockReturnValue({
      data: [MEMBER],
      isPending: false,
      isError: false,
    })

    const { container } = render(<VisitForm />)

    fireEvent.input(nameInput(), {
      target: { value: 'Orang Baru XYZ' },
      inputType: 'insertText',
    })
    fireEvent.change(nameInput(), { target: { value: 'Orang Baru XYZ' } })

    // Tak ada pilihan → query detail tak pernah aktif dengan id nyata.
    expect(
      memberDetailMock.mock.calls.every(([visitorId]) => visitorId === null),
    ).toBe(true)

    fireEvent.change(screen.getByLabelText(/Nomor KTP \/ SIM/), {
      target: { value: '3273010501900099' },
    })
    fireEvent.change(screen.getByLabelText(/Nomor HP/), {
      target: { value: '081234567899' },
    })

    await fillBaseVisitForm(container)
    uploadInto(container, 'visit-tech-0-selfie', 'selfie.jpg')
    await waitFor(() => expect(screen.getByText('selfie.jpg')).toBeInTheDocument())
    uploadInto(container, 'visit-tech-0-id_card_photo', 'ktp.jpg')
    await waitFor(() => expect(screen.getByText('ktp.jpg')).toBeInTheDocument())

    submitForm()

    await waitFor(() => expect(createVisitMock).toHaveBeenCalledTimes(1))
    const visitor = createVisitMock.mock.calls[0]?.[0]?.body.visitors[0]
    expect(visitor).toMatchObject({
      name: 'Orang Baru XYZ',
      id_number: '3273010501900099',
      phone: '081234567899',
      id_card_photo_url: 'https://cdn.example/ktp.jpg',
      photo_url: 'https://cdn.example/selfie.jpg',
    })
    expect(visitor).not.toHaveProperty('source_visit_id')
    expect(visitor).not.toHaveProperty('visitor_id')
  })
})
