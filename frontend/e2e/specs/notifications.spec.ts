/**
 * Notifikasi in-app — lonceng header (SHELL-01..04) + tiga endpoint:
 * `GET /notifications`, `PATCH /notifications/{id}`, `POST /notifications/read-all`.
 *
 * Sumber kebenaran yang dibaca sebelum menulis spec ini (bukan asumsi):
 * - `backend/internal/repository/visit_repository.go:122` — SETIAP `POST /visits`
 *   memanggil `emit(..., domain.CreatedNotification(visitCode), ...)`, jadi
 *   pengajuan vendor memicu notifikasi `visit_requested`.
 * - `backend/internal/repository/db/queries/notifications.sql:29-47` — audience
 *   `staff` = SEMUA super_admin aktif (nasional) + admin/security aktif di
 *   `location_id` kunjungan; `:49-64` audience `vendor` = `vendor_user_id` saja.
 * - `backend/internal/domain/notification.go:80-131` — approve/reject ->
 *   vendor (`visit_approved`/`visit_rejected`); check-in/check-out dan
 *   reschedule -> staff.
 * - `backend/internal/usecase/notification/service.go:92-100` (dan komentar
 *   handler `notification_handler.go:129-132`): PATCH id milik pengguna lain
 *   mengenai nol baris -> `NotFoundEntity` -> HTTP **404 `NOT_FOUND`**, BUKAN
 *   403. Spec ini menegaskan perilaku nyata tersebut.
 * - `queries/notifications.sql:96-102` — `unread_count` bersifat GLOBAL milik
 *   pemanggil dan tidak terpengaruh filter `location_id`; `:66-94` — `items`
 *   dan `total` yang difilter, urut terbaru lebih dulu.
 *
 * Bell juga dirender di SHELL-04 vendor (`VendorMobileShell.tsx:204-208`,
 * `tone="brand"`), jadi @NOTIF-07 menguji keterjangkauan nyata pada viewport
 * 360px — bukan ketiadaan yang disengaja.
 *
 * Tidak ada `waitForTimeout`: semua tunggu memakai auto-retry `expect` /
 * `expect.poll`. Semua kunjungan dibuat lewat `h.createVisit` sehingga
 * dibersihkan otomatis pada teardown harness; tidak ada baris seed yang diubah.
 */

import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import { LOCATIONS, apiFetchRaw, type ApiEnvelope, type Role } from '../helpers/api'

/** Bentuk `GET /notifications` sesuai `docs/4. openapi.yaml`. */
interface NotificationItem {
  id: string
  type: string
  visit_request_id: string
  visit_id: string
  location_id: string
  location_name: string
  title: string
  message: string
  is_read: boolean
  occurred_at: string
}

interface NotificationListData {
  items: NotificationItem[]
  total: number
  unread_count: number
  page: number
  limit: number
}

/** Lonceng tampil di keempat shell: super, admin cabang, admin Sambas, security, vendor. */
const BELL_ROLES: readonly Role[] = ['super', 'admin', 'admin-sambas', 'security', 'vendor']

/** UUID valid agar PATCH tanpa token ditolak middleware autentikasi (401), bukan 400. */
const FOREIGN_NOTIFICATION_ID = '00000000-0000-4000-8000-000000000000'

interface ListOptions {
  locationId?: string
  limit?: number
}

/** `GET /notifications` dengan amplop dibuka; melempar bila bukan 200 sukses. */
async function listNotifications(
  token: string,
  options: ListOptions = {},
): Promise<NotificationListData> {
  const query = new URLSearchParams()
  query.set('limit', String(options.limit ?? 100))
  if (options.locationId !== undefined) {
    query.set('location_id', options.locationId)
  }
  const path = `/notifications?${query.toString()}`
  const result = await apiFetchRaw<ApiEnvelope<NotificationListData>>(token, 'GET', path)
  expect(result.status, `GET ${path} -> HTTP ${result.status}`).toBe(200)
  if (result.body.success !== true) {
    throw new Error(`GET ${path} gagal: ${JSON.stringify(result.body)}`)
  }
  return result.body.data
}

/** Baris notifikasi untuk SATU kunjungan + jenis tertentu (bukan "salah satu unread"). */
function notificationFor(
  data: NotificationListData,
  visitId: string,
  type: string,
): NotificationItem {
  const item = data.items.find(
    (candidate) => candidate.visit_request_id === visitId && candidate.type === type,
  )
  if (item === undefined) {
    const seen = data.items
      .map((candidate) => `${candidate.type}:${candidate.visit_request_id}`)
      .join(', ')
    throw new Error(`Notifikasi ${type} untuk kunjungan ${visitId} tidak ada. Baris: ${seen}`)
  }
  return item
}

/** Tunggu transisi baca nyata lewat API (bukan stale cache UI). */
async function expectReadState(
  token: string,
  notificationId: string,
  isRead: boolean,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const feed = await listNotifications(token)
        return feed.items.find((item) => item.id === notificationId)?.is_read
      },
      { message: `notifikasi ${notificationId} harus is_read=${String(isRead)}`, timeout: 15_000 },
    )
    .toBe(isRead)
}

/** Tunggu `unread_count` akun itu sendiri mencapai angka yang diharapkan. */
async function expectUnreadCount(token: string, expected: number): Promise<void> {
  await expect
    .poll(async () => (await listNotifications(token)).unread_count, {
      message: `unread_count harus ${expected}`,
      timeout: 15_000,
    })
    .toBe(expected)
}

/**
 * Pemicu lonceng. Nama aksesibelnya berubah mengikuti badge:
 * `Notifikasi` atau `Notifikasi, N belum dibaca`, jadi regex menangani keduanya.
 * Header desktop & mobile sama-sama ada di DOM, tetapi yang `display:none`
 * tidak masuk accessibility tree sehingga locator ini tetap tunggal.
 */
function bell(page: Page) {
  return page.getByRole('button', { name: /^Notifikasi/ })
}

async function openBell(page: Page): Promise<void> {
  const trigger = bell(page)
  await expect(trigger).toBeVisible()
  await trigger.click()
  await expect(page.getByRole('menu')).toBeVisible()
}

/** Baris di dalam panel untuk kode tiket tertentu (pesan memuat `VST-...`). */
function notificationRow(page: Page, visitCode: string) {
  return page.getByRole('menuitem').filter({ hasText: visitCode })
}

test('@NOTIF-01 lonceng notifikasi tampil di shell setiap peran (super, admin, admin-sambas, security, vendor)', async ({
  h,
}) => {
  for (const role of BELL_ROLES) {
    const page = await h.openAs(role)
    await page.goto('/')

    const trigger = bell(page)
    await expect(trigger, `lonceng wajib tampil untuk peran ${role}`).toBeVisible()
    await expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    await expect(trigger).toBeEnabled()
  }
})

test('@NOTIF-02 badge belum-dibaca cocok dengan unread_count API dan baris kunjungan baru tampil di panel', async ({
  h,
}) => {
  // Pengajuan vendor -> audience staff: admin HQ menerima `visit_requested`.
  const visit = await h.createVisit('notif02', { approve: false, withFiles: false })
  const token = await h.tokenAs('admin')
  const feed = await listNotifications(token)

  const item = notificationFor(feed, visit.id, 'visit_requested')
  expect(item.is_read, 'notifikasi yang baru dibuat wajib belum dibaca').toBe(false)
  expect(item.visit_id).toBe(visit.code)
  expect(item.location_id).toBe(LOCATIONS.hq)
  expect(feed.unread_count, 'harus ada minimal satu unread baru').toBeGreaterThan(0)

  const page = await h.openAs('admin')
  await page.goto('/')

  // Badge & aria-label WAJIB berasal dari unread_count akun yang sama.
  const trigger = bell(page)
  await expect(trigger).toHaveAttribute(
    'aria-label',
    `Notifikasi, ${feed.unread_count} belum dibaca`,
  )
  const expectedBadge = feed.unread_count > 99 ? '99+' : String(feed.unread_count)
  await expect(trigger.getByTestId('notifications-unread-badge')).toHaveText(expectedBadge)

  await openBell(page)
  const row = notificationRow(page, visit.code)
  await expect(row).toBeVisible()
  await expect(row.getByText('Permintaan kunjungan baru', { exact: true })).toBeVisible()
  await expect(row.getByText('Belum dibaca', { exact: true })).toBeVisible()
})

test('@NOTIF-03 memilih satu notifikasi menandainya dibaca (PATCH terverifikasi API) tanpa menyentuh yang lain', async ({
  h,
}) => {
  const visit = await h.createVisit('notif03', { approve: false, withFiles: false })
  const token = await h.tokenAs('admin')

  const before = await listNotifications(token)
  const item = notificationFor(before, visit.id, 'visit_requested')
  expect(item.is_read).toBe(false)
  const otherUnread = before.items.find(
    (candidate) => candidate.id !== item.id && !candidate.is_read,
  )

  const page = await h.openAs('admin')
  await page.goto('/')
  await openBell(page)

  // Klik baris nyata: panel menutup, PATCH berjalan, lalu deep-link ke detail.
  await notificationRow(page, visit.code).click()
  await expect(page).toHaveURL(new RegExp(`/visits/${visit.id}$`))

  await expectReadState(token, item.id, true)
  await expectUnreadCount(token, before.unread_count - 1)

  const after = await listNotifications(token)
  expect(
    after.unread_count,
    'hanya SATU baris yang dibaca; read-all tidak boleh terpanggil',
  ).toBe(before.unread_count - 1)
  if (otherUnread !== undefined) {
    expect(
      after.items.find((candidate) => candidate.id === otherUnread.id)?.is_read,
      'notifikasi lain milik admin harus tetap belum dibaca',
    ).toBe(false)
  }
})

test('@NOTIF-04 tandai semua dibaca menurunkan unread_count akun itu ke nol', async ({ h }) => {
  // Cabang Sambas: akun yang dipakai di test ini (admin-sambas) adalah satu-satunya
  // akun yang di-read-all; notifikasi cabang/pengguna lain tidak disentuh.
  const visit = await h.createVisit('notif04', {
    approve: false,
    withFiles: false,
    locationId: LOCATIONS.sambas,
  })
  const token = await h.tokenAs('admin-sambas')

  const before = await listNotifications(token)
  const item = notificationFor(before, visit.id, 'visit_requested')
  expect(item.location_id).toBe(LOCATIONS.sambas)
  expect(item.is_read).toBe(false)
  expect(before.unread_count).toBeGreaterThan(0)

  const page = await h.openAs('admin-sambas')
  await page.goto('/')
  await openBell(page)
  await expect(notificationRow(page, visit.code)).toBeVisible()

  await page.getByRole('button', { name: 'Tandai semua dibaca', exact: true }).click()

  await expectUnreadCount(token, 0)
  await expectReadState(token, item.id, true)
  await expect(bell(page)).toHaveAttribute('aria-label', 'Notifikasi')
  await expect(bell(page).getByTestId('notifications-unread-badge')).toHaveCount(0)
})

test('@NOTIF-05 isolasi: notifikasi pengguna lain tidak bisa ditandai (404) dan filter cabang super_admin mengecualikan cabang lain', async ({
  h,
}) => {
  const hqVisit = await h.createVisit('notif05-hq', { approve: false, withFiles: false })
  const sambasVisit = await h.createVisit('notif05-sbs', {
    approve: false,
    withFiles: false,
    locationId: LOCATIONS.sambas,
  })

  const adminToken = await h.tokenAs('admin')
  const securityToken = await h.tokenAs('security')
  const superToken = await h.tokenAs('super')

  const adminFeed = await listNotifications(adminToken)
  const adminItem = notificationFor(adminFeed, hqVisit.id, 'visit_requested')
  expect(adminItem.is_read).toBe(false)

  // Fan-out staff memberi security satu baris SENDIRI untuk kunjungan yang sama.
  const securityFeed = await listNotifications(securityToken)
  const securityItem = notificationFor(securityFeed, hqVisit.id, 'visit_requested')
  expect(securityItem.id).not.toBe(adminItem.id)
  expect(
    securityFeed.items.some((candidate) => candidate.id === adminItem.id),
    'security tidak boleh melihat/menerima id notifikasi milik admin',
  ).toBe(false)

  // Akun B menandai notifikasi akun A: handler -> 404 NOT_FOUND (bukan 403).
  const crossUser = await apiFetchRaw<ApiEnvelope<unknown>>(
    securityToken,
    'PATCH',
    `/notifications/${adminItem.id}`,
    { is_read: true },
  )
  expect(crossUser.status, `PATCH lintas pengguna -> HTTP ${crossUser.status}`).toBe(404)
  if (crossUser.body.success) {
    throw new Error(`PATCH lintas pengguna tidak boleh sukses: ${JSON.stringify(crossUser.body)}`)
  }
  expect(crossUser.body.error.code).toBe('NOT_FOUND')

  const adminAfter = await listNotifications(adminToken)
  expect(
    notificationFor(adminAfter, hqVisit.id, 'visit_requested').is_read,
    'notifikasi admin harus tetap belum dibaca setelah PATCH ditolak',
  ).toBe(false)
  expect(adminAfter.unread_count, 'unread_count admin tidak boleh berubah').toBe(
    adminFeed.unread_count,
  )

  // Super_admin melihat nasional; filter location_id hanya mempersempit items/total.
  const superAll = await listNotifications(superToken)
  const superHq = notificationFor(superAll, hqVisit.id, 'visit_requested')
  const superSambas = notificationFor(superAll, sambasVisit.id, 'visit_requested')
  expect(superHq.location_id).toBe(LOCATIONS.hq)
  expect(superSambas.location_id).toBe(LOCATIONS.sambas)

  const superSambasOnly = await listNotifications(superToken, { locationId: LOCATIONS.sambas })
  expect(
    superSambasOnly.items.some((candidate) => candidate.id === superHq.id),
    'filter Sambas tidak boleh memuat notifikasi cabang HQ',
  ).toBe(false)
  expect(
    superSambasOnly.items.some((candidate) => candidate.id === superSambas.id),
    'filter Sambas wajib memuat notifikasi cabang Sambas',
  ).toBe(true)
  expect(
    superSambasOnly.unread_count,
    'unread_count global tidak terpengaruh filter location_id',
  ).toBe(superAll.unread_count)

  const superHqOnly = await listNotifications(superToken, { locationId: LOCATIONS.hq })
  expect(
    superHqOnly.items.some((candidate) => candidate.id === superSambas.id),
    'filter HQ tidak boleh memuat notifikasi cabang Sambas',
  ).toBe(false)
  expect(superHqOnly.items.some((candidate) => candidate.id === superHq.id)).toBe(true)
})

test('@NOTIF-06 ketiga endpoint notifikasi menolak permintaan tanpa token dengan 401', async () => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [
    { method: 'GET', path: '/notifications' },
    {
      method: 'PATCH',
      path: `/notifications/${FOREIGN_NOTIFICATION_ID}`,
      body: { is_read: true },
    },
    { method: 'POST', path: '/notifications/read-all' },
  ]

  for (const call of calls) {
    const result = await apiFetchRaw<ApiEnvelope<unknown>>(
      '',
      call.method,
      call.path,
      call.body,
    )
    expect(
      result.status,
      `${call.method} ${call.path} tanpa token -> HTTP ${result.status}`,
    ).toBe(401)
    if (result.body.success) {
      throw new Error(`${call.method} ${call.path} tanpa token tidak boleh sukses`)
    }
    expect(result.body.error.code).toBe('UNAUTHORIZED')
  }
})

test('@NOTIF-07 lonceng vendor tetap terjangkau dan panelnya bisa dipakai di viewport 360px', async ({
  h,
}) => {
  // Approve oleh admin -> vendor menerima `visit_approved` (audience vendor).
  const visit = await h.createVisit('notif07', { withFiles: false })
  const token = await h.tokenAs('vendor')
  const feed = await listNotifications(token)
  const item = notificationFor(feed, visit.id, 'visit_approved')
  expect(item.is_read).toBe(false)

  const page = await h.openAs('vendor')
  await page.setViewportSize({ width: 360, height: 800 })
  await page.goto('/')

  const trigger = bell(page)
  await expect(trigger).toBeVisible()
  const triggerBox = await trigger.boundingBox()
  if (triggerBox === null) {
    throw new Error('lonceng tidak punya bounding box pada viewport 360px')
  }
  expect(triggerBox.width, 'target sentuh minimal 44px').toBeGreaterThanOrEqual(44)
  expect(triggerBox.height, 'target sentuh minimal 44px').toBeGreaterThanOrEqual(44)
  expect(triggerBox.x).toBeGreaterThanOrEqual(0)
  expect(triggerBox.x + triggerBox.width).toBeLessThanOrEqual(360)

  await openBell(page)

  // Panel ditambatkan `right-0` ke pembungkus lonceng: tepi kanannya tidak boleh
  // melewati viewport, dan titik klik baris harus benar-benar di dalam layar.
  const menuBox = await page.getByRole('menu').boundingBox()
  if (menuBox === null) {
    throw new Error('panel notifikasi tidak punya bounding box pada viewport 360px')
  }
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(360)

  const row = notificationRow(page, visit.code)
  await expect(row).toBeVisible()
  const rowBox = await row.boundingBox()
  if (rowBox === null) {
    throw new Error('baris notifikasi tidak punya bounding box pada viewport 360px')
  }
  const centerX = rowBox.x + rowBox.width / 2
  const centerY = rowBox.y + rowBox.height / 2
  expect(centerX).toBeGreaterThan(0)
  expect(centerX).toBeLessThan(360)
  expect(centerY).toBeGreaterThan(0)
  expect(centerY).toBeLessThan(800)

  // Bukti usability nyata: baris bisa diklik di 360px dan transisi baca tercatat API.
  await row.click()
  await expect(page).toHaveURL(new RegExp(`/visits/${visit.id}$`))
  await expectReadState(token, item.id, true)
})
