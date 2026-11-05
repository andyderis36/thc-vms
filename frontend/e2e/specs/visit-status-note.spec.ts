/**
 * `status_note` — alasan transisi status dapat dibaca balik lewat API & UI.
 *
 * Sumber kebenaran yang dibaca sebelum menulis spec ini (bukan asumsi):
 * - `docs/4. openapi.yaml` `VisitDetail.status_note`: catatan transisi
 *   status saat ini (alasan penolakan/pembatalan/perubahan jadwal), null bila
 *   tidak ada; `check_in_at`/`check_out_at`: stempel gerbang aktual.
 * - `backend/internal/repository/visit_status.go:61-67,145-151` — alasan
 *   cancel/reschedule ditulis sebagai baris `status_history.notes` dalam
 *   transaksi yang sama; detail kunjungan memproyeksikannya sebagai
 *   `status_note` (kosong -> NULL, bukan string kosong).
 * - `frontend/src/features/visits/detail/Timeline.tsx:174-190` — status
 *   terminal (`rejected`/`cancelled`/`not_visit`) menutup timeline dengan baris
 *   "Status akhir" + `statusNote` UTUH (bukan potongan).
 * - `frontend/src/app/visits/[id]/page.tsx:496-503` — status `rescheduled`
 *   menampilkan InfoRow "Alasan Perubahan Jadwal" berisi `status_note` penuh.
 * - Pola buka-detail + guard heading mengikuti
 *   `e2e/specs/visit-lifecycle.spec.ts` (`openDetail`).
 *
 * Semua kunjungan dibuat lewat `h.createVisit` (marker sweep `E2E-...` di
 * notes) sehingga auto-cleanup teardown + `sweep.ts`/`global.setup.ts`
 * mengenalinya: spec ini aman live maupun lokal, tanpa `test.skip`.
 */

import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import {
  apiFetch,
  getVisitViaApi,
  rejectVisitViaApi,
  cancelVisitViaApi,
} from '../helpers/api'
import { gotoApp } from '../helpers/nav'

/** Buka `/visits/{id}` lalu tunggu heading kode kunjungan (guard sesi lolos). */
async function openDetail(page: Page, visitId: string, code: string): Promise<void> {
  await gotoApp(page, `/visits/${visitId}`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText(code)
}

test('@SNOTE-01 alasan penolakan terbaca balik via API dan dirender penuh di baris Status akhir', async ({
  h,
}) => {
  const visit = await h.createVisit('snote01', { approve: false, withFiles: false })
  const reason = h.unique('stok material habis minggu ini')

  await rejectVisitViaApi(await h.tokenAs('admin'), visit.id, reason)

  const fetched = await getVisitViaApi(await h.tokenAs('vendor'), visit.id)
  expect(fetched.status).toBe('rejected')
  expect(fetched.status_note).toBe(reason)

  const page = await h.openAs('vendor')
  await openDetail(page, visit.id, visit.code)
  await expect(page.getByText('Status akhir', { exact: true })).toBeVisible()
  await expect(page.getByText(reason, { exact: true })).toBeVisible()
})

test('@SNOTE-02 alasan pembatalan terbaca balik via API dan dirender penuh di baris Status akhir', async ({
  h,
}) => {
  const visit = await h.createVisit('snote02', { withFiles: false })
  expect(visit.status).toBe('approved')
  const reason = h.unique('jadwal proyek digeser pemilik lahan')

  await cancelVisitViaApi(await h.tokenAs('vendor'), visit.id, reason)

  const fetched = await getVisitViaApi(await h.tokenAs('vendor'), visit.id)
  expect(fetched.status).toBe('cancelled')
  expect(fetched.status_note).toBe(reason)

  const page = await h.openAs('vendor')
  await openDetail(page, visit.id, visit.code)
  await expect(page.getByText('Status akhir', { exact: true })).toBeVisible()
  await expect(page.getByText(reason, { exact: true })).toBeVisible()
})

test('@SNOTE-03 alasan reschedule terbaca balik via API dan dirender di Alasan Perubahan Jadwal', async ({
  h,
}) => {
  const visit = await h.createVisit('snote03', { withFiles: false })
  expect(visit.status).toBe('approved')
  const reason = h.unique('akses jalan desa ditutup hajatan')

  // `rescheduleVisitViaApi` memakai alasan tetap; alasan khusus memakai
  // `apiFetch` langsung (kontrak helper di `e2e/helpers/api.ts`).
  const start = new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString()
  const end = new Date(Date.now() + 3 * 24 * 60 * 60_000 + 2 * 60 * 60_000).toISOString()
  await apiFetch(await h.tokenAs('vendor'), 'POST', `/visits/${visit.id}/reschedule`, {
    start_date: start,
    end_date: end,
    reason,
  })

  const fetched = await getVisitViaApi(await h.tokenAs('vendor'), visit.id)
  expect(fetched.status).toBe('rescheduled')
  expect(fetched.status_note).toBe(reason)

  const page = await h.openAs('vendor')
  await openDetail(page, visit.id, visit.code)
  await expect(page.getByText('Alasan Perubahan Jadwal', { exact: true })).toBeVisible()
  await expect(page.getByText(reason, { exact: true })).toBeVisible()
})
