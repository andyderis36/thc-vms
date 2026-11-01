/**
 * SCR-02 — dashboard kunjungan (`/dashboard`).
 *
 * Tag baru (tidak ada ID dashboard di docs/6 QA_CHECKLIST):
 * - @DASH-01 superadmin melihat 4 kartu metrik + 4 tab kunjungan, dan filter
 *   Fasilitas aktif.
 * - @DASH-02 admin melihat kartu/tab yang sama dengan Fasilitas terkunci ke
 *   cabangnya.
 * - @DASH-03 tab "Sedang di Lokasi" memuat kunjungan yang sudah check-in dan
 *   baris Visit ID membuka halaman detail.
 * - @DASH-04 dashboard vendor hanya memuat kunjungan miliknya, tanpa kontrol
 *   approve/reject/check-in. Kunjungan vendor lain dipakai sebagai pembanding.
 * - @DASH-05 baris SPK pada kartu kunjungan mobile sejajar vertikal dengan
 *   ikonnya di viewport 375px dan 320px, tanpa overflow horizontal.
 *
 * Kunjungan milik vendor sendiri memakai `h.createVisit` (auto-cleanup).
 * Kunjungan pembanding vendor1b dibuat manual dan dihapus di `finally`, lalu
 * diverifikasi 404 lewat GET. Akun seed tidak dimutasi.
 */

import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import {
  DEFAULT_PASSWORD,
  LOCATIONS,
  PURPOSES,
  apiFetchRaw,
  checkInViaApi,
  createVisitViaApi,
  deleteVisitViaApi,
  getVisitViaApi,
  loginViaApi,
} from '../helpers/api'
import { gotoApp } from '../helpers/nav'

const PLACEHOLDER_SPK_URL =
  'http://localhost:9000/thc-vms-bucket/assignment_letter/e2e-placeholder.pdf'

const KPI_LABELS = [
  'Total Kunjungan Cabang',
  'Menunggu Approval',
  'Sedang di Lokasi',
  'Selesai',
] as const

const TAB_NAMES = [
  /^Semua Kunjungan/,
  /^Menunggu Approval/,
  /^Sedang di Lokasi/,
  /^Selesai/,
] as const

function visitRow(page: Page, visitCode: string) {
  return page.getByRole('row').filter({
    has: page.getByRole('link', {
      name: `Lihat detail kunjungan ${visitCode}`,
      exact: true,
    }),
  })
}

async function expectDashboardChrome(page: Page): Promise<void> {
  await expect(
    page.getByRole('heading', { name: 'Dashboard Kunjungan', exact: true }),
  ).toBeVisible()
  for (const label of KPI_LABELS) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible()
  }
  for (const name of TAB_NAMES) {
    await expect(page.getByRole('tab', { name })).toBeVisible()
  }
}

test('@DASH-01 dashboard superadmin menampilkan empat KPI, empat tab, dan filter Fasilitas aktif', async ({
  h,
}) => {
  const page = await h.openAs('super')
  await gotoApp(page, '/dashboard')

  await expectDashboardChrome(page)
  const facility = page.getByLabel('Fasilitas')
  await expect(facility).toBeEnabled()
  await expect(facility).toHaveValue('all')
  await expect(
    page.getByRole('tab', { name: /^Semua Kunjungan/ }),
  ).toHaveAttribute('aria-selected', 'true')
})

test('@DASH-02 dashboard admin menampilkan KPI/tab dengan Fasilitas terkunci ke cabangnya', async ({
  h,
}) => {
  const page = await h.openAs('admin')
  await gotoApp(page, '/dashboard')

  await expectDashboardChrome(page)
  const facility = page.getByLabel('Fasilitas')
  await expect(facility).toBeDisabled()
  await expect(facility).toHaveValue(LOCATIONS.hq)
})

test('@DASH-03 tab Sedang di Lokasi memuat kunjungan check-in dan baris membuka detail', async ({
  h,
}) => {
  const visit = await h.createVisit('dash03', { withFiles: false })
  const superToken = await h.tokenAs('super')
  await checkInViaApi(await h.tokenAs('security'), visit.id)
  expect((await getVisitViaApi(superToken, visit.id)).status).toBe('visiting')

  const page = await h.openAs('admin')
  await gotoApp(page, '/dashboard')
  await expectDashboardChrome(page)

  const visitingTab = page.getByRole('tab', { name: /^Sedang di Lokasi/ })
  await visitingTab.click()
  await expect(visitingTab).toHaveAttribute('aria-selected', 'true')

  const row = visitRow(page, visit.code)
  await expect(row).toBeVisible()
  await expect(row).toContainText('Sedang di Lokasi')

  await row
    .getByRole('link', {
      name: `Lihat detail kunjungan ${visit.code}`,
      exact: true,
    })
    .click()
  await expect(page).toHaveURL(new RegExp(`/visits/${visit.id}$`))
  await expect(page.getByRole('heading', { level: 1 })).toContainText(visit.code)
})

test('@DASH-04 dashboard vendor hanya memuat kunjungan sendiri tanpa kontrol approval', async ({
  h,
}) => {
  const ownVisit = await h.createVisit('dash04-own', { withFiles: false })
  const purposeId = PURPOSES.Survey
  if (purposeId === undefined) {
    throw new Error('[DASH-04] purpose seed untuk vendor pembanding tidak ditemukan.')
  }

  const vendorB = await loginViaApi(process.env.E2E_EMAIL_VENDOR2 ?? 'vendor1b@transhybrid.net.id', DEFAULT_PASSWORD)
  let foreignVisitId: string | null = null

  try {
    const foreignVisit = await createVisitViaApi(vendorB.token, {
      location_id: LOCATIONS.hq,
      purpose_ids: [purposeId],
      start_date: new Date(Date.now() - 30 * 60_000).toISOString(),
      end_date: new Date(Date.now() + 180 * 60_000).toISOString(),
      is_nda_accepted: true,
      assignment_letter_url: PLACEHOLDER_SPK_URL,
      notes: h.unique('dash04-foreign'),
      visitors: [
        {
          name: `${h.unique('Teknisi Vendor B')} Uji`,
          id_number: String(Date.now()).slice(-12),
          phone: '081234567890',
          vendor_name: 'PT Daya Power Mandiri',
        },
      ],
    })
    foreignVisitId = foreignVisit.id
    expect(foreignVisit.status).toBe('requested')
    if (foreignVisit.visit_id === undefined) {
      throw new Error('[DASH-04] kunjungan pembanding tidak mengembalikan visit_id.')
    }
    const foreignCode = foreignVisit.visit_id

    const page = await h.openAs('vendor')
    await gotoApp(page, '/dashboard')
    await expectDashboardChrome(page)

    await expect(visitRow(page, ownVisit.code)).toBeVisible()
    await expect(
      page.getByRole('row').filter({ hasText: foreignCode }),
    ).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: /Setujui|Tolak|Check-in|Check-out/i }),
    ).toHaveCount(0)
  } finally {
    if (foreignVisitId !== null) {
      const superToken = await h.tokenAs('super')
      await deleteVisitViaApi(superToken, foreignVisitId)
      const followUp = await apiFetchRaw(superToken, 'GET', `/visits/${foreignVisitId}`)
      expect(followUp.status).toBe(404)
    }
  }
})

test('@DASH-05 baris SPK kartu kunjungan mobile sejajar vertikal dengan ikonnya', async ({
  h,
}) => {
  const visit = await h.createVisit('dash05', { withFiles: true })
  const page = await h.openAs('super')

  async function measureSpkRow(width: number) {
    await page.setViewportSize({ width, height: 800 })
    await gotoApp(page, '/dashboard')

    const allTab = page.getByRole('tab', { name: /^Semua Kunjungan/ })
    if ((await allTab.getAttribute('aria-selected')) !== 'true') {
      await allTab.click()
      await expect(allTab).toHaveAttribute('aria-selected', 'true')
    }

    const card = page.locator('li').filter({
      has: page.getByRole('link', {
        name: `Lihat detail kunjungan ${visit.code}`,
        exact: true,
      }),
    })
    await expect(card).toBeVisible()

    const spkLinkName = `Lihat surat tugas SPK kunjungan ${visit.code}`
    const spkLink = card.getByRole('link', { name: spkLinkName, exact: true })
    await expect(spkLink).toBeVisible()
    await expect(spkLink).toHaveText('Lihat SPK')

    // `has` di-root ke `page` (bukan `spkLink` yang sudah di-scope ke kartu):
    // locator ber-scope kartu akan menyusun ulang rantai `li` di dalam `p`.
    const row = card.locator('p').filter({
      has: page.getByRole('link', { name: spkLinkName, exact: true }),
    })
    const icon = row.locator('svg').first()
    await expect(icon).toBeVisible()

    const cardBox = await card.boundingBox()
    const iconBox = await icon.boundingBox()
    const linkBox = await spkLink.boundingBox()
    if (cardBox === null || iconBox === null || linkBox === null) {
      throw new Error(
        `[@DASH-05] boundingBox null pada viewport ${width}px (kartu/ikon/tautan).`,
      )
    }

    const centerDelta = Math.abs(
      iconBox.y + iconBox.height / 2 - (linkBox.y + linkBox.height / 2),
    )
    expect(centerDelta).toBeLessThanOrEqual(2)
    expect(iconBox.x + iconBox.width).toBeLessThanOrEqual(linkBox.x + 1)
    expect(iconBox.y).toBeGreaterThanOrEqual(cardBox.y)
    expect(linkBox.x + linkBox.width).toBeLessThanOrEqual(
      cardBox.x + cardBox.width + 1,
    )
    expect(linkBox.height).toBeGreaterThanOrEqual(44)

    const noHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    )
    expect(noHorizontalOverflow).toBe(true)

    return { width, iconBox, linkBox, centerDelta }
  }

  const at375 = await measureSpkRow(375)
  const at320 = await measureSpkRow(320)

  for (const measured of [at375, at320]) {
    console.log(
      `[@DASH-05] ${measured.width}px ikon box (x=${measured.iconBox.x.toFixed(2)}, ` +
        `y=${measured.iconBox.y.toFixed(2)}, w=${measured.iconBox.width.toFixed(2)}, ` +
        `h=${measured.iconBox.height.toFixed(2)}) tautan box (x=${measured.linkBox.x.toFixed(2)}, ` +
        `y=${measured.linkBox.y.toFixed(2)}, w=${measured.linkBox.width.toFixed(2)}, ` +
        `h=${measured.linkBox.height.toFixed(2)}) delta center-Y=${measured.centerDelta.toFixed(2)}px`,
    )
  }
})
