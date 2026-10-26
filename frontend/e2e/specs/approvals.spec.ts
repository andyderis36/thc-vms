/**
 * SCR-02 (irisan) — Halaman Antrean Approval (`/approvals`).
 *
 * Semua test masuk lewat `h.openAs(role)` (token asli di localStorage, bukan
 * storageState project) sehingga tiap skenario menguji peran dari nol.
 * Kunjungan dibuat lewat `h.createVisit` (auto-cleanup teardown) — spec ini
 * TIDAK membuat kunjungan lewat UI, jadi tidak perlu sweep manual.
 *
 * Catatan label nyata (dibaca dari kode, bukan asumsi):
 * - Tombol detail halaman `/visits/[id]` bernama "Ubah Jadwal" (bukan
 *   "Ajukan Reschedule") dan membuka modal berjudul "Ubah Jadwal Kunjungan"
 *   dengan field "Tanggal & Waktu Mulai", "Tanggal & Waktu Selesai",
 *   "Alasan Perubahan Jadwal" (wajib), lalu tombol "Simpan Jadwal Baru".
 * - Badge status `rescheduled` berlabel "Jadwal Digeser" (`VISIT_STATUS_META`).
 * - Endpoint detail kunjungan tidak mengekspos catatan approval / alasan
 *   penolakan (hanya tersimpan di riwayat status internal), jadi verifikasi
 *   catatan/alasan dibatasi pada field yang memang tersedia di API — status.
 *
 * Tidak ada `waitForTimeout` / `networkidle`: semua tunggu memakai auto-retry
 * `expect(...)`. Navigasi APPR-05 memakai link sidebar (`next/link`, client
 * routing) dan dibuktikan tanpa reload lewat penanda `window`.
 */

import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import { getVisitViaApi, LOCATIONS } from '../helpers/api'

/** `datetime-local` memakai waktu lokal tanpa zona: `YYYY-MM-DDTHH:mm`. */
function toLocalInput(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  ].join('T')
}

/** Waktu lokal berpresisi menit (detik dimulai dari 0 agar cocok `datetime-local`). */
function plusMinutes(minutes: number): Date {
  const date = new Date(Date.now() + minutes * 60_000)
  date.setSeconds(0, 0)
  return date
}

function approveButton(page: Page, code: string) {
  return page.getByRole('button', { name: `Setujui kunjungan ${code}`, exact: true })
}

function rejectButton(page: Page, code: string) {
  return page.getByRole('button', { name: `Tolak kunjungan ${code}`, exact: true })
}

/** Baris tabel kunjungan (desktop 1280px; kartu mobile `lg:hidden` tidak ikut). */
function visitRow(page: Page, code: string) {
  return page.getByRole('row').filter({
    has: page.getByRole('link', { name: `Lihat detail kunjungan ${code}`, exact: true }),
  })
}

async function openApprovals(page: Page): Promise<void> {
  await page.goto('/approvals')
  await expect(page.getByRole('heading', { name: 'Antrean Approval', exact: true })).toBeVisible()
}

/**
 * Ubah jadwal lewat modal nyata di halaman detail, lalu tunggu modal tertutup
 * (penanda bahwa mutasi sukses; kegagalan backend menampilkan alert dan modal
 * tetap terbuka sehingga `toHaveCount(0)` akan gagal dengan bukti).
 */
async function rescheduleViaUi(page: Page, start: Date, end: Date): Promise<void> {
  await page.getByRole('button', { name: 'Ubah Jadwal', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(
    dialog.getByRole('heading', { name: 'Ubah Jadwal Kunjungan', exact: true }),
  ).toBeVisible()
  await dialog.getByLabel('Tanggal & Waktu Mulai').fill(toLocalInput(start))
  await dialog.getByLabel('Tanggal & Waktu Selesai').fill(toLocalInput(end))
  await dialog.getByLabel('Alasan Perubahan Jadwal').fill('E2E penjadwalan ulang approval')
  await dialog.getByRole('button', { name: 'Simpan Jadwal Baru', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

test('@NAV-01 antrean menampilkan kunjungan requested cabang admin dan menyembunyikan cabang lain', async ({
  h,
}) => {
  const hqVisit = await h.createVisit('nav01', { approve: false })
  const sambasVisit = await h.createVisit('nav01-sbs', {
    approve: false,
    locationId: LOCATIONS.sambas,
  })

  const page = await h.openAs('admin')
  await openApprovals(page)

  const row = visitRow(page, hqVisit.code)
  await expect(row).toBeVisible()
  await expect(row.getByText('Diminta', { exact: true })).toBeVisible()
  await expect(approveButton(page, hqVisit.code)).toBeVisible()
  await expect(rejectButton(page, hqVisit.code)).toBeVisible()

  // Isolasi cabang: kunjungan Sambas tidak pernah dirender untuk admin HQ.
  await expect(approveButton(page, sambasVisit.code)).toHaveCount(0)
  await expect(rejectButton(page, sambasVisit.code)).toHaveCount(0)
  await expect(
    page.getByRole('link', { name: `Lihat detail kunjungan ${sambasVisit.code}`, exact: true }),
  ).toHaveCount(0)
})

test('@APPR-01 approve via modal menyimpan keputusan dan menghapus baris dari antrean', async ({
  h,
}) => {
  const visit = await h.createVisit('appr01', { approve: false })
  const note = h.unique('appr01-note')

  const page = await h.openAs('admin')
  await openApprovals(page)
  await approveButton(page, visit.code).click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(
    dialog.getByRole('heading', { name: 'Setujui Kunjungan', exact: true }),
  ).toBeVisible()
  await dialog.getByLabel('Catatan Persetujuan').fill(note)

  // "Setujui" di footer modal — tombol baris bernama "Setujui kunjungan …".
  await dialog.getByRole('button', { name: 'Setujui', exact: true }).click()
  await expect(dialog).toHaveCount(0)

  // Baris requested keluar dari antrean: tombol keputusan hilang tanpa reload.
  await expect(approveButton(page, visit.code)).toHaveCount(0)
  await expect(rejectButton(page, visit.code)).toHaveCount(0)
  await expect(page).toHaveURL(/\/approvals$/)

  const fetched = await getVisitViaApi(await h.tokenAs('super'), visit.id)
  expect(fetched.status).toBe('approved')
})

test('@APPR-02 reject mensyaratkan alasan minimal 5 karakter lalu menyimpan status rejected', async ({
  h,
}) => {
  const visit = await h.createVisit('appr02', { approve: false })
  const reason = 'Alasan E2E ditolak'

  const page = await h.openAs('admin')
  await openApprovals(page)
  await rejectButton(page, visit.code).click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(
    dialog.getByRole('heading', { name: 'Tolak Kunjungan', exact: true }),
  ).toBeVisible()

  const reasonField = dialog.getByLabel('Alasan Penolakan')
  const rejectSubmit = dialog.getByRole('button', { name: 'Tolak', exact: true })

  // Kosong -> nonaktif; 4 karakter -> masih nonaktif.
  await expect(rejectSubmit).toBeDisabled()
  await reasonField.fill('abcd')
  await expect(rejectSubmit).toBeDisabled()

  // 19 karakter -> aktif, lalu submit.
  await reasonField.fill(reason)
  await expect(rejectSubmit).toBeEnabled()
  await rejectSubmit.click()
  await expect(dialog).toHaveCount(0)

  await expect(rejectButton(page, visit.code)).toHaveCount(0)
  await expect(approveButton(page, visit.code)).toHaveCount(0)
  await expect(page).toHaveURL(/\/approvals$/)

  const fetched = await getVisitViaApi(await h.tokenAs('super'), visit.id)
  expect(fetched.status).toBe('rejected')
})

test('@APPR-03 reschedule lewat detail lalu approve ulang dari antrean', async ({ h }) => {
  const visit = await h.createVisit('appr03', { approve: false })
  const newStart = plusMinutes(24 * 60)
  const newEnd = plusMinutes(24 * 60 + 120)

  const page = await h.openAs('admin')
  await page.goto(`/visits/${visit.id}`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText(visit.code)

  await rescheduleViaUi(page, newStart, newEnd)

  // Detail langsung mencerminkan status baru (`rescheduled` -> "Jadwal Digeser").
  await expect(page.getByText('Jadwal Digeser', { exact: true }).first()).toBeVisible()

  const afterReschedule = await getVisitViaApi(await h.tokenAs('super'), visit.id)
  expect(afterReschedule.status).toBe('rescheduled')
  expect(afterReschedule.start_date).toBeDefined()
  const startDelta = Math.abs(new Date(afterReschedule.start_date ?? '').getTime() - newStart.getTime())
  expect(startDelta).toBeLessThan(60_000)

  // Kembali ke antrean: kunjungan rescheduled wajib muncul untuk di-approve ulang.
  await openApprovals(page)
  const row = visitRow(page, visit.code)
  await expect(row).toBeVisible()
  await expect(row.getByText('Jadwal Digeser', { exact: true })).toBeVisible()
  await expect(approveButton(page, visit.code)).toBeVisible()
  // `rescheduled->rejected` ilegal di backend, jadi tombol Tolak tidak ditawarkan.
  await expect(rejectButton(page, visit.code)).toHaveCount(0)

  await approveButton(page, visit.code).click()
  const dialog = page.getByRole('dialog')
  await expect(
    dialog.getByRole('heading', { name: 'Setujui Kunjungan', exact: true }),
  ).toBeVisible()
  await dialog.getByRole('button', { name: 'Setujui', exact: true }).click()
  await expect(dialog).toHaveCount(0)

  const finalVisit = await getVisitViaApi(await h.tokenAs('super'), visit.id)
  expect(finalVisit.status).toBe('approved')
})

test('@APPR-05 antrean menyegarkan tanpa reload setelah reschedule dan approve ulang', async ({
  h,
}) => {
  const visit = await h.createVisit('appr05', { approve: false })
  const newStart = plusMinutes(48 * 60)
  const newEnd = plusMinutes(48 * 60 + 120)

  const page = await h.openAs('admin')
  await page.goto(`/visits/${visit.id}`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText(visit.code)

  await rescheduleViaUi(page, newStart, newEnd)

  // Penanda hidup di window; hilang bila navigasi memicu reload penuh.
  const marker = h.unique('appr05-no-reload')
  await page.evaluate((value) => {
    ;(window as unknown as Record<string, unknown>).__e2eMarker = value
  }, marker)

  // Navigasi SPA lewat sidebar (next/link) — BUKAN page.goto/reload.
  await page
    .getByRole('navigation', { name: 'Navigasi utama' })
    .getByRole('link', { name: 'Antrean Approval', exact: true })
    .click()
  await expect(page).toHaveURL(/\/approvals$/)
  await expect(page.getByRole('heading', { name: 'Antrean Approval', exact: true })).toBeVisible()

  const row = visitRow(page, visit.code)
  await expect(row).toBeVisible()
  await expect(row.getByText('Jadwal Digeser', { exact: true })).toBeVisible()
  await expect(approveButton(page, visit.code)).toBeVisible()
  await expect(rejectButton(page, visit.code)).toHaveCount(0)

  // Approve ulang di tempat: tombol setujui hilang tanpa reload halaman.
  await approveButton(page, visit.code).click()
  const dialog = page.getByRole('dialog')
  await expect(
    dialog.getByRole('heading', { name: 'Setujui Kunjungan', exact: true }),
  ).toBeVisible()
  await dialog.getByRole('button', { name: 'Setujui', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(approveButton(page, visit.code)).toHaveCount(0)

  const markerAfter = await page.evaluate(
    () => (window as unknown as Record<string, unknown>).__e2eMarker,
  )
  expect(markerAfter).toBe(marker)
  await expect(page).toHaveURL(/\/approvals$/)

  const fetched = await getVisitViaApi(await h.tokenAs('super'), visit.id)
  expect(fetched.status).toBe('approved')
})
