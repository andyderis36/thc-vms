/**
 * SCR-04 — Siklus pembatalan kunjungan & kontrak `GET /visits/{id}/qr`.
 *
 * Di luar cakupan (sudah dikunci spec lain dan SENGAJA tidak diulang):
 * - `@APPR-03` / `@APPR-05` — ubah jadwal lewat modal + approve ulang
 *   (`approvals.spec.ts`).
 * - `@GATE-*` — check-in/check-out, toleransi jendela, dan isolasi cabang
 *   gerbang (`gate-scanner.spec.ts`). Spec ini hanya memakai akibatnya
 *   (gate menolak kunjungan yang sudah dibatalkan / sudah check-in).
 *
 * Semantik penolakan yang DIBACA dari kode (bukan tebakan):
 * - Cancel — `backend/internal/usecase/visit/lifecycle.go`:
 *   role yang boleh hanya `vendor`, `admin`, `super_admin`.
 *   `vendor` bukan pemilik -> `404 NOT_FOUND`; `admin` cabang lain ->
 *   `403 FORBIDDEN_BRANCH`; `security` -> `403 FORBIDDEN_BRANCH`;
 *   `super_admin` lintas cabang -> `200`. `visiting -> cancelled` tidak ada
 *   di state machine (`backend/internal/domain/status.go`) ->
 *   `409 INVALID_TRANSITION`.
 * - QR — `handlers/visit_handler.go` + `usecase/visit/detail.go`:
 *   endpoint HANYA memakai otorisasi baca (`super_admin` global,
 *   `admin`/`security` per cabang, `vendor` pemilik). TIDAK ada gerbang
 *   status di API; payload selalu `visit_id`. Karena itu gerbang "tanpa QR"
 *   untuk `rescheduled`/`cancelled` hidup di UI `isQrVisible()`
 *   (`components/layouts/VendorMobileShell.tsx`), dan spec ini membuktikan
 *   keduanya: API tetap 200, kartu tidak dirender.
 * - Check-in atas kunjungan `cancelled` — `usecase/gate/checkin.go` menolak
 *   sebelum state machine dengan `409 CONFLICT`.
 *
 * Label UI nyata dari kode: badge `cancelled` = "Dibatalkan", `rescheduled` =
 * "Jadwal Digeser", `visiting` = "Sedang di Lokasi"
 * (`frontend/src/lib/visits/status-badge.ts`). Tombol aksi: "Batalkan
 * Kunjungan" -> modal "Batalkan Kunjungan" -> "Ya, Batalkan Kunjungan".
 *
 * Semua kunjungan dibuat lewat `h.createVisit` (auto-cleanup teardown
 * super_admin); tidak ada kunjungan seed yang disentuh. Tanpa
 * `waitForTimeout`/`networkidle`: sinkronisasi memakai `expect`/`expect.poll`.
 */

import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import {
  LOCATIONS,
  apiFetchRaw,
  approveVisitViaApi,
  checkInViaApi,
  getVisitViaApi,
  rescheduleVisitViaApi,
  type ApiResult,
} from '../helpers/api'

interface QrData {
  visit_id: string
  qr_code_payload: string
}

interface RefusalData {
  code: string
  message: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Kartu QR SCR-04 — `<section aria-label="Kartu QR akses fasilitas">`. */
function qrSection(page: Page) {
  return page.locator('section[aria-label="Kartu QR akses fasilitas"]')
}

/** Grafik QR hanya dirender saat ada payload yang boleh ditampilkan. */
function qrSvg(page: Page, code: string) {
  return page.locator(`svg[aria-label="QR Code ${code}"]`)
}

function cancelButton(page: Page) {
  return page.getByRole('button', { name: 'Batalkan Kunjungan', exact: true })
}

/** Buka `/visits/{id}` lalu tunggu heading kode kunjungan (guard sesi lolos). */
async function openDetail(page: Page, visitId: string, code: string): Promise<void> {
  await page.goto(`/visits/${visitId}`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText(code)
}

/** Buka amplop sukses `{ visit_id, qr_code_payload }` dan validasi bentuknya. */
function readQr(result: ApiResult<unknown>): QrData {
  expect(result.status, 'GET /visits/:id/qr harus 200').toBe(200)
  const body = result.body
  if (!isRecord(body) || body.success !== true || !isRecord(body.data)) {
    throw new Error(`Respons QR tidak valid: ${JSON.stringify(body)}`)
  }
  const { visit_id: visitId, qr_code_payload: payload } = body.data
  if (typeof visitId !== 'string' || typeof payload !== 'string') {
    throw new Error(`Respons QR tanpa payload string: ${JSON.stringify(body)}`)
  }
  return { visit_id: visitId, qr_code_payload: payload }
}

/** Baca amplop gagal dan pastikan status HTTP persis seperti kontrak usecase. */
function readRefusal(result: ApiResult<unknown>, expectedStatus: number): RefusalData {
  expect(result.status, `HTTP harus ${expectedStatus}`).toBe(expectedStatus)
  const body = result.body
  if (!isRecord(body) || body.success !== false || !isRecord(body.error)) {
    throw new Error(`Amplop gagal tidak valid: ${JSON.stringify(body)}`)
  }
  const { code, message } = body.error
  if (typeof code !== 'string' || typeof message !== 'string') {
    throw new Error(`Amplop gagal tanpa code/message: ${JSON.stringify(body)}`)
  }
  return { code, message }
}

/** Ambil `reason` dari body request yang tertangkap (bila ada). */
function readReason(value: unknown): string | null {
  if (!isRecord(value)) return null
  const reason = value.reason
  return typeof reason === 'string' ? reason : null
}

/** Kartu QR tetap ter-mount, tetapi payload/grafiknya tidak boleh tampil. */
async function expectQrCardHidden(page: Page, code: string): Promise<void> {
  await expect(qrSvg(page, code)).toHaveCount(0)
  await expect(
    qrSection(page).getByText('QR Code terbit setelah izin disetujui', { exact: true }),
  ).toBeVisible()
}

test('@CANCEL-01 vendor membatalkan kunjungan approved miliknya lewat modal: toast, badge, API, QR, dan gerbang ikut terkunci', async ({
  h,
}) => {
  const visit = await h.createVisit('cancel01', { withFiles: false })
  expect(visit.status).toBe('approved')

  const page = await h.openAs('vendor')
  await openDetail(page, visit.id, visit.code)
  // Prasyarat: kunjungan approved memang menampilkan kartu QR.
  await expect(qrSvg(page, visit.code)).toBeVisible()

  await cancelButton(page).click()
  const dialog = page.getByRole('dialog')
  await expect(
    dialog.getByRole('heading', { name: 'Batalkan Kunjungan', exact: true }),
  ).toBeVisible()
  await dialog.getByRole('button', { name: 'Ya, Batalkan Kunjungan', exact: true }).click()
  await expect(dialog).toHaveCount(0)

  // Permukaan 1 — toast sukses dari `CancelModal`.
  await expect(page.getByText('Kunjungan berhasil dibatalkan.', { exact: true })).toBeVisible()
  // Permukaan 2 — badge detail: VISIT_STATUS_META.cancelled -> "Dibatalkan".
  await expect(page.getByText('Dibatalkan', { exact: true }).first()).toBeVisible()
  // Permukaan 3 — status tersimpan menurut API.
  const fetched = await getVisitViaApi(await h.tokenAs('vendor'), visit.id)
  expect(fetched.status).toBe('cancelled')

  // Konsekuensi 1 — payload QR tidak lagi dirender.
  await expectQrCardHidden(page, visit.code)

  // Konsekuensi 2 — gerbang menolak check-in. Gate usecase memeriksa status
  // SEBELUM state machine, jadi kode galatnya CONFLICT (409), bukan
  // INVALID_TRANSITION.
  const rejection = await apiFetchRaw(
    await h.tokenAs('security'),
    'POST',
    `/visits/${visit.id}/checkin`,
    {},
  )
  const refusal = readRefusal(rejection, 409)
  expect(refusal.code).toBe('CONFLICT')
  expect(refusal.message).toContain('cancelled')
})

test('@CANCEL-02 alasan pembatalan ditangkap form dan diteruskan ke API', async ({ h }) => {
  const visit = await h.createVisit('cancel02', { withFiles: false })
  const reason = h.unique('pekerjaan dibatalkan pelanggan')
  const page = await h.openAs('vendor')
  await openDetail(page, visit.id, visit.code)

  // Tangkap body request nyata: satu-satunya bukti eksternal bahwa alasan
  // benar-benar "captured" (riwayat status tidak diekspos endpoint baca).
  const cancelRequests: unknown[] = []
  page.on('request', (request) => {
    if (request.method() !== 'POST') return
    if (!new URL(request.url()).pathname.endsWith(`/visits/${visit.id}/cancel`)) return
    cancelRequests.push(JSON.parse(request.postData() ?? 'null') as unknown)
  })

  await cancelButton(page).click()
  const dialog = page.getByRole('dialog')
  const reasonField = dialog.getByLabel('Alasan Pembatalan')
  await expect(
    dialog.getByText('Opsional. Alasan akan tercatat pada riwayat kunjungan.', {
      exact: true,
    }),
  ).toBeVisible()
  await reasonField.fill(reason)
  await expect(reasonField).toHaveValue(reason)

  await dialog.getByRole('button', { name: 'Ya, Batalkan Kunjungan', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText('Kunjungan berhasil dibatalkan.', { exact: true })).toBeVisible()

  await expect.poll(() => cancelRequests.length).toBe(1)
  expect(readReason(cancelRequests[0])).toBe(reason)

  const fetched = await getVisitViaApi(await h.tokenAs('vendor'), visit.id)
  expect(fetched.status).toBe('cancelled')
})

test('@CANCEL-03 peran bukan pemilik tidak bisa membatalkan: UI absen + API menolak sesuai usecase', async ({
  h,
}) => {
  const hqVisit = await h.createVisit('cancel03-hq', { withFiles: false })
  const sambasVisit = await h.createVisit('cancel03-sbs', {
    locationId: LOCATIONS.sambas,
    withFiles: false,
  })
  // Kunjungan milik admin (bukan vendor) untuk membuktikan aturan ownership.
  const adminOwnedVisit = await h.createVisit('cancel03-admin', {
    role: 'admin',
    withFiles: false,
  })

  const adminToken = await h.tokenAs('admin')
  const adminSambasToken = await h.tokenAs('admin-sambas')
  const securityToken = await h.tokenAs('security')
  const superToken = await h.tokenAs('super')
  const vendorToken = await h.tokenAs('vendor')

  // --- Permukaan UI ------------------------------------------------------
  // security: boleh membaca detail cabangnya, tetapi matriks kapabilitas
  // (`capabilities.ts`) tidak memberi `cancelVisit`.
  const securityPage = await h.openAs('security')
  await openDetail(securityPage, hqVisit.id, hqVisit.code)
  await expect(cancelButton(securityPage)).toHaveCount(0)

  // admin cabang lain tidak bisa melihat detail -> layar "Akses ditolak",
  // sehingga kontrol batal tidak pernah dirender.
  const sambasAdminPage = await h.openAs('admin-sambas')
  await sambasAdminPage.goto(`/visits/${hqVisit.id}`)
  await expect(sambasAdminPage.getByText('Akses ditolak', { exact: true })).toBeVisible()
  await expect(cancelButton(sambasAdminPage)).toHaveCount(0)

  const adminPage = await h.openAs('admin')
  await adminPage.goto(`/visits/${sambasVisit.id}`)
  await expect(adminPage.getByText('Akses ditolak', { exact: true })).toBeVisible()
  await expect(cancelButton(adminPage)).toHaveCount(0)

  // super_admin adalah pengecualian yang disengaja: kapabilitas
  // `cancelVisit` + `viewAllBranches` membuat kontrolnya benar-benar dirender.
  const superPage = await h.openAs('super')
  await openDetail(superPage, hqVisit.id, hqVisit.code)
  await expect(cancelButton(superPage)).toBeVisible()

  // --- Permukaan API -----------------------------------------------------
  // admin HQ pada kunjungan Sambas -> 403 FORBIDDEN_BRANCH (bukan 404).
  const adminRefusal = readRefusal(
    await apiFetchRaw(adminToken, 'POST', `/visits/${sambasVisit.id}/cancel`, {}),
    403,
  )
  expect(adminRefusal.code).toBe('FORBIDDEN_BRANCH')

  // admin Sambas pada kunjungan HQ -> 403 FORBIDDEN_BRANCH.
  const sambasAdminRefusal = readRefusal(
    await apiFetchRaw(adminSambasToken, 'POST', `/visits/${hqVisit.id}/cancel`, {}),
    403,
  )
  expect(sambasAdminRefusal.code).toBe('FORBIDDEN_BRANCH')

  // security (cabang yang sama) -> 403 karena role, bukan 404.
  const securityRefusal = readRefusal(
    await apiFetchRaw(securityToken, 'POST', `/visits/${hqVisit.id}/cancel`, {}),
    403,
  )
  expect(securityRefusal.code).toBe('FORBIDDEN_BRANCH')

  // vendor bukan pemilik -> 404 NOT_FOUND (aturan ownership).
  const foreignVendorRefusal = readRefusal(
    await apiFetchRaw(vendorToken, 'POST', `/visits/${adminOwnedVisit.id}/cancel`, {}),
    404,
  )
  expect(foreignVendorRefusal.code).toBe('NOT_FOUND')

  // super_admin lintas cabang -> 200 (satu-satunya yang global).
  const superAllowed = await apiFetchRaw(
    superToken,
    'POST',
    `/visits/${sambasVisit.id}/cancel`,
    { reason: 'E2E superadmin lintas cabang' },
  )
  expect(superAllowed.status).toBe(200)
  expect((await getVisitViaApi(superToken, sambasVisit.id)).status).toBe('cancelled')

  // Penolakan tidak mengubah status kunjungan HQ.
  expect((await getVisitViaApi(superToken, hqVisit.id)).status).toBe('approved')
})

test('@CANCEL-04 kunjungan yang sudah check-in tidak bisa dibatalkan (visiting -> cancelled ilegal)', async ({
  h,
}) => {
  const visit = await h.createVisit('cancel04', { withFiles: false })
  const securityToken = await h.tokenAs('security')
  const superToken = await h.tokenAs('super')
  const vendorToken = await h.tokenAs('vendor')

  await checkInViaApi(securityToken, visit.id)
  expect((await getVisitViaApi(superToken, visit.id)).status).toBe('visiting')

  const page = await h.openAs('vendor')
  await openDetail(page, visit.id, visit.code)
  await expect(page.getByText('Sedang di Lokasi', { exact: true }).first()).toBeVisible()
  // `isCancelableStatus` mengecualikan `visiting` — tombol tidak pernah ada.
  await expect(cancelButton(page)).toHaveCount(0)

  // Pemilik pun ditolak: `visiting -> cancelled` tidak ada di state machine.
  const vendorRefusal = readRefusal(
    await apiFetchRaw(vendorToken, 'POST', `/visits/${visit.id}/cancel`, {
      reason: 'Terlambat membatalkan',
    }),
    409,
  )
  expect(vendorRefusal.code).toBe('INVALID_TRANSITION')

  // Admin cabang juga ditolak pada edge yang sama.
  const adminRefusal = readRefusal(
    await apiFetchRaw(await h.tokenAs('admin'), 'POST', `/visits/${visit.id}/cancel`, {}),
    409,
  )
  expect(adminRefusal.code).toBe('INVALID_TRANSITION')

  expect((await getVisitViaApi(superToken, visit.id)).status).toBe('visiting')
})

test('@QREP-01 pemilik kunjungan approved menerima payload QR = visit_id, kartu above-the-fold di 360px', async ({
  h,
}) => {
  const visit = await h.createVisit('qrep01', { withFiles: false })
  const vendorToken = await h.tokenAs('vendor')

  const qr = readQr(await apiFetchRaw(vendorToken, 'GET', `/visits/${visit.id}/qr`))
  expect(qr.visit_id).toBe(visit.code)
  expect(qr.qr_code_payload).toBe(visit.code)

  const page = await h.openAs('vendor')
  // SCR-04: ponsel 360px, kartu QR wajib berada di atas lipatan 800px.
  await page.setViewportSize({ width: 360, height: 800 })
  await openDetail(page, visit.id, visit.code)
  await expect(qrSvg(page, visit.code)).toBeVisible()
  await expect(qrSection(page).getByText(visit.code, { exact: true }).first()).toBeVisible()

  const section = qrSection(page)
  const box = await section.boundingBox()
  if (box === null) throw new Error('Kartu QR tidak memiliki bounding box di 360px.')
  console.log(`[QREP-01] kartu QR top=${box.y}px (batas lipatan 800px)`)
  expect(box.y).toBeLessThan(800)

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }))
  console.log(
    `[QREP-01] scrollWidth=${overflow.scrollWidth} innerWidth=${overflow.innerWidth}`,
  )
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth)
})

test('@QREP-02 vendor lain ditolak membaca QR kunjungan milik admin (404, UI tanpa kartu)', async ({
  h,
}) => {
  const visit = await h.createVisit('qrep02', { role: 'admin', withFiles: false })
  const vendorToken = await h.tokenAs('vendor')

  const refusal = readRefusal(
    await apiFetchRaw(vendorToken, 'GET', `/visits/${visit.id}/qr`),
    404,
  )
  expect(refusal.code).toBe('NOT_FOUND')

  // Pembanding: pemilik (admin) tetap mendapat payload.
  const ownerQr = readQr(
    await apiFetchRaw(await h.tokenAs('admin'), 'GET', `/visits/${visit.id}/qr`),
  )
  expect(ownerQr.qr_code_payload).toBe(visit.code)

  // UI vendor berhenti di layar 404 — tidak ada kartu QR yang ter-mount.
  const page = await h.openAs('vendor')
  await page.goto(`/visits/${visit.id}`)
  await expect(page.getByText('Kunjungan tidak ditemukan', { exact: true })).toBeVisible()
  await expect(qrSection(page)).toHaveCount(0)
})

test('@QREP-03 kunjungan rescheduled menyembunyikan kartu QR sampai disetujui ulang', async ({
  h,
}) => {
  const visit = await h.createVisit('qrep03', { withFiles: false })
  const vendorToken = await h.tokenAs('vendor')
  const superToken = await h.tokenAs('super')

  const page = await h.openAs('vendor')
  await openDetail(page, visit.id, visit.code)
  await expect(qrSvg(page, visit.code)).toBeVisible()

  const start = new Date(Date.now() + 24 * 60 * 60_000)
  const end = new Date(Date.now() + 24 * 60 * 60_000 + 120 * 60_000)
  await rescheduleVisitViaApi(vendorToken, visit.id, start.toISOString(), end.toISOString())
  expect((await getVisitViaApi(superToken, visit.id)).status).toBe('rescheduled')

  // Endpoint QR TIDAK menggerbangi status: otorisasi baca tetap 200 dan
  // payload-nya sama. Gerbang "tanpa QR" ada di UI, bukan di API.
  const whileRescheduled = readQr(
    await apiFetchRaw(vendorToken, 'GET', `/visits/${visit.id}/qr`),
  )
  expect(whileRescheduled.qr_code_payload).toBe(visit.code)

  await page.reload()
  await expect(page.getByText('Jadwal Digeser', { exact: true }).first()).toBeVisible()
  await expectQrCardHidden(page, visit.code)

  // Persetujuan ulang membuka kembali kartu QR tanpa mengubah payload.
  await approveVisitViaApi(await h.tokenAs('admin'), visit.id, 'Setujui ulang setelah reschedule E2E')
  expect((await getVisitViaApi(superToken, visit.id)).status).toBe('approved')

  await page.reload()
  await expect(qrSvg(page, visit.code)).toBeVisible()
})

test('@QREP-04 kunjungan cancelled menyembunyikan kartu QR meski endpoint tetap melayani pemilik', async ({
  h,
}) => {
  const visit = await h.createVisit('qrep04', { withFiles: false })
  const vendorToken = await h.tokenAs('vendor')

  const cancelled = await apiFetchRaw(vendorToken, 'POST', `/visits/${visit.id}/cancel`, {
    reason: 'E2E QREP-04',
  })
  expect(cancelled.status).toBe(200)

  // Kontrak nyata: QR adalah endpoint otorisasi-saja, tanpa gerbang status.
  const qr = readQr(await apiFetchRaw(vendorToken, 'GET', `/visits/${visit.id}/qr`))
  expect(qr.qr_code_payload).toBe(visit.code)

  const page = await h.openAs('vendor')
  await openDetail(page, visit.id, visit.code)
  await expect(page.getByText('Dibatalkan', { exact: true }).first()).toBeVisible()
  await expectQrCardHidden(page, visit.code)
})
