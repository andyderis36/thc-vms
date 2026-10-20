// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NotificationsMenu, type NotificationsMenuProps } from './NotificationsMenu'
import type { NotificationItem, NotificationListResult, NotificationType } from '@/lib/api/types'

const { listNotifications, markNotificationRead, markAllNotificationsRead, push } = vi.hoisted(() => ({
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  push: vi.fn(),
}))

vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/client')>()
  return { ...actual, listNotifications, markNotificationRead, markAllNotificationsRead }
})

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

/** Bangun satu baris notifikasi tersimpan dengan nilai bawaan yang stabil. */
function notification(overrides: Partial<NotificationItem> & Pick<NotificationItem, 'id' | 'type' | 'visit_request_id'>): NotificationItem {
  return {
    visit_id: 'VST-AAA',
    location_id: 'loc-1',
    location_name: 'POP Pontianak',
    title: 'Judul notifikasi',
    message: 'Pesan notifikasi.',
    is_read: false,
    occurred_at: '2026-10-17T02:00:00Z',
    ...overrides,
  }
}

const REQUESTED = notification({
  id: 'visit-1:visit_requested',
  type: 'visit_requested',
  visit_request_id: 'visit-1',
  title: 'Permintaan kunjungan baru',
  message: 'Permintaan VST-AAA menunggu persetujuan.',
})

const CHECKED_IN = notification({
  id: 'visit-2:visit_check_in',
  type: 'visit_check_in',
  visit_request_id: 'visit-2',
  visit_id: 'VST-BBB',
  title: 'Check-in tamu',
  message: 'Tamu VST-BBB telah check-in.',
  is_read: true,
})

const APPROVED = notification({
  id: 'visit-3:visit_approved',
  type: 'visit_approved',
  visit_request_id: 'visit-3',
  visit_id: 'VST-CCC',
  title: 'Kunjungan disetujui',
  message: 'Permintaan VST-CCC telah disetujui.',
})

/** `unread_count` sengaja terpisah dari isi `items` agar badge diuji terpisah. */
function result(
  items: NotificationItem[],
  unreadCount = items.filter((item) => !item.is_read).length,
  total = items.length,
): NotificationListResult {
  return { items, total, unread_count: unreadCount, page: 1, limit: 10 }
}

function renderMenu(props: NotificationsMenuProps = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  render(<NotificationsMenu {...props} />, { wrapper })
}

/** Buka panel, lalu tunggu feed selesai dimuat (isi atau keadaan kosong). */
async function openMenu(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: /Notifikasi/ }))
  await screen.findByRole('menu')
  await waitFor(() => {
    expect(screen.queryByText('Memuat notifikasi…')).not.toBeInTheDocument()
  })
}

beforeEach(() => {
  listNotifications.mockReset()
  markNotificationRead.mockReset()
  markAllNotificationsRead.mockReset()
  push.mockReset()
  markNotificationRead.mockResolvedValue({ id: 'x', is_read: true })
  markAllNotificationsRead.mockResolvedValue({ updated: 0 })
})

afterEach(() => {
  cleanup()
})

describe('NotificationsMenu', () => {
  it('tidak memuat feed sebelum panel dibuka', () => {
    listNotifications.mockResolvedValue(result([]))
    renderMenu()

    // Badge boleh taking `limit: 1` saat mount supaya lonceng terisi; feed
    // panel (halaman 1, limit 10) hanya boleh diambil setelah panel dibuka.
    expect(listNotifications).not.toHaveBeenCalledWith({ limit: 10, page: 1 })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('memuat judul, pesan, dan lokasi tiap notifikasi saat lonceng diklik', async () => {
    listNotifications.mockResolvedValue(result([REQUESTED, CHECKED_IN]))
    renderMenu()

    await openMenu()

    expect(await screen.findByText('Permintaan kunjungan baru')).toBeInTheDocument()
    expect(screen.getByText('Permintaan VST-AAA menunggu persetujuan.')).toBeInTheDocument()
    expect(screen.getByText('Check-in tamu')).toBeInTheDocument()
    expect(screen.getByText('Tamu VST-BBB telah check-in.')).toBeInTheDocument()
    expect(screen.getAllByText('POP Pontianak')).toHaveLength(2)
    expect(listNotifications).toHaveBeenCalledWith({ limit: 10, page: 1 })
  })

  it('memberi indikator dan wash tint hanya pada baris belum dibaca', async () => {
    listNotifications.mockResolvedValue(result([REQUESTED, CHECKED_IN]))
    renderMenu()

    await openMenu()

    const chips = await screen.findAllByText('Belum dibaca')
    expect(chips).toHaveLength(1)
    const unreadRow = screen.getByRole('menuitem', { name: /Permintaan kunjungan baru/ })
    const readRow = screen.getByRole('menuitem', { name: /Check-in tamu/ })
    expect(unreadRow.className).toContain('bg-brand-soft/60')
    expect(readRow.className).not.toContain('bg-brand-soft/60')
  })

  it('menampilkan badge angka dari unread_count dan menandainya pada aria-label', async () => {
    listNotifications.mockResolvedValue(result([], 7))
    renderMenu()

    expect(await screen.findByTestId('notifications-unread-badge')).toHaveTextContent('7')
    expect(
      await screen.findByRole('button', { name: 'Notifikasi, 7 belum dibaca' }),
    ).toBeInTheDocument()
  })

  it('membatasi badge angka pada 99+', async () => {
    listNotifications.mockResolvedValue(result([], 250))
    renderMenu()

    expect(await screen.findByTestId('notifications-unread-badge')).toHaveTextContent('99+')
  })

  it('tanpa unread_count tidak ada badge dan tombol tandai-semua nonaktif', async () => {
    listNotifications.mockResolvedValue(result([CHECKED_IN], 0))
    renderMenu()

    await screen.findByRole('button', { name: 'Notifikasi' })
    expect(screen.queryByTestId('notifications-unread-badge')).not.toBeInTheDocument()
    await openMenu()
    expect(screen.getByRole('button', { name: 'Tandai semua dibaca' })).toBeDisabled()
  })

  it('menandai semua dibaca lewat aksi panel dan menyegarkan cache notifikasi', async () => {
    listNotifications.mockResolvedValue(result([REQUESTED, CHECKED_IN]))
    renderMenu()
    await openMenu()

    fireEvent.click(screen.getByRole('button', { name: 'Tandai semua dibaca' }))

    await waitFor(() => {
      expect(markAllNotificationsRead).toHaveBeenCalledTimes(1)
    })
    // Panel tetap terbuka agar petugas bisa melihat feed yang baru ditandai.
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('menandai satu baris dibaca saat dipilih tanpa memanggil read-all', async () => {
    listNotifications.mockResolvedValue(result([REQUESTED, CHECKED_IN]))
    renderMenu()
    await openMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: /Permintaan kunjungan baru/ }))

    await waitFor(() => {
      expect(markNotificationRead).toHaveBeenCalledWith('visit-1:visit_requested')
    })
    expect(markAllNotificationsRead).not.toHaveBeenCalled()
  })

  it('tidak menandai ulang baris yang sudah dibaca saat dipilih', async () => {
    listNotifications.mockResolvedValue(result([CHECKED_IN]))
    renderMenu()
    await openMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: /Check-in tamu/ }))

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/visits/visit-2')
    })
    expect(markNotificationRead).not.toHaveBeenCalled()
  })

  it('mengarahkan permintaan kunjungan ke detail kunjungan, bukan /approvals', async () => {
    listNotifications.mockResolvedValue(result([REQUESTED]))
    renderMenu()
    await openMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: /Permintaan kunjungan baru/ }))

    expect(push).toHaveBeenCalledWith('/visits/visit-1')
  })

  it('mengarahkan jadwal ulang ke detail kunjungan, bukan /approvals', async () => {
    const rescheduled = notification({
      id: 'visit-4:visit_rescheduled',
      type: 'visit_rescheduled',
      visit_request_id: 'visit-4',
      title: 'Jadwal kunjungan diperbarui',
    })
    listNotifications.mockResolvedValue(result([rescheduled]))
    renderMenu()
    await openMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: /Jadwal kunjungan diperbarui/ }))

    expect(push).toHaveBeenCalledWith('/visits/visit-4')
  })

  it('mengarahkan notifikasi vendor ke detail kunjungan, bukan /approvals', async () => {
    listNotifications.mockResolvedValue(result([APPROVED]))
    renderMenu()
    await openMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: /Kunjungan disetujui/ }))

    expect(push).toHaveBeenCalledWith('/visits/visit-3')
  })

  it('memanggil onSelect tanpa navigasi bila intersektor disediakan (kios pengawas)', async () => {
    const onSelect = vi.fn()
    listNotifications.mockResolvedValue(result([REQUESTED, CHECKED_IN]))
    renderMenu({ onSelect })
    await openMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: /Permintaan kunjungan baru/ }))

    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith(REQUESTED)
    })
    expect(push).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(markNotificationRead).toHaveBeenCalledWith('visit-1:visit_requested')
    })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('mendukung kedelapan jenis notifikasi dari kontrak', async () => {
    const types: NotificationType[] = [
      'visit_requested',
      'visit_rescheduled',
      'visit_check_in',
      'visit_check_out',
      'visit_approved',
      'visit_rejected',
      'visit_reminder',
      'visit_auto_cancelled',
    ]
    const items = types.map((type, index) =>
      notification({
        id: `visit-${index}:${type}`,
        type,
        visit_request_id: `visit-${index}`,
        title: `Judul ${type}`,
        is_read: true,
      }),
    )
    listNotifications.mockResolvedValue(result(items))
    renderMenu()
    await openMenu()

    for (const type of types) {
      expect(await screen.findByText(`Judul ${type}`)).toBeInTheDocument()
    }
    expect(screen.getAllByRole('menuitem')).toHaveLength(types.length)
  })

  it('menampilkan keadaan kosong tanpa item', async () => {
    listNotifications.mockResolvedValue(result([]))
    renderMenu()

    await openMenu()

    expect(await screen.findByText('Belum ada notifikasi.')).toBeInTheDocument()
  })

  it('menampilkan tombol muat lebih banyak dan garis progres saat total melebihi baris tampil', async () => {
    listNotifications.mockResolvedValue(result([REQUESTED, CHECKED_IN], 116, 126))
    renderMenu()

    await openMenu()

    expect(await screen.findByRole('button', { name: 'Muat lebih banyak' })).toBeInTheDocument()
    expect(screen.getByText('Menampilkan 2 dari 126 notifikasi')).toBeInTheDocument()
    expect(screen.getByText('116 belum dibaca')).toBeInTheDocument()
  })

  it('memuat halaman berikutnya dan menambah baris saat "Muat lebih banyak" diklik', async () => {
    const extra = notification({
      id: 'visit-5:visit_reminder',
      type: 'visit_reminder',
      visit_request_id: 'visit-5',
      title: 'Pengingat kunjungan',
      is_read: true,
    })
    listNotifications.mockImplementation((params: { page?: number } = {}) =>
      Promise.resolve(
        params.page === 2
          ? { ...result([extra], 1, 12), page: 2 }
          : result([REQUESTED, CHECKED_IN], 1, 12),
      ),
    )
    renderMenu()

    await openMenu()
    expect(await screen.findByText('Permintaan kunjungan baru')).toBeInTheDocument()
    expect(screen.getByText('Menampilkan 2 dari 12 notifikasi')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Muat lebih banyak' }))

    expect(await screen.findByText('Pengingat kunjungan')).toBeInTheDocument()
    await waitFor(() => {
      expect(listNotifications).toHaveBeenCalledWith({ limit: 10, page: 2 })
    })
    // Baris halaman 1 tetap ada, halaman 2 ditambahkan di bawahnya (append).
    expect(screen.getAllByRole('menuitem')).toHaveLength(3)
    expect(screen.getByText('Menampilkan 3 dari 12 notifikasi')).toBeInTheDocument()
    // 2 × 10 ≥ 12 → tak ada halaman lanjutan, tombol muat-lebih hilang.
    expect(screen.queryByRole('button', { name: 'Muat lebih banyak' })).not.toBeInTheDocument()
  })

  it('menampilkan jumlah belum dibaca persis di panel agar badge 99+ dapat direkonsiliasi', async () => {
    listNotifications.mockResolvedValue(result([REQUESTED], 116, 126))
    renderMenu()

    expect(await screen.findByTestId('notifications-unread-badge')).toHaveTextContent('99+')
    await openMenu()

    expect(screen.getByText('116 belum dibaca')).toBeInTheDocument()
    expect(screen.getByText('Menampilkan 1 dari 126 notifikasi')).toBeInTheDocument()
  })

  it('memakai tinta kontras pada permukaan brand saat nada "brand" dipakai', async () => {
    listNotifications.mockResolvedValue(result([]))
    renderMenu({ tone: 'brand' })

    const trigger = await screen.findByRole('button', { name: 'Notifikasi' })
    expect(trigger.className).toContain('text-brand-contrast')
  })

  it('menutup panel saat Escape ditekan', async () => {
    listNotifications.mockResolvedValue(result([REQUESTED]))
    renderMenu()
    await openMenu()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})