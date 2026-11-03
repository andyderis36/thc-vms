/**
 * Berkas kunjungan (SPK / foto KTP / selfie) melalui endpoint backend.
 *
 * Kontrak nyata yang dipakai (diverifikasi dari `docs/4. openapi.yaml`,
 * `backend/internal/delivery/http/router.go`, `handlers/file_handler.go`,
 * `usecase/visit/file_access.go`, dan `frontend/src/lib/api/files.ts`):
 *
 *   GET /api/v1/visits/{uuid}/file?kind=assignment_letter|id_card|selfie[&visitor_id=<uuid>]
 *
 * - `assignment_letter` (per-kunjungan) mengabaikan `visitor_id`;
 *   `id_card`/`selfie` (per-teknisi) mewajibkan UUID baris visitor.
 * - Cakupan baca sama dengan `GET /visits/{id}`: super_admin global,
 *   admin/security terkunci cabang (403), vendor hanya miliknya (404).
 * - Sukses menyajikan byte inline lewat `http.ServeContent`, sehingga
 *   `Cache-Control: private, no-store`, `Accept-Ranges: bytes`, dan dukungan
 *   `Range` (206 + `Content-Range`) berasal dari standard library.
 * - Semua berkas diambil dari backend; tidak ada permintaan langsung ke MinIO.
 *
 * `apiFetchRaw` dipakai untuk seluruh uji status/amplop negatif (tidak pernah
 * melempar). Karena helper bersama itu tidak mengembalikan header, probe
 * `fetch` lokal di bawah membaca status + header + byte untuk asersi
 * Content-Type/Content-Range/Cache-Control. Kunjungan uji dibuat lewat
 * harness dan dihapus otomatis pada teardown.
 */

import { expect, test } from '../fixtures'
import {
  API_BASE,
  DEFAULT_PASSWORD,
  LOCATIONS,
  apiFetchRaw,
  getVisitViaApi,
  loginViaApi,
  type ApiEnvelope,
  type ApiFailure,
  type ApiResult,
} from '../helpers/api'
import { gotoApp } from '../helpers/nav'

/** UUID berformat sah yang tidak pernah menjadi baris visitor kunjungan uji. */
const UNKNOWN_VISITOR_ID = '00000000-0000-4000-8000-000000000000'

/** Path endpoint berkas backend, lengkap dengan query wajibnya. */
function visitFilePath(visitId: string, kind: string, visitorId?: string): string {
  const params = new URLSearchParams({ kind })
  if (visitorId !== undefined) {
    params.set('visitor_id', visitorId)
  }
  return `/visits/${encodeURIComponent(visitId)}/file?${params.toString()}`
}

interface FileProbe {
  status: number
  headers: Headers
  contentType: string
  bodyLength: number
  bodyBytes: Uint8Array
}

/**
 * Ambil berkas dari backend dan kembalikan status + header + byte tanpa
 * melempar pada respons non-2xx. Token kosong/undefined tidak mengirim header
 * Authorization sama sekali (kasus "tanpa token").
 */
async function probeFile(
  path: string,
  token?: string,
  extraHeaders: Record<string, string> = {},
): Promise<FileProbe> {
  const headers: Record<string, string> = { ...extraHeaders }
  if (token !== undefined && token !== '') {
    headers.authorization = `Bearer ${token}`
  }
  const response = await fetch(`${API_BASE}${path}`, { headers })
  const bodyBytes = new Uint8Array(await response.arrayBuffer())
  return {
    status: response.status,
    headers: response.headers,
    contentType: response.headers.get('content-type') ?? '',
    bodyLength: bodyBytes.byteLength,
    bodyBytes,
  }
}

/** Header dibaca case-insensitive oleh `Headers.get`; nilai di-trim untuk log. */
function header(probe: FileProbe, name: string): string {
  return (probe.headers.get(name) ?? '').trim()
}

function describe(result: ApiResult<unknown>): string {
  return `HTTP ${result.status} body=${JSON.stringify(result.body)}`
}

/** Pastikan amplop gagal standar: `{ success:false, error:{ code, message } }`. */
function expectFailure(
  result: ApiResult<ApiEnvelope<unknown>>,
  status: number,
  label: string,
): ApiFailure {
  console.log(`[${label}] ${describe(result)}`)
  expect(result.status, `${label}: status`).toBe(status)
  const body = result.body
  expect(body.success, `${label}: success wajib false`).toBe(false)
  if (body.success) {
    throw new Error(`${label}: respons sukses tidak terduga`)
  }
  expect(body.error.code.length, `${label}: error.code wajib terisi`).toBeGreaterThan(0)
  expect(body.error.message.length, `${label}: error.message wajib terisi`).toBeGreaterThan(0)
  // Amplop gagal tidak boleh membawa `data`.
  expect(Object.keys(body).sort(), `${label}: kunci amplop`).toEqual(['error', 'success'])
  return body
}

// ---------------------------------------------------------------------------
// @FILE-01 - UI vendor memuat SPK miliknya dari halaman detail
// ---------------------------------------------------------------------------
test('@FILE-01 vendor melihat dan membuka SPK miliknya di halaman detail', async ({ h }) => {
  const created = await h.createVisit('file01', { withFiles: true })
  const page = await h.openAs('vendor')

  // Daftarkan listener SEBELUM navigasi: komponen `SpkFileLink` mengambil
  // berkas lewat endpoint backend tepat setelah detail kunjungan termuat.
  const spkResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/visits/${created.id}/file`) &&
      response.url().includes('kind=assignment_letter'),
  )

  await gotoApp(page, `/visits/${created.id}`)

  const spkResponse = await spkResponsePromise
  console.log(
    `[@FILE-01] UI GET ${spkResponse.url()} -> HTTP ${spkResponse.status()} ` +
      `content-type=${spkResponse.headers()['content-type'] ?? ''}`,
  )
  expect(spkResponse.status(), '@FILE-01: endpoint berkas dari UI').toBe(200)
  expect(spkResponse.headers()['content-type'] ?? '').toContain('application/pdf')
  // Ukuran dari Content-Length: response.body() bisa kosong untuk fetch yang sudah dikonsumsi halaman.
  const uiContentLength = Number(spkResponse.headers()['content-length'] ?? '0')
  console.log(`[@FILE-01] content-length dari UI: ${uiContentLength}`)
  expect(uiContentLength, '@FILE-01: body SPK tidak kosong').toBeGreaterThan(0)

  const link = page.getByRole('link', {
    name: `Lihat dokumen surat tugas ${created.code}`,
    exact: true,
  })
  await expect(link).toBeVisible()
  // Object URL lokal (blob:) - bukan URL MinIO/presigned.
  await expect(link).toHaveAttribute('href', /^blob:/)

  // target="_blank": klik membuka tab baru (atau mengunduh bila viewer PDF
  // tidak tersedia di browser headless). Keduanya membuktikan klik berfungsi.
  const popupOutcome = page
    .waitForEvent('popup', { timeout: 15_000 })
    .then((popup) => ({ popup }))
    .catch(() => null)
  const downloadOutcome = page
    .waitForEvent('download', { timeout: 15_000 })
    .then((download) => ({ download }))
    .catch(() => null)

  await link.click()
  const outcome = await Promise.race([popupOutcome, downloadOutcome])
  expect(outcome, '@FILE-01: klik harus membuka tab baru atau mengunduh berkas').not.toBeNull()

  if (outcome !== null && 'popup' in outcome) {
    console.log(`[@FILE-01] klik membuka tab baru: ${outcome.popup.url()}`)
    await outcome.popup.close()
  } else if (outcome !== null) {
    console.log(`[@FILE-01] klik memicu unduhan: ${outcome.download.suggestedFilename()}`)
  }
})

// ---------------------------------------------------------------------------
// @FILE-02 - admin se-cabang: SPK 200 application/pdf, body tidak kosong
// ---------------------------------------------------------------------------
test('@FILE-02 admin se-cabang mengunduh SPK: 200, application/pdf, body tidak kosong', async ({
  h,
}) => {
  const created = await h.createVisit('file02', { withFiles: true })
  const adminToken = await h.tokenAs('admin')
  const path = visitFilePath(created.id, 'assignment_letter')

  const raw = await apiFetchRaw<string>(adminToken, 'GET', path)
  console.log(`[@FILE-02] apiFetchRaw GET ${path} -> ${describe(raw)}`)
  expect(raw.status, '@FILE-02: status SPK').toBe(200)
  expect(typeof raw.body, '@FILE-02: body biner terbaca').toBe('string')
  expect(raw.body.length, '@FILE-02: body tidak kosong').toBeGreaterThan(0)

  const probe = await probeFile(path, adminToken)
  expect(probe.status).toBe(200)
  expect(probe.contentType.toLowerCase()).toContain('application/pdf')
  expect(probe.bodyLength).toBeGreaterThan(0)
  // Magic PDF: unggahan harness adalah PDF sah (`%PDF-`).
  expect(new TextDecoder().decode(probe.bodyBytes.slice(0, 5))).toBe('%PDF-')
  expect(header(probe, 'content-disposition')).toMatch(/^inline;/)
})

// ---------------------------------------------------------------------------
// @FILE-03 - super_admin lintas cabang: SPK kunjungan Sambas tetap 200
// ---------------------------------------------------------------------------
test('@FILE-03 super_admin mengakses SPK kunjungan cabang Sambas: 200', async ({ h }) => {
  const sambasToken = await h.tokenAs('admin-sambas')
  const sambasMe = await apiFetchRaw<ApiEnvelope<{ location_id: string | null }>>(
    sambasToken,
    'GET',
    '/auth/me',
  )
  expect(sambasMe.status, 'GET /auth/me admin-sambas harus 200').toBe(200)
  if (!sambasMe.body.success) {
    throw new Error(`GET /auth/me admin-sambas gagal: ${sambasMe.body.error.code}`)
  }
  const sambasLocationId = sambasMe.body.data.location_id
  expect(sambasLocationId, 'lokasi runtime cabang Sambas wajib ada').not.toBeNull()
  const created = await h.createVisit('file03', {
    withFiles: true,
    locationId: sambasLocationId ?? undefined,
  })
  expect(created.locationId, '@FILE-03: fixture harus di cabang runtime Sambas').toBe(
    sambasLocationId,
  )

  const superToken = await h.tokenAs('super')
  const path = visitFilePath(created.id, 'assignment_letter')

  const raw = await apiFetchRaw<ApiEnvelope<unknown>>(superToken, 'GET', path)
  console.log(`[@FILE-03] apiFetchRaw GET ${path} -> ${describe(raw)}`)
  expect(raw.status, '@FILE-03: status SPK lintas cabang').toBe(200)

  const probe = await probeFile(path, superToken)
  expect(probe.status).toBe(200)
  expect(probe.contentType.toLowerCase()).toContain('application/pdf')
  expect(probe.bodyLength).toBeGreaterThan(0)
})

// ---------------------------------------------------------------------------
// @FILE-04 - foto KTP (image/jpeg) dan selfie (image/png) lewat visitor_id
// ---------------------------------------------------------------------------
test('@FILE-04 admin se-cabang mengakses foto KTP dan selfie teknisi: 200 sesuai MIME', async ({
  h,
}) => {
  const created = await h.createVisit('file04', { withFiles: true })
  const detail = await getVisitViaApi(await h.tokenAs('super'), created.id)
  const visitor = detail.visitors?.[0]
  expect(visitor, '@FILE-04: detail wajib memuat teknisi').toBeDefined()
  expect(visitor?.id, '@FILE-04: visitors[].id (UUID baris) wajib ada pada respons baca').toBeTruthy()
  const visitorId = visitor?.id ?? ''

  const adminToken = await h.tokenAs('admin')

  const ktpPath = visitFilePath(created.id, 'id_card', visitorId)
  const ktpRaw = await apiFetchRaw<ApiEnvelope<unknown>>(adminToken, 'GET', ktpPath)
  console.log(`[@FILE-04] apiFetchRaw GET ${ktpPath} -> ${describe(ktpRaw)}`)
  expect(ktpRaw.status, '@FILE-04: status foto KTP').toBe(200)

  const ktp = await probeFile(ktpPath, adminToken)
  expect(ktp.status).toBe(200)
  expect(ktp.contentType.toLowerCase(), '@FILE-04: MIME KTP sesuai unggahan JPEG').toBe(
    'image/jpeg',
  )
  expect(ktp.bodyLength).toBeGreaterThan(0)
  // Magic JPEG: FF D8 FF.
  expect(Array.from(ktp.bodyBytes.slice(0, 3))).toEqual([0xff, 0xd8, 0xff])

  const selfiePath = visitFilePath(created.id, 'selfie', visitorId)
  const selfieRaw = await apiFetchRaw<ApiEnvelope<unknown>>(adminToken, 'GET', selfiePath)
  console.log(`[@FILE-04] apiFetchRaw GET ${selfiePath} -> ${describe(selfieRaw)}`)
  expect(selfieRaw.status, '@FILE-04: status selfie').toBe(200)

  const selfie = await probeFile(selfiePath, adminToken)
  expect(selfie.status).toBe(200)
  expect(selfie.contentType.toLowerCase(), '@FILE-04: MIME selfie sesuai unggahan PNG').toBe(
    'image/png',
  )
  expect(selfie.bodyLength).toBeGreaterThan(0)
  // Magic PNG: 89 50 4E 47 0D 0A 1A 0A.
  expect(Array.from(selfie.bodyBytes.slice(0, 8))).toEqual([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ])
})

// ---------------------------------------------------------------------------
// @FILE-05 - tanpa token dan token rusak: 401 dengan amplop standar
// ---------------------------------------------------------------------------
test('@FILE-05 tanpa token dan token rusak ditolak 401 dengan amplop gagal', async ({ h }) => {
  const created = await h.createVisit('file05', { withFiles: true })
  const path = visitFilePath(created.id, 'assignment_letter')

  const anonymous = await apiFetchRaw<ApiEnvelope<unknown>>('', 'GET', path)
  const anonymousBody = expectFailure(anonymous, 401, '@FILE-05 tanpa token')
  expect(anonymousBody.error.code).toBe('UNAUTHORIZED')
  expect(anonymousBody.error.message).toBe('Token tidak valid atau kedaluwarsa.')

  const broken = await apiFetchRaw<ApiEnvelope<unknown>>('not-a-token', 'GET', path)
  const brokenBody = expectFailure(broken, 401, '@FILE-05 token rusak')
  expect(brokenBody.error.code).toBe('UNAUTHORIZED')
  expect(brokenBody.error.message).toBe('Token tidak valid atau kedaluwarsa.')
})

// ---------------------------------------------------------------------------
// @FILE-06 - isolasi cabang (403) dan kepemilikan vendor lain (404)
// ---------------------------------------------------------------------------
test('@FILE-06 admin lintas cabang 403, vendor lain 404', async ({ h }) => {
  const created = await h.createVisit('file06', {
    withFiles: true,
    locationId: LOCATIONS.sambas,
  })
  const path = visitFilePath(created.id, 'assignment_letter')

  const adminHqToken = await h.tokenAs('admin')
  const crossBranch = await apiFetchRaw<ApiEnvelope<unknown>>(adminHqToken, 'GET', path)
  const crossBody = expectFailure(crossBranch, 403, '@FILE-06 admin HQ ke Sambas')
  expect(crossBody.error.code).toBe('FORBIDDEN_BRANCH')
  expect(crossBody.error.message).toBe('Tidak berhak mengelola kunjungan cabang lain')

  // vendor1b adalah akun seed lain (bukan pemilik kunjungan ini).
  const otherVendor = await loginViaApi(process.env.E2E_EMAIL_VENDOR2 ?? 'vendor1b@transhybrid.net.id', DEFAULT_PASSWORD)
  const foreignVendor = await apiFetchRaw<ApiEnvelope<unknown>>(otherVendor.token, 'GET', path)
  const foreignBody = expectFailure(foreignVendor, 404, '@FILE-06 vendor lain')
  expect(foreignBody.error.code).toBe('NOT_FOUND')

  // Bukti pembanding: pemilik (vendor1a) mendapat 200 untuk berkas yang sama.
  const ownerProbe = await probeFile(path, await h.tokenAs('vendor'))
  expect(ownerProbe.status, '@FILE-06: pemilik tetap 200').toBe(200)
})

// ---------------------------------------------------------------------------
// @FILE-07 - parameter salah: kind tidak dikenal 400, visitor/slot kosong 404
// ---------------------------------------------------------------------------
test('@FILE-07 kind tidak dikenal 400; visitor_id tidak ada / slot kosong 404', async ({
  h,
}) => {
  const created = await h.createVisit('file07', { withFiles: true, memberCount: 2 })
  const adminToken = await h.tokenAs('admin')
  const detail = await getVisitViaApi(await h.tokenAs('super'), created.id)
  const visitors = detail.visitors ?? []
  expect(visitors.length, '@FILE-07: fixture dua teknisi').toBe(2)
  // Urutan roster tidak dijamin sama dengan urutan pembuatan, jadi slot kosong
  // ditentukan dari ada/tidaknya tautan foto pada respons detail.
  const withCard = visitors.find(
    (visitor) =>
      typeof visitor.id_card_photo_url === 'string' && visitor.id_card_photo_url !== '',
  )
  const withoutCard = visitors.find(
    (visitor) =>
      visitor.id_card_photo_url === undefined ||
      visitor.id_card_photo_url === null ||
      visitor.id_card_photo_url === '',
  )
  expect(withCard?.id, '@FILE-07: teknisi ber-KTP wajib ada').toBeTruthy()
  expect(withoutCard?.id, '@FILE-07: teknisi tanpa KTP wajib ada').toBeTruthy()
  const filledVisitorId = withCard?.id ?? ''
  const emptyVisitorId = withoutCard?.id ?? ''

  const unknownKind = await apiFetchRaw<ApiEnvelope<unknown>>(
    adminToken,
    'GET',
    `/visits/${encodeURIComponent(created.id)}/file?kind=unknown_kind`,
  )
  const unknownKindBody = expectFailure(unknownKind, 400, '@FILE-07 kind tidak dikenal')
  expect(unknownKindBody.error.code).toBe('VALIDATION_ERROR')
  expect(unknownKindBody.error.message).toBe('Jenis berkas tidak dikenal.')

  const missingVisitor = await apiFetchRaw<ApiEnvelope<unknown>>(
    adminToken,
    'GET',
    visitFilePath(created.id, 'id_card'),
  )
  const missingVisitorBody = expectFailure(missingVisitor, 400, '@FILE-07 visitor_id kosong')
  expect(missingVisitorBody.error.code).toBe('VALIDATION_ERROR')
  expect(missingVisitorBody.error.message).toBe(
    'visitor_id wajib diisi untuk jenis berkas ini.',
  )

  const unknownVisitor = await apiFetchRaw<ApiEnvelope<unknown>>(
    adminToken,
    'GET',
    visitFilePath(created.id, 'id_card', UNKNOWN_VISITOR_ID),
  )
  const unknownVisitorBody = expectFailure(unknownVisitor, 404, '@FILE-07 visitor tidak dikenal')
  expect(unknownVisitorBody.error.code).toBe('NOT_FOUND')
  expect(unknownVisitorBody.error.message).toBe('Berkas tidak tersedia.')

  // Teknisi kedua sengaja tidak diberi foto oleh harness -> slot kosong.
  const emptySlot = await apiFetchRaw<ApiEnvelope<unknown>>(
    adminToken,
    'GET',
    visitFilePath(created.id, 'id_card', emptyVisitorId),
  )
  const emptySlotBody = expectFailure(emptySlot, 404, '@FILE-07 slot kosong')
  expect(emptySlotBody.error.code).toBe('NOT_FOUND')
  expect(emptySlotBody.error.message).toBe('Berkas tidak tersedia.')

  // Teknisi pertama memang punya foto, jadi 404 di atas bukan karena seluruh
  // endpoint menolak id_card.
  const filledSlot = await probeFile(
    visitFilePath(created.id, 'id_card', filledVisitorId),
    adminToken,
  )
  expect(filledSlot.status, '@FILE-07: slot terisi tetap 200').toBe(200)
})

// ---------------------------------------------------------------------------
// @FILE-08 - Range 206 + Content-Range + Accept-Ranges; tanpa Range no-store
// ---------------------------------------------------------------------------
test('@FILE-08 Range bytes=0-1023 -> 206 + Content-Range; tanpa Range no-store', async ({ h }) => {
  const created = await h.createVisit('file08', { withFiles: true })
  const adminToken = await h.tokenAs('admin')
  const path = visitFilePath(created.id, 'assignment_letter')

  const plain = await probeFile(path, adminToken)
  console.log(
    `[@FILE-08] tanpa Range -> HTTP ${plain.status} ` +
      `cache-control=${header(plain, 'cache-control')} ` +
      `accept-ranges=${header(plain, 'accept-ranges')} ` +
      `content-length=${header(plain, 'content-length')}`,
  )
  expect(plain.status).toBe(200)
  expect(header(plain, 'cache-control')).toBe('private, no-store')
  expect(header(plain, 'pragma')).toBe('no-cache')
  expect(header(plain, 'x-content-type-options')).toBe('nosniff')
  expect(header(plain, 'accept-ranges')).toBe('bytes')
  expect(header(plain, 'content-length')).toBe(String(plain.bodyLength))
  expect(plain.bodyLength, '@FILE-08: berkas uji harus lebih dari 1024 byte').toBeGreaterThan(
    1024,
  )

  const ranged = await probeFile(path, adminToken, { Range: 'bytes=0-1023' })
  console.log(
    `[@FILE-08] Range bytes=0-1023 -> HTTP ${ranged.status} ` +
      `content-range=${header(ranged, 'content-range')} ` +
      `accept-ranges=${header(ranged, 'accept-ranges')} ` +
      `body=${ranged.bodyLength}`,
  )
  expect(ranged.status).toBe(206)
  expect(header(ranged, 'accept-ranges')).toBe('bytes')
  expect(header(ranged, 'content-range')).toMatch(/^bytes 0-1023\/\d+$/)
  expect(header(ranged, 'cache-control')).toBe('private, no-store')
  expect(ranged.bodyLength).toBe(1024)
  // Byte pertama potongan tetap byte pertama PDF.
  expect(ranged.bodyBytes[0]).toBe(0x25) // '%'
})
