/**
 * E2E Back/Forward bfcache — membuktikan listener `pageshow` global di
 * `app/providers.tsx` (`useBfcacheRefresh`) menyegarkan seluruh cache query.
 *
 * Latar: semua layar memakai `useQuery` dengan `staleTime: Infinity`, dan
 * navigasi Back/Forward memulihkan DOM dari Router Cache tanpa remount —
 * jadi refetch-saat-mount tidak pernah menyala dan antrean terlihat basi
 * sampai reload manual. Tanpa invalidasi, Back menyajikan Router Cache +
 * cache RQ yang masih segar = basi; listener memperbaiki dengan
 * `invalidateQueries()` tanpa filter kunci saat `event.persisted` true.
 *
 * Tag judul:
 * - @BFW-01 admin membuka /dashboard, mencatat antrean lewat API, membuat
 *   kunjungan, pindah ke /approvals lewat nav UI, menekan Back browser, lalu
 *   dashboard menampilkan hitungan baru TANPA page.reload.
 * - @BFW-02 pola yang sama sisi vendor: dari /dashboard ke /visits/new lewat
 *   nav UI, Back, lalu hitungan + baris milik vendor segar TANPA page.reload.
 *   CATATAN: filter tab TIDAK dipertahankan setelah Back — App Router me-remount
 *   halaman saat traversal (state `useState` filter kembali default), jadi yang
 *   dijamin listener hanyalah kesegaran data, bukan keadaan filter.
 *
 * Penanda `__bfwNoReload`: membuktikan tidak ada reload dokumen penuh di
 * tengah jalan (reload penuh ikut me-refetch dan membuat uji lolos secara
 * vakum tanpa listener). Penanda dipasang sebelum pergi dan dibaca lagi
 * setelah Back — hilang berarti dokumen dimuat ulang.
 *
 * Cleanup mengikuti pola `audit.spec.ts`: setiap kunjungan buatan dihapus
 * eksplisit di `finally` (204/404) lalu diverifikasi GET 404. Teardown
 * harness tetap berjalan sesudahnya (DELETE ulang 404 ditoleransi).
 */

import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import { apiFetch, apiFetchRaw, type ApiEnvelope } from '../helpers/api'
import { gotoApp } from '../helpers/nav'

interface VisitListPage {
  items: unknown[]
  total: number
  page: number
  limit: number
}

function expectList(body: ApiEnvelope<VisitListPage>, context: string): VisitListPage {
  if (body.success !== true) {
    throw new Error(`[e2e-backforward] ${context}: ${body.error.code} - ${body.error.message}`)
  }
  return body.data
}

async function getVisitTotal(token: string, status: string): Promise<number> {
  const result = await apiFetch<ApiEnvelope<VisitListPage>>(
    token,
    'GET',
    `/visits?status=${status}&limit=1`,
  )
  return expectList(result.body, `GET /visits?status=${status}`).total
}

/** Baris tabel kunjungan (desktop 1280px; pola `dashboard.spec.ts`). */
function visitRow(page: Page, visitCode: string) {
  return page.getByRole('row').filter({
    has: page.getByRole('link', {
      name: `Lihat detail kunjungan ${visitCode}`,
      exact: true,
    }),
  })
}

function approvalTab(page: Page) {
  return page.getByRole('tab', { name: /^Menunggu Approval/ })
}

/** Penanda hidup-di-window: hilang bila dokumen dimuat ulang penuh. */
async function stampNoReloadMarker(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as unknown as Record<string, unknown>).__bfwNoReload = 'tertanda'
  })
}

async function expectNoReload(page: Page): Promise<void> {
  const marker = await page.evaluate(() => {
    return (window as unknown as Record<string, unknown>).__bfwNoReload
  })
  expect(marker, 'tidak boleh ada reload dokumen penuh (tanpa listener uji ini vakum)').toBe(
    'tertanda',
  )
}

async function cleanupVisit(token: string, visitId: string): Promise<void> {
  const firstDelete = await apiFetchRaw(token, 'DELETE', `/visits/${encodeURIComponent(visitId)}`)
  expect(
    [204, 404],
    `cleanup DELETE kunjungan ${visitId} harus 204/404, dapat ${firstDelete.status}`,
  ).toContain(firstDelete.status)

  const verify = await apiFetchRaw(token, 'GET', `/visits/${encodeURIComponent(visitId)}`)
  expect(verify.status, `kunjungan ${visitId} harus benar-benar hilang`).toBe(404)
}

test('@BFW-01 admin kembali dari /approvals lewat Back melihat antrean baru tanpa reload', async ({
  h,
}) => {
  const page = await h.openAs('admin')
  await gotoApp(page, '/dashboard')
  await expect(
    page.getByRole('heading', { name: 'Dashboard Kunjungan', exact: true }),
  ).toBeVisible()
  await expect(approvalTab(page)).toBeVisible()

  await stampNoReloadMarker(page)

  const adminToken = await h.tokenAs('admin')
  const requestedBefore = await getVisitTotal(adminToken, 'requested')
  const rescheduled = await getVisitTotal(adminToken, 'rescheduled')

  const visit = await h.createVisit('BFW01', { withFiles: false, approve: false })
  expect(visit.status, 'kunjungan BFW01 harus berstatus requested').toBe('requested')

  try {
    const requestedAfter = await getVisitTotal(adminToken, 'requested')
    expect(requestedAfter, 'total requested API harus naik 1 setelah createVisit').toBe(
      requestedBefore + 1,
    )
    const expectedPending = requestedAfter + rescheduled

    await page.getByRole('link', { name: /Antrean Approval/ }).first().click()
    await expect(
      page.getByRole('heading', { name: 'Antrean Approval', exact: true }),
    ).toBeVisible()
    await expect(page).toHaveURL(/\/approvals$/)

    await page.goBack()
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(
      page.getByRole('heading', { name: 'Dashboard Kunjungan', exact: true }),
    ).toBeVisible()

    // Tanpa page.reload di seluruh alur — kesegaran datang dari invalidasi
    // bfcache, bukan muat ulang dokumen.
    await expectNoReload(page)

    // Hitungan antrean (API-driven: requested + rescheduled) sudah menyertakan
    // kunjungan yang dibuat selagi pergi.
    await expect(
      page.getByRole('tab', { name: `Menunggu Approval ${expectedPending}`, exact: true }),
    ).toBeVisible()
    await expect(visitRow(page, visit.code)).toBeVisible()
  } finally {
    await cleanupVisit(await h.tokenAs('super'), visit.id)
  }
})

test('@BFW-02 vendor kembali lewat Back melihat kunjungan baru tanpa reload', async ({
  h,
}) => {
  const page = await h.openAs('vendor')
  await gotoApp(page, '/dashboard')
  await expect(
    page.getByRole('heading', { name: 'Dashboard Kunjungan', exact: true }),
  ).toBeVisible()
  await expect(approvalTab(page)).toBeVisible()

  await stampNoReloadMarker(page)

  const vendorToken = await h.tokenAs('vendor')
  const requestedBefore = await getVisitTotal(vendorToken, 'requested')
  const rescheduled = await getVisitTotal(vendorToken, 'rescheduled')

  const visit = await h.createVisit('BFW02', { withFiles: false, approve: false })
  expect(visit.status, 'kunjungan BFW02 harus berstatus requested').toBe('requested')

  try {
    const requestedAfter = await getVisitTotal(vendorToken, 'requested')
    expect(requestedAfter, 'total requested API vendor harus naik 1 setelah createVisit').toBe(
      requestedBefore + 1,
    )
    const expectedPending = requestedAfter + rescheduled

    await page.getByRole('link', { name: 'Ajukan Kunjungan Baru' }).first().click()
    await expect(
      page.getByRole('heading', { name: 'Pengajuan Akses Fasilitas Jaringan THC' }),
    ).toBeVisible()
    await expect(page).toHaveURL(/\/visits\/new$/)

    await page.goBack()
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(
      page.getByRole('heading', { name: 'Dashboard Kunjungan', exact: true }),
    ).toBeVisible()

    await expectNoReload(page)

    // Data segar: hitungan cocok API dan baris baru terlihat. Keadaan filter
    // SENGAJA tidak diasertikan — Back me-remount halaman (tab kembali ke
    // "Semua Kunjungan"), yang adalah perilaku App Router, bukan kebasian.
    await expect(
      page.getByRole('tab', { name: `Menunggu Approval ${expectedPending}`, exact: true }),
    ).toBeVisible()
    await expect(visitRow(page, visit.code)).toBeVisible()
  } finally {
    await cleanupVisit(await h.tokenAs('super'), visit.id)
  }
})
