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
import { expect, test } from '../fixtures'
import {
  LOCATIONS,
  PURPOSES,
  apiFetchRaw,
  deleteVisitViaApi,
  getVisitViaApi,
  type ApiEnvelope,
} from '../helpers/api'
import { exeBuffer, jpegBuffer, pdfBuffer, writeAsset } from '../helpers/assets'
import { collectFileUrls, deleteUploadedFiles } from '../helpers/storage'

const HQ_LABEL = 'Kantor Pusat THC (Pontianak)'
const PURPOSE_CATALOG = 'Splicing & Maintenance Kabel Fiber Optik'
const SUBMIT_LABEL = 'Kirim Permohonan Kunjungan'

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

async function openForm(page: Page): Promise<void> {
  await page.goto('/visits/new')
  await expect(
    page.getByRole('heading', { name: 'Pengajuan Akses Fasilitas Jaringan THC' }),
  ).toBeVisible()
  // Katalog fasilitas & tujuan dimuat async; tunggu sampai kontrol siap.
  await expect(
    page.locator('#visit-location option').filter({ hasText: HQ_LABEL }),
  ).toHaveCount(1)
  await expect(page.locator('#visit-purpose')).toBeEnabled()
}

async function pickLocation(page: Page): Promise<void> {
  await page.getByLabel('Fasilitas Tujuan').selectOption({ label: HQ_LABEL })
}

async function pickCatalogPurpose(page: Page): Promise<void> {
  await page.locator('#visit-purpose').click()
  const panel = page.getByRole('listbox')
  await expect(panel).toBeVisible()
  await panel.getByRole('checkbox', { name: PURPOSE_CATALOG }).check()
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
  const uploaded = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().includes('/api/v1/uploads') &&
      response.status() >= 200 &&
      response.status() < 300,
  )
  await box.locator('input[type=file]').setInputFiles(filePath)
  const body = (await (await uploaded).json()) as { data?: { file_url?: unknown } }
  const fileUrl = body.data?.file_url
  if (typeof fileUrl !== 'string') {
    throw new Error(`[visit-form] respons POST /uploads tanpa data.file_url untuk ${fileName}`)
  }
  uploadUrls.push(fileUrl)
  await expect(box.getByText(fileName, { exact: true })).toBeVisible()
}

async function fillVisitForm(page: Page, options: FillVisitOptions): Promise<void> {
  await openForm(page)
  await pickLocation(page)

  if (options.pickCatalogPurpose !== false) {
    await pickCatalogPurpose(page)
  }
  if (options.purposeNote !== undefined) {
    await page.locator('#visit-purpose-note').fill(options.purposeNote)
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
  try {
    const token = await h.tokenAs('super')
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

    fileUrls.push(...(await sweepMarkedVisits(token)))
    fileUrls.push(...uploadUrls)
    if (process.env.E2E_SKIP_STORAGE_CLEANUP === '1') {
      console.log(
        `[visit-form-cleanup] cleanup bucket dilewati; ${fileUrls.length} objek tersisa di target`,
      )
    } else {
      await deleteUploadedFiles(fileUrls)
    }
  } catch (error) {
    problems.push(`cleanup: ${errorText(error)}`)
  }

  if (problems.length > 0) {
    throw new Error(`[visit-form-cleanup] ${problems.join('; ')}`)
  }
})

test('@VISIT-01 happy path lengkap: 1 anggota KTP+selfie, SPK 1,5 MB, tujuan katalog, NDA', async ({
  h,
}) => {
  const page = await h.openAs('vendor')
  const marker = h.unique('visit01')
  markers.push(marker)

  const spk = await writeAsset(test.info(), 'spk-visit01.pdf', pdfBuffer(1500))
  const ktp = await writeAsset(test.info(), 'ktp.jpg', jpegBuffer())
  const selfie = await writeAsset(test.info(), 'selfie.jpg', jpegBuffer())

  await fillVisitForm(page, {
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
  await openForm(page)

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
  await openForm(page)

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

  const ktp = await writeAsset(test.info(), 'ktp.jpg', jpegBuffer())
  const selfie = await writeAsset(test.info(), 'selfie.jpg', jpegBuffer())
  const spk = await writeAsset(test.info(), 'spk-visit05.pdf', pdfBuffer(8))

  await fillVisitForm(page, {
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

  const ktp = await writeAsset(test.info(), 'ktp.jpg', jpegBuffer())
  const selfie = await writeAsset(test.info(), 'selfie.jpg', jpegBuffer())
  const spk = await writeAsset(test.info(), 'spk-visit12.pdf', pdfBuffer(8))

  await fillVisitForm(page, {
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
  // Fasilitas & tujuan katalog tetap sesuai pilihan form — payload terkirim utuh.
  expect(raw.location?.id).toBe(LOCATIONS.hq)
  expect(raw.purposes?.[0]?.id).toBe(PURPOSES[PURPOSE_CATALOG])
})
