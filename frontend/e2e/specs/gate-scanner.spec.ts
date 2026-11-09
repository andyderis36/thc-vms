/**
 * SCR-05 — Gerbang Masuk & Scanner QR (E2E).
 *
 * Cakupan: input Visit ID manual, unggah gambar QR (jalur
 * `html5-qrcode.scanFile`), check-in/check-out, toleransi jendela backend
 * (GATE-04/05), isolasi cabang (GATE-08), pengawas multi-cabang di cabang
 * sekunder (GATE-13), dual-role admin (GATE-02),
 * lintas cabang super_admin (GATE-10), klik kartu antrean (GATE-11),
 * kartu `rescheduled` (GATE-12), dan smoke kamera headless (GATE-01).
 *
 * Semua kunjungan dibuat lewat `h.createVisit` sehingga ikut dibersihkan
 * teardown harness memakai token super_admin. Konteks browser manual untuk
 * vendor (deviceScaleFactor 2) ditutup sendiri di `finally`.
 *
 * Tidak ada `waitForTimeout`/`networkidle`: semua sinkronisasi memakai
 * `expect`/locator auto-wait.
 */

import { expect, test } from '../fixtures'
import type { Page } from '@playwright/test'
import {
  apiFetchRaw,
  checkInViaApi,
  FRONTEND_BASE,
  getVisitViaApi,
  LOCATIONS,
  loginViaApi,
  rescheduleVisitViaApi,
  TOKEN_STORAGE_KEY,
} from '../helpers/api'
import { gotoApp } from '../helpers/nav'

const GATE_URL = '/gate'
const TOLERANCE_TEXT = /toleransi/i

/** Buka `/gate` lalu tunggu panel pemindai siap (guard sesi sudah lolos). */
async function openGate(page: Page): Promise<void> {
  await gotoApp(page, GATE_URL)
  await expect(page.getByRole('tablist', { name: 'Mode pemindaian' })).toBeVisible()
}

/**
 * Pindai kunjungan lewat tab "Input Manual" dan kembalikan modal hasilnya.
 * Modal memiliki nama aksesibel `Hasil Pindaian — <visit_id>`.
 */
async function scanManual(page: Page, code: string) {
  await page.getByRole('tab', { name: 'Input Manual', exact: true }).click()
  const input = page.getByLabel('Visit ID', { exact: true })
  await expect(input).toBeVisible()
  await input.fill(code)
  await page.getByRole('button', { name: 'Proses Visit ID', exact: true }).click()

  const dialog = page.getByRole('dialog', { name: `Hasil Pindaian — ${code}` })
  await expect(dialog).toBeVisible()
  return dialog
}

/** Unggah berkas gambar QR lewat file chooser tombol "Unggah QR Code". */
async function uploadQrFile(page: Page, filePath: string): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Unggah QR Code', exact: true }).click()
  const chooser = await chooserPromise
  await chooser.setFiles(filePath)
}

test('@GATE-07 input manual happy path: check-in sukses & status jadi visiting', async ({
  h,
}) => {
  const visit = await h.createVisit('gate07', {
    locationId: LOCATIONS.hq,
    approve: true,
    withFiles: false,
  })
  expect(visit.status).toBe('approved')

  const page = await h.openAs('security')
  await openGate(page)

  const dialog = await scanManual(page, visit.code)
  // Tombol "Tutup" ada dua: ikon X (aria-label) di header dan tombol footer.
  // Dipakai footer karena itu tombol "Tutup" sesuai kontrak SCR-05.
  await expect(
    dialog.locator('footer').getByRole('button', { name: 'Tutup', exact: true }),
  ).toBeVisible()

  const checkInButton = dialog.getByRole('button', { name: 'Check-in Masuk', exact: true })
  await expect(checkInButton).toBeVisible()
  await checkInButton.click()

  // Modal ditutup setelah mutasi sukses dan toast sukses tampil.
  await expect(dialog).toBeHidden()
  await expect(page.getByText(`${visit.code} berhasil Check-in MASUK.`)).toBeVisible()

  await expect
    .poll(async () => (await getVisitViaApi(await h.tokenAs('super'), visit.id)).status)
    .toBe('visiting')
})

test('@GATE-06 QR upload dari galeri: screenshot kartu QR vendor berhasil dipindai', async ({
  h,
  browser,
}) => {
  const visit = await h.createVisit('gate06', {
    locationId: LOCATIONS.hq,
    approve: true,
    withFiles: false,
  })

  // Context manual agar bisa memaksa deviceScaleFactor 2 (tidak bisa diubah
  // setelah context dibuat). Token vendor disuntik ke localStorage, sama
  // seperti `h.openAs`.
  const vendorToken = await h.tokenAs('vendor')
  const vendorContext = await browser.newContext({
    baseURL: FRONTEND_BASE,
    deviceScaleFactor: 2,
    viewport: { width: 1280, height: 960 },
    storageState: {
      cookies: [],
      origins: [
        {
          origin: FRONTEND_BASE,
          localStorage: [{ name: TOKEN_STORAGE_KEY, value: vendorToken }],
        },
      ],
    },
  })

  const primaryPath = test.info().outputPath(`qr-${visit.code}.png`)
  const fallbackPath = test.info().outputPath(`qr-${visit.code}-inline.png`)

  try {
    const vendorPage = await vendorContext.newPage()
    // `waitUntil: 'domcontentloaded'`: event `load` di halaman detail bisa
    // tertahan resource pihak ketiga di dev server; auto-wait locator QR
    // (10s) sudah cukup untuk menunggu render kartu QR.
    await vendorPage.goto(`/visits/${visit.id}`, { waitUntil: 'domcontentloaded' })

    const inlineQr = vendorPage.locator(`svg[aria-label="QR Code ${visit.code}"]`)
    await expect(inlineQr).toBeVisible()

    // QR inline (SVG 192px) sebagai cadangan pertama.
    await inlineQr.locator('xpath=..').screenshot({ path: fallbackPath })

    // QR layar penuh (SVG 288px) + quiet zone putih p-4 sebagai sumber utama.
    await vendorPage
      .getByRole('button', { name: 'Perbesar Layar Penuh', exact: true })
      .click()
    const qrDialog = vendorPage.getByRole('dialog', { name: 'QR Code layar penuh' })
    await expect(qrDialog).toBeVisible()
    const fullQr = qrDialog.locator(
      `svg[aria-label="QR Code ${visit.code} layar penuh"]`,
    )
    await expect(fullQr).toBeVisible()
    await fullQr.locator('xpath=..').screenshot({ path: primaryPath })
  } finally {
    await vendorContext.close()
  }

  const page = await h.openAs('security')
  await openGate(page)
  await expect(page.getByRole('tab', { name: 'Kamera', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )

  const modal = page.getByRole('dialog', { name: `Hasil Pindaian — ${visit.code}` })
  const decodeError = page
    .getByRole('alert')
    .filter({ hasText: 'Gambar tidak terbaca' })

  await uploadQrFile(page, primaryPath)
  await expect(modal.or(decodeError)).toBeVisible({ timeout: 30_000 })

  // Upaya kedua HANYA bila decode pertama gagal: gambar QR inline (tanpa
  // dialog layar penuh, tetap 2x DPR).
  if (await decodeError.isVisible()) {
    console.log('[GATE-06] decode gagal pada gambar layar penuh; mencoba QR inline.')
    await uploadQrFile(page, fallbackPath)
    await expect(modal.or(decodeError)).toBeVisible({ timeout: 30_000 })
  }

  await expect(modal).toBeVisible()
  await expect(page.getByRole('button', { name: 'Unggah QR Code', exact: true })).toBeVisible()
  await expect(
    modal.getByRole('button', { name: 'Check-in Masuk', exact: true }),
  ).toBeVisible()
})

test('@GATE-09 check-out: kunjungan visiting dipindai ulang lalu selesai', async ({ h }) => {
  const visit = await h.createVisit('gate09', { withFiles: false })
  const securityToken = await h.tokenAs('security')
  const superToken = await h.tokenAs('super')

  await checkInViaApi(securityToken, visit.id)
  expect((await getVisitViaApi(superToken, visit.id)).status).toBe('visiting')

  const page = await h.openAs('security')
  await openGate(page)

  const dialog = await scanManual(page, visit.code)
  const checkOutButton = dialog.getByRole('button', { name: 'Check-out Keluar', exact: true })
  await expect(checkOutButton).toBeVisible()
  await checkOutButton.click()

  await expect(dialog).toBeHidden()
  await expect(page.getByText(`${visit.code} berhasil Check-out KELUAR.`)).toBeVisible()

  await expect
    .poll(async () => (await getVisitViaApi(superToken, visit.id)).status)
    .toBe('completed')
})

test('@GATE-04 terlalu awal: check-in ditolak jendela toleransi, status tetap approved', async ({
  h,
}) => {
  const visit = await h.createVisit('gate04', {
    startOffsetMinutes: 240,
    endOffsetMinutes: 420,
    withFiles: false,
  })
  const superToken = await h.tokenAs('super')

  const page = await h.openAs('security')
  await openGate(page)

  const dialog = await scanManual(page, visit.code)
  await dialog.getByRole('button', { name: 'Check-in Masuk', exact: true }).click()

  const alert = dialog.getByRole('alert')
  await expect(alert).toBeVisible()
  const message = (await alert.textContent()) ?? ''
  console.log(`[GATE-04] teks error persis: ${JSON.stringify(message)}`)
  expect(message).toMatch(TOLERANCE_TEXT)

  // Modal tidak boleh tertutup saat konfirmasi gagal.
  await expect(dialog).toBeVisible()
  expect((await getVisitViaApi(superToken, visit.id)).status).toBe('approved')
})

test('@GATE-05 kedaluwarsa: check-in ditolak jendela toleransi, status tetap approved', async ({
  h,
}) => {
  const visit = await h.createVisit('gate05', {
    startOffsetMinutes: -420,
    endOffsetMinutes: -240,
    withFiles: false,
  })
  const superToken = await h.tokenAs('super')

  const page = await h.openAs('security')
  await openGate(page)

  const dialog = await scanManual(page, visit.code)
  await dialog.getByRole('button', { name: 'Check-in Masuk', exact: true }).click()

  const alert = dialog.getByRole('alert')
  await expect(alert).toBeVisible()
  const message = (await alert.textContent()) ?? ''
  console.log(`[GATE-05] teks error persis: ${JSON.stringify(message)}`)
  expect(message).toMatch(TOLERANCE_TEXT)

  await expect(dialog).toBeVisible()
  expect((await getVisitViaApi(superToken, visit.id)).status).toBe('approved')
})

test('@GATE-08 lokasi salah: security cabang lain tidak bisa memproses kunjungan HQ', async ({
  h,
}) => {
  const visit = await h.createVisit('gate08', {
    locationId: LOCATIONS.hq,
    approve: true,
    withFiles: false,
  })
  const superToken = await h.tokenAs('super')

  const page = await h.openAs('security-sambas')
  await openGate(page)

  await page.getByRole('tab', { name: 'Input Manual', exact: true }).click()
  await page.getByLabel('Visit ID', { exact: true }).fill(visit.code)
  await page.getByRole('button', { name: 'Proses Visit ID', exact: true }).click()

  // GET detail kunjungan cabang lain ditolak backend, jadi UI berhenti di
  // feedback "Tiket tidak ditemukan" — modal check-in tidak pernah terbuka.
  const feedback = page.getByText('Tiket tidak ditemukan')
  await expect(feedback).toBeVisible()
  const feedbackMessage = page.getByText(`Kode "${visit.code}" tidak terdaftar.`)
  await expect(feedbackMessage).toBeVisible()
  await expect(
    page.getByRole('dialog', { name: `Hasil Pindaian — ${visit.code}` }),
  ).toHaveCount(0)
  console.log(
    `[GATE-08] teks penolakan UI persis: ${JSON.stringify(
      (await page
        .getByText(new RegExp(`Kode "${visit.code}" tidak terdaftar`))
        .textContent()) ?? '',
    )}`,
  )

  // Jalur API tetap diuji agar pesan penolakan backend tercatat: check-in
  // lintas cabang ditolak 403.
  const sambasToken = await h.tokenAs('security-sambas')
  const rejection = await checkInViaApi(sambasToken, visit.id).then(
    () => null,
    (error: unknown) => error,
  )
  expect(rejection).toBeInstanceOf(Error)
  const rejectionMessage = (rejection as Error).message
  console.log(`[GATE-08] pesan penolakan backend: ${JSON.stringify(rejectionMessage)}`)
  expect(rejectionMessage).toContain('Tidak berhak mengelola kunjungan cabang lain')

  expect((await getVisitViaApi(superToken, visit.id)).status).toBe('approved')
})

test('@GATE-02 dual-role admin: admin HQ boleh check-in lewat layar gerbang', async ({ h }) => {
  const visit = await h.createVisit('gate02', {
    locationId: LOCATIONS.hq,
    approve: true,
    withFiles: false,
  })
  const superToken = await h.tokenAs('super')

  const page = await h.openAs('admin')
  await openGate(page)

  const dialog = await scanManual(page, visit.code)
  await dialog.getByRole('button', { name: 'Check-in Masuk', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText(`${visit.code} berhasil Check-in MASUK.`)).toBeVisible()

  await expect
    .poll(async () => (await getVisitViaApi(superToken, visit.id)).status)
    .toBe('visiting')

  const raw = await apiFetchRaw<{
    success: boolean
    data?: { checked_in_by?: string | null }
  }>(superToken, 'GET', `/visits/${visit.id}`)
  expect(raw.status).toBe(200)
  const checkedInBy = raw.body.data?.checked_in_by ?? null
  console.log(`[GATE-02] checked_in_by: ${JSON.stringify(checkedInBy)}`)
  expect(typeof checkedInBy).toBe('string')
  expect(checkedInBy).not.toBe('')
})

test('@GATE-10 super admin lintas cabang: check-in kunjungan Sambas dari gerbang', async ({
  h,
}) => {
  const visit = await h.createVisit('gate10', {
    locationId: LOCATIONS.sambas,
    approve: true,
    withFiles: false,
  })
  const superToken = await h.tokenAs('super')

  const page = await h.openAs('super')
  await openGate(page)

  const dialog = await scanManual(page, visit.code)
  await dialog.getByRole('button', { name: 'Check-in Masuk', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText(`${visit.code} berhasil Check-in MASUK.`)).toBeVisible()

  await expect
    .poll(async () => (await getVisitViaApi(superToken, visit.id)).status)
    .toBe('visiting')
})

test('@GATE-11 klik kartu antrean membuka detail hasil pindaian', async ({ h }) => {
  const visit = await h.createVisit('gate11', { withFiles: false })

  const page = await h.openAs('security')
  await openGate(page)

  // Isolasi kartu lewat pencarian server-side, bukan menebak urutan antrean.
  await page.getByLabel('Cari kunjungan').fill(visit.code)

  const cardButton = page.getByRole('button', { name: `Lihat detail ${visit.code}` })
  await expect(cardButton).toBeVisible()
  await cardButton.click()

  const dialog = page.getByRole('dialog', { name: `Hasil Pindaian — ${visit.code}` })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(visit.code, { exact: false }).first()).toBeVisible()
  await expect(
    dialog.getByRole('button', { name: 'Check-in Masuk', exact: true }),
  ).toBeVisible()
})

test('@GATE-12 kartu rescheduled: badge Jadwal Digeser tanpa aksi check-in/QR', async ({ h }) => {
  const visit = await h.createVisit('gate12', { withFiles: false })
  const superToken = await h.tokenAs('super')

  const start = new Date(Date.now() + 60 * 60_000)
  const end = new Date(Date.now() + 300 * 60_000)
  await rescheduleVisitViaApi(superToken, visit.id, start.toISOString(), end.toISOString())
  expect((await getVisitViaApi(superToken, visit.id)).status).toBe('rescheduled')

  const page = await h.openAs('security')
  await openGate(page)
  await page.getByLabel('Cari kunjungan').fill(visit.code)

  const card = page
    .locator('li')
    .filter({ has: page.getByRole('button', { name: `Lihat detail ${visit.code}` }) })
  await expect(card).toBeVisible()

  const badge = card.getByText('Jadwal Digeser', { exact: true })
  await expect(badge).toBeVisible()
  console.log(`[GATE-12] teks badge persis: ${JSON.stringify((await badge.textContent()) ?? '')}`)

  await expect(card.getByRole('button', { name: 'Check-in Masuk', exact: true })).toHaveCount(0)
  await expect(card.getByRole('button', { name: /QR/i })).toHaveCount(0)
})

test('@GATE-01 kamera tidak tersedia (getUserMedia ditolak) tanpa merusak halaman', async ({
  h,
}) => {
  const page = await h.openAs('security', {
    initScript: () => {
      const media = navigator.mediaDevices
      if (media === undefined) return
      media.getUserMedia = () =>
        Promise.reject(new DOMException('Requested device not found', 'NotFoundError'))
      media.enumerateDevices = () => Promise.resolve([])
    },
  })
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })

  await openGate(page)

  const cameraTab = page.getByRole('tab', { name: 'Kamera', exact: true })
  await expect(cameraTab).toBeVisible()
  await expect(cameraTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab', { name: 'Input Manual', exact: true })).toBeVisible()

  const cameraFailure = page.getByText(
    /Kamera tidak ditemukan|Izin kamera ditolak|Kamera hanya bisa aktif|Kamera tidak dapat diakses/,
  )
  await expect(cameraFailure).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('heading', { name: 'Scan Barcode', exact: true })).toBeVisible()

  // Panel lain tetap hidup — halaman tidak crash karena kamera gagal.
  await page.getByRole('tab', { name: 'Input Manual', exact: true }).click()
  await expect(page.getByLabel('Visit ID', { exact: true })).toBeVisible()

  expect(pageErrors).toEqual([])
  const unexpectedConsoleErrors = consoleErrors.filter(
    (text) =>
      !/camera|media|device|notfound|permission|getusermedia|secure|stream/i.test(text),
  )
  console.log(`[GATE-01] console errors: ${JSON.stringify(consoleErrors)}`)
  expect(unexpectedConsoleErrors).toEqual([])
})

test('@GATE-13 pengawas multi-cabang check-in/out di cabang sekunder, 403 di luar cakupan', async ({
  h,
  browser,
}) => {
  const superToken = await h.tokenAs('super')
  const email = `${h.unique('gatesec').toLowerCase()}@transhybrid.net.id`
  let guardId = ''
  try {
    // Petugas temp dengan coverage HQ + Sambas.
    const created = await apiFetchRaw<{ success: boolean; data: { id: string } }>(
      superToken,
      'POST',
      '/users/security',
      {
        name: `E2E Gate Guard ${h.unique('name')}`,
        email,
        password: 'Password123!',
        phone: '081200000013',
        location_id: LOCATIONS.hq,
        location_ids: [LOCATIONS.hq, LOCATIONS.sambas],
      },
    )
    expect(created.status, 'pembuatan pengawas temp harus 201').toBe(201)
    guardId = (created.body as { data: { id: string } }).data.id

    const guardToken = (await loginViaApi(email, 'Password123!')).token

    const sambasVisit = await h.createVisit('gate13-sbs', {
      locationId: LOCATIONS.sambas,
      approve: true,
      withFiles: false,
    })
    expect(sambasVisit.status).toBe('approved')
    const outsideVisit = await h.createVisit('gate13-out', {
      locationId: LOCATIONS.mempawah,
      approve: true,
      withFiles: false,
    })

    // UI: gerbang menerima tiket cabang sekunder (Sambas) — check-in lalu check-out.
    const guardContext = await browser.newContext({
      baseURL: FRONTEND_BASE,
      storageState: {
        cookies: [],
        origins: [
          {
            origin: FRONTEND_BASE,
            localStorage: [{ name: TOKEN_STORAGE_KEY, value: guardToken }],
          },
        ],
      },
    })
    try {
      const page = await guardContext.newPage()
      await openGate(page)

      const inDialog = await scanManual(page, sambasVisit.code)
      const checkInButton = inDialog.getByRole('button', { name: 'Check-in Masuk', exact: true })
      await expect(checkInButton).toBeVisible()
      await checkInButton.click()
      await expect(inDialog).toBeHidden()
      await expect(page.getByText(`${sambasVisit.code} berhasil Check-in MASUK.`)).toBeVisible()
      await expect
        .poll(async () => (await getVisitViaApi(superToken, sambasVisit.id)).status)
        .toBe('visiting')

      const outDialog = await scanManual(page, sambasVisit.code)
      const checkOutButton = outDialog.getByRole('button', { name: 'Check-out Keluar', exact: true })
      await expect(checkOutButton).toBeVisible()
      await checkOutButton.click()
      await expect(outDialog).toBeHidden()
      await expect(page.getByText(`${sambasVisit.code} berhasil Check-out KELUAR.`)).toBeVisible()
      await expect
        .poll(async () => (await getVisitViaApi(superToken, sambasVisit.id)).status)
        .toBe('completed')
    } finally {
      await guardContext.close()
    }

    // API: cabang di luar cakupan (Mempawah) tetap 403 dan status tak berubah.
    const rejection = await checkInViaApi(guardToken, outsideVisit.id).then(
      () => null,
      (error: unknown) => error,
    )
    expect(rejection).toBeInstanceOf(Error)
    expect((rejection as Error).message).toContain('Tidak berhak mengelola kunjungan cabang lain')
    expect((await getVisitViaApi(superToken, outsideVisit.id)).status).toBe('approved')
  } finally {
    if (guardId !== '') {
      await apiFetchRaw(superToken, 'DELETE', `/users/security/${guardId}`)
    }
  }
})
