/**
 * Manajemen user superadmin — halaman `/coordinators`.
 *
 * `/users` TIDAK ada (route 404, dikunci @NAV-06 di `backoffice.spec.ts`).
 * UI pengelolaan akun internal yang benar-benar berjalan adalah
 * `/coordinators` (admin + super_admin) dan `/vendor-registrations` (vendor).
 *
 * Tag baru:
 * - @USR-01 pencarian email menyaring baris + Reset Filter memulihkan daftar.
 * - @USR-02 create admin lewat UI, baris muncul, DELETE API, lalu GET/search
 *   kosong dan DELETE kedua 404.
 * - @USR-03 filter Cabang hanya menampilkan koordinator cabang terpilih.
 * - @USR-04 filter peran Koordinator Wilayah menyembunyikan Superadmin dan
 *   mempertahankan tombol tambah.
 *
 * Sudah dicakup spec lain (SENGAJA tidak diulang):
 * - @NAV-06: `/users` 404 + filter Superadmin menyembunyikan tombol tambah.
 * - @DEL-04 / @DEL-06 (`rbac-api.spec.ts`): tolak hapus user yang masih punya
 *   kunjungan dan tolak hapus akun sendiri.
 * - @AUTH-07, @DEL-01 (`backoffice.spec.ts`): create/delete pengawas security.
 *
 * Semua user uji memakai email unik `h.unique`; cleanup di `finally` melakukan
 * list -> DELETE -> list kosong. Akun seed tidak disentuh.
 */

import type { Page } from '@playwright/test'
import { expect, test, type Harness } from '../fixtures'
import { LOCATIONS, apiFetch, apiFetchRaw, isLiveRun, type ApiEnvelope } from '../helpers/api'
import { gotoApp } from '../helpers/nav'

const PASSWORD = 'Password123!'

interface ManagedUserRow {
  id: string
  name: string
  email: string
  role: string
  location_id: string | null
}

function uniqueEmail(h: Harness, label: string): string {
  return `${h.unique(label).toLowerCase()}@transhybrid.net.id`
}

function uniqueNik(): string {
  return `3200${String(Date.now()).slice(-12)}`
}

function tableRowWith(page: Page, text: string) {
  return page.locator('tbody tr').filter({ hasText: text })
}

async function runtimeBranchId(h: Harness): Promise<string> {
  const token = await h.tokenAs('super')
  const rows = expectData(
    (await apiFetch<ApiEnvelope<Array<{ id: string; name: string }>>>(
      token,
      'GET',
      '/locations',
    )).body,
    'GET /locations',
  )
  const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name))
  const picked =
    sorted.find((row) => row.name.toLowerCase().includes('pusat')) ?? sorted[0]
  if (picked === undefined) {
    throw new Error('[users] katalog lokasi runtime kosong.')
  }
  return picked.id
}

function expectData<T>(body: ApiEnvelope<T>, context: string): T {
  if (body.success !== true) {
    throw new Error(`[users] ${context}: ${body.error.code} — ${body.error.message}`)
  }
  return body.data
}

async function listUsers(token: string, search?: string): Promise<ManagedUserRow[]> {
  const path = search === undefined ? '/users' : `/users?search=${encodeURIComponent(search)}`
  const result = await apiFetch<ApiEnvelope<ManagedUserRow[]>>(token, 'GET', path)
  return expectData(result.body, path)
}

async function findUser(token: string, email: string): Promise<ManagedUserRow | undefined> {
  const rows = await listUsers(token, email)
  return rows.find((row) => row.email.trim().toLowerCase() === email.toLowerCase())
}

/** Cleanup idempoten: hapus sisa user uji bila ada, lalu buktikan sudah hilang. */
async function removeUserIfPresent(h: Harness, email: string): Promise<void> {
  const token = await h.tokenAs('super')
  const existing = await findUser(token, email)
  if (existing !== undefined) {
    const result = await apiFetchRaw(token, 'DELETE', `/users/${existing.id}`)
    if (result.status !== 204 && result.status !== 404) {
      throw new Error(`[users cleanup] DELETE ${email} -> HTTP ${result.status}`)
    }
  }
  const leftover = await findUser(token, email)
  if (leftover !== undefined) {
    throw new Error(`[users cleanup] user ${email} masih ada (${leftover.id})`)
  }
}

/** Isi pencarian dan tunggu request GET /users dengan `search` yang sama. */
async function fillSearch(page: Page, term: string): Promise<void> {
  const settled = page
    .waitForResponse(
      (response) => {
        if (response.request().method() !== 'GET') return false
        const url = new URL(response.url())
        return url.pathname.endsWith('/users') && url.searchParams.get('search') === term
      },
      { timeout: 20_000 },
    )
    .catch(() => null)
  await page.getByLabel('Cari user').fill(term)
  await settled
}

async function expectToast(page: Page, text: string): Promise<void> {
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: text }).first(),
  ).toBeVisible()
}

test('@USR-01 pencarian email di /coordinators menyaring baris dan Reset Filter memulihkan', async ({
  h,
}) => {
  test.skip(
    isLiveRun(),
    'live: email seed admin1/admin2 tidak ada di prod (dataset seed-only).',
  )
  const page = await h.openAs('super')
  await gotoApp(page, '/coordinators')

  await expect(
    page.getByRole('heading', { name: 'Koordinator Wilayah & Superadmin', exact: true }),
  ).toBeVisible()
  await expect(tableRowWith(page, 'admin1@transhybrid.net.id')).toHaveCount(1)
  await expect(tableRowWith(page, 'admin2@transhybrid.net.id')).toHaveCount(1)

  await fillSearch(page, 'admin1@transhybrid.net.id')
  await expect(tableRowWith(page, 'admin1@transhybrid.net.id')).toHaveCount(1)
  await expect(tableRowWith(page, 'admin2@transhybrid.net.id')).toHaveCount(0)

  await fillSearch(page, h.unique('tidak-ada'))
  await expect(page.getByText('Tidak ada user yang cocok', { exact: true })).toBeVisible()
  await expect(page.locator('tbody tr')).toHaveCount(0)

  await page.getByRole('button', { name: 'Reset Filter', exact: true }).click()
  await expect(page.getByLabel('Cari user')).toHaveValue('')
  await expect(tableRowWith(page, 'admin1@transhybrid.net.id')).toHaveCount(1)
  await expect(tableRowWith(page, 'admin2@transhybrid.net.id')).toHaveCount(1)
})

test('@USR-02 superadmin membuat koordinator lewat UI lalu API menghapusnya dan 404', async ({
  h,
}) => {
  const email = uniqueEmail(h, 'usr02')
  const name = `${h.unique('Koordinator')} Uji`
  try {
    const branchId = await runtimeBranchId(h)
    const page = await h.openAs('super')
    await gotoApp(page, '/coordinators')
    await expect(
      page.getByRole('heading', { name: 'Koordinator Wilayah & Superadmin', exact: true }),
    ).toBeVisible()

    await page
      .getByRole('button', { name: 'Tambah Koordinator Wilayah', exact: true })
      .click()
    const dialog = page.getByRole('dialog')
    await expect(
      dialog.getByRole('heading', { name: 'Tambah Koordinator Wilayah', exact: true }),
    ).toBeVisible()

    await dialog.getByLabel('Nama Lengkap').fill(name)
    await dialog.getByLabel('Email').fill(email)
    await dialog.getByRole('textbox', { name: 'Kata Sandi' }).fill(PASSWORD)
    await dialog.getByLabel('NIK').fill(uniqueNik())
    await dialog.getByLabel('Cabang Penugasan').selectOption(branchId)
    await dialog
      .getByRole('button', { name: 'Tambah Koordinator Wilayah', exact: true })
      .click()

    await expectToast(page, `${name} berhasil ditambahkan`)
    await expect(dialog).toHaveCount(0)

    await fillSearch(page, email)
    const row = tableRowWith(page, email)
    await expect(row).toHaveCount(1)
    await expect(row).toContainText(name)

    const token = await h.tokenAs('super')
    const created = await findUser(token, email)
    expect(created).toBeDefined()
    if (created === undefined) {
      throw new Error(`[USR-02] user ${email} tidak ditemukan lewat API setelah dibuat via UI.`)
    }
    expect(created.role).toBe('admin')
    expect(created.location_id).toBe(branchId)

    const firstDelete = await apiFetchRaw(token, 'DELETE', `/users/${created.id}`)
    expect(firstDelete.status).toBe(204)
    expect(await findUser(token, email)).toBeUndefined()

    const secondDelete = await apiFetchRaw(token, 'DELETE', `/users/${created.id}`)
    expect(secondDelete.status).toBe(404)
  } finally {
    await removeUserIfPresent(h, email)
  }
})

test('@USR-03 filter Cabang hanya menampilkan koordinator cabang terpilih', async ({ h }) => {
  test.skip(
    isLiveRun(),
    'live: baris seed admin1/admin2/superadmin tidak ada di prod (dataset seed-only).',
  )
  const page = await h.openAs('super')
  await gotoApp(page, '/coordinators')
  await expect(tableRowWith(page, 'admin1@transhybrid.net.id')).toHaveCount(1)

  // Tombol aksi baris berlabel "… (Admin Cabang …)" juga cocok dengan "Cabang".
  await page.getByLabel('Cabang', { exact: true }).selectOption(LOCATIONS.hq)
  await expect(tableRowWith(page, 'admin1@transhybrid.net.id')).toHaveCount(1)
  await expect(tableRowWith(page, 'admin2@transhybrid.net.id')).toHaveCount(0)
  await expect(tableRowWith(page, 'superadmin@transhybrid.net.id')).toHaveCount(0)

  await page.getByRole('button', { name: 'Reset Filter', exact: true }).click()
  await expect(tableRowWith(page, 'admin2@transhybrid.net.id')).toHaveCount(1)
  await expect(tableRowWith(page, 'superadmin@transhybrid.net.id')).toHaveCount(1)
})

test('@USR-04 filter peran Koordinator Wilayah menyembunyikan Superadmin dan mempertahankan tombol tambah', async ({
  h,
}) => {
  test.skip(
    isLiveRun(),
    'live: baris seed admin1/admin2/superadmin tidak ada di prod (dataset seed-only).',
  )
  const page = await h.openAs('super')
  await gotoApp(page, '/coordinators')
  await expect(tableRowWith(page, 'superadmin@transhybrid.net.id')).toHaveCount(1)

  await page
    .locator('thead select[aria-label="Filter peran"]')
    .selectOption({ label: 'Koordinator Wilayah' })

  await expect(tableRowWith(page, 'admin1@transhybrid.net.id')).toHaveCount(1)
  await expect(tableRowWith(page, 'admin2@transhybrid.net.id')).toHaveCount(1)
  await expect(tableRowWith(page, 'superadmin@transhybrid.net.id')).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Tambah Koordinator Wilayah', exact: true }),
  ).toBeVisible()

  await page
    .locator('thead select[aria-label="Filter peran"]')
    .selectOption({ label: 'Semua Peran' })
  await expect(tableRowWith(page, 'superadmin@transhybrid.net.id')).toHaveCount(1)
})
