// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Role, User } from '@/lib/api/types'
import { ApiError } from '@/lib/api/fetcher'

import SettingsNotificationsPage from './page'

const { session, queryState, mutationState, toastMock, refetchMock } = vi.hoisted(() => {
  const refetchMock = vi.fn()
  const toastMock = { success: vi.fn(), error: vi.fn() }
  const queryState = {
    data: null as unknown,
    isPending: false,
    isError: false,
    error: null as unknown,
    refetch: refetchMock,
  }
  const mutationState = {
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }
  return {
    session: { user: null as User | null },
    queryState,
    mutationState,
    toastMock,
    refetchMock,
  }
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}))

vi.mock('@/lib/auth/guards', () => ({
  RequireRole: ({ children }: { children: ReactNode }) => children,
}))

vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({ user: session.user, status: 'authenticated', refresh: vi.fn() }),
}))

vi.mock('@/lib/api/hooks', () => ({
  usePendingApprovalCount: () => ({ pendingCount: 0, isPending: false, isError: false, refetch: vi.fn() }),
  useNotificationSettingsQuery: () => ({ ...queryState }),
  useUpdateNotificationSettingsMutation: () => ({ ...mutationState }),
}))

vi.mock('@/components/layouts/SuperadminShell', () => ({
  SuperadminShell: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-testid': 'superadmin-shell' }, children),
}))

vi.mock('sonner', () => ({ toast: toastMock }))

function makeUser(role: Role): User {
  return {
    id: `u-${role}`,
    name: 'Budi Santoso',
    email: 'budi@thc.id',
    phone: '081234567890',
    nik: null,
    role,
    location_id: 'loc-1',
    location_name: 'POP Jakarta',
    status: 'active',
    type: 'internal',
    vendor_name: null,
    avatar_url: null,
    editable_fields: [],
  }
}

function makeData() {
  const events = ['visit_requested', 'visit_approved', 'visit_rejected', 'visit_rescheduled', 'visit_check_in', 'visit_check_out', 'visit_cancelled', 'visit_auto_cancelled', 'visit_reminder']
  const mandatory = new Set(['visit_approved', 'visit_rejected', 'visit_cancelled', 'visit_auto_cancelled'])
  // Peta kaki backend: sel vendor yang tidak punya jalur pengiriman. Baris
  // yang diminta tidak punya kaki vendor sama sekali, sedangkan baris
  // check-in/check-out hanya kehilangan sel in_app vendor - sel email vendor
  // tetap hidup karena roster fan-out memails anggota roster.
  const withoutVendorLeg = new Set(['visit_requested'])
  const withoutInAppVendorLeg = new Set(['visit_requested', 'visit_check_in', 'visit_check_out'])
  return {
    toggles: events.map((event, i) => {
      const inAppVendor = !withoutInAppVendorLeg.has(event)
      const emailVendor = !withoutVendorLeg.has(event)
      return {
        event,
        in_app: { staff: true, vendor: i % 2 === 0 && inAppVendor },
        email: { staff: i % 3 === 0, vendor: emailVendor },
        mandatory: mandatory.has(event),
        applicable: {
          in_app: { staff: true, vendor: inAppVendor },
          email: { staff: true, vendor: emailVendor },
        },
      }
    }),
    version: 7,
  }
}

beforeEach(() => {
  session.user = makeUser('super_admin')
  queryState.data = makeData()
  queryState.isPending = false
  queryState.isError = false
  queryState.error = null
  queryState.refetch = refetchMock
  mutationState.mutate.mockReset()
  mutationState.mutateAsync.mockReset()
  mutationState.isPending = false
  toastMock.success.mockReset()
  toastMock.error.mockReset()
  refetchMock.mockReset()
})

afterEach(cleanup)

describe('/settings/notifications', () => {
  it('renders 9 rows from mocked GET', () => {
    render(createElement(SettingsNotificationsPage))
    // 9 baris × 4 sel × 2 permukaan (desktop + mobile), dikurangi 4 sel mati
    // (visit_requested in_app/email vendor, check_in/check_out in_app vendor)
    // yang kini diganti placeholder "-" tanpa checkbox.
    expect(screen.getAllByRole('checkbox')).toHaveLength(9 * 4 * 2 - 4 * 2)
  })

  it('non-mandatory toggle triggers PUT with correct version + full payload', async () => {
    // make mutate invoke onSuccess
    mutationState.mutate.mockImplementation((payload, opts) => {
      opts?.onSuccess?.({ toggles: payload.toggles, version: payload.version })
    })
    render(createElement(SettingsNotificationsPage))
    const checkboxes = screen.getAllByRole('checkbox')
    const enabledCb = checkboxes.find((cb) => !(cb as HTMLInputElement).disabled) as HTMLElement
    fireEvent.click(enabledCb)
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }))
    await waitFor(() => {
      expect(mutationState.mutate).toHaveBeenCalled()
    })
    const payload = mutationState.mutate.mock.calls[0]![0]
    expect(payload.version).toBe(7)
    expect(payload.toggles).toHaveLength(9)
  })

  it('mandatory rows disabled + badge', () => {
    render(createElement(SettingsNotificationsPage))
    expect(screen.getAllByText('Wajib sistem').length).toBeGreaterThan(0)
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    // some disabled
    expect(checkboxes.some((cb) => cb.disabled)).toBe(true)
  })

  it('409 resets draft and refetches', async () => {
    mutationState.mutate.mockImplementation((payload, opts) => {
      opts?.onError?.(new ApiError('stale', 409, 'CONFLICT'))
    })
    render(createElement(SettingsNotificationsPage))
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }))
    await waitFor(() => {
      expect(refetchMock).toHaveBeenCalled()
    })
    expect(toastMock.error).toHaveBeenCalledWith('Versi basi — memuat ulang…')
  })

  it('kontrak backend: render dari payload GET nama-penuh lalu PUT mengirim nama-penuh', async () => {
    mutationState.mutate.mockImplementation((payload, opts) => {
      opts?.onSuccess?.({ toggles: payload.toggles, version: payload.version })
    })
    render(createElement(SettingsNotificationsPage))
    expect(screen.getAllByRole('checkbox')).toHaveLength(9 * 4 * 2 - 4 * 2)
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }))
    await waitFor(() => {
      expect(mutationState.mutate).toHaveBeenCalled()
    })
    const payload = mutationState.mutate.mock.calls[0]![0]
    const events = payload.toggles.map((t: { event: string }) => t.event)
    expect(events).toEqual([
      'visit_requested',
      'visit_approved',
      'visit_rejected',
      'visit_rescheduled',
      'visit_check_in',
      'visit_check_out',
      'visit_cancelled',
      'visit_auto_cancelled',
      'visit_reminder',
    ])
  })

  it('dibatalkan otomatis terkunci dari flag server (mandatory)', () => {
    render(createElement(SettingsNotificationsPage))
    const autoBoxes = screen.getAllByRole('checkbox', { name: /Dibatalkan Otomatis in_app staff/i })
    expect(autoBoxes.length).toBeGreaterThan(0)
    for (const box of autoBoxes) {
      expect(box).toBeDisabled()
      expect(box).toHaveAttribute('title', 'Wajib sistem')
    }
  })

  it('email staf baris diminta hidup dan terkirim di PUT', async () => {
    mutationState.mutate.mockImplementation((payload, opts) => {
      opts?.onSuccess?.({ toggles: payload.toggles, version: payload.version })
    })
    render(createElement(SettingsNotificationsPage))
    const emailStaffBoxes = screen.getAllByRole('checkbox', { name: /Diminta email staff/i })
    expect(emailStaffBoxes.length).toBeGreaterThan(0)
    for (const box of emailStaffBoxes.slice(0, 1)) {
      expect(box).toBeEnabled()
    }
    fireEvent.click(emailStaffBoxes[0]!)
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }))
    await waitFor(() => {
      expect(mutationState.mutate).toHaveBeenCalled()
    })
    const payload = mutationState.mutate.mock.calls[0]![0]
    const requested = payload.toggles.find((t: { event: string }) => t.event === 'visit_requested')
    expect(requested.email.staff).toBe(false)
    expect(payload.toggles).toHaveLength(9)
    expect(payload.version).toBe(7)
  })

  it('togel staf baris pengingat dapat diubah', async () => {
    mutationState.mutate.mockImplementation((payload, opts) => {
      opts?.onSuccess?.({ toggles: payload.toggles, version: payload.version })
    })
    render(createElement(SettingsNotificationsPage))
    const reminderInApp = screen.getAllByRole('checkbox', { name: /Pengingat in_app staff/i })
    const reminderEmail = screen.getAllByRole('checkbox', { name: /Pengingat email staff/i })
    expect(reminderInApp.length).toBeGreaterThan(0)
    expect(reminderEmail.length).toBeGreaterThan(0)
    for (const box of [...reminderInApp, ...reminderEmail]) {
      expect(box).toBeEnabled()
    }
    fireEvent.click(reminderEmail[0]!)
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }))
    await waitFor(() => {
      expect(mutationState.mutate).toHaveBeenCalled()
    })
    const payload = mutationState.mutate.mock.calls[0]![0]
    const reminder = payload.toggles.find((t: { event: string }) => t.event === 'visit_reminder')
    expect(reminder.email.staff).toBe(true)
  })

  it('sel tanpa kaki backend tidak dirender dan diganti placeholder "-" (desktop)', () => {
    render(createElement(SettingsNotificationsPage))
    for (const name of [
      /Diminta in_app vendor/i,
      /Diminta email vendor/i,
      /Sedang di Lokasi in_app vendor/i,
      /Selesai in_app vendor/i,
    ]) {
      expect(screen.queryByRole('checkbox', { name })).not.toBeInTheDocument()
    }
    const table = screen.getByRole('table')
    // Jumlah "-": satu per sel mati + satu dari kolom Wajib Sistem (baris ini
    // tidak wajib), sehingga penghilangan placeholder akan membuat test merah.
    const expectedPlaceholders: Array<[string, number]> = [
      ['Diminta', 3],
      ['Sedang di Lokasi', 2],
      ['Selesai', 2],
    ]
    for (const [label, count] of expectedPlaceholders) {
      const row = within(table).getByText(label).closest('tr')
      if (!row) throw new Error(`baris ${label} tidak ditemukan`)
      expect(within(row).getAllByText('-')).toHaveLength(count)
    }
  })

  it('sel email vendor check-in/check-out hidup karena kaki roster fan-out', () => {
    render(createElement(SettingsNotificationsPage))
    for (const name of [/Sedang di Lokasi email vendor/i, /Selesai email vendor/i]) {
      const boxes = screen.getAllByRole('checkbox', { name })
      expect(boxes.length).toBeGreaterThan(0)
      for (const box of boxes) {
        expect(box).toBeEnabled()
        expect(box).not.toHaveAttribute('title', 'Tidak berlaku untuk peristiwa ini')
      }
    }
  })

  it('rescheduled/reminder/cancelled/auto_cancelled semua kaki berlaku', () => {
    render(createElement(SettingsNotificationsPage))
    for (const name of [
      /Jadwal Digeser in_app staff/i,
      /Jadwal Digeser in_app vendor/i,
      /Jadwal Digeser email staff/i,
      /Jadwal Digeser email vendor/i,
      /Pengingat in_app staff/i,
      /Pengingat in_app vendor/i,
      /Pengingat email staff/i,
      /Pengingat email vendor/i,
    ]) {
      const boxes = screen.getAllByRole('checkbox', { name })
      expect(boxes.length).toBeGreaterThan(0)
      for (const box of boxes) {
        expect(box).toBeEnabled()
        expect(box).not.toHaveAttribute('title', 'Tidak berlaku untuk peristiwa ini')
      }
    }
    const autoBoxes = screen.getAllByRole('checkbox', { name: /Dibatalkan Otomatis in_app staff/i })
    expect(autoBoxes.length).toBeGreaterThan(0)
    for (const box of autoBoxes) {
      expect(box).toBeDisabled()
      expect(box).toHaveAttribute('title', 'Wajib sistem')
    }
  })

  it('kartu mobile ikut menyembunyikan sel tanpa kaki dan menjaga sel staf hidup', () => {
    render(createElement(SettingsNotificationsPage))
    const cardList = screen.getByRole('list')
    const expectedPlaceholders: Array<[string, number]> = [
      ['Diminta', 2],
      ['Sedang di Lokasi', 1],
      ['Selesai', 1],
    ]
    for (const [label, count] of expectedPlaceholders) {
      const card = within(cardList).getByText(label).closest('li')
      if (!card) throw new Error(`kartu ${label} tidak ditemukan`)
      expect(within(card).queryByRole('checkbox', { name: 'Dalam aplikasi · Vendor' })).not.toBeInTheDocument()
      expect(within(card).getAllByText('-')).toHaveLength(count)
      for (const name of ['Dalam aplikasi · Staf', 'Email · Staf']) {
        expect(within(card).getByRole('checkbox', { name })).toBeEnabled()
      }
    }
    // Sel email vendor tetap tersembunyi hanya di baris yang tidak punya kaki
    // vendor sama sekali; check-in/check-out punya kaki roster fan-out.
    const requested = within(cardList).getByText('Diminta').closest('li')
    if (!requested) throw new Error('kartu Diminta tidak ditemukan')
    expect(within(requested).queryByRole('checkbox', { name: 'Email · Vendor' })).not.toBeInTheDocument()
    for (const label of ['Sedang di Lokasi', 'Selesai']) {
      const card = within(cardList).getByText(label).closest('li')
      if (!card) throw new Error(`kartu ${label} tidak ditemukan`)
      const box = within(card).getByRole('checkbox', { name: 'Email · Vendor' })
      expect(box).toBeEnabled()
      expect(box).not.toHaveAttribute('title', 'Tidak berlaku untuk peristiwa ini')
    }
  })

  it('sel staf pada baris staff-only tetap berlaku', () => {
    render(createElement(SettingsNotificationsPage))
    for (const name of [
      /Diminta in_app staff/i,
      /Diminta email staff/i,
      /Sedang di Lokasi in_app staff/i,
      /Sedang di Lokasi email staff/i,
      /Selesai in_app staff/i,
      /Selesai email staff/i,
    ]) {
      const boxes = screen.getAllByRole('checkbox', { name })
      expect(boxes.length).toBeGreaterThan(0)
      for (const box of boxes) {
        expect(box).toBeEnabled()
        expect(box).not.toHaveAttribute('title', 'Tidak berlaku untuk peristiwa ini')
      }
    }
  })

  it('payload tidak pernah menyalakan sel tanpa kaki', async () => {
    mutationState.mutate.mockImplementation((payload, opts) => {
      opts?.onSuccess?.({ toggles: payload.toggles, version: payload.version })
    })
    render(createElement(SettingsNotificationsPage))
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }))
    await waitFor(() => {
      expect(mutationState.mutate).toHaveBeenCalled()
    })
    const payload = mutationState.mutate.mock.calls[0]![0]
    for (const row of payload.toggles) {
      const applicable = row.applicable
      if (!applicable) throw new Error(`${row.event} tidak punya peta applicable`)
      if (!applicable.in_app.staff) expect(row.in_app.staff).toBe(false)
      if (!applicable.in_app.vendor) expect(row.in_app.vendor).toBe(false)
      if (!applicable.email.staff) expect(row.email.staff).toBe(false)
      if (!applicable.email.vendor) expect(row.email.vendor).toBe(false)
    }
  })

  it('loading + error states', () => {
    queryState.isPending = true
    queryState.data = null
    const { unmount } = render(createElement(SettingsNotificationsPage))
    expect(screen.getByRole('status')).toBeInTheDocument()
    unmount()

    queryState.isPending = false
    queryState.isError = true
    queryState.error = new ApiError('boom', 500, 'SERVER_ERROR')
    render(createElement(SettingsNotificationsPage))
    expect(screen.getByRole('button', { name: 'Coba Lagi' })).toBeInTheDocument()
  })
})
