/**
 * SCR-04 — Kartu "Bukti Kerja" (`/visits/{id}`): CRUD penuh Anteseden.
 *
 * Yang dibuktikan, berurutan dalam SATU kunjungan visiting:
 * - W1 @WORK-01: kartu tampil dua slot kosong + hint format saat visiting.
 * - W2 @WORK-02: unggah UI (setInputFiles berkas NYATA dummy-assets) → slot
 *   terisi + stempel "Diunggah" + tombol Lihat/Ganti.
 * - W3 @WORK-03: tombol Lihat membuka dialog pratinjau modal (bukan tab baru).
 * - W4 @WORK-04: Ganti via UI → URL baru tampil + objek LAMA hilang dari
 *   bucket (stat MinIO → gone), objek baru ada. Inilah regresi untuk
 *   orphan-leak: backend menghapus objek terganti best-effort.
 * - W5 @WORK-05: purge superadmin (DELETE /visits/{id}) → SPK + kedua foto
 *   hilang dari bucket + GET → 404.
 *
 * Berkas nyata `dummy-assets/` (selfie.jpg, selfie-2.jpeg, ktp.jpg) dipakai
 * agar MIME/ukuran yang divalidasi backend adalah kasus produksi.
 * Tanpa `waitForTimeout`: sinkronisasi via expect visible + respons POST.
 */

import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import {
  apiFetchRaw,
  checkInViaApi,
  deleteVisitViaApi,
} from '../helpers/api'
import { gotoApp } from '../helpers/nav'
import { objectExists } from '../helpers/storage'

/** dummy-assets di root repo (spec berjalan dengan cwd `frontend/`). */
function dummyAsset(name: string): string {
  return path.join(process.cwd(), '..', 'dummy-assets', name)
}

/** Ambil URL berkas dari GET /visits/{id} mentah (VisitRecord tak membawa URL). */
async function detailFileUrls(
  token: string,
  id: string,
): Promise<{ spk: string | null; before: string | null; after: string | null }> {
  const result = await apiFetchRaw<unknown>(token, 'GET', `/visits/${id}`)
  const body = result.body as {
    success?: unknown
    data?: Record<string, unknown>
  }
  if (body.success !== true || body.data === undefined) {
    throw new Error('[work-photo] GET /visits/{id} tanpa data')
  }
  const data = body.data
  const str = (value: unknown): string | null =>
    typeof value === 'string' && value !== '' ? value : null
  const photos = data.work_photos as Record<string, unknown> | null | undefined
  return {
    spk: str(data.assignment_letter_url),
    before: str(photos?.before && (photos.before as Record<string, unknown>).url),
    after: str(photos?.after && (photos.after as Record<string, unknown>).url),
  }
}

async function openDetail(page: Page, visitId: string, code: string): Promise<void> {
  await gotoApp(page, `/visits/${visitId}`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText(code)
  await expect(page.getByText('Bukti Kerja', { exact: true })).toBeVisible()
}

/** Input file tersembunyi per slot (urutan DOM: before, after). */
function slotInput(page: Page, slot: 0 | 1) {
  return page.locator('input[type="file"]').nth(slot)
}

test('@WORK-01 visiting tanpa foto: dua slot kosong + hint format', async ({ h }) => {
  const visit = await h.createVisit('work01', { withFiles: false })
  await checkInViaApi(await h.tokenAs('security'), visit.id)

  const page = await h.openAs('vendor')
  await openDetail(page, visit.id, visit.code)

  await expect(page.getByText('Sebelum kerja', { exact: true })).toBeVisible()
  await expect(page.getByText('Sesudah kerja', { exact: true })).toBeVisible()
  await expect(page.getByText('Belum ada foto.').first()).toBeVisible()
  await expect(page.getByText('JPEG/PNG, maksimal 5 MB.').first()).toBeVisible()
})

test('@WORK-02 unggah UI berkas nyata: slot terisi + stempel + Lihat/Ganti', async ({
  h,
}) => {
  const visit = await h.createVisit('work02', { withFiles: false })
  await checkInViaApi(await h.tokenAs('security'), visit.id)

  const page = await h.openAs('vendor')
  await openDetail(page, visit.id, visit.code)

  await slotInput(page, 0).setInputFiles(dummyAsset('selfie.jpg'))
  await expect(page.getByText(/^Diunggah /).first()).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Lihat foto bukti sebelum kerja' }),
  ).toBeEnabled()

  await slotInput(page, 1).setInputFiles(dummyAsset('selfie-2.jpeg'))
  await expect(page.getByText(/^Diunggah /).nth(1)).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Lihat foto bukti sesudah kerja' }),
  ).toBeEnabled()
})

test('@WORK-03 tombol Lihat membuka dialog modal, bukan tab baru', async ({ h }) => {
  const visit = await h.createVisit('work03', { withFiles: false })
  await checkInViaApi(await h.tokenAs('security'), visit.id)

  const page = await h.openAs('vendor')
  await openDetail(page, visit.id, visit.code)
  await slotInput(page, 0).setInputFiles(dummyAsset('selfie.jpg'))
  await expect(page.getByText(/^Diunggah /).first()).toBeVisible()

  await page
    .getByRole('button', { name: 'Lihat foto bukti sebelum kerja' })
    .click()
  await expect(
    page.getByText('Pratinjau foto bukti sebelum kerja'),
  ).toBeVisible()
  // Tetap satu tab: tidak ada popup/window baru yang dibuka.
  expect(page.context().pages()).toHaveLength(1)
  await page.keyboard.press('Escape')
  await expect(
    page.getByText('Pratinjau foto bukti sebelum kerja'),
  ).not.toBeVisible()
})

test('@WORK-04 ganti foto: URL baru tampil + objek lama hilang dari bucket', async ({
  h,
}) => {
  const visit = await h.createVisit('work04', { withFiles: false })
  await checkInViaApi(await h.tokenAs('security'), visit.id)
  const vendorToken = await h.tokenAs('vendor')

  const page = await h.openAs('vendor')
  await openDetail(page, visit.id, visit.code)
  await slotInput(page, 0).setInputFiles(dummyAsset('selfie.jpg'))
  await expect(page.getByText(/^Diunggah /).first()).toBeVisible()

  const before = await detailFileUrls(vendorToken, visit.id)
  const oldUrl = before.before
  expect(oldUrl !== null).toBe(true)
  expect(await objectExists(oldUrl as string)).toBe(true)

  // Ganti dengan berkas lain lewat UI.
  await slotInput(page, 0).setInputFiles(dummyAsset('ktp.jpg'))
  await expect
    .poll(async () => (await detailFileUrls(vendorToken, visit.id)).before)
    .not.toBe(oldUrl)

  // Objek lama benar-benar terhapus dari MinIO; objek baru ada.
  expect(await objectExists(oldUrl as string)).toBe(false)
  const afterReplace = await detailFileUrls(vendorToken, visit.id)
  const newUrl = afterReplace.before as string
  expect(await objectExists(newUrl)).toBe(true)
})

test('@WORK-05 purge kunjungan: SPK + kedua foto hilang dari bucket + 404', async ({
  h,
}) => {
  const visit = await h.createVisit('work05', { withFiles: true })
  await checkInViaApi(await h.tokenAs('security'), visit.id)
  const vendorToken = await h.tokenAs('vendor')

  const page = await h.openAs('vendor')
  await openDetail(page, visit.id, visit.code)
  await slotInput(page, 0).setInputFiles(dummyAsset('selfie.jpg'))
  await expect(page.getByText(/^Diunggah /).first()).toBeVisible()
  await slotInput(page, 1).setInputFiles(dummyAsset('selfie-2.jpeg'))
  await expect(page.getByText(/^Diunggah /).nth(1)).toBeVisible()

  const detail = await detailFileUrls(vendorToken, visit.id)
  const urls = [detail.spk, detail.before, detail.after].filter(
    (u): u is string => u !== null,
  )
  expect(urls).toHaveLength(3)
  for (const url of urls) {
    expect(await objectExists(url)).toBe(true)
  }

  await deleteVisitViaApi(await h.tokenAs('super'), visit.id)

  for (const url of urls) {
    await expect.poll(() => objectExists(url), { timeout: 15_000 }).toBe(false)
  }
  await expect
    .poll(() =>
      apiFetchRaw(vendorToken, 'GET', `/visits/${visit.id}`).then(
        (result) => (result.status === 404 ? 'hilang' : 'ada'),
      ),
    )
    .toBe('hilang')
})
