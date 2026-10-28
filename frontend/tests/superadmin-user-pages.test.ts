// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement, type ImgHTMLAttributes, type ReactNode } from 'react'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest'

import { COORDINATORS_PAGE_ROLES } from '@/app/coordinators/page'
import { VENDOR_REGISTRATIONS_PAGE_ROLES } from '@/app/vendor-registrations/page'
import { SuperadminShell } from '@/components/layouts/SuperadminShell'
import { ManagedUserTable } from '@/features/users/components/ManagedUserTable'
import { ManagedUsersScreen } from '@/features/users/components/ManagedUsersScreen'
import {
  filterManagedUsersByRoles,
  managedServerRoleParam,
  toManagedUserListParams,
  type ManagedPageRole,
} from '@/features/users/managed-user-filters'
import type { User } from '@/lib/api/types'
import { NAV_LABELS } from '@/lib/nav/labels'
import { TABLE_CLASS, TABLE_WRAPPER_CLASS } from '@/lib/table-styles'
import {
  AVATAR_OBJECT_URL,
  installAvatarFetchStubs,
  mockAvatarImage,
} from '@/test-utils/avatarFetch'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

vi.mock('next/image', () => ({
  default: (props: ImgHTMLAttributes<HTMLImageElement>) => createElement('img', props),
}))

vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({
    user: { id: 'me-id', name: 'Pusat', role: 'super_admin', location_name: 'Pontianak' },
    status: 'authenticated',
    signOut: vi.fn(),
  }),
}))

vi.mock('@/components/ui/NotificationsMenu', () => ({
  NotificationsMenu: ({ className }: { className?: string }) =>
    createElement('div', { 'data-testid': 'notif-menu', className }),
}))

/**
 * Data user terkelola untuk layer layar: satu baris per peran. Akun
 * `super_admin` TIDAK punya cabang (location_id null) — itulah sebabnya
 * backend tak bisa menyaringnya lewat `?location_id=`.
 */
const { managedUsersFixture } = vi.hoisted(() => ({
  managedUsersFixture: [
    {
      id: 'u-admin',
      name: 'Bayu Santoso',
      email: 'koordinator.sby@thc.net.id',
      phone: '0811-3000-002',
      nik: '3201010101990001',
      role: 'admin',
      location_id: 'loc-1',
      location_name: 'Kantor Cabang Malang',
      status: 'active',
      type: 'internal',
      vendor_name: null,
      avatar_url: '/api/v1/avatars/0d1f5f4e-6a0b-4c1d-9e8f-1a2b3c4d5e6f?v=1a2b3c4d',
    },
    {
      id: 'u-super',
      name: 'Agus Salim',
      email: 'superadmin@thc.net.id',
      phone: '0811-3000-003',
      nik: '3201010101990002',
      role: 'super_admin',
      location_id: null,
      location_name: null,
      status: 'active',
      type: 'internal',
      vendor_name: null,
      avatar_url: null,
    },
    {
      id: 'u-vendor',
      name: 'Citra Lestari',
      email: 'vendor@lintasfiber.co.id',
      phone: '0811-3000-004',
      nik: '3201010101990003',
      role: 'vendor',
      location_id: null,
      location_name: null,
      status: 'active',
      type: 'external',
      vendor_name: 'PT Lintas Fiber',
      avatar_url: null,
    },
  ],
}))

vi.mock('@/lib/api/hooks', () => ({
  useDeleteManagedUserMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useLocationsQuery: () => ({ data: [] }),
  useManagedUsersQuery: () => ({
    data: managedUsersFixture,
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  usePendingApprovalCount: () => ({ pendingCount: 0 }),
  useUpdateManagedUserMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateManagedUserStatusMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    variables: undefined,
  }),
}))

/** jsdom tidak menyediakan `matchMedia`; efek laci shell memanggilnya saat dibuka. */
beforeAll(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
})

afterAll(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  cleanup()
})

/** Stub avatar: `fetch` + object URL dipasang ulang tiap uji (jsdom tanpa object URL asli). */
let fetchMock: Mock<typeof fetch>

beforeEach(() => {
  fetchMock = installAvatarFetchStubs().fetchMock
})

function userStub(overrides: Partial<User> = {}): User {
  return {
    id: 'u-1',
    name: 'Bayu Santoso',
    email: 'koordinator.sby@thc.net.id',
    phone: '0811-3000-002',
    nik: '3201010101990001',
    role: 'admin',
    location_id: 'a11ce5b0-7f2d-4e5a-9c1d-0000000000a1',
    location_name: 'Kantor Cabang Malang',
    status: 'active',
    type: 'internal',
    vendor_name: null,
    avatar_url: null,
    ...overrides,
  }
}

function renderShell(): void {
  const children: ReactNode = createElement('div', null, 'konten')
  render(createElement(SuperadminShell, null, children))
}

/** Render layar user terkelola untuk satu set peran cakupan halaman. */
function renderScreen(roles: readonly ManagedPageRole[]): HTMLElement {
  const { container } = render(
    createElement(ManagedUsersScreen, {
      roles,
      activeHref: '/coordinators',
      title: 'Judul Uji',
      subtitle: 'Subjudul uji',
    }),
  )
  return container
}

/** Tabel desktop di dalam container layar (satu-satunya `<table>` per layar). */
function tableOf(container: HTMLElement): HTMLElement {
  const table = container.querySelector('table')
  if (table === null) throw new Error('tabel user terkelola tak dirender')
  return table as HTMLElement
}

describe('NAV_LABELS — label menu superadmin per peran', () => {
  it('memiliki label desktop persis untuk kedua halaman akun', () => {
    expect(NAV_LABELS.coordinators.desktop).toBe('Koordinator Wilayah')
    expect(NAV_LABELS.vendorRegistrations.desktop).toBe('Pendaftaran Vendor/Mitra')
  })

  it('kunci /users sudah dihapus (akun superadmin pindah ke /coordinators)', () => {
    expect('users' in NAV_LABELS).toBe(false)
  })

  it('kedua halaman akun punya label mobile ringkas', () => {
    expect(NAV_LABELS.coordinators.mobile.length).toBeGreaterThan(0)
    expect(NAV_LABELS.vendorRegistrations.mobile.length).toBeGreaterThan(0)
  })
})

describe('SuperadminShell — pemisahan menu per peran', () => {
  it('sidebar memuat link Koordinator Wilayah ke /coordinators', () => {
    renderShell()

    const link = screen.getByRole('link', { name: 'Koordinator Wilayah' })
    expect(link.getAttribute('href')).toBe('/coordinators')
  })

  it('sidebar memuat link Pendaftaran Vendor/Mitra ke /vendor-registrations', () => {
    renderShell()

    const link = screen.getByRole('link', { name: 'Pendaftaran Vendor/Mitra' })
    expect(link.getAttribute('href')).toBe('/vendor-registrations')
  })

  it('sidebar tak lagi memuat entry "Users"', () => {
    renderShell()

    expect(screen.queryByRole('link', { name: 'Users' })).toBeNull()
    expect(document.querySelector('aside nav a[href="/users"]')).toBeNull()
  })

  it('menu akun duduk setelah /security dan sebelum /audit', () => {
    renderShell()

    const hrefs = Array.from(document.querySelectorAll('aside nav a')).map((anchor) =>
      anchor.getAttribute('href'),
    )
    expect(hrefs).toEqual([
      '/dashboard',
      '/approvals',
      '/facilities',
      '/security',
      '/coordinators',
      '/vendor-registrations',
      '/audit',
    ])
  })
})

describe('cakupan peran tiap halaman user terkelola', () => {
  it('halaman Koordinator Wilayah memuat admin DAN super_admin', () => {
    expect([...COORDINATORS_PAGE_ROLES]).toEqual(['admin', 'super_admin'])
  })

  it('halaman >1 peran requesting TANPA ?role= (backend menolak ?role=super_admin)', () => {
    const serverRole = managedServerRoleParam(COORDINATORS_PAGE_ROLES)
    expect(serverRole).toBe('')
    expect(
      toManagedUserListParams({ role: serverRole, search: '', locationId: 'all' }),
    ).toEqual({})
  })

  it('halaman Pendaftaran Vendor/Mitra memuat vendor saja', () => {
    expect([...VENDOR_REGISTRATIONS_PAGE_ROLES]).toEqual(['vendor'])
    const serverRole = managedServerRoleParam(VENDOR_REGISTRATIONS_PAGE_ROLES)
    expect(serverRole).toBe('vendor')
    expect(
      toManagedUserListParams({ role: serverRole, search: '', locationId: 'all' }),
    ).toEqual({ role: 'vendor' })
  })

  it('penyaringan peran di klien menyisakan hanya peran cakupan halaman', () => {
    const rows = [
      userStub({ id: 'u-admin', role: 'admin' }),
      userStub({ id: 'u-super', role: 'super_admin' }),
      userStub({ id: 'u-vendor', role: 'vendor' }),
    ]
    expect(
      filterManagedUsersByRoles(rows, COORDINATORS_PAGE_ROLES).map((row) => row.id),
    ).toEqual(['u-admin', 'u-super'])
    expect(
      filterManagedUsersByRoles(rows, VENDOR_REGISTRATIONS_PAGE_ROLES).map((row) => row.id),
    ).toEqual(['u-vendor'])
  })
})

describe('tabel user terkelola — base UI bersama', () => {
  it('memakai token TABLE_* yang sama untuk semua halaman', () => {
    const client = new QueryClient()
    const { container } = render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ManagedUserTable, {
          users: [userStub()],
          currentUserId: 'me-id',
          viewerRole: 'super_admin',
          onDelete: () => undefined,
          onEdit: () => undefined,
          onView: () => undefined,
        }),
      ),
    )

    const table = container.querySelector('table')
    expect(table).not.toBeNull()
    expect(table?.className).toBe(TABLE_CLASS)
    expect(table?.parentElement?.className).toBe(TABLE_WRAPPER_CLASS)
    expect(container.querySelector('tbody')?.className).toContain('divide-y')
    expect(table?.querySelector('tbody tr')?.className).toContain('hover:bg-brand/5')
    expect(table?.querySelector('th[scope="col"]')).not.toBeNull()
  })

  it('menampilkan pil peran sesuai label peran aplikasi', () => {
    const client = new QueryClient()
    render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ManagedUserTable, {
          users: [userStub()],
          currentUserId: 'me-id',
          viewerRole: 'super_admin',
          onDelete: () => undefined,
          onEdit: () => undefined,
          onView: () => undefined,
        }),
      ),
    )

    expect(screen.getByText('Koordinator Wilayah')).toBeInTheDocument()
  })

  it('token TABLE_* yang sama dipakai di setiap halaman user terkelola', () => {
    for (const roles of [COORDINATORS_PAGE_ROLES, VENDOR_REGISTRATIONS_PAGE_ROLES]) {
      const container = renderScreen(roles)
      const table = tableOf(container)

      expect(table.className).toBe(TABLE_CLASS)
      expect(table.parentElement?.className).toBe(TABLE_WRAPPER_CLASS)
      expect(table.querySelector('tbody')?.className).toContain('divide-y')
      expect(table.querySelector('tbody tr')?.className).toContain('hover:bg-brand/5')
      expect(table.querySelector('th[scope="col"]')).not.toBeNull()
      cleanup()
    }
  })
})

describe('layar user terkelola — filter peran di kolom "Peran"', () => {
  it('halaman Koordinator Wilayah menampilkan akun admin DAN super_admin sekaligus', () => {
    const table = tableOf(renderScreen(COORDINATORS_PAGE_ROLES))

    expect(within(table).getByText('Bayu Santoso')).toBeInTheDocument()
    expect(within(table).getByText('Agus Salim')).toBeInTheDocument()
    expect(within(table).queryByText('Citra Lestari')).toBeNull()
  })

  it('filter peran hidup di dalam header kolom "Peran" dan default "Semua Peran"', () => {
    const table = tableOf(renderScreen(COORDINATORS_PAGE_ROLES))
    const header = within(table).getByRole('columnheader', { name: /Peran/ })
    const select = within(header as HTMLElement).getByLabelText('Filter peran')

    expect(select.tagName).toBe('SELECT')
    expect((select as HTMLSelectElement).value).toBe('')
    expect(Array.from((select as HTMLSelectElement).options).map((option) => option.text)).toEqual([
      'Semua Peran',
      'Koordinator Wilayah',
      'Superadmin',
    ])
  })

  it('memilih peran menyaring baris tabel ke peran itu', () => {
    const table = tableOf(renderScreen(COORDINATORS_PAGE_ROLES))
    const select = within(table).getByLabelText('Filter peran')

    fireEvent.change(select, { target: { value: 'super_admin' } })

    expect(within(table).queryByText('Bayu Santoso')).toBeNull()
    expect(within(table).getByText('Agus Salim')).toBeInTheDocument()
  })

  it('layar < lg punya cermin filter peran di filter bar', () => {
    renderScreen(COORDINATORS_PAGE_ROLES)

    // Dua kontrol: header kolom "Peran" (desktop) + filter bar (ponsel/tablet).
    expect(screen.getAllByLabelText('Filter peran')).toHaveLength(2)
  })

  it('halaman satu peran tak merender kontrol filter peran', () => {
    const table = tableOf(renderScreen(VENDOR_REGISTRATIONS_PAGE_ROLES))

    expect(within(table).queryByLabelText('Filter peran')).toBeNull()
    expect(screen.queryAllByLabelText('Filter peran')).toHaveLength(0)
  })

  it('tombol tambah memakai peran utama halaman saat filter "Semua Peran"', () => {
    renderScreen(COORDINATORS_PAGE_ROLES)

    expect(screen.getByRole('button', { name: 'Tambah Koordinator Wilayah' })).toBeInTheDocument()
  })

  it('tombol tambah disembunyikan saat peran super_admin dipilih', () => {
    const table = tableOf(renderScreen(COORDINATORS_PAGE_ROLES))

    fireEvent.change(within(table).getByLabelText('Filter peran'), {
      target: { value: 'super_admin' },
    })

    expect(screen.queryByRole('button', { name: 'Tambah Koordinator Wilayah' })).toBeNull()
  })

  it('filter cabang tak lagi dikirim ke server saat peran super_admin dipilih', () => {
    const table = tableOf(renderScreen(COORDINATORS_PAGE_ROLES))

    // Filter cabang tampil saat peran efektif masih memuat `admin`.
    expect(screen.getByLabelText('Cabang')).toBeInTheDocument()

    fireEvent.change(within(table).getByLabelText('Filter peran'), {
      target: { value: 'super_admin' },
    })

    // Akun super_admin tak punya cabang, jadi filter cabang disembunyikan.
    expect(screen.queryByLabelText('Cabang')).toBeNull()
  })
})

describe('modal detail user — avatar identitas', () => {
  function openDetail(container: HTMLElement, name: string): HTMLElement {
    const table = tableOf(container)
    fireEvent.click(within(table).getByRole('button', { name: `Aksi untuk ${name}` }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Lihat detail' }))
    return screen.getByRole('dialog')
  }

  it('membuka "Lihat detail" menampilkan <img> avatar dari object URL blob baris', async () => {
    mockAvatarImage(fetchMock)
    const dialog = openDetail(renderScreen(COORDINATORS_PAGE_ROLES), 'Bayu Santoso')

    const wrapper = dialog.querySelector('[data-avatar-state]') as HTMLElement
    expect(wrapper).not.toBeNull()
    await waitFor(() => {
      expect(wrapper).toHaveAttribute('data-avatar-state', 'image')
    })
    expect(wrapper.querySelector('img')).toHaveAttribute('src', AVATAR_OBJECT_URL)
    expect(dialog.querySelector('dl')?.contains(wrapper)).toBe(false)

    const row = dialog.querySelector('div.mb-3') as HTMLElement
    expect(row).not.toBeNull()
    expect(row).toHaveTextContent('Bayu Santoso')
    expect(row.contains(wrapper)).toBe(true)
  })

  it('jatuh ke inisial ketika avatar_url baris null', () => {
    const dialog = openDetail(renderScreen(COORDINATORS_PAGE_ROLES), 'Agus Salim')

    const wrapper = dialog.querySelector('[data-avatar-state]') as HTMLElement
    expect(wrapper).not.toBeNull()
    expect(wrapper).toHaveAttribute('data-avatar-state', 'initials')
    expect(wrapper.querySelector('img')).toBeNull()
    expect(wrapper.textContent).toBe('AS')
  })
})
