/**
 * E2E back-office: master data pengawas, koordinator, vendor, dan navigasi.
 *
 * Cakupan (tag judul = ID skenario):
 * - @NAV-02 /security sebagai admin: form tambah + daftar cabangnya saja.
 * - @AUTH-07 admin menambah pengawas lewat UI (lokasi dipaksa cabangnya).
 * - @DEL-01  hapus pengawas lewat UI (super_admin) + verifikasi API 404.
 * - @NAV-04  /coordinators memuat admin + super_admin, filter peran bekerja.
 * - @NAV-05  /vendor-registrations hanya vendor + filter vendor bekerja.
 * - @NAV-06  /users 404 + filter "Superadmin" menyembunyikan tombol tambah.
 * - @EDT-01  ubah nama koordinator lewat modal Ubah.
 * - @EDT-02  reset kata sandi lewat modal Ubah lalu login dengan sandi baru.
 * - @EDT-03  admin ubah pengawas se-cabang; lintas cabang ditolak server.
 *
 * ATURAN KESELAMATAN DATA:
 * - Akun seed TIDAK PERNAH diubah/dihapus. Semua mutasi hanya pada akun BARU
 *   yang dibuat lewat API di dalam test.
 * - Setiap email akun uji dicatat di tracker; `finally` menyapu SEMUA akun
 *   dengan email tersebut (termasuk bila ID-nya gagal tertangkap), lalu
 *   memverifikasi akun itu benar-benar hilang.
 */

import type { Locator, Page } from '@playwright/test'
import { expect, test, type Harness } from '../fixtures'
import {
  LOCATIONS,
  apiFetch,
  apiFetchRaw,
  loginViaApi,
  type ApiEnvelope,
} from '../helpers/api'

const PASSWORD = 'Password123!'
const NEW_PASSWORD = 'RahasiaBaru456!'

/** Bentuk minimal `User` dari openapi yang dipakai spec ini. */
interface AccountRow {
  id: string
  name: string
  email: string
  nik: string | null
  role: string
  location_id: string | null
  location_name: string | null
  status: string
  type: string
  vendor_name: string | null
}

interface TempUser {
  kind: 'security' | 'managed'
  id: string
  email: string
}

// ---------------------------------------------------------------------------
// Helper unik (tanpa menyentuh berkas shared)
// ---------------------------------------------------------------------------

let nikSequence = 0

/** NIK 16 digit angka yang unik antar test. */
function uniqueNik(): string {
  nikSequence += 1
  const time = String(Date.now()).slice(-12)
  const random = String(Math.floor(Math.random() * 1000)).padStart(3, '0')
  return `${time}${random}${nikSequence % 10}`
}

/**
 * Email unik berformat `<prefix>.<unique>@thc.com` sesuai skenario AUTH-07.
 * `h.unique` sudah mengandung timestamp + nomor urut + sufiks acak.
 */
function uniqueEmail(h: Harness, prefix: string): string {
  return `${prefix}.${h.unique(prefix).toLowerCase()}@thc.com`
}

function expectData<T>(body: ApiEnvelope<T>, context: string): T {
  if (body.success !== true) {
    throw new Error(`[e2e-t8] ${context} gagal: ${body.error.code} - ${body.error.message}`)
  }
  return body.data
}

/**
 * Buka menu aksi baris lalu pilih satu item.
 *
 * Query pencarian yang baru selesai dapat me-render ulang tabel tepat setelah
 * menu dibuka sehingga menunya hilang; klik pembuka diulang selama menu belum
 * terlihat.
 */
async function selectRowAction(page: Page, trigger: Locator, itemLabel: string): Promise<void> {
  const item = page.getByRole('menuitem', { name: itemLabel, exact: true })
  await trigger.click()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await item.waitFor({ state: 'visible', timeout: 2500 })
      await item.click()
      return
    } catch {
      await trigger.click()
    }
  }
  await item.click({ timeout: 5000 })
}

async function listSecurityUsers(token: string, locationId?: string): Promise<AccountRow[]> {
  const path =
    locationId !== undefined
      ? `/users/security?location_id=${encodeURIComponent(locationId)}`
      : '/users/security'
  const result = await apiFetch<ApiEnvelope<AccountRow[]>>(token, 'GET', path)
  return expectData(result.body, `GET ${path}`)
}

async function listManagedUsers(token: string, search = ''): Promise<AccountRow[]> {
  const path = search === '' ? '/users' : `/users?search=${encodeURIComponent(search)}`
  const result = await apiFetch<ApiEnvelope<AccountRow[]>>(token, 'GET', path)
  return expectData(result.body, `GET ${path}`)
}

async function createSecurityUser(
  token: string,
  input: {
    name: string
    email: string
    password?: string
    phone?: string
    /** Hanya dikirim bila diisi (super_admin wajib; admin diabaikan server). */
    locationId?: string
  },
): Promise<AccountRow> {
  const payload: Record<string, unknown> = {
    name: input.name,
    email: input.email,
    password: input.password ?? PASSWORD,
  }
  if (input.phone !== undefined) payload.phone = input.phone
  if (input.locationId !== undefined) payload.location_id = input.locationId
  const result = await apiFetch<ApiEnvelope<AccountRow>>(
    token,
    'POST',
    '/users/security',
    payload,
  )
  const created = expectData(result.body, 'POST /users/security')
  console.log(`[e2e-t8] create security ${created.email} -> ${created.id}`)
  return created
}

async function createManagedUser(
  token: string,
  input: {
    name: string
    email: string
    password?: string
    role: 'admin' | 'vendor'
    nik: string
    locationId?: string
  },
): Promise<AccountRow> {
  const payload: Record<string, unknown> = {
    name: input.name,
    email: input.email,
    password: input.password ?? PASSWORD,
    role: input.role,
    nik: input.nik,
  }
  if (input.locationId !== undefined) payload.location_id = input.locationId
  const result = await apiFetch<ApiEnvelope<AccountRow>>(token, 'POST', '/users', payload)
  const created = expectData(result.body, 'POST /users')
  console.log(`[e2e-t8] create ${input.role} ${created.email} -> ${created.id}`)
  return created
}

async function deleteUser(
  token: string,
  kind: TempUser['kind'],
  id: string,
): Promise<number> {
  const path = kind === 'security' ? `/users/security/${id}` : `/users/${id}`
  const result = await apiFetchRaw(token, 'DELETE', path)
  return result.status
}

/** Toast Sonner: `<li data-sonner-toast>` (sonner 2.x). */
async function expectToast(page: Page, text: string): Promise<void> {
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: text }).first(),
  ).toBeVisible()
}

/**
 * Tracker akun uji. Bekerja berbasis EMAIL, bukan ID: bila pembuatan akun
 * berhasil tetapi ID gagal dibaca (assertion gagal di tengah), cleanup tetap
 * menemukan akunnya lewat penyapuan daftar user.
 */
function makeTracker() {
  const emails = new Set<string>()
  return {
    track(rawEmail: string): void {
      emails.add(rawEmail.trim().toLowerCase())
    },
    async cleanup(h: Harness): Promise<void> {
      if (emails.size === 0) return
      let token: string
      try {
        token = await h.tokenAs('super')
      } catch (error) {
        console.log(`[e2e-t8] cleanup dilewati (token super gagal): ${String(error)}`)
        return
      }

      // 1) Hapus SEMUA akun yang emailnya tercatat (aman untuk diulang).
      try {
        const rows = [...(await listSecurityUsers(token)), ...(await listManagedUsers(token))]
        for (const row of rows) {
          if (!emails.has(row.email.trim().toLowerCase())) continue
          const kind: TempUser['kind'] = row.role === 'security' ? 'security' : 'managed'
          try {
            const status = await deleteUser(token, kind, row.id)
            console.log(`[e2e-t8] cleanup DELETE ${kind} ${row.email} -> HTTP ${status}`)
          } catch (error) {
            console.log(`[e2e-t8] cleanup DELETE ${row.email} dilewati: ${String(error)}`)
          }
        }
      } catch (error) {
        console.log(`[e2e-t8] cleanup sapuan gagal: ${String(error)}`)
      }

      // 2) Verifikasi tidak ada akun uji yang tertinggal.
      try {
        const remaining = [...(await listSecurityUsers(token)), ...(await listManagedUsers(token))]
        for (const email of emails) {
          const leftover = remaining.find(
            (row) => row.email.trim().toLowerCase() === email,
          )
          console.log(
            `[e2e-t8] cleanup verify ${email} -> ${leftover !== undefined ? `MASIH ADA (${leftover.id})` : 'bersih'}`,
          )
        }
      } catch (error) {
        console.log(`[e2e-t8] cleanup verifikasi gagal: ${String(error)}`)
      }
    },
  }
}

/** Baris tabel desktop yang memuat teks tertentu (kartu mobile diabaikan). */
function tableRowWith(page: Page, text: string) {
  return page.locator('tbody tr').filter({ hasText: text })
}

/**
 * Isi kolom cari lalu TUNGGU respons daftar yang tersaring.
 *
 * Penting: klik yang jatuh tepat saat refetch debounce selesai bisa mendarat
 * di baris yang baru saja di-mount ulang, sehingga handler React-nya hilang.
 * Menunggu respons (`?search=<term>`) memastikan daftar sudah settle.
 */
async function fillSearch(page: Page, label: string, term: string): Promise<void> {
  const settled = page
    .waitForResponse(
      (response) => {
        if (response.request().method() !== 'GET') return false
        const url = new URL(response.url())
        if (!url.pathname.endsWith('/users') && !url.pathname.endsWith('/users/security')) {
          return false
        }
        return url.searchParams.get('search') === term
      },
      { timeout: 20_000 },
    )
    // Cache React Query bisa memenuhi hasil tanpa request baru - jangan gagal.
    .catch(() => null)
  await page.getByLabel(label).fill(term)
  await settled
}

// ---------------------------------------------------------------------------
// Skenario
// ---------------------------------------------------------------------------

test('@NAV-02 admin membuka /security: form tambah + daftar pengawas cabangnya saja', async ({
  h,
}) => {
  const page = await h.openAs('admin')
  await page.goto('/security')

  await expect(
    page.getByRole('heading', { name: 'Kelola Pengawas', exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Tambah Pengawas' })).toBeVisible()

  // Daftar pengawas cabang HQ tampil.
  await expect(page.getByText('security1a@thc.com', { exact: true })).toBeVisible()

  // Modal tambah: field terlihat, cabang terkunci (admin tak punya select cabang).
  await page.getByRole('button', { name: 'Tambah Pengawas' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Nama Lengkap')).toBeVisible()
  await expect(dialog.getByLabel('Email')).toBeVisible()
  await expect(dialog.getByLabel('Kata Sandi')).toBeVisible()
  await expect(dialog.locator('select')).toHaveCount(0)
  await expect(dialog.getByText('(terkunci)')).toBeVisible()
  await dialog.getByRole('button', { name: 'Batal' }).click()
  await expect(dialog).toHaveCount(0)

  // Isolasi cabang: pengawas Sambas (dibaca via API admin Sambas) tidak tampil.
  const sambasUsers = await listSecurityUsers(await h.tokenAs('admin-sambas'))
  expect(sambasUsers.length).toBeGreaterThan(0)
  for (const user of sambasUsers) {
    await expect(page.getByText(user.email, { exact: true })).toHaveCount(0)
  }
})

test('@AUTH-07 admin menambah pengawas baru via UI dan lokasinya = cabang admin', async ({
  h,
}) => {
  const tracker = makeTracker()
  const email = uniqueEmail(h, 'security')
  tracker.track(email)
  const name = `${h.unique('AUTH07')} Pengawas`

  try {
    const adminToken = await h.tokenAs('admin')
    const page = await h.openAs('admin')
    await page.goto('/security')
    await expect(
      page.getByRole('heading', { name: 'Kelola Pengawas', exact: true }),
    ).toBeVisible()

    await page.getByRole('button', { name: 'Tambah Pengawas' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Nama Lengkap').fill(name)
    await dialog.getByLabel('Email').fill(email)
    await dialog.getByLabel('Kata Sandi').fill(PASSWORD)
    await dialog.getByRole('button', { name: 'Tambah Pengawas' }).click()

    await expectToast(page, `Pengawas ${name} berhasil ditambahkan`)
    await expect(dialog).toHaveCount(0)

    // Baris baru muncul di daftar (cari dulu agar bebas pagination).
    await fillSearch(page, 'Cari pengawas', email)
    await expect(tableRowWith(page, email)).toHaveCount(1)

    // Verifikasi API: user baru berada di cabang admin (HQ).
    const users = await listSecurityUsers(adminToken)
    const created = users.find((user) => user.email === email)
    expect(created, `user ${email} harus ada di daftar API admin`).toBeDefined()
    if (created === undefined) {
      throw new Error(`[e2e-t8] user ${email} tidak ditemukan lewat API admin.`)
    }
    expect(created.role).toBe('security')
    expect(created.location_id).toBe(LOCATIONS.hq)
  } finally {
    await tracker.cleanup(h)
  }
})

test('@DEL-01 super_admin menghapus pengawas baru via UI lalu API 404', async ({ h }) => {
  const tracker = makeTracker()
  const email = uniqueEmail(h, 'security')
  tracker.track(email)
  const name = `${h.unique('DEL01')} Pengawas`

  try {
    const superToken = await h.tokenAs('super')
    const adminToken = await h.tokenAs('admin')
    const created = await createSecurityUser(adminToken, { name, email })
    expect(created.location_id).toBe(LOCATIONS.hq)

    const page = await h.openAs('super')
    await page.goto('/security')
    await expect(
      page.getByRole('heading', { name: 'Kelola Pengawas', exact: true }),
    ).toBeVisible()

    await fillSearch(page, 'Cari pengawas', email)
    const row = tableRowWith(page, email)
    await expect(row).toHaveCount(1)

    await selectRowAction(page, row.getByRole('button', { name: `Aksi untuk ${name}` }), 'Hapus')

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: `Hapus ${name}` })).toBeVisible()
    await dialog.getByRole('button', { name: 'Hapus Permanen' }).click()

    await expectToast(page, `${name} dihapus permanen`)
    await expect(row).toHaveCount(0)

    // Verifikasi API: hilang dari daftar dan DELETE ulang menjawab 404.
    const after = await listSecurityUsers(superToken)
    expect(after.some((user) => user.email === email)).toBe(false)
    const secondDelete = await apiFetchRaw(superToken, 'DELETE', `/users/security/${created.id}`)
    expect(secondDelete.status).toBe(404)
  } finally {
    await tracker.cleanup(h)
  }
})

test('@NAV-04 /coordinators memuat admin + super_admin dan filter peran bekerja', async ({
  h,
}) => {
  const page = await h.openAs('super')
  await page.goto('/coordinators')

  await expect(
    page.getByRole('heading', { name: 'Koordinator Wilayah & Superadmin', exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Tambah Koordinator Wilayah' })).toBeVisible()

  const rows = page.locator('tbody tr')

  // Tanpa filter: admin cabang & super_admin tampil berdampingan.
  await expect(tableRowWith(page, 'admin1@thc.com')).toHaveCount(1)
  await expect(tableRowWith(page, 'superadmin@thc.net.id')).toHaveCount(1)

  // Filter peran di header kolom "Peran" (desktop) -> hanya Superadmin.
  const roleFilter = page.locator('thead select[aria-label="Filter peran"]')
  await expect(roleFilter).toBeVisible()
  await roleFilter.selectOption({ label: 'Superadmin' })

  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Superadmin')
  await expect(tableRowWith(page, 'superadmin@thc.net.id')).toHaveCount(1)
  await expect(tableRowWith(page, 'admin1@thc.com')).toHaveCount(0)

  // Kembali ke semua peran -> tombol tambah muncul lagi.
  await roleFilter.selectOption({ label: 'Semua Peran' })
  await expect(page.getByRole('button', { name: 'Tambah Koordinator Wilayah' })).toBeVisible()
  await expect(tableRowWith(page, 'admin1@thc.com')).toHaveCount(1)
})

test('@NAV-05 /vendor-registrations hanya akun vendor dan filter vendor bekerja', async ({
  h,
}) => {
  const page = await h.openAs('super')
  await page.goto('/vendor-registrations')

  await expect(
    page.getByRole('heading', { name: 'Pendaftaran Vendor/Mitra', exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Tambah Vendor/Mitra' })).toBeVisible()

  // Halaman satu peran: kontrol filter peran tidak dirender (perilaku nyata).
  await expect(page.locator('select[aria-label="Filter peran"]')).toHaveCount(0)

  // Semua baris adalah akun Vendor/Mitra.
  const rows = page.locator('tbody tr')
  await expect(rows.first()).toBeVisible()
  const initialCount = await rows.count()
  expect(initialCount).toBeGreaterThan(0)
  for (let index = 0; index < initialCount; index += 1) {
    await expect(rows.nth(index)).toContainText('Vendor/Mitra')
  }

  // Filter "Vendor/Nama Perusahaan" (bukan filter peran) menyaring baris.
  await page.getByLabel('Vendor/Nama Perusahaan').selectOption({ label: 'PT Lintas Fiber' })
  await expect(rows).toHaveCount(5)
  for (let index = 0; index < 5; index += 1) {
    await expect(rows.nth(index)).toContainText('PT Lintas Fiber')
  }
  await expect(page.getByText('vendor1b@thc.com', { exact: true })).toHaveCount(0)
})

test('@NAV-06 /users 404 dan filter Superadmin menyembunyikan tombol tambah', async ({ h }) => {
  const page = await h.openAs('super')

  const response = await page.goto('/users')
  expect(response?.status()).toBe(404)
  await expect(page.getByRole('heading', { name: '404', exact: true })).toBeVisible()
  await expect(page.getByText('This page could not be found.')).toBeVisible()

  await page.goto('/coordinators')
  await expect(
    page.getByRole('heading', { name: 'Koordinator Wilayah & Superadmin', exact: true }),
  ).toBeVisible()

  const roleFilter = page.locator('thead select[aria-label="Filter peran"]')
  await roleFilter.selectOption({ label: 'Superadmin' })

  // Perilaku nyata: baris tersaring ke Superadmin dan tombol tambah hilang
  // (POST /users hanya menerima admin|vendor).
  await expect(page.locator('tbody tr')).toHaveCount(1)
  await expect(page.locator('tbody tr').first()).toContainText('Superadmin')
  await expect(page.getByRole('button', { name: 'Tambah Koordinator Wilayah' })).toHaveCount(0)
})

test('@EDT-01 super_admin mengubah nama koordinator baru lewat modal Ubah', async ({ h }) => {
  const tracker = makeTracker()
  const email = uniqueEmail(h, 'koordinator')
  tracker.track(email)
  const originalName = `${h.unique('EDT01')} Koordinator`
  const updatedName = `${originalName} Diubah`

  try {
    const superToken = await h.tokenAs('super')
    await createManagedUser(superToken, {
      name: originalName,
      email,
      role: 'admin',
      nik: uniqueNik(),
      locationId: LOCATIONS.hq,
    })

    const page = await h.openAs('super')
    await page.goto('/coordinators')
    await expect(
      page.getByRole('heading', { name: 'Koordinator Wilayah & Superadmin', exact: true }),
    ).toBeVisible()

    await fillSearch(page, 'Cari user', email)
    const row = tableRowWith(page, email)
    await expect(row).toHaveCount(1)

    await selectRowAction(
      page,
      row.getByRole('button', { name: `Aksi untuk ${originalName}` }),
      'Ubah',
    )

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: `Ubah User — ${originalName}` })).toBeVisible()
    await dialog.getByLabel('Nama Lengkap').fill(updatedName)
    await dialog.getByRole('button', { name: 'Simpan Perubahan' }).click()

    await expectToast(page, `Perubahan ${updatedName} tersimpan`)
    await expect(dialog).toHaveCount(0)

    const after = await listManagedUsers(superToken, email)
    const updated = after.find((user) => user.email === email)
    expect(updated?.name).toBe(updatedName)
  } finally {
    await tracker.cleanup(h)
  }
})

test('@EDT-02 reset kata sandi lewat modal Ubah lalu login dengan sandi baru', async ({ h }) => {
  const tracker = makeTracker()
  const email = uniqueEmail(h, 'koordinator')
  tracker.track(email)
  const name = `${h.unique('EDT02')} Koordinator`

  try {
    const superToken = await h.tokenAs('super')
    await createManagedUser(superToken, {
      name,
      email,
      password: PASSWORD,
      role: 'admin',
      nik: uniqueNik(),
      locationId: LOCATIONS.hq,
    })

    const page = await h.openAs('super')
    await page.goto('/coordinators')
    await expect(
      page.getByRole('heading', { name: 'Koordinator Wilayah & Superadmin', exact: true }),
    ).toBeVisible()

    await fillSearch(page, 'Cari user', email)
    const row = tableRowWith(page, email)
    await expect(row).toHaveCount(1)
    await selectRowAction(page, row.getByRole('button', { name: `Aksi untuk ${name}` }), 'Ubah')

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: `Ubah User — ${name}` })).toBeVisible()
    await dialog.getByLabel('Kata Sandi Baru').fill(NEW_PASSWORD)
    await dialog.getByRole('button', { name: 'Simpan Perubahan' }).click()

    await expectToast(page, `Perubahan ${name} tersimpan`)
    await expect(dialog).toHaveCount(0)

    // Sandi baru berlaku; sandi lama ditolak.
    const login = await loginViaApi(email, NEW_PASSWORD)
    expect(login.user.email).toBe(email)
    expect(login.user.role).toBe('admin')

    const stale = await apiFetchRaw('', 'POST', '/auth/login', {
      email,
      password: PASSWORD,
    })
    expect(stale.status).toBe(401)
  } finally {
    await tracker.cleanup(h)
  }
})

test('@EDT-03 admin ubah pengawas se-cabang; lintas cabang ditolak (UI & API)', async ({
  h,
}) => {
  const tracker = makeTracker()
  const hqEmail = uniqueEmail(h, 'security')
  const sambasEmail = uniqueEmail(h, 'security')
  tracker.track(hqEmail)
  tracker.track(sambasEmail)
  const hqName = `${h.unique('EDT03HQ')} Pengawas`
  const hqUpdatedName = `${hqName} Diubah`
  const sambasName = `${h.unique('EDT03SAMBAS')} Pengawas`

  try {
    const adminToken = await h.tokenAs('admin')
    const superToken = await h.tokenAs('super')

    // Pengawas cabang sendiri (HQ) dibuat oleh admin; cabang lain oleh super.
    const hqUser = await createSecurityUser(adminToken, { name: hqName, email: hqEmail })
    expect(hqUser.location_id).toBe(LOCATIONS.hq)
    const sambasUser = await createSecurityUser(superToken, {
      name: sambasName,
      email: sambasEmail,
      locationId: LOCATIONS.sambas,
    })
    expect(sambasUser.location_id).toBe(LOCATIONS.sambas)

    const page = await h.openAs('admin')
    await page.goto('/security')
    await expect(
      page.getByRole('heading', { name: 'Kelola Pengawas', exact: true }),
    ).toBeVisible()

    // 1) Edit pengawas se-cabang berhasil.
    await fillSearch(page, 'Cari pengawas', hqEmail)
    const hqRow = tableRowWith(page, hqEmail)
    await expect(hqRow).toHaveCount(1)
    await selectRowAction(page, hqRow.getByRole('button', { name: `Aksi untuk ${hqName}` }), 'Ubah')

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: `Ubah User — ${hqName}` })).toBeVisible()
    await dialog.getByLabel('Nama Lengkap').fill(hqUpdatedName)
    await dialog.getByRole('button', { name: 'Simpan Perubahan' }).click()
    await expectToast(page, `Perubahan ${hqName} tersimpan`)
    await expect(dialog).toHaveCount(0)

    const hqList = await listSecurityUsers(adminToken)
    expect(hqList.find((user) => user.email === hqEmail)?.name).toBe(hqUpdatedName)

    // 2) Pengawas cabang lain tidak muncul di daftar admin (tak bisa diubah).
    await fillSearch(page, 'Cari pengawas', sambasEmail)
    await expect(tableRowWith(page, sambasEmail)).toHaveCount(0)
    await expect(page.getByRole('button', { name: `Aksi untuk ${sambasName}` })).toHaveCount(0)
    await expect(page.getByText('Tidak ada pengawas yang cocok')).toBeVisible()

    // 3) Perilaku nyata di API: admin lintas cabang ditolak 403.
    const forbidden = await apiFetchRaw(adminToken, 'PATCH', `/users/security/${sambasUser.id}`, {
      name: `${sambasName} Diubah`,
    })
    console.log(
      `[e2e-t8] admin PATCH pengawas Sambas -> HTTP ${forbidden.status} ${JSON.stringify(forbidden.body)}`,
    )
    expect(forbidden.status).toBe(403)

    // 4) Admin masih melihat pengawas cabangnya setelah pencarian diubah.
    await fillSearch(page, 'Cari pengawas', hqEmail)
    await expect(tableRowWith(page, hqEmail)).toHaveCount(1)
    await expect(tableRowWith(page, hqEmail)).toContainText(hqUpdatedName)
  } finally {
    await tracker.cleanup(h)
  }
})

test('@SEED akun seed tetap bisa login dengan peran & lokasi yang benar', async ({ h }) => {
  // Guard terakhir: memastikan tidak ada test back-office yang menyentuh seed.
  const seeds = [
    { role: 'super', email: 'superadmin@thc.net.id', apiRole: 'super_admin', location: null },
    { role: 'admin', email: 'admin1@thc.com', apiRole: 'admin', location: LOCATIONS.hq },
    { role: 'security', email: 'security1a@thc.com', apiRole: 'security', location: LOCATIONS.hq },
    { role: 'vendor', email: 'vendor1a@thc.com', apiRole: 'vendor', location: null },
  ] as const

  for (const seed of seeds) {
    const login = await loginViaApi(seed.email, PASSWORD)
    expect(login.user.email).toBe(seed.email)
    expect(login.user.role).toBe(seed.apiRole)
    expect(login.user.location_id).toBe(seed.location)
    // Token seed juga harus hidup untuk peran yang dipakai harness.
    expect(await h.tokenAs(seed.role)).not.toBe('')
  }
})
