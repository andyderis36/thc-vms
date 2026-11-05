/**
 * Fan-out notifikasi pembatalan & penjadwalan ulang — arah audience per sisi.
 *
 * Sumber kebenaran yang dibaca sebelum menulis spec ini (bukan asumsi):
 * - `backend/internal/domain/notification.go:159-193` —
 *   `HumanCancelledNotification(code, byVendor=true)` -> audience `staff`
 *   ("Kunjungan dibatalkan vendor"); `byVendor=false` -> audience `vendor`
 *   ("Kunjungan dibatalkan"). `RescheduledVendorNotification` -> salinan vendor
 *   bertipe `visit_rescheduled` yang sama dengan baris staff.
 * - `backend/internal/repository/visit_status.go:74-92` (cancel) — satu
 *   transaksi menulis SATU baris `visit_cancelled` ke sisi LAWAN: vendor yang
 *   membatalkan -> staff saja, admin/superadmin yang membatalkan -> vendor
 *   saja. `:154-166` (reschedule) — SELALU dua baris `visit_rescheduled`
 *   (staff + vendor) sekaligus, dan pemancaran ulang bersifat idempoten lewat
 *   unique constraint store (tidak ada duplikat).
 * - Pola assertion feed + isolasi lintas pengguna mengikuti
 *   `e2e/specs/notifications.spec.ts` (`listNotifications`, `notificationFor`,
 *   `expect.poll` tanpa `waitForTimeout`).
 *
 * Semua kunjungan dibuat lewat `h.createVisit` (marker sweep `E2E-...` di
 * notes) sehingga auto-cleanup teardown + `sweep.ts`/`global.setup.ts`
 * mengenalinya: spec ini aman live maupun lokal, tanpa `test.skip`.
 */

import { expect, test } from '../fixtures'
import {
  apiFetchRaw,
  cancelVisitViaApi,
  rescheduleVisitViaApi,
  type ApiEnvelope,
} from '../helpers/api'

/** Bentuk `GET /notifications` sesuai `docs/4. openapi.yaml`. */
interface NotificationItem {
  id: string
  type: string
  visit_request_id: string
  visit_id: string
  location_id: string
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

/** `GET /notifications` dengan amplop dibuka; melempar bila bukan 200 sukses. */
async function listNotifications(token: string): Promise<NotificationListData> {
  const result = await apiFetchRaw<ApiEnvelope<NotificationListData>>(
    token,
    'GET',
    '/notifications?limit=100',
  )
  expect(result.status, `GET /notifications -> HTTP ${result.status}`).toBe(200)
  if (result.body.success !== true) {
    throw new Error(`GET /notifications gagal: ${JSON.stringify(result.body)}`)
  }
  return result.body.data
}

/** Baris notifikasi untuk SATU kunjungan + jenis tertentu. */
function notificationFor(
  data: NotificationListData,
  visitId: string,
  type: string,
): NotificationItem | undefined {
  return data.items.find(
    (candidate) => candidate.visit_request_id === visitId && candidate.type === type,
  )
}

/** Jumlah baris SATU kunjungan + jenis tertentu (untuk bukti no-dup). */
function notificationCount(
  data: NotificationListData,
  visitId: string,
  type: string,
): number {
  return data.items.filter(
    (candidate) => candidate.visit_request_id === visitId && candidate.type === type,
  ).length
}

/** Tunggu baris fan-out muncul di feed penerima (tanpa fixed sleep). */
async function expectFanOut(
  token: string,
  visitId: string,
  type: string,
): Promise<NotificationItem> {
  let found: NotificationItem | undefined
  await expect
    .poll(
      async () => {
        found = notificationFor(await listNotifications(token), visitId, type)
        return found?.id
      },
      { message: `feed harus memuat ${type} untuk ${visitId}`, timeout: 15_000 },
    )
    .toBeDefined()
  if (found === undefined) {
    throw new Error(`poll selesai tanpa ${type} untuk ${visitId}`)
  }
  return found
}

function futureWindow(daysOut: number): { start: string; end: string } {
  const start = new Date(Date.now() + daysOut * 24 * 60 * 60_000)
  const end = new Date(start.getTime() + 2 * 60 * 60_000)
  return { start: start.toISOString(), end: end.toISOString() }
}

test('@CFAN-01 vendor membatalkan: staff (admin) dapat visit_cancelled, vendor sendiri tidak', async ({
  h,
}) => {
  const visit = await h.createVisit('cfan01', { withFiles: false })
  expect(visit.status).toBe('approved')

  await cancelVisitViaApi(await h.tokenAs('vendor'), visit.id, h.unique('vendor membatalkan'))

  const staffRow = await expectFanOut(await h.tokenAs('admin'), visit.id, 'visit_cancelled')
  expect(staffRow.title).toBe('Kunjungan dibatalkan vendor')
  expect(staffRow.message).toContain(visit.code)

  const vendorFeed = await listNotifications(await h.tokenAs('vendor'))
  expect(
    notificationFor(vendorFeed, visit.id, 'visit_cancelled'),
    'vendor tidak boleh menerima visit_cancelled atas pembatalannya sendiri',
  ).toBeUndefined()
})

test('@CFAN-02 admin membatalkan: vendor dapat visit_cancelled, staff (admin) tidak', async ({
  h,
}) => {
  const visit = await h.createVisit('cfan02', { withFiles: false })
  expect(visit.status).toBe('approved')

  await cancelVisitViaApi(await h.tokenAs('admin'), visit.id, h.unique('admin membatalkan'))

  const vendorRow = await expectFanOut(await h.tokenAs('vendor'), visit.id, 'visit_cancelled')
  expect(vendorRow.title).toBe('Kunjungan dibatalkan')
  expect(vendorRow.message).toContain(visit.code)

  const adminFeed = await listNotifications(await h.tokenAs('admin'))
  expect(
    notificationFor(adminFeed, visit.id, 'visit_cancelled'),
    'staff tidak boleh menerima visit_cancelled atas pembatalan admin',
  ).toBeUndefined()
})

test('@CFAN-03 reschedule memberitahu KEDUA sisi: staff dan vendor dapat visit_rescheduled', async ({
  h,
}) => {
  const visit = await h.createVisit('cfan03', { withFiles: false })
  expect(visit.status).toBe('approved')

  const window = futureWindow(3)
  await rescheduleVisitViaApi(await h.tokenAs('vendor'), visit.id, window.start, window.end)

  const staffRow = await expectFanOut(await h.tokenAs('admin'), visit.id, 'visit_rescheduled')
  expect(staffRow.message).toContain(visit.code)
  const vendorRow = await expectFanOut(await h.tokenAs('vendor'), visit.id, 'visit_rescheduled')
  expect(vendorRow.message).toContain(visit.code)
  expect(vendorRow.id).not.toBe(staffRow.id)
})

test('@CFAN-04 reschedule berulang tidak menduplikat baris feed (idempoten per audience)', async ({
  h,
}) => {
  const visit = await h.createVisit('cfan04', { withFiles: false })
  const vendorToken = await h.tokenAs('vendor')
  const adminToken = await h.tokenAs('admin')

  const first = futureWindow(3)
  await rescheduleVisitViaApi(vendorToken, visit.id, first.start, first.end)
  await expectFanOut(adminToken, visit.id, 'visit_rescheduled')
  await expectFanOut(vendorToken, visit.id, 'visit_rescheduled')

  const second = futureWindow(5)
  await rescheduleVisitViaApi(vendorToken, visit.id, second.start, second.end)

  // Kedua emit terjadi dalam transaksi reschedule yang sama dengan respons
  // HTTP-nya, jadi setelah `await` di atas commit sudah pasti tertulis:
  // hitung langsung tanpa sleep, harus tetap tepat 1 per audience.
  const adminFeed = await listNotifications(adminToken)
  const vendorFeed = await listNotifications(vendorToken)
  expect(
    notificationCount(adminFeed, visit.id, 'visit_rescheduled'),
    'reschedule ulang tidak boleh menambah baris staff',
  ).toBe(1)
  expect(
    notificationCount(vendorFeed, visit.id, 'visit_rescheduled'),
    'reschedule ulang tidak boleh menambah baris vendor',
  ).toBe(1)
})
