// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { SecurityUserPanel } from './SecurityUserModal'

const { securityMembers } = vi.hoisted(() => ({
  securityMembers: [
    {
      id: 'sec-1',
      name: 'Joko Susilo',
      email: 'security.sby@thc.net.id',
      phone: '0811-3000-004',
      nik: null,
      role: 'security',
      location_id: 'a11ce5b0-7f2d-4e5a-9c1d-0000000000a1',
      location_name: 'Kantor Pusat THC (Surabaya)',
      status: 'active',
      type: 'internal',
      vendor_name: null,
      avatar_url: 'https://minio.local/avatars/joko.png',
    },
    {
      id: 'sec-2',
      name: 'Sari Dewi',
      email: 'security.dwu@thc.net.id',
      phone: '0811-3000-005',
      nik: null,
      role: 'security',
      location_id: 'a11ce5b0-7f2d-4e5a-9c1d-0000000000a1',
      location_name: 'Kantor Pusat THC (Surabaya)',
      status: 'active',
      type: 'internal',
      vendor_name: null,
      avatar_url: null,
    },
  ],
}))

vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({
    user: {
      id: 'session-id',
      name: 'Pusat',
      role: 'super_admin',
      location_id: null,
      location_name: 'Kantor Pusat',
    },
    status: 'authenticated',
    signOut: vi.fn(),
  }),
}))

vi.mock('@/lib/api/hooks', () => ({
  useCreateSecurityUserMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteSecurityUserMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useLocationsQuery: () => ({ data: [] }),
  useSecurityUsersQuery: () => ({
    data: securityMembers,
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useUpdateSecurityUserMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateSecurityUserStatusMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    variables: undefined,
  }),
  useVendorsQuery: () => ({
    data: [],
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}))

function openDetail(name: string): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: `Aksi untuk ${name}` }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Lihat detail' }))
  return screen.getByRole('dialog')
}

function avatarWrapper(dialog: HTMLElement): HTMLElement {
  const wrapper = dialog.querySelector('[data-avatar-state]')
  expect(wrapper).not.toBeNull()
  return wrapper as HTMLElement
}

describe('SecurityUserPanel — avatar pada modal detail', () => {
  it('membuka "Lihat detail" menampilkan <img> avatar dari avatar_url pengawas', () => {
    render(<SecurityUserPanel enabled />)

    const dialog = openDetail('Joko Susilo')
    const wrapper = avatarWrapper(dialog)

    expect(wrapper).toHaveAttribute('data-avatar-state', 'image')
    expect(wrapper.querySelector('img')).toHaveAttribute(
      'src',
      'https://minio.local/avatars/joko.png',
    )
    expect(dialog.querySelector('dl')?.contains(wrapper)).toBe(false)

    const row = dialog.querySelector('div.mb-3') as HTMLElement
    expect(row).not.toBeNull()
    expect(row).toHaveTextContent('Joko Susilo')
    expect(row.contains(wrapper)).toBe(true)
  })

  it('jatuh ke inisial ketika avatar_url pengawas null', () => {
    render(<SecurityUserPanel enabled />)

    const dialog = openDetail('Sari Dewi')
    const wrapper = avatarWrapper(dialog)

    expect(wrapper).toHaveAttribute('data-avatar-state', 'initials')
    expect(wrapper.querySelector('img')).toBeNull()
    expect(wrapper.textContent).toBe('SD')
  })
})
