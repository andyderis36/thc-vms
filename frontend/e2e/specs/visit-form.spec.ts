/**
 * SCR-03 — Formulir Pengajuan Kunjungan (`/visits/new`).
 *
 * Seluruh test masuk sebagai `vendor` lewat `h.openAs('vendor')` (token asli di
 * localStorage, bukan storageState project). Kunjungan yang dibuat lewat UI
 * TIDAK tercatat oleh harness `h.createVisit`, jadi spec ini menyimpan id hasil
 * redirect dan menghapusnya sebagai `super_admin` di `afterEach` — termasuk
 * saat test gagal. Sebagai jaring pengaman, `afterEach` juga menyapu
 * `GET /visits?limit=100` untuk kunjungan yang memuat penanda unik test ini.
 *
 * Catatan selector: seluruh id diambil dari kode nyata
 * (`features/visits/form/VisitForm.tsx`, `TechnicianList.tsx`, `UploadBox.tsx`,
 * `PurposeDropdown.tsx`) dan teks galat dari `lib/uploads/validation.ts`,
 * `visit-schema.ts`, serta `invalid-fields.ts`.
 */

import type { Page } from '@playwright/test'
import { expect, test, type Harness } from '../fixtures'
import {
  apiFetchRaw,
  createVisitViaApi,
  deleteVisitViaApi,
  getVisitViaApi,
  LOCATIONS,
  translateSeedLocationId,
  uploadFileViaApi,
  type ApiEnvelope,
} from '../helpers/api'
import { exeBuffer, jpegBuffer, pdfBuffer, pngBuffer, writeAsset } from '../helpers/assets'
import { collectFileUrls, deleteUploadedFiles } from '../helpers/storage'
import { gotoApp } from '../helpers/nav'

const SUBMIT_LABEL = 'Kirim Permohonan Kunjungan'

interface RuntimeCatalog {
  facilityId: string
  facilityName: string
  purposeId?: string
  purposeName?: string
}

let cachedCatalog: RuntimeCatalog | null = null

async function runtimeCatalog(h: Harness): Promise<RuntimeCatalog> {
  if (cachedCatalog !== null) {
    return cachedCatalog
  }
  const token = await h.tokenAs('super')
  const locResult = await apiFetchRaw<ApiEnvelope<Array<{ id: string; name: string }>>>(
    token,
    'GET',
    '/locations',
  )
  if (locResult.status !== 200 || !locResult.body.success) {
    throw new Error(
      `[visit-form] GET /locations -> HTTP ${locResult.status}: ${JSON.stringify(locResult.body)}`,
    )
  }
  const facilities = locResult.body.data
  if (facilities.length === 0) {
    throw new Error('[visit-form] katalog lokasi runtime kosong.')
  }
  const sorted = [...facilities].sort((a, b) => a.name.localeCompare(b.name))
  const picked =
    sorted.find((facility) => facility.name.toLowerCase().includes('pusat')) ?? sorted[0]
  if (picked === undefined) {
    throw new Error('[visit-form] katalog lokasi runtime kosong.')
  }
  const purResult = await apiFetchRaw<ApiEnvelope<Array<{ id: string; name: string }>>>(
    token,
    'GET',
    '/purposes',
  )
  if (purResult.status !== 200 || !purResult.body.success) {
    throw new Error(
      `[visit-form] GET /purposes -> HTTP ${purResult.status}: ${JSON.stringify(purResult.body)}`,
    )
  }
  const firstPurpose = purResult.body.data[0]
  cachedCatalog = {
    facilityId: picked.id,
    facilityName: picked.name,
    ...(firstPurpose !== undefined
      ? { purposeId: firstPurpose.id, purposeName: firstPurpose.name }
      : {}),
  }
  return cachedCatalog
}

/** Kunjungan yang dibuat lewat UI dan harus dihapus (diisi setelah redirect). */
const createdVisitIds: string[] = []
const uploadUrls: string[] = []
/** Penanda unik per test; dipakai untuk menyapu sisa bila assert gagal dini. */
const markers: string[] = []

interface RawVisitor {
  name: string
  id_number: string
  phone: string
  vendor_name?: string | null
  jabatan?: string | null
  id_card_photo_url?: string | null
  photo_url?: string | null
}

interface RawVisit {
  id: string
  visit_id: string
  status: string
  notes?: string
  purpose_note?: string | null
  purposes?: Array<{ id: string; name?: string }>
  location?: { id: string; name?: string }
  visitors?: RawVisitor[]
}

interface MemberInput {
  name: string
  idNumber: string
  phone: string
  jabatan?: string
  vendorName?: string
  ktpPath?: string
  selfiePath?: string
}

interface FillVisitOptions {
  catalog: RuntimeCatalog
  start: string
  end: string
  members: MemberInput[]
  /** Pilih tujuan dari katalog; false untuk jalur "Tujuan lain". */
  pickCatalogPurpose?: boolean
  purposeNote?: string
  notes?: string
  /** Default true — SOP keselamatan wajib untuk submit sukses. */
  acceptNda?: boolean
  spk?: { path: string; name: string } | null
}

/** `datetime-local` memakai waktu lokal tanpa zona: `YYYY-MM-DDTHH:mm`. */
function toLocalInput(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  ].join('T')
}

function offset(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000)
}

/** Baca detail kunjungan mentah (field `jabatan`/`vendor_name` tidak ada di VisitRecord). */
async function fetchVisitRaw(token: string, id: string): Promise<RawVisit> {
  const result = await apiFetchRaw<{ success: boolean; data: RawVisit }>(
    token,
    'GET',
    `/visits/${encodeURIComponent(id)}`,
  )
  if (result.status !== 200 || result.body.success !== true) {
    throw new Error(
      `[visit-form] GET /visits/${id} -> HTTP ${result.status}: ${JSON.stringify(result.body)}`,
    )
  }
  return result.body.data
}

async function openForm(page: Page, facilityName: string): Promise<void> {
  await gotoApp(page, '/visits/new')
  await expect(
    page.getByRole('heading', { name: 'Pengajuan Akses Fasilitas Jaringan THC' }),
  ).toBeVisible()
  // Katalog fasilitas & tujuan dimuat async; tunggu sampai kontrol siap.
  await expect(
    page.locator(`#visit-facility-datalist option[value="${facilityName}"]`),
  ).toHaveCount(1)
  await expect(page.locator('#visit-purpose')).toBeEnabled()
}

async function pickLocation(page: Page, facilityName: string): Promise<void> {
  await page.getByLabel('Fasilitas Tujuan').fill(facilityName)
}

async function pickCatalogPurpose(page: Page, purposeName: string): Promise<void> {
  await page.locator('#visit-purpose').click()
  const panel = page.getByRole('listbox')
  await expect(panel).toBeVisible()
  await panel.getByRole('checkbox', { name: purposeName }).check()
  await expect(page.locator('#visit-purpose')).toContainText('1 tujuan dipilih')
  // Escape menutup panel (listener document) tanpa bergantung pada klik luar.
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
}

/**
 * Unggah satu berkas ke kotak UploadBox dan tunggu chip nama berkas muncul —
 * chip hanya dirender setelah `POST /uploads` sukses.
 */
async function uploadInto(
  page: Page,
  boxId: string,
  filePath: string,
  fileName: string,
): Promise<void> {
  const box = page.locator(`#${boxId}`)
  // Anggaran 80 s (di bawah test timeout 90 s): run live 2026-10-28 memutus
  // unggahan 1,5 MB di plafon 60 s saat jaringan lambat, padahal request tetap
  // berjalan. Batas ini masih menghasilkan error Playwright yang jelas bila
  // unggahan benar-benar tidak pernah dikirim.
  const uploaded = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().includes('/api/v1/uploads'),
    { timeout: 80_000 },
  )
  await box.locator('input[type=file]').setInputFiles(filePath)
  const response = await uploaded
  if (!response.ok()) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `[visit-form] POST /uploads ${response.status()} untuk ${fileName}: ${detail}`,
    )
  }
  const body = (await response.json()) as { data?: { file_url?: unknown } }
  const fileUrl = body.data?.file_url
  if (typeof fileUrl !== 'string') {
    throw new Error(`[visit-form] respons POST /uploads tanpa data.file_url untuk ${fileName}`)
  }
  uploadUrls.push(fileUrl)
  await expect(box.getByText(fileName, { exact: true })).toBeVisible()
}

async function fillVisitForm(page: Page, options: FillVisitOptions): Promise<void> {
  const catalog = options.catalog
  await openForm(page, catalog.facilityName)
  await pickLocation(page, catalog.facilityName)

  // Katalog tujuan bisa kosong di prod: tanpa purpose runtime, pakai jalur
  // "Tujuan lain" (purpose_note) agar submit tetap valid.
  const catalogAvailable =
    options.pickCatalogPurpose !== false && catalog.purposeName !== undefined
  if (catalogAvailable) {
    await pickCatalogPurpose(page, catalog.purposeName ?? '')
  }
  if (options.purposeNote !== undefined || !catalogAvailable) {
    await page
      .locator('#visit-purpose-note')
      .fill(options.purposeNote ?? options.notes ?? 'E2E tujuan kunjungan')
  }

  await page.locator('#visit-start-date').fill(options.start)
  await page.locator('#visit-end-date').fill(options.end)

  const addButton = page.getByRole('button', { name: 'Tambah Anggota' })
  for (let index = 1; index < options.members.length; index += 1) {
    await addButton.click()
    await expect(page.locator('#visit-technicians > div')).toHaveCount(index + 1)
  }

  for (let index = 0; index < options.members.length; index += 1) {
    const member = options.members[index]
    if (member === undefined) continue
    const row = page.locator('#visit-technicians > div').nth(index)
    await page.locator(`#visit-tech-${index}-name`).fill(member.name)
    await page.locator(`#visit-tech-${index}-id_number`).fill(member.idNumber)
    await page.locator(`#visit-tech-${index}-phone`).fill(member.phone)
    if (member.jabatan !== undefined) {
      await page.locator(`#visit-tech-${index}-jabatan`).fill(member.jabatan)
    }
    if (member.vendorName !== undefined) {
      await row.getByLabel('Perusahaan Vendor').fill(member.vendorName)
    }
    if (member.ktpPath !== undefined) {
      await uploadInto(page, `visit-tech-${index}-id_card_photo`, member.ktpPath, 'ktp.jpg')
    }
    if (member.selfiePath !== undefined) {
      await uploadInto(page, `visit-tech-${index}-selfie`, member.selfiePath, 'selfie.jpg')
    }
  }

  if (options.spk != null) {
    await uploadInto(page, 'visit-assignment-letter', options.spk.path, options.spk.name)
  }

  if (options.notes !== undefined) {
    await page.locator('#visit-notes').fill(options.notes)
  }

  if (options.acceptNda !== false) {
    await page.locator('#visit-nda').check()
  }
}

/** Klik kirim, lalu tunggu redirect detail kunjungan; kembalikan id dari URL. */
async function submitAndCaptureId(page: Page): Promise<string> {
  await page.getByRole('button', { name: SUBMIT_LABEL }).click()
  await expect(page).toHaveURL(
    /\/visits\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  )
  const id = new URL(page.url()).pathname.split('/').pop() ?? ''
  expect(id).not.toBe('')
  createdVisitIds.push(id)
  return id
}

/**
 * Isi fasilitas/tujuan/jadwal/SPK/SOP TANPA menyentuh baris anggota — untuk
 * test saran anggota yang barisnya sudah terisi lewat autofill (mengisi ulang
 * lewat `fillVisitForm` akan menimpa hasil pilihan saran).
 */
async function fillScheduleAndSpk(
  page: Page,
  options: {
    catalog: RuntimeCatalog
    start: string
    end: string
    spk?: { path: string; name: string }
  },
): Promise<void> {
  await openForm(page, options.catalog.facilityName)
  await pickLocation(page, options.catalog.facilityName)
  if (options.catalog.purposeName !== undefined) {
    await pickCatalogPurpose(page, options.catalog.purposeName)
  } else {
    await page.locator('#visit-purpose-note').fill('E2E saran anggota')
  }
  await page.locator('#visit-start-date').fill(options.start)
  await page.locator('#visit-end-date').fill(options.end)
  if (options.spk !== undefined) {
    await uploadInto(page, 'visit-assignment-letter', options.spk.path, options.spk.name)
  }
  await page.locator('#visit-nda').check()
}

/** Nama berkas tampilan dari URL presigned (segmen terakhir pathname). */
function fileNameFromUrl(url: string): string {
  const segment = new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''
  return decodeURIComponent(segment)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Hapus sisa kunjungan ber-penanda test ini (jaring pengaman bila assert gagal). */
async function sweepMarkedVisits(token: string): Promise<string[]> {
  const fileUrls: string[] = []
  if (markers.length === 0) return fileUrls
  const result = await apiFetchRaw<{
    success: boolean
    data: { items?: RawVisit[] }
  }>(token, 'GET', '/visits?limit=100')
  if (result.status !== 200 || result.body.success !== true) return fileUrls

  for (const item of result.body.data.items ?? []) {
    if (createdVisitIds.includes(item.id)) continue
    const haystack = [item.notes ?? '', ...(item.visitors ?? []).map((v) => v.name)].join(' ')
    if (!markers.some((marker) => haystack.includes(marker))) continue
    try {
      const detail = await apiFetchRaw<ApiEnvelope<unknown>>(
        token,
        'GET',
        `/visits/${encodeURIComponent(item.id)}`,
      )
      if (detail.status === 200 && detail.body.success === true) {
        fileUrls.push(...collectFileUrls(detail.body.data))
      }
      await deleteVisitViaApi(token, item.id)
      console.log(`[visit-form-cleanup] sapu DELETE ${item.visit_id} (${item.id}) -> 204`)
    } catch (error) {
      console.log(`[visit-form-cleanup] sapu DELETE ${item.id} dilewati: ${errorText(error)}`)
    }
  }
  return fileUrls
}

test.beforeEach(() => {
  createdVisitIds.length = 0
  uploadUrls.length = 0
  markers.length = 0
})

test.afterEach(async ({ h }) => {
  const problems: string[] = []
  const fileUrls: string[] = []
  // Penanda langkah agar kegagalan lapisan koneksi (mis. ECONNRESET) dapat
  // ditelusuri ke pemanggilnya, bukan hanya "cleanup" generik.
  let step = 'login'
  try {
    const token = await h.tokenAs('super')
    step = 'detail-delete-verify'
    for (const id of createdVisitIds) {
      try {
        const detail = await apiFetchRaw<ApiEnvelope<unknown>>(
          token,
          'GET',
          `/visits/${encodeURIComponent(id)}`,
        )
        if (detail.status === 200 && detail.body.success === true) {
          fileUrls.push(...collectFileUrls(detail.body.data))
        }
      } catch (error) {
        problems.push(`detail ${id}: ${errorText(error)}`)
      }

      try {
        await deleteVisitViaApi(token, id)
      } catch (error) {
        problems.push(`DELETE ${id}: ${errorText(error)}`)
      }

      const verify = await apiFetchRaw(token, 'GET', `/visits/${encodeURIComponent(id)}`)
      console.log(
        `[visit-form-cleanup] DELETE ${id} -> verify GET HTTP ${verify.status} (harus 404)`,
      )
      if (verify.status !== 404) {
        problems.push(`kunjungan ${id} masih ada (HTTP ${verify.status})`)
      }
    }

    step = 'sweep'
    fileUrls.push(...(await sweepMarkedVisits(token)))
    fileUrls.push(...uploadUrls)
    step = 'storage'
    if (process.env.E2E_SKIP_STORAGE_CLEANUP === '1') {
      console.log(
        `[visit-form-cleanup] cleanup bucket dilewati; ${fileUrls.length} objek tersisa di target`,
      )
    } else {
      await deleteUploadedFiles(fileUrls)
    }
  } catch (error) {
    problems.push(`cleanup@${step}: ${errorText(error)}`)
  }

  if (problems.length > 0) {
    throw new Error(`[visit-form-cleanup] ${problems.join('; ')}`)
  }
})

test('@VISIT-01 happy path lengkap: 1 anggota KTP+selfie, SPK 1,5 MB, tujuan katalog, NDA', async ({
  h,
}) => {
  test.setTimeout(120_000)
  const page = await h.openAs('vendor')
  const marker = h.unique('visit01')
  markers.push(marker)
  const catalog = await runtimeCatalog(h)

  const spk = await writeAsset(test.info(), 'spk-visit01.pdf', pdfBuffer(1500))
  const ktp = await writeAsset(test.info(), 'ktp.jpg', jpegBuffer())
  const selfie = await writeAsset(test.info(), 'selfie.jpg', jpegBuffer())

  await fillVisitForm(page, {
    catalog,
    start: toLocalInput(offset(-30)),
    end: toLocalInput(offset(180)),
    members: [
      {
        name: `${marker} Teknisi Satu`,
        idNumber: '6171010101010001',
        phone: '081234567801',
        jabatan: 'Teknisi Fiber Optik',
        vendorName: 'PT Lintas Fiber Nusantara',
        ktpPath: ktp,
        selfiePath: selfie,
      },
    ],
    notes: marker,
    spk: { path: spk, name: 'spk-visit01.pdf' },
  })

  const id = await submitAndCaptureId(page)

  // Teks UI nyata: StatusBadge `requested` = "Diminta".
  await expect(page.getByRole('heading', { level: 1 }).filter({ hasText: /VST-/ })).toBeVisible()
  await expect(page.locator('.status-badge').filter({ hasText: 'Diminta' }).first()).toBeVisible()

  const fetched = await getVisitViaApi(await h.tokenAs('vendor'), id)
  expect(fetched.status).toBe('requested')
  expect(fetched.visit_id).toMatch(/^VST-/)
  expect(fetched.notes).toContain(marker)
  expect(fetched.visitors?.length).toBe(1)
})

test('@VISIT-02 klien meneruskan SPK 6,2 MB dan menolak 21 MB dengan pesan batas 20 MB', async ({
  h,
}) => {
  test.setTimeout(120_000)
  const page = await h.openAs('vendor')
  await openForm(page, (await runtimeCatalog(h)).facilityName)

  const uploadPosts: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/uploads')) {
      uploadPosts.push(request.url())
    }
  })

  const input = page.locator('#visit-assignment-letter input[type=file]')
  const clientSizeAlert = page.getByRole('alert').filter({ hasText: 'melebihi batas 20 MB' })

  // Plafon transport 20 MB: 6,2 MB diteruskan ke server. Plafon simpan 5 MB
  // ditegakkan server, jadi status di sini boleh 201 atau 413 - yang diuji
  // adalah klien TIDAK memblokirnya.
  const mediumSpk = await writeAsset(test.info(), 'spk-6mb.pdf', pdfBuffer(6200))
  const firstUpload = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().includes('/uploads'),
    { timeout: 60_000 },
  )
  await input.setInputFiles(mediumSpk)
  const firstStatus = (await firstUpload).status()
  expect([201, 413]).toContain(firstStatus)
  await expect(clientSizeAlert).toHaveCount(0)

  // `UploadBox.processFile` mengabaikan berkas baru selama mutation upload
  // masih `isPending`. Tunggu state pending benar-benar turun sebelum memilih
  // berkas 21 MB; tanpa ini, test balapan dengan response production yang
  // lebih lambat dan file kedua tidak pernah diproses.
  const uploadBox = page.locator('#visit-assignment-letter')
  await expect(uploadBox.getByText('Mengunggah berkas.', { exact: true })).toHaveCount(0)
  await expect(
    uploadBox.getByRole('button', { name: /Ganti Berkas|Pilih dari Galeri \/ Berkas/ }),
  ).toBeVisible()

  // Di atas plafon transport, klien menolak lebih dulu tanpa request tambahan.
  const hugeSpk = await writeAsset(test.info(), 'spk-21mb.pdf', pdfBuffer(21500))
  await input.setInputFiles(hugeSpk)
  await expect(clientSizeAlert).toHaveText(
    /Ukuran berkas "spk-21mb\.pdf" melebihi batas 20 MB\./,
  )
  expect(uploadPosts).toHaveLength(1)

  await expect(page).toHaveURL(/\/visits\/new$/)
})

test('@VISIT-03 berkas .exe pada slot SPK ditolak sebagai tipe tidak didukung', async ({ h }) => {
  const page = await h.openAs('vendor')
  await openForm(page, (await runtimeCatalog(h)).facilityName)

  const exe = await writeAsset(test.info(), 'malware.exe', exeBuffer())
  await page.locator('#visit-assignment-letter input[type=file]').setInputFiles(exe)

  const alert = page.getByRole('alert').filter({ hasText: 'tidak didukung' })
  await expect(alert).toBeVisible()
  await expect(alert).toHaveText(
    /Format berkas "malware\.exe" tidak didukung\. Gunakan PDF, JPG, atau PNG\./,
  )

  await expect(page).toHaveURL(/\/visits\/new$/)
})

test('@VISIT-04 tanggal terbalik ditolak tanpa request create', async ({ h }) => {
  const page = await h.openAs('vendor')

  const createPosts: string[] = []
  page.on('response', (response) => {
    const request = response.request()
    if (
      request.method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/api/v1/visits')
    ) {
      createPosts.push(`${response.status()} ${response.url()}`)
    }
  })

  const ktp = await writeAsset(test.info(), 'ktp.jpg', jpegBuffer())
  const selfie = await writeAsset(test.info(), 'selfie.jpg', jpegBuffer())
  const spk = await writeAsset(test.info(), 'spk.pdf', pdfBuffer(8))

  await fillVisitForm(page, {
    catalog: await runtimeCatalog(h),
    start: toLocalInput(offset(180)),
    end: toLocalInput(offset(-60)),
    members: [
      {
        name: 'Teknisi Tanggal Terbalik',
        idNumber: '6171010101010002',
        phone: '081234567802',
        vendorName: 'PT Lintas Fiber Nusantara',
        ktpPath: ktp,
        selfiePath: selfie,
      },
    ],
    spk: { path: spk, name: 'spk.pdf' },
  })

  await page.getByRole('button', { name: SUBMIT_LABEL }).click()

  const alert = page.getByRole('alert').filter({
    hasText: 'Waktu selesai harus setelah waktu mulai.',
  })
  await expect(alert).toBeVisible()
  await expect(page).toHaveURL(/\/visits\/new$/)
  expect(createPosts).toHaveLength(0)
})

test('@VISIT-05 tiga anggota sekaligus tersimpan lengkap', async ({ h }) => {
  const page = await h.openAs('vendor')
  const marker = h.unique('visit05')
  markers.push(marker)
  const catalog05 = await runtimeCatalog(h)

  const ktp = await writeAsset(test.info(), 'ktp.jpg', jpegBuffer())
  const selfie = await writeAsset(test.info(), 'selfie.jpg', jpegBuffer())
  const spk = await writeAsset(test.info(), 'spk-visit05.pdf', pdfBuffer(8))

  await fillVisitForm(page, {
    catalog: catalog05,
    start: toLocalInput(offset(-15)),
    end: toLocalInput(offset(120)),
    members: [1, 2, 3].map((index) => ({
      name: `${marker} Anggota ${index}`,
      idNumber: `61710101010110${index}`,
      phone: `08123456790${index}`,
      jabatan: `Teknisi ${index}`,
      vendorName: 'PT Lintas Fiber Nusantara',
      ktpPath: ktp,
      selfiePath: selfie,
    })),
    notes: marker,
    spk: { path: spk, name: 'spk-visit05.pdf' },
  })

  const id = await submitAndCaptureId(page)
  const raw = await fetchVisitRaw(await h.tokenAs('vendor'), id)

  expect(raw.status).toBe('requested')
  expect(raw.visitors?.length).toBe(3)
  // Urutan roster tidak dijamin backend; bandingkan sebagai himpunan nama.
  expect((raw.visitors ?? []).map((visitor) => visitor.name).sort()).toEqual(
    [`${marker} Anggota 1`, `${marker} Anggota 2`, `${marker} Anggota 3`].sort(),
  )
  expect(raw.visitors?.every((visitor) => visitor.id_card_photo_url)).toBe(true)
  expect(raw.visitors?.every((visitor) => visitor.photo_url)).toBe(true)
})

test('@VISIT-08 jalur di luar katalog: Tujuan lain + vendor manual tersimpan', async ({ h }) => {
  const page = await h.openAs('vendor')
  const marker = h.unique('visit08')
  markers.push(marker)
  const purposeNote = `${marker} Audit kabel feeder area Pontianak`
  const manualVendor = 'CV Mitra Serat Mandiri'

  const ktp = await writeAsset(test.info(), 'ktp.jpg', jpegBuffer())
  const selfie = await writeAsset(test.info(), 'selfie.jpg', jpegBuffer())
  const spk = await writeAsset(test.info(), 'spk-visit08.pdf', pdfBuffer(8))

  await fillVisitForm(page, {
    catalog: await runtimeCatalog(h),
    start: toLocalInput(offset(-10)),
    end: toLocalInput(offset(90)),
    pickCatalogPurpose: false,
    purposeNote,
    members: [
      {
        name: `${marker} Teknisi Manual`,
        idNumber: '6171010101010008',
        phone: '081234567808',
        vendorName: manualVendor,
        ktpPath: ktp,
        selfiePath: selfie,
      },
    ],
    notes: marker,
    spk: { path: spk, name: 'spk-visit08.pdf' },
  })

  const id = await submitAndCaptureId(page)
  const raw = await fetchVisitRaw(await h.tokenAs('vendor'), id)

  expect(raw.status).toBe('requested')
  expect(raw.purpose_note).toBe(purposeNote)
  // Katalog tidak berubah: tidak ada purpose_id baru pada kunjungan ini.
  expect(raw.purposes ?? []).toHaveLength(0)
  expect(raw.visitors?.[0]?.vendor_name).toBe(manualVendor)
})

test('@VISIT-11 submit tanpa Foto KTP ditolak di baris anggota', async ({ h }) => {
  const page = await h.openAs('vendor')
  const selfie = await writeAsset(test.info(), 'selfie.jpg', jpegBuffer())
  const spk = await writeAsset(test.info(), 'spk-visit11.pdf', pdfBuffer(8))

  await fillVisitForm(page, {
    catalog: await runtimeCatalog(h),
    start: toLocalInput(offset(-5)),
    end: toLocalInput(offset(60)),
    members: [
      {
        name: 'Teknisi Tanpa KTP',
        idNumber: '6171010101010011',
        phone: '081234567811',
        vendorName: 'PT Lintas Fiber Nusantara',
        // sengaja tanpa ktpPath
        selfiePath: selfie,
      },
    ],
    spk: { path: spk, name: 'spk-visit11.pdf' },
  })

  await page.getByRole('button', { name: SUBMIT_LABEL }).click()

  const rowAlert = page
    .locator('#visit-tech-0-id_card_photo')
    .getByRole('alert')
    .filter({ hasText: 'Foto KTP wajib diunggah.' })
  await expect(rowAlert).toBeVisible()
  await expect(page).toHaveURL(/\/visits\/new$/)
})

test('@VISIT-12 Jabatan teks bebas tersimpan apa adanya', async ({ h }) => {
  const page = await h.openAs('vendor')
  const marker = h.unique('visit12')
  markers.push(marker)
  const jabatan = 'Teknisi Senior E2E'
  const catalog = await runtimeCatalog(h)

  const ktp = await writeAsset(test.info(), 'ktp.jpg', jpegBuffer())
  const selfie = await writeAsset(test.info(), 'selfie.jpg', jpegBuffer())
  const spk = await writeAsset(test.info(), 'spk-visit12.pdf', pdfBuffer(8))

  await fillVisitForm(page, {
    catalog,
    start: toLocalInput(offset(-20)),
    end: toLocalInput(offset(150)),
    members: [
      {
        name: `${marker} Teknisi Senior`,
        idNumber: '6171010101010012',
        phone: '081234567812',
        jabatan,
        vendorName: 'PT Lintas Fiber Nusantara',
        ktpPath: ktp,
        selfiePath: selfie,
      },
    ],
    notes: marker,
    spk: { path: spk, name: 'spk-visit12.pdf' },
  })

  const id = await submitAndCaptureId(page)
  const raw = await fetchVisitRaw(await h.tokenAs('vendor'), id)

  expect(raw.visitors?.[0]?.jabatan).toBe(jabatan)
  // Fasilitas & tujuan tetap sesuai pilihan form runtime — payload terkirim utuh.
  expect(raw.location?.id).toBe(catalog.facilityId)
  if (catalog.purposeId !== undefined) {
    expect(raw.purposes?.[0]?.id).toBe(catalog.purposeId)
  } else {
    expect(raw.purposes ?? []).toHaveLength(0)
    expect(raw.purpose_note).toBe(marker)
  }
})

test('@SUGGEST-01 vendor memilih saran anggota -> autofill data + foto + perusahaan (375px)', async ({ h }) => {
  test.setTimeout(180_000)
  const page = await h.openAs('vendor')
  const marker = h.unique('suggest01')
  markers.push(marker)
  const sourceVendor = `PT Saran ${marker}`
  const editedVendor = `PT Sunting ${marker}`

  // Kunjungan sumber dibuat via API agar anggota MEMBAWA EMAIL + foto —
  // bukti autofill Email ikut terlihat pada tangkapan layar 375px.
  const token = await h.tokenAs('vendor')
  const spkUpload = await uploadFileViaApi(token, 'assignment_letter', {
    name: `spk-${marker}.pdf`,
    mimeType: 'application/pdf',
    buffer: pdfBuffer(8),
  })
  uploadUrls.push(spkUpload.fileUrl)
  const ktpUpload = await uploadFileViaApi(token, 'id_card', {
    name: `ktp-${marker}.jpg`,
    mimeType: 'image/jpeg',
    buffer: jpegBuffer(),
  })
  uploadUrls.push(ktpUpload.fileUrl)
  const selfieUpload = await uploadFileViaApi(token, 'id_card', {
    name: `selfie-${marker}.png`,
    mimeType: 'image/png',
    buffer: pngBuffer(),
  })
  uploadUrls.push(selfieUpload.fileUrl)
  const now = Date.now()
  const sourceVisit = await createVisitViaApi(token, {
    location_id: translateSeedLocationId(LOCATIONS.hq),
    start_date: new Date(now - 30 * 60_000).toISOString(),
    end_date: new Date(now + 180 * 60_000).toISOString(),
    is_nda_accepted: true,
    assignment_letter_url: spkUpload.fileUrl,
    purpose_note: `E2E ${marker} purpose`,
    visitors: [
      {
        name: `${marker} Visitor 1`,
        id_number: `${String(now).slice(-13)}11`,
        phone: `0812${String(now).slice(-8)}`,
        email: 'saran.anggota@vendor.test',
        jabatan: 'Teknisi',
        vendor_name: sourceVendor,
        id_card_photo_url: ktpUpload.fileUrl,
        photo_url: selfieUpload.fileUrl,
      },
    ],
  })
  createdVisitIds.push(sourceVisit.id)
  const source = await getVisitViaApi(token, sourceVisit.id)
  const member = source.visitors?.[0]
  if (member?.id === undefined || member.id === '') {
    throw new Error('[suggest01] kunjungan sumber tidak memuat visitor id.')
  }
  if (member.id_card_photo_url == null || member.photo_url == null) {
    throw new Error('[suggest01] kunjungan sumber tidak memuat foto anggota.')
  }
  const memberName = member.name

  await page.setViewportSize({ width: 375, height: 812 })
  const catalog = await runtimeCatalog(h)
  const spk = await writeAsset(test.info(), 'spk-suggest01.pdf', pdfBuffer(8))
  await fillScheduleAndSpk(page, {
    catalog,
    start: toLocalInput(offset(-10)),
    end: toLocalInput(offset(120)),
    spk: { path: spk, name: 'spk-suggest01.pdf' },
  })

  // Formulir baru: "Perusahaan Vendor" baris anggota mulai KOSONG — tidak ada
  // prefill otomatis dari akun vendor maupun localStorage.
  await expect(page.getByLabel('Perusahaan Vendor')).toHaveValue('')

  // Ketikan memicu feed saran ber-`q=` (debounce 300 ms) — bukan hanya feed awal.
  const qResponsePromise = page.waitForResponse(
    (response) => {
      const url = new URL(response.url())
      return (
        response.request().method() === 'GET' &&
        url.pathname.endsWith('/api/v1/visits/member-suggestions') &&
        url.searchParams.has('q')
      )
    },
    { timeout: 30_000 },
  )
  const nameInput = page.locator('#visit-tech-0-name')
  await nameInput.click()
  await nameInput.pressSequentially(memberName.slice(0, 24))
  const qResponse = await qResponsePromise
  expect(qResponse.ok()).toBe(true)
  await expect(
    page.locator(`#visit-tech-0-name-datalist option[value="${memberName}"]`),
  ).toHaveCount(1)
  await page.screenshot({
    path: 'test-results/suggest-01-typeahead-375.png',
    fullPage: true,
  })

  // Pilihan langsung memanggil detail anggota (foto presigned) memakai
  // `visitor_id` dari baris saran — tanpa GET kunjungan sumber.
  const detailPromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      /^\/api\/v1\/visits\/member-suggestions\/[0-9a-f-]{36}$/.test(
        new URL(response.url()).pathname,
      ),
    { timeout: 30_000 },
  )

  // Popup saran native <datalist> tidak terbuka di Chromium bawaan Playwright
  // (teruji sampai halaman HTML statis pun), jadi pemilihan disimulasikan
  // lewat kontrak `input` Chrome/Edge: value = opsi terpilih, `inputType`
  // kosong (bukan `insertText`). Jalur Firefox (`insertReplacementText`)
  // diuji di @SUGGEST-04.
  await page.evaluate((fullName) => {
    const el = document.querySelector('#visit-tech-0-name')
    if (!(el instanceof HTMLInputElement)) return
    el.focus()
    el.value = fullName
    el.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: '' }),
    )
  }, memberName)
  await expect(nameInput).toHaveValue(memberName)

  const detailResponse = await detailPromise
  expect(detailResponse.ok()).toBe(true)
  expect(new URL(detailResponse.url()).pathname.endsWith(member.id)).toBe(true)

  await expect(page.locator('#visit-tech-0-id_number')).toHaveValue(member.id_number)
  await expect(page.locator('#visit-tech-0-phone')).toHaveValue(member.phone)
  await expect(page.locator('#visit-tech-0-jabatan')).toHaveValue('Teknisi')
  await expect(page.locator('#visit-tech-0-email')).toHaveValue('saran.anggota@vendor.test')

  // Perusahaan Vendor baris terisi dari perusahaan anggota SENDIRI, bukan
  // Vendor Pengaju kunjungan, dan tetap dapat disunting manual.
  const rowVendor = page.getByLabel('Perusahaan Vendor')
  await expect(rowVendor).toHaveValue(sourceVendor)
  await rowVendor.fill(editedVendor)
  await expect(rowVendor).toHaveValue(editedVendor)

  // Pratinjau foto = chip UploadBox (nama berkas turunan dari URL presigned).
  const ktpName = fileNameFromUrl(member.id_card_photo_url)
  const selfieName = fileNameFromUrl(member.photo_url)
  expect(ktpName).not.toBe('')
  expect(selfieName).not.toBe('')
  await expect(
    page.locator('#visit-tech-0-id_card_photo').getByText(ktpName, { exact: true }),
  ).toBeVisible()
  await expect(
    page.locator('#visit-tech-0-selfie').getByText(selfieName, { exact: true }),
  ).toBeVisible()

  // Permukaan nyata 375px: tanpa scroll horizontal + target aksi 44-52px.
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth)
  const submitBox = await page
    .getByRole('button', { name: SUBMIT_LABEL })
    .boundingBox()
  expect(submitBox?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect(submitBox?.height ?? 0).toBeLessThanOrEqual(52)
  await page.screenshot({
    path: 'test-results/suggest-01-autofill-375.png',
    fullPage: true,
  })

  // Submit: foto terbawa VERBATIM (key penyimpanan sama, query presigned
  // dibersihkan backend) tanpa field saran baru.
  const id = await submitAndCaptureId(page)
  const submitted = await fetchVisitRaw(token, id)
  const submittedMember = submitted.visitors?.[0]
  expect(submittedMember?.name).toBe(memberName)
  expect(submittedMember?.id_number).toBe(member.id_number)
  expect(submittedMember?.vendor_name).toBe(editedVendor)
  expect(submittedMember?.id_card_photo_url).toBeTruthy()
  expect(submittedMember?.photo_url).toBeTruthy()
  expect(new URL(submittedMember?.id_card_photo_url ?? '').pathname).toBe(
    new URL(member.id_card_photo_url).pathname,
  )
  expect(new URL(submittedMember?.photo_url ?? '').pathname).toBe(
    new URL(member.photo_url).pathname,
  )
})

test('@SUGGEST-02 Vendor Pengaju menyempitkan feed saran anggota (admin)', async ({
  h,
}) => {
  test.setTimeout(180_000)
  const page = await h.openAs('admin')
  const markerA = h.unique('scopingA')
  const markerB = h.unique('scopingB')
  markers.push(markerA, markerB)

  const token = await h.tokenAs('admin')
  const spk = await uploadFileViaApi(token, 'assignment_letter', {
    name: `spk-${markerA}.pdf`,
    mimeType: 'application/pdf',
    buffer: pdfBuffer(8),
  })
  uploadUrls.push(spk.fileUrl)

  // Dua kunjungan di cabang admin: vendor berbeda membuktikan penyempitan.
  const now = Date.now()
  const basePayload = {
    location_id: translateSeedLocationId(LOCATIONS.hq),
    start_date: new Date(now - 30 * 60_000).toISOString(),
    end_date: new Date(now + 180 * 60_000).toISOString(),
    is_nda_accepted: true,
    assignment_letter_url: spk.fileUrl,
  }
  const visitA = await createVisitViaApi(token, {
    ...basePayload,
    purpose_note: `E2E ${markerA} purpose`,
    vendor_name: 'PT Lintas Fiber',
    visitors: [
      {
        name: `${markerA} Anggota`,
        id_number: `${String(now).slice(-13)}01`,
        phone: `0812${String(now).slice(-8)}`,
        jabatan: 'Teknisi',
      },
    ],
  })
  createdVisitIds.push(visitA.id)
  const visitB = await createVisitViaApi(token, {
    ...basePayload,
    purpose_note: `E2E ${markerB} purpose`,
    vendor_name: 'PT Daya Power',
    visitors: [
      {
        name: `${markerB} Anggota`,
        id_number: `${String(now).slice(-13)}02`,
        phone: `0812${String(now + 1).slice(-8)}`,
        jabatan: 'Teknisi',
      },
    ],
  })
  createdVisitIds.push(visitB.id)

  // Feed awal (tanpa ?vendor=) harus memuat KEDUA anggota cabang.
  const eagerPromise = page.waitForResponse(
    (response) => {
      const url = new URL(response.url())
      return (
        response.request().method() === 'GET' &&
        url.pathname.endsWith('/api/v1/visits/member-suggestions') &&
        !url.searchParams.has('q') &&
        !url.searchParams.has('vendor')
      )
    },
    { timeout: 30_000 },
  )
  await gotoApp(page, '/visits/new')
  await expect(
    page.getByRole('heading', { name: 'Pengajuan Akses Fasilitas Jaringan THC' }),
  ).toBeVisible()
  const eager = await eagerPromise
  expect(eager.ok()).toBe(true)
  const optionA = page.locator(
    `#visit-tech-0-name-datalist option[value="${markerA} Anggota"]`,
  )
  const optionB = page.locator(
    `#visit-tech-0-name-datalist option[value="${markerB} Anggota"]`,
  )
  await expect(optionA).toHaveCount(1)
  await expect(optionB).toHaveCount(1)

  // Vendor Pengaju diisi -> feed anggota dikirim ulang dengan ?vendor=.
  const scopedPromise = page.waitForResponse(
    (response) => {
      const url = new URL(response.url())
      return (
        response.request().method() === 'GET' &&
        url.pathname.endsWith('/api/v1/visits/member-suggestions') &&
        url.searchParams.has('vendor')
      )
    },
    { timeout: 30_000 },
  )
  await page.locator('#visit-vendor-name').fill('PT Lintas Fiber')
  const scoped = await scopedPromise
  expect(new URL(scoped.url()).searchParams.get('vendor')).toBe('PT Lintas Fiber')
  expect(scoped.ok()).toBe(true)

  const scopedBody = (await scoped.json()) as ApiEnvelope<Array<{ name: string }>>
  if (scopedBody.success !== true) {
    throw new Error(`[suggest02] feed saran anggota gagal: ${JSON.stringify(scopedBody)}`)
  }
  const scopedNames = scopedBody.data.map((item) => item.name)
  expect(scopedNames).toContain(`${markerA} Anggota`)
  expect(scopedNames).not.toContain(`${markerB} Anggota`)

  await expect(optionA).toHaveCount(1)
  await expect(optionB).toHaveCount(0)
})

test('@SUGGEST-03 ketikan manual nama anggota novel tetap terkirim tanpa saran', async ({
  h,
}) => {
  test.setTimeout(180_000)
  const page = await h.openAs('vendor')
  const marker = h.unique('suggest03')
  markers.push(marker)
  const manualName = `${marker} Manual`

  // Jalur manual tidak pernah menembak endpoint detail saran.
  const detailRequests: string[] = []
  page.on('request', (request) => {
    if (/\/api\/v1\/visits\/member-suggestions\/[0-9a-f-]{36}/.test(request.url())) {
      detailRequests.push(request.url())
    }
  })

  const catalog = await runtimeCatalog(h)
  const ktp = await writeAsset(test.info(), 'ktp-suggest03.jpg', jpegBuffer())
  const selfie = await writeAsset(test.info(), 'selfie-suggest03.jpg', jpegBuffer())
  const spk = await writeAsset(test.info(), 'spk-suggest03.pdf', pdfBuffer(8))
  await fillScheduleAndSpk(page, {
    catalog,
    start: toLocalInput(offset(-5)),
    end: toLocalInput(offset(90)),
    spk: { path: spk, name: 'spk-suggest03.pdf' },
  })

  await page.locator('#visit-tech-0-name').fill(manualName)
  await expect(
    page.locator(`#visit-tech-0-name-datalist option[value="${manualName}"]`),
  ).toHaveCount(0)

  await page.locator('#visit-tech-0-id_number').fill('6171010101010033')
  await page.locator('#visit-tech-0-phone').fill('081234567833')
  await uploadInto(page, 'visit-tech-0-id_card_photo', ktp, 'ktp-suggest03.jpg')
  await uploadInto(page, 'visit-tech-0-selfie', selfie, 'selfie-suggest03.jpg')

  const id = await submitAndCaptureId(page)
  const raw = await fetchVisitRaw(await h.tokenAs('vendor'), id)
  expect(raw.status).toBe('requested')
  expect(raw.visitors?.[0]?.name).toBe(manualName)
  expect(raw.visitors?.[0]?.id_number).toBe('6171010101010033')
  expect(detailRequests).toHaveLength(0)
})

test('@SUGGEST-04 dua anggota bernama sama dipilih terpisah lewat nomor HP', async ({
  h,
}) => {
  test.setTimeout(180_000)
  const page = await h.openAs('vendor')
  const marker = h.unique('suggest04')
  markers.push(marker)
  const sharedName = `${marker} Kembar`

  const token = await h.tokenAs('vendor')
  const spkUpload = await uploadFileViaApi(token, 'assignment_letter', {
    name: `spk-${marker}.pdf`,
    mimeType: 'application/pdf',
    buffer: pdfBuffer(8),
  })
  uploadUrls.push(spkUpload.fileUrl)
  const now = Date.now()
  const phoneA = `0813${String(now).slice(-8)}`
  const phoneB = `0899${String(now + 1).slice(-8)}`
  const vendorA = `PT Kembar A ${marker}`
  const vendorB = `PT Kembar B ${marker}`

  // Dua baris visitor dengan nama PERSIS sama, nomor HP berbeda: keduanya
  // lolos dedupe backend dan harus dapat dipilih terpisah di datalist.
  const sourceVisit = await createVisitViaApi(token, {
    location_id: translateSeedLocationId(LOCATIONS.hq),
    start_date: new Date(now - 30 * 60_000).toISOString(),
    end_date: new Date(now + 180 * 60_000).toISOString(),
    is_nda_accepted: true,
    assignment_letter_url: spkUpload.fileUrl,
    purpose_note: `E2E ${marker} purpose`,
    visitors: [
      {
        name: sharedName,
        id_number: `${String(now).slice(-13)}41`,
        phone: phoneA,
        email: 'kembar.a@vendor.test',
        jabatan: 'Teknisi A',
        vendor_name: vendorA,
      },
      {
        name: sharedName,
        id_number: `${String(now).slice(-13)}42`,
        phone: phoneB,
        email: 'kembar.b@vendor.test',
        jabatan: 'Teknisi B',
        vendor_name: vendorB,
      },
    ],
  })
  createdVisitIds.push(sourceVisit.id)
  const source = await getVisitViaApi(token, sourceVisit.id)
  const second = (source.visitors ?? []).find((visitor) => visitor.phone === phoneB)
  if (second?.id === undefined || second.id === '') {
    throw new Error('[suggest04] kunjungan sumber tidak memuat id visitor kedua.')
  }

  await gotoApp(page, '/visits/new')
  await expect(
    page.getByRole('heading', { name: 'Pengajuan Akses Fasilitas Jaringan THC' }),
  ).toBeVisible()

  const qResponsePromise = page.waitForResponse(
    (response) => {
      const url = new URL(response.url())
      return (
        response.request().method() === 'GET' &&
        url.pathname.endsWith('/api/v1/visits/member-suggestions') &&
        url.searchParams.has('q')
      )
    },
    { timeout: 30_000 },
  )
  const nameInput = page.locator('#visit-tech-0-name')
  await nameInput.click()
  await nameInput.pressSequentially(sharedName.slice(0, 24))
  const qResponse = await qResponsePromise
  expect(qResponse.ok()).toBe(true)

  // Nilai opsi diberi akhiran nomor HP HANYA karena namanya duplikat.
  await expect(
    page.locator(`#visit-tech-0-name-datalist option[value="${sharedName} (${phoneA})"]`),
  ).toHaveCount(1)
  await expect(
    page.locator(`#visit-tech-0-name-datalist option[value="${sharedName} (${phoneB})"]`),
  ).toHaveCount(1)

  const detailPromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      /^\/api\/v1\/visits\/member-suggestions\/[0-9a-f-]{36}$/.test(
        new URL(response.url()).pathname,
      ),
    { timeout: 30_000 },
  )
  await page.evaluate((pickedValue) => {
    const el = document.querySelector('#visit-tech-0-name')
    if (!(el instanceof HTMLInputElement)) return
    el.focus()
    el.value = pickedValue
    // Kontrak Firefox: opsi datalist dipilih lewat `insertReplacementText`
    // (Chrome/Edge memakai `inputType` kosong, diuji di @SUGGEST-01).
    el.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText' }),
    )
  }, `${sharedName} (${phoneB})`)

  const detailResponse = await detailPromise
  expect(detailResponse.ok()).toBe(true)
  expect(new URL(detailResponse.url()).pathname.endsWith(second.id)).toBe(true)

  // Nama kembali kanonis; baris memakai data orang KEDUA (bukan yang pertama).
  await expect(nameInput).toHaveValue(sharedName)
  await expect(page.locator('#visit-tech-0-phone')).toHaveValue(phoneB)
  await expect(page.locator('#visit-tech-0-jabatan')).toHaveValue('Teknisi B')
  await expect(page.locator('#visit-tech-0-email')).toHaveValue('kembar.b@vendor.test')
  await expect(page.getByLabel('Perusahaan Vendor')).toHaveValue(vendorB)
})
