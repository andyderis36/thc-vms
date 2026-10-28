/**
 * E2E filter jejak audit (K5) — URL persisten, debounce, dan modal berkelompok.
 *
 * Tag judul:
 * - @K5-01 pencarian menulis `q` ke URL dan hanya mengirim SATU request per jeda ketik.
 * - @K5-02 urutan (`order=asc`) dan preset rentang tanggal bertahan setelah reload.
 * - @K5-03 modal detail dikelompokkan Aksi/Aktor/Entitas/Konteks dan memuat ID Jejak.
 * - @K5-04 klik menu `/audit` saat sudah berfilter mengembalikan state ke URL.
 * - @K5-05 `?page=999` menampilkan "Halaman ini kosong" dan tombol lompat ke halaman terakhir.
 * - @K5-06 parameter URL tak valid (UUID/tanggal/entitas/aksi/page/limit) dinormalisasi tanpa crash.
 * - @K5-07 rentang tanggal terbalik menampilkan guard perbaikan TANPA mengirim request `/audit-logs`.
 *
 * Catatan: filter/reset versi lama sudah dicakup `audit.spec.ts` (@AUD-01),
 * guard RBAC oleh @AUD-03, jadi berkas ini fokus ke perilaku state URL yang baru.
 */

import { expect, test } from '../fixtures'
import { gotoApp } from '../helpers/nav'

function auditSearchParams(search: string): URLSearchParams {
  return new URLSearchParams(search)
}

test('@K5-01 pencarian debounce menulis q ke URL dan mengirim satu request', async ({ h }) => {
  const page = await h.openAs('super')
  const captured: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/audit-logs')) {
      captured.push(new URL(request.url()).search)
    }
  })

  await gotoApp(page, '/audit')
  await expect(page.locator('tbody tr').first()).toBeVisible()

  const qRequests = (): string[] =>
    captured.filter((search) => auditSearchParams(search).get('q') !== null)

  await page.getByLabel('Cari jejak audit').pressSequentially('admin', { delay: 60 })
  await expect(page).toHaveURL(/[?&]q=admin/)

  await expect.poll(qRequests, { timeout: 10000 }).toHaveLength(1)
  await page.waitForTimeout(700)
  expect(qRequests()).toHaveLength(1)
  const first = auditSearchParams(qRequests()[0] ?? '')
  expect(first.get('q')).toBe('admin')
  expect(first.get('order')).toBe('desc')
  expect(first.get('limit')).toBe('50')
})

test('@K5-02 urutan dan preset tanggal bertahan setelah reload', async ({ h }) => {
  const page = await h.openAs('super')
  await gotoApp(page, '/audit')
  await expect(page.locator('tbody tr').first()).toBeVisible()

  await page.getByLabel('Urutan').selectOption('asc')
  await expect(page).toHaveURL(/[?&]order=asc/)

  await page.getByRole('button', { name: '7 hari', exact: true }).click()
  await expect(page).toHaveURL(/[?&]from=\d{4}-\d{2}-\d{2}/)
  const urlBeforeReload = page.url()

  const restoredRequests: URLSearchParams[] = []
  page.on('request', (request) => {
    if (request.url().includes('/audit-logs')) {
      restoredRequests.push(new URL(request.url()).searchParams)
    }
  })

  await page.reload()
  await expect(page).toHaveURL(urlBeforeReload)
  await expect(page.locator('tbody tr').first()).toBeVisible()
  await expect(page.getByLabel('Urutan')).toHaveValue('asc')
  await expect(page.getByLabel('Dari Tanggal')).not.toHaveValue('')
  await expect(page.getByLabel('Sampai Tanggal')).not.toHaveValue('')

  await expect
    .poll(() => restoredRequests.some((params) => params.get('order') === 'asc'), { timeout: 10000 })
    .toBe(true)
  const restored = restoredRequests.find((params) => params.get('order') === 'asc')
  expect(restored?.get('limit')).toBe('50')
  expect(restored?.get('date_from')).toMatch(/T\d{2}:\d{2}:\d{2}/)
  expect(restored?.get('date_to')).toMatch(/T\d{2}:\d{2}:\d{2}/)
})

test('@K5-04 klik menu yang sama mengembalikan state ke URL', async ({ h }) => {
  const page = await h.openAs('super')
  await gotoApp(page, '/audit?q=admin&order=asc')
  await expect(page.getByLabel('Cari jejak audit')).toHaveValue('admin')
  await expect(page.getByLabel('Urutan')).toHaveValue('asc')

  await page.getByRole('link', { name: 'Jejak Audit' }).first().click()
  await expect(page).not.toHaveURL(/[?&]q=/)
  await expect(page.getByLabel('Cari jejak audit')).toHaveValue('')
  await expect(page.getByLabel('Urutan')).toHaveValue('desc')
})

test('@K5-03 modal detail dikelompokkan dan menampilkan ID Jejak', async ({ h }) => {
  const page = await h.openAs('super')
  await gotoApp(page, '/audit')
  await page.locator('tbody tr').first().click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()

  for (const title of ['Aksi', 'Aktor', 'Entitas', 'Konteks', 'Metadata']) {
    await expect(dialog.locator('section h3').filter({ hasText: title })).toHaveCount(1)
  }
  await expect(dialog.getByText('ID Jejak', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Waktu relatif', { exact: true })).toBeVisible()

  await dialog.locator('footer').getByRole('button', { name: 'Tutup', exact: true }).click()
  await expect(dialog).toHaveCount(0)
})

test('@K5-05 halaman di luar rentang menawarkan lompat ke halaman terakhir', async ({ h }) => {
  const page = await h.openAs('super')
  await gotoApp(page, '/audit?page=999')

  await expect(page.getByText('Halaman ini kosong')).toBeVisible()
  const summary = await page.getByText(/melewati halaman terakhir/).textContent()
  const lastPage = Number(/halaman terakhir \((\d+)\)/.exec(summary ?? '')?.[1])
  expect(Number.isFinite(lastPage)).toBe(true)

  const jump = page.getByRole('button', { name: 'Ke halaman terakhir' })
  await expect(jump).toBeVisible()
  await jump.click()

  await expect(page.getByText('Halaman ini kosong')).toHaveCount(0)
  await expect(page.locator('tbody tr').first()).toBeVisible()
  await expect
    .poll(() => new URL(page.url()).searchParams.get('page'), { timeout: 10000 })
    .toBe(lastPage === 1 ? null : String(lastPage))
})

test('@K5-06 parameter URL tidak valid dinormalisasi tanpa memicu crash', async ({ h }) => {
  const page = await h.openAs('super')
  await gotoApp(
    page,
    '/audit?user_id=bukan-uuid&from=2026-13-45&to=abc&entity=BUKAN_ENTITAS&action=nope&page=0&limit=-3',
  )

  await expect(page.getByRole('heading', { name: 'Jejak Audit', exact: true })).toBeVisible()
  await expect(page.getByText('Gagal memuat jejak audit')).toHaveCount(0)

  // `limit=-3` tidak diuji: `normaliseAuditLimit` menjepitnya ke batas server
  // (1), jadi kunci itu memang tetap ditulis ulang ke URL.
  const droppedKeys = ['user_id', 'from', 'to', 'entity', 'action'] as const
  await expect
    .poll(
      () => {
        const params = new URL(page.url()).searchParams
        return droppedKeys.filter((key) => params.has(key)).join(',')
      },
      { timeout: 10000 },
    )
    .toBe('')
  await expect(page.getByText('Gagal memuat jejak audit')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Jejak Audit', exact: true })).toBeVisible()
})

test('@K5-07 rentang tanggal terbalik menampilkan guard tanpa request', async ({ h }) => {
  const page = await h.openAs('super')
  const auditRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/audit-logs')) {
      auditRequests.push(request.url())
    }
  })

  await gotoApp(page, '/audit')
  await expect(page.getByLabel('Dari Tanggal')).toBeVisible()
  await expect(page.locator('tbody tr').first()).toBeVisible()

  await page.getByLabel('Dari Tanggal').fill('2099-01-02')
  await expect(page).toHaveURL(/[?&]from=2099-01-02/)
  await expect.poll(() => auditRequests.length, { timeout: 10000 }).toBeGreaterThan(0)
  // Rentang setengah jadi masih sah, jadi request-nya wajar; nol-kan dulu agar
  // yang diuji hanya jendela setelah tanggal kedua (rentang terbalik).
  auditRequests.length = 0

  await page.getByLabel('Sampai Tanggal').fill('2099-01-01')

  await expect(page.getByText('Rentang tanggal tidak valid')).toBeVisible()
  await expect(page.getByLabel('Dari Tanggal')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByText('Tanggal awal melewati tanggal akhir.')).toBeVisible()
  const guardReset = page.getByTestId('audit-range-reset')
  await expect(guardReset).toBeVisible()
  await expect(guardReset).toContainText('Reset Filter')

  // Rentang mustahil dipenuhi server: query dimatikan, jadi tidak boleh ada
  // request `/audit-logs` baru selama guard tampil.
  await page.waitForTimeout(1000)
  expect(auditRequests).toHaveLength(0)

  await guardReset.click()
  await expect(page.getByText('Rentang tanggal tidak valid')).toHaveCount(0)
  await expect(page).not.toHaveURL(/[?&]from=/)
  await expect(page).not.toHaveURL(/[?&]to=/)
})

