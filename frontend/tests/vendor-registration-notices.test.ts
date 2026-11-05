// @vitest-environment jsdom
/**
 * Kontrak pendaftaran vendor menunggu DI DALAM daftar lonceng notifikasi
 * (superadmin) — `frontend/src/components/ui/NotificationsMenu.tsx` +
 * hook di `src/lib/api/hooks.ts`.
 *
 * Modul produksi yang DITARGETKAN:
 *   · `usePendingRegistrationCount()` — selalu ter-mount, query hanya untuk
 *     sesi superadmin; probe `limit: 1` membaca `pending_count` agregat.
 *   · `usePendingRegistrationsFeed(open)` — hanya `open ∧ super_admin`.
 *   · Badge lonceng = `unread_count + pending_count` (cap 99+ dipertahankan).
 *   · Baris pending dipin di ATAS daftar yang sama dengan komponen baris
 *     persis seperti notifikasi kunjungan; klik menutup panel lalu menuju
 *     `/vendor-registrations`.
 *
 * Strategi mock: `@/lib/api/client` di-mock pada level fungsi klien
 * (`listNotifications`, `listPendingRegistrations`), sehingga badan hook,
 * queryOptions, dan React Query berjalan ASLI. Sesi di-mock dengan peran
 * yang bisa diubah per kasus (`sessionRole.role`).
 *
 * Kasus:
 *  · Jumlah badge  = unread + pending; 100+ tampil `99+`.
 *  · Role gating   = admin/security/vendor: NOL query pending, section absen.
 *  · Gating panel  = superadmin tertutup → hanya probe `limit: 1`; terbuka
 *                    → feed `limit: 5` ikut terambil.
 *  · Baris pinned  = judul `Pendaftaran vendor baru`, pill `Perlu tindakan`
 *                    (bukan `Belum dibaca`), urutan di atas notifikasi
 *                    kunjungan; klik → `/vendor-registrations` + panel tutup.
 *  · Kosong        = `pending_count` 0 + feed notifikasi kosong → pesan
 *                    tunggal `Tidak ada notifikasi.`, tanpa pill angka.
 *  · Galat         = endpoint 404 (belum ada) → pesan galat tunggal, badge tetap.
 */
import '@testing-library/jest-dom/vitest'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NotificationsMenu } from '@/components/ui/NotificationsMenu'
import { ApiError } from '@/lib/api/fetcher'
import type {
  NotificationItem,
  NotificationListResult,
  PendingRegistrationItem,
  PendingRegistrationListResult,
  Role,
} from '@/lib/api/types'

const { listNotifications, listPendingRegistrations, push, sessionRole } = vi.hoisted(() => ({
  listNotifications: vi.fn(),
  listPendingRegistrations: vi.fn(),
  push: vi.fn(),
  sessionRole: { role: 'super_admin' as string },
}))

vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/client')>()
  return { ...actual, listNotifications, listPendingRegistrations }
})

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({
    user: { id: 'u-1', name: 'Pusat', role: sessionRole.role, location_id: null },
    status: 'authenticated',
    signOut: vi.fn(),
  }),
}))

/** Halaman feed notifikasi — hanya `unread_count` yang menggerakkan badge. */
function notifications(unreadCount: number): NotificationListResult {
  return { items: [], total: 0, unread_count: unreadCount, page: 1, limit: 10 }
}

/** Baris antrean pendaftaran dengan nilai bawaan yang stabil. */
function pendingItem(overrides: Partial<PendingRegistrationItem> = {}): PendingRegistrationItem {
  return {
    vendor_user_id: 'v-1',
    name: 'Budi Santoso',
    email: 'budi@mitrafo.net.id',
    phone: '081234567890',
    nik: '3201010112000001',
    vendor_name: 'PT Mitra FO',
    created_at: '2026-11-01T02:00:00Z',
    status: 'pending',
    ...overrides,
  }
}

function pendingQueue(
  items: PendingRegistrationItem[] = [],
  pendingCount = items.length,
): PendingRegistrationListResult {
  return { items, total: items.length, pending_count: pendingCount, page: 1, limit: 5 }
}

/** Wrapper React Query baru PER TEST agar cache tidak bocor antar kasus. */
function renderMenu(role: Role = 'super_admin'): void {
  sessionRole.role = role
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  render(createElement(NotificationsMenu), { wrapper })
}

/** Buka panel, lalu tunggu feed notifikasi selesai dimuat. */
async function openMenu(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: /Notifikasi/ }))
  await screen.findByRole('menu')
  await waitFor(() => {
    expect(screen.queryByText('Memuat notifikasi…')).not.toBeInTheDocument()
  })
}

beforeEach(() => {
  listNotifications.mockReset()
  listPendingRegistrations.mockReset()
  push.mockReset()
  sessionRole.role = 'super_admin'
  listNotifications.mockResolvedValue(notifications(0))
  listPendingRegistrations.mockResolvedValue(pendingQueue())
})

afterEach(() => {
  cleanup()
})

describe('vendor-registration-notices — badge lonceng', () => {
  it('menjumlahkan unread + pendaftaran menunggu pada badge superadmin', async () => {
    listNotifications.mockResolvedValue(notifications(7))
    listPendingRegistrations.mockResolvedValue(pendingQueue([], 5))

    renderMenu('super_admin')

    expect(await screen.findByTestId('notifications-unread-badge')).toHaveTextContent('12')
    expect(
      await screen.findByRole('button', { name: 'Notifikasi, 12 belum dibaca' }),
    ).toBeInTheDocument()
    // Always-on: probe `limit: 1` menembak walau panel belum pernah dibuka.
    expect(listPendingRegistrations).toHaveBeenCalledWith({ limit: 1 })
  })

  it('mempertahankan cap 99+ untuk jumlah gabungan', async () => {
    listNotifications.mockResolvedValue(notifications(60))
    listPendingRegistrations.mockResolvedValue(pendingQueue([], 50))

    renderMenu('super_admin')

    expect(await screen.findByTestId('notifications-unread-badge')).toHaveTextContent('99+')
  })
})

describe('vendor-registration-notices — gating peran', () => {
  it.each(['admin', 'security', 'vendor'] as const)(
    'role %s tidak menembak API pendaftaran sama sekali',
    async (role) => {
      listNotifications.mockResolvedValue(notifications(3))

      renderMenu(role)
      await openMenu()
      await waitFor(() => {
        expect(listNotifications).toHaveBeenCalledWith({ limit: 10, page: 1 })
      })

      expect(listPendingRegistrations).not.toHaveBeenCalled()
      expect(screen.queryByTestId('pending-registrations-section')).not.toBeInTheDocument()
      // Badge non-superadmin tetap unread saja, tanpa tambahan pending.
      expect(screen.getByTestId('notifications-unread-badge')).toHaveTextContent('3')
    },
  )

  it('superadmin: panel tertutup hanya probe limit:1, feed limit:5 saat terbuka', async () => {
    renderMenu('super_admin')

    await waitFor(() => {
      expect(listPendingRegistrations).toHaveBeenCalledWith({ limit: 1 })
    })
    expect(listPendingRegistrations).not.toHaveBeenCalledWith({ limit: 5 })

    await openMenu()

    await waitFor(() => {
      expect(listPendingRegistrations).toHaveBeenCalledWith({ limit: 5 })
    })
  })
})

describe('vendor-registration-notices — baris pinned dalam daftar', () => {
  function visitNotification(): NotificationItem {
    return {
      id: 'visit-9:visit_requested',
      type: 'visit_requested',
      visit_request_id: 'visit-9',
      visit_id: 'VST-9',
      location_id: 'loc-1',
      location_name: 'POP Test',
      title: 'Judul kunjungan',
      message: 'Pesan kunjungan.',
      is_read: false,
      occurred_at: '2026-11-01T02:00:00Z',
    }
  }

  it('baris pending menuju /vendor-registrations dan menutup panel', async () => {
    listPendingRegistrations.mockResolvedValue(pendingQueue([pendingItem()]))

    renderMenu('super_admin')
    await openMenu()

    const row = await screen.findByRole('menuitem', { name: /Pendaftaran vendor baru/ })
    expect(screen.getByTestId('pending-registrations-section')).toBeInTheDocument()

    fireEvent.click(row)

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/vendor-registrations')
    })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('menampilkan entri antrean sebagai baris pertama beserta pill jumlah pending', async () => {
    listPendingRegistrations.mockResolvedValue(pendingQueue([pendingItem()]))

    renderMenu('super_admin')
    await openMenu()

    expect(await screen.findByText('Pendaftaran vendor baru')).toBeInTheDocument()
    expect(screen.getByText('Budi Santoso')).toBeInTheDocument()
    expect(screen.getByText('PT Mitra FO')).toBeInTheDocument()
    expect(screen.getByText('Perlu tindakan')).toBeInTheDocument()
    expect(screen.getByTestId('pending-registrations-badge')).toHaveTextContent('1')
  })

  it('mem-pin pendaftaran menunggu di atas notifikasi kunjungan dalam satu daftar', async () => {
    listNotifications.mockResolvedValue({
      items: [visitNotification()],
      total: 1,
      unread_count: 1,
      page: 1,
      limit: 10,
    })
    listPendingRegistrations.mockResolvedValue(pendingQueue([pendingItem()]))

    renderMenu('super_admin')
    await openMenu()

    const rows = await screen.findAllByRole('menuitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Pendaftaran vendor baru')
    expect(rows[1]).toHaveTextContent('Judul kunjungan')
    // Pending memakai pill `Perlu tindakan`, bukan `Belum dibaca`.
    expect(screen.getAllByText('Belum dibaca')).toHaveLength(1)
  })

  it('keadaan kosong: pesan tunggal tanpa pill angka', async () => {
    listPendingRegistrations.mockResolvedValue(pendingQueue([], 0))

    renderMenu('super_admin')
    await openMenu()

    expect(await screen.findByText('Tidak ada notifikasi.')).toBeInTheDocument()
    expect(screen.queryByTestId('pending-registrations-badge')).not.toBeInTheDocument()
    expect(screen.getByTestId('pending-registrations-section')).toBeInTheDocument()
  })

  it('keadaan galat: pesan galat tunggal, badge tetap', async () => {
    listNotifications.mockResolvedValue(notifications(2))
    listPendingRegistrations.mockRejectedValue(new ApiError('Not Found', 404, 'NOT_FOUND'))

    renderMenu('super_admin')
    await openMenu()

    expect(await screen.findByText('Gagal memuat notifikasi.')).toBeInTheDocument()
    // Badge lonceng tetap hidup dari unread meski pendaftaran gagal dimuat.
    expect(screen.getByTestId('notifications-unread-badge')).toHaveTextContent('2')
  })
})
