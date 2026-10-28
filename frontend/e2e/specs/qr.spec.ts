/**
 * SCR-04 — resolver tiket QR vendor (`/qr`).
 *
 * Tag baru (tidak ada ID khusus resolver di docs/6 QA_CHECKLIST):
 * - @QR-01 vendor dengan tiket `approved` diarahkan ke detail dan kartu QR
 *   above-the-fold pada 360×800.
 * - @QR-02 vendor tanpa tiket aktif melihat empty state + CTA Ajukan Kunjungan.
 * - @QR-03 kunjungan `rescheduled` tidak dipilih resolver (tanpa kartu QR)
 *   sampai admin menyetujuinya ulang.
 *
 * Kontrak endpoint `GET /visits/{id}/qr` dan visibilitas kartu tanpa-status
 * sudah dikunci oleh @QREP-01..04 di `visit-lifecycle.spec.ts`. Spec ini fokus
 * pada perilaku RESOLVER `/qr`, bukan mengulang kontrak endpoint.
 *
 * Semua kunjungan dibuat lewat `h.createVisit` (auto-cleanup teardown).
 */

import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import {
  approveVisitViaApi,
  getVisitViaApi,
  rescheduleVisitViaApi,
  apiFetch,
  type ApiEnvelope,
  type VisitRecord,
} from '../helpers/api'
import { gotoApp } from '../helpers/nav'

function qrSection(page: Page) {
  return page.locator('section[aria-label="Kartu QR akses fasilitas"]')
}

function qrSvg(page: Page, code: string) {
  return page.locator(`svg[aria-label="QR Code ${code}"]`)
}

async function expectRedirectToDetail(page: Page, visitId: string): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`/visits/${visitId}$`))
}

test('@QR-01 vendor dengan tiket approved diarahkan ke detail dan QR above-the-fold di 360x800', async ({
  h,
}) => {
  const visit = await h.createVisit('qr01', { withFiles: false })
  expect(visit.status).toBe('approved')

  const page = await h.openAs('vendor')
  await page.setViewportSize({ width: 360, height: 800 })
  await gotoApp(page, '/qr')

  await expectRedirectToDetail(page, visit.id)
  await expect(qrSvg(page, visit.code)).toBeVisible()

  const section = qrSection(page)
  const box = await section.boundingBox()
  if (box === null) {
    throw new Error('[QR-01] kartu QR tidak memiliki bounding box yang terlihat.')
  }
  // Target: kartu QR terlihat tanpa scroll pada viewport 360×800 (AGENTS §6.5).
  expect(box.y).toBeLessThan(800)

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }))
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth)
})

test('@QR-02 vendor tanpa tiket aktif melihat empty state dan CTA Ajukan Kunjungan', async ({ h }) => {
  const token = await h.tokenAs('vendor')
  const list = await apiFetch<ApiEnvelope<{ items: VisitRecord[] }>>(
    token,
    'GET',
    '/visits?limit=50',
  )
  if (!list.body.success) {
    throw new Error(`[QR-02] gagal membaca daftar kunjungan vendor: ${list.body.error.message}`)
  }
  const active = list.body.data.items.filter(
    (visit) => visit.status === 'approved' || visit.status === 'visiting',
  )
  expect(active).toHaveLength(0)

  const page = await h.openAs('vendor')
  await gotoApp(page, '/qr')

  await expect(page).toHaveURL(/\/qr$/)
  await expect(page.getByText('Belum ada tiket aktif', { exact: true })).toBeVisible()
  await expect(
    page.getByText('Tiket QR muncul di sini setelah pengajuan Anda disetujui.', { exact: true }),
  ).toBeVisible()
  await expect(qrSection(page)).toHaveCount(0)

  const cta = page.getByRole('button', { name: 'Ajukan Kunjungan', exact: true })
  await expect(cta).toBeVisible()
  await cta.click()
  await expect(page).toHaveURL(/\/visits\/new$/)
})

test('@QR-03 kunjungan rescheduled tidak menjadi tiket QR sampai disetujui ulang', async ({ h }) => {
  const visit = await h.createVisit('qr03', { withFiles: false })
  const vendorToken = await h.tokenAs('vendor')
  const superToken = await h.tokenAs('super')

  await rescheduleVisitViaApi(
    vendorToken,
    visit.id,
    new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    new Date(Date.now() + 26 * 60 * 60_000).toISOString(),
  )
  expect((await getVisitViaApi(superToken, visit.id)).status).toBe('rescheduled')

  const page = await h.openAs('vendor')
  await gotoApp(page, '/qr')

  await expect(page).toHaveURL(/\/qr$/)
  await expect(page.getByText('Belum ada tiket aktif', { exact: true })).toBeVisible()
  await expect(qrSection(page)).toHaveCount(0)

  await approveVisitViaApi(await h.tokenAs('admin'), visit.id, 'Setujui ulang E2E QR-03')
  expect((await getVisitViaApi(superToken, visit.id)).status).toBe('approved')

  await gotoApp(page, '/qr')
  await expectRedirectToDetail(page, visit.id)
  await expect(qrSvg(page, visit.code)).toBeVisible()
})
