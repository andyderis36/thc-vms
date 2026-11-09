// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SecurityUserPanel } from '@/features/security/components/SecurityUserModal'
import type { User } from '@/lib/api/types'

import { ManagedUserCreateModal } from './ManagedUserCreateModal'
import { EditUserModal } from './EditUserModal'

/**
 * Kontrak multi-cabang (model hibrida, accept-either/return-both):
 * - payload CREATE/PATCH selalu memuat `location_ids[]` (urut pilihan) DAN
 *   `location_id` = elemen PERTAMA pilihan (kompatibilitas server lama);
 * - prefill Edit: `user.location_ids ?? [user.location_id]`;
 * - field "Cabang Penugasan" = dropdown multi-select `BranchMultiSelect`
 *   (TERTUTUP saat idle: tombol trigger berisi pill/placeholder; opsi baru
 *   terlihat setelah trigger dibuka — semua interaksi uji Membuka dulu).
 * - SecurityUserPanel: opsi cabang difilter ke cakupan sesi admin
 *   (`location_ids ?? [location_id]`); super_admin melihat semua.
 */

const LOCATIONS = [
  { id: 'loc-sby', name: 'Kantor Pusat Surabaya' },
  { id: 'loc-mlg', name: 'Cabang Malang' },
  { id: 'loc-swj', name: 'POP Singkawang' },
]

const { mutateMock, sessionState } = vi.hoisted(() => ({
  mutateMock: vi.fn(),
  // Sesi untuk SecurityUserPanel diuji per kasus; null = tanpa sesi.
  sessionState: { user: null as User | null },
}))

vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({
    user: sessionState.user,
    status: 'authenticated',
    signOut: vi.fn(),
  }),
}))

vi.mock('@/lib/api/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/hooks')>()
  return {
    ...actual,
    useCreateManagedUserMutation: () => ({ mutate: mutateMock, isPending: false }),
    useVendorsQuery: () => ({
      data: [{ id: 'v-1', name: 'PT Katalog Fiber' }],
      isPending: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
    useVendorSuggestionsQuery: () => ({
      data: [{ name: 'PT Saran Riwayat', source: 'history' }],
      isPending: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
    useLocationsQuery: () => ({ data: LOCATIONS }),
    useSecurityUsersQuery: () => ({
      data: [],
      isPending: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
    useCreateSecurityUserMutation: () => ({ mutate: vi.fn(), isPending: false }),
    useDeleteSecurityUserMutation: () => ({ mutate: vi.fn(), isPending: false }),
    useUpdateSecurityUserMutation: () => ({ mutate: vi.fn(), isPending: false }),
    useUpdateSecurityUserStatusMutation: () => ({
      mutate: vi.fn(),
      isPending: false,
      variables: undefined,
    }),
  }
})

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQueries: () => [{
      data: [],
      isPending: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }],
  }
})

/** Buka dropdown "Cabang Penugasan" — prasyarat SEMUA interaksi opsi. */
function openBranchDropdown(scope?: ReturnType<typeof within>): HTMLElement {
  const trigger = (scope ?? screen).getByRole('button', { name: /Cabang Penugasan/ })
  fireEvent.click(trigger)
  return trigger
}

/** Panel opsi dropdown (role=group berlabel "Cabang Penugasan"). */
function branchPanel(scope?: ReturnType<typeof within>): HTMLElement {
  return (scope ?? screen).getByRole('group', { name: /Cabang Penugasan/ })
}

/** Klik SATU BARIS penuh (label, bukan checkbox-nya) — membuktikan full-row click. */
function clickBranchRow(name: string): void {
  const row = within(branchPanel()).getByText(name).closest('label')
  expect(row).not.toBeNull()
  fireEvent.click(row as HTMLElement)
}

function fillValidCreateForm(container: HTMLElement): HTMLFormElement {
  fireEvent.change(screen.getByLabelText(/Nama Lengkap/), {
    target: { value: 'Admin Baru' },
  })
  fireEvent.change(screen.getByLabelText(/^Email/), {
    target: { value: 'admin.baru@thc.id' },
  })
  fireEvent.change(screen.getByLabelText(/Kata Sandi/), {
    target: { value: 'rahasia123' },
  })
  fireEvent.change(screen.getByLabelText(/NIK/), {
    target: { value: '3512345678901234' },
  })
  const form = container.querySelector('form') as HTMLFormElement
  expect(form).not.toBeNull()
  return form
}

function submitForm(form: HTMLFormElement): void {
  fireEvent.submit(form)
}

describe('ManagedUserCreateModal — dropdown multi-select Cabang Penugasan', () => {
  it('tertutup: hanya tombol trigger berisi placeholder (tanpa combobox / opsi terlihat)', () => {
    render(<ManagedUserCreateModal role="admin" locations={LOCATIONS} onClose={vi.fn()} />)

    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    const trigger = screen.getByRole('button', { name: /Cabang Penugasan/ })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(within(trigger).getByText('Pilih cabang / POP')).toBeInTheDocument()
  })

  it('submit tanpa membuka dropdown (belum ada cabang) → mutasi tak dipanggil + error role=alert', () => {
    const { container } = render(
      <ManagedUserCreateModal role="admin" locations={LOCATIONS} onClose={vi.fn()} />,
    )
    const form = fillValidCreateForm(container)

    submitForm(form)

    expect(mutateMock).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Pilih minimal satu cabang / POP.')
  })

  it('membuka dropdown: baris per cabang, pill di trigger, submit location_ids[] (urut pilihan) DAN location_id = pilihan pertama', () => {
    const { container } = render(
      <ManagedUserCreateModal role="admin" locations={LOCATIONS} onClose={vi.fn()} />,
    )
    const form = fillValidCreateForm(container)

    const trigger = openBranchDropdown()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    for (const location of LOCATIONS) {
      expect(screen.getByRole('checkbox', { name: location.name })).toBeInTheDocument()
    }

    // Urut klik: Malang dulu → dialah pilihan pertama / lokasi utama.
    clickBranchRow('Cabang Malang')
    clickBranchRow('Kantor Pusat Surabaya')

    // Pill daftar cabang terpilih tampil DI TOMBOL TRIGGER (maks 2).
    const triggerAfter = screen.getByRole('button', { name: /Cabang Penugasan/ })
    expect(within(triggerAfter).getByText('Cabang Malang')).toBeInTheDocument()
    expect(within(triggerAfter).getByText('Kantor Pusat Surabaya')).toBeInTheDocument()

    submitForm(form)

    expect(mutateMock).toHaveBeenCalledTimes(1)
    const { body } = mutateMock.mock.calls[0]?.[0] as {
      body: Record<string, unknown>
    }
    expect(body.location_ids).toEqual(['loc-mlg', 'loc-sby'])
    expect(body.location_id).toBe('loc-mlg')
  })

  it('lebih dari 2 pilihan → pill maks 2 + label "+N lainnya"', () => {
    render(<ManagedUserCreateModal role="admin" locations={LOCATIONS} onClose={vi.fn()} />)

    openBranchDropdown()
    for (const location of LOCATIONS) clickBranchRow(location.name)

    const trigger = screen.getByRole('button', { name: /Cabang Penugasan/ })
    expect(within(trigger).getByText('Kantor Pusat Surabaya')).toBeInTheDocument()
    expect(within(trigger).getByText('Cabang Malang')).toBeInTheDocument()
    expect(within(trigger).getByText('+1 lainnya')).toBeInTheDocument()
    expect(within(trigger).queryByText('POP Singkawang')).toBeNull()
  })

  it('keyboard: ArrowDown membuka & fokus baris pertama, panah berpindah, Space men-toggle, Escape menutup & mengembalikan fokus ke trigger', () => {
    render(<ManagedUserCreateModal role="admin" locations={LOCATIONS} onClose={vi.fn()} />)

    const trigger = screen.getByRole('button', { name: /Cabang Penugasan/ })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const rows = screen.getAllByRole('checkbox')
    expect(rows[0]).toHaveFocus()

    fireEvent.keyDown(rows[0] as HTMLElement, { key: 'ArrowDown' })
    expect(rows[1]).toHaveFocus()

    fireEvent.keyDown(rows[1] as HTMLElement, { key: ' ' })
    expect(rows[1]).toBeChecked()

    fireEvent.keyDown(rows[1] as HTMLElement, { key: 'Escape' })
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveFocus()
  })

  it('klik di luar panel menutup dropdown', () => {
    render(<ManagedUserCreateModal role="admin" locations={LOCATIONS} onClose={vi.fn()} />)

    openBranchDropdown()
    expect(screen.getAllByRole('checkbox')).toHaveLength(LOCATIONS.length)

    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('role vendor: tanpa field cabang dan tanpa location_id/location_ids dalam payload', () => {
    const { container } = render(
      <ManagedUserCreateModal role="vendor" locations={LOCATIONS} onClose={vi.fn()} />,
    )
    expect(screen.queryByRole('button', { name: /Cabang Penugasan/ })).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    const form = fillValidCreateForm(container)

    submitForm(form)

    expect(mutateMock).toHaveBeenCalledTimes(1)
    const { body } = mutateMock.mock.calls[0]?.[0] as {
      body: Record<string, unknown>
    }
    expect('location_id' in body).toBe(false)
    expect('location_ids' in body).toBe(false)
  })

  it('role vendor: datalist Vendor menggabungkan saran feed + katalog', () => {
    const { container } = render(
      <ManagedUserCreateModal role="vendor" locations={LOCATIONS} onClose={vi.fn()} />,
    )

    const options = Array.from(
      container.querySelectorAll('#users-create-vendor-datalist option'),
    ).map((option) => option.getAttribute('value'))
    expect(options).toEqual(['PT Saran Riwayat', 'PT Katalog Fiber'])
  })
})

describe('ManagedUserCreateModal — pemetaan teks Vendor saat submit', () => {
  function submitWithVendor(vendorText: string | null): Record<string, unknown> {
    const { container } = render(
      <ManagedUserCreateModal role="vendor" locations={LOCATIONS} onClose={vi.fn()} />,
    )
    const form = fillValidCreateForm(container)
    if (vendorText !== null) {
      fireEvent.change(screen.getByLabelText('Vendor'), { target: { value: vendorText } })
    }
    submitForm(form)
    expect(mutateMock).toHaveBeenCalledTimes(1)
    return (mutateMock.mock.calls[0]?.[0] as { body: Record<string, unknown> }).body
  }

  it('memilih nama katalog dari datalist → vendor_id (tanpa vendor_name)', () => {
    const body = submitWithVendor('PT Katalog Fiber')
    expect(body.vendor_id).toBe('v-1')
    expect('vendor_name' in body).toBe(false)
  })

  it('nama di luar katalog (termasuk nama saran feed) → vendor_name manual', () => {
    const body = submitWithVendor('PT Saran Riwayat')
    expect(body.vendor_name).toBe('PT Saran Riwayat')
    expect('vendor_id' in body).toBe(false)
  })

  it('vendor dikosongkan → tanpa vendor_id maupun vendor_name dalam payload', () => {
    const body = submitWithVendor(null)
    expect('vendor_id' in body).toBe(false)
    expect('vendor_name' in body).toBe(false)
  })
})

function adminUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    name: 'Agus Setiawan',
    email: 'admin@thc.id',
    phone: '08111111111',
    nik: '3512345678901234',
    role: 'admin',
    location_id: 'loc-sby',
    location_name: 'Kantor Pusat Surabaya',
    status: 'active',
    type: 'internal',
    vendor_name: null,
    avatar_url: null,
    ...overrides,
  }
}

function renderEdit(user: User, locationMode: 'select' | 'locked' | 'hidden') {
  const onSubmit = vi.fn()
  const view = render(
    <EditUserModal
      user={user}
      locations={LOCATIONS}
      saving={false}
      locationMode={locationMode}
      isSelf={false}
      onClose={vi.fn()}
      onSubmit={onSubmit}
    />,
  )
  return { ...view, onSubmit }
}

describe('EditUserModal — prefill & submit multi-cabang', () => {
  it('prefill dari user.location_ids (semua entri tercentang setelah dropdown dibuka)', () => {
    const user = adminUser({ location_id: 'loc-mlg', location_ids: ['loc-mlg', 'loc-sby'] })
    renderEdit(user, 'select')

    openBranchDropdown()
    expect(screen.getByRole('checkbox', { name: 'Cabang Malang' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Kantor Pusat Surabaya' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'POP Singkawang' })).not.toBeChecked()

    // Pill prefill juga tampil di trigger tertutup… yang kini terbuka.
    const trigger = screen.getByRole('button', { name: /Cabang Penugasan/ })
    expect(within(trigger).getByText('Cabang Malang')).toBeInTheDocument()
    expect(within(trigger).getByText('Kantor Pusat Surabaya')).toBeInTheDocument()
  })

  it('prefill fallback: location_ids absen → [location_id]', () => {
    const user = adminUser({ location_id: 'loc-sby', location_ids: undefined })
    renderEdit(user, 'select')

    openBranchDropdown()
    expect(screen.getByRole('checkbox', { name: 'Kantor Pusat Surabaya' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Cabang Malang' })).not.toBeChecked()
  })

  it('submit locationMode=select mengirim location_id (elemen pertama) + location_ids[]', () => {
    const user = adminUser({ location_id: 'loc-sby', location_ids: ['loc-sby'] })
    const { container, onSubmit } = renderEdit(user, 'select')

    openBranchDropdown()
    clickBranchRow('POP Singkawang')
    clickBranchRow('Cabang Malang')
    fireEvent.submit(container.querySelector('form') as HTMLFormElement)

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const body = onSubmit.mock.calls[0]?.[0] as Record<string, unknown>
    // Prefill lama (loc-sby) tetap elemen pertama → lokasi utama tak bergeser;
    // pilihan baru menyusul sesuai urut klik (Singkawang, lalu Malang).
    expect(body.location_ids).toEqual(['loc-sby', 'loc-swj', 'loc-mlg'])
    expect(body.location_id).toBe('loc-sby')
  })

  it('tanpa cabang terpilih pada mode select → onSubmit tidak dipanggil + error role=alert', () => {
    const user = adminUser({ location_id: 'loc-sby', location_ids: undefined })
    const { container, onSubmit } = renderEdit(user, 'select')

    // Lepas satu-satunya pilihan hasil prefill (buka dropdown dulu).
    openBranchDropdown()
    clickBranchRow('Kantor Pusat Surabaya')
    fireEvent.submit(container.querySelector('form') as HTMLFormElement)

    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Pilih minimal satu cabang / POP.')
  })

  it('locationMode=hidden: tanpa field cabang dan tanpa location di payload', () => {
    const user = adminUser({ role: 'super_admin', location_id: null, location_ids: undefined, nik: null })
    const { container, onSubmit } = renderEdit(user, 'hidden')

    expect(screen.queryByRole('button', { name: /Cabang Penugasan/ })).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.submit(container.querySelector('form') as HTMLFormElement)

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const body = onSubmit.mock.calls[0]?.[0] as Record<string, unknown>
    expect('location_id' in body).toBe(false)
    expect('location_ids' in body).toBe(false)
  })

  it('target vendor: datalist Vendor menggabungkan saran feed + katalog', () => {
    const user = adminUser({
      role: 'vendor',
      location_id: null,
      location_ids: undefined,
      vendor_name: 'PT Katalog Fiber',
    })
    const { container } = renderEdit(user, 'hidden')

    const options = Array.from(
      container.querySelectorAll('#edit-user-vendor-datalist option'),
    ).map((option) => option.getAttribute('value'))
    expect(options).toEqual(['PT Saran Riwayat', 'PT Katalog Fiber'])
  })
})

describe('EditUserModal — pemetaan teks Vendor saat simpan', () => {
  function vendorUser(vendorName: string | null): User {
    return adminUser({
      role: 'vendor',
      location_id: null,
      location_ids: undefined,
      vendor_name: vendorName,
    })
  }

  function submitVendorEdit(
    initialVendorName: string | null,
    nextText: string,
  ): Record<string, unknown> {
    const { container, onSubmit } = renderEdit(vendorUser(initialVendorName), 'hidden')
    fireEvent.change(screen.getByLabelText('Vendor'), { target: { value: nextText } })
    fireEvent.submit(container.querySelector('form') as HTMLFormElement)
    expect(onSubmit).toHaveBeenCalledTimes(1)
    return onSubmit.mock.calls[0]?.[0] as Record<string, unknown>
  }

  it('diubah ke nama katalog persis (case-insensitive) → vendor_id (tanpa vendor_name)', () => {
    const body = submitVendorEdit('PT Saran Riwayat', 'pt katalog fiber')
    expect(body.vendor_id).toBe('v-1')
    expect('vendor_name' in body).toBe(false)
  })

  it('diubah ke nama di luar katalog (termasuk nama saran feed) → vendor_name manual', () => {
    const body = submitVendorEdit('PT Katalog Fiber', 'PT Saran Riwayat')
    expect(body.vendor_name).toBe('PT Saran Riwayat')
    expect('vendor_id' in body).toBe(false)
  })

  it('dikosongkan → vendor_name: \'\' (bersihkan kolom), tanpa vendor_id', () => {
    const body = submitVendorEdit('PT Katalog Fiber', '')
    expect(body.vendor_name).toBe('')
    expect('vendor_id' in body).toBe(false)
  })

  it('tak diubah dari prefill → tanpa field vendor sama sekali', () => {
    const { container, onSubmit } = renderEdit(vendorUser('PT Katalog Fiber'), 'hidden')
    fireEvent.submit(container.querySelector('form') as HTMLFormElement)
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const body = onSubmit.mock.calls[0]?.[0] as Record<string, unknown>
    expect('vendor_id' in body).toBe(false)
    expect('vendor_name' in body).toBe(false)
  })
})

describe('SecurityUserPanel — filter opsi cabang sesuai cakupan sesi', () => {
  afterEach(() => {
    cleanup()
    sessionState.user = null
  })

  it('admin hanya melihat cabang cakupannya (location_ids ?? [location_id]); super_admin melihat semua', () => {
    // 1) Admin dengan location_ids[]: hanya entri cakupan yang jadi opsi.
    sessionState.user = adminUser({ location_ids: ['loc-sby', 'loc-mlg'] })
    render(<SecurityUserPanel enabled />)
    fireEvent.click(screen.getByRole('button', { name: 'Tambah Pengawas' }))
    let scope = within(screen.getByRole('dialog'))
    openBranchDropdown(scope)
    scope = within(screen.getByRole('dialog'))
    expect(scope.getByRole('checkbox', { name: 'Kantor Pusat Surabaya' })).toBeInTheDocument()
    expect(scope.getByRole('checkbox', { name: 'Cabang Malang' })).toBeInTheDocument()
    expect(scope.queryByRole('checkbox', { name: 'POP Singkawang' })).toBeNull()
    cleanup()

    // 2) Fallback: location_ids absen → [location_id] (lokasi utama saja).
    sessionState.user = adminUser({ location_ids: undefined })
    render(<SecurityUserPanel enabled />)
    fireEvent.click(screen.getByRole('button', { name: 'Tambah Pengawas' }))
    scope = within(screen.getByRole('dialog'))
    openBranchDropdown(scope)
    scope = within(screen.getByRole('dialog'))
    expect(scope.getByRole('checkbox', { name: 'Kantor Pusat Surabaya' })).toBeInTheDocument()
    expect(scope.queryByRole('checkbox', { name: 'Cabang Malang' })).toBeNull()
    expect(scope.queryByRole('checkbox', { name: 'POP Singkawang' })).toBeNull()
    cleanup()

    // 3) Superadmin: tanpa filter — semua cabang tampil.
    sessionState.user = adminUser({
      role: 'super_admin',
      location_id: null,
      location_ids: undefined,
      location_name: 'Kantor Pusat',
      nik: null,
    })
    render(<SecurityUserPanel enabled />)
    fireEvent.click(screen.getByRole('button', { name: 'Tambah Pengawas' }))
    scope = within(screen.getByRole('dialog'))
    openBranchDropdown(scope)
    scope = within(screen.getByRole('dialog'))
    for (const location of LOCATIONS) {
      expect(scope.getByRole('checkbox', { name: location.name })).toBeInTheDocument()
    }
  })
})
