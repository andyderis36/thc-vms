/**
 * E2E fasilitas & cabang (super_admin) — `/facilities` + kontrak `/locations`.
 *
 * Tag judul:
 * - @FAC-01 (ID baru) daftar + pencarian fasilitas seed.
 * - @FAC-02 (ID baru) tambah fasilitas non-pusat lewat UI, verifikasi API.
 * - @FAC-03 (ID baru) ubah nama/kota lewat UI, persist setelah reload.
 * - @FAC-04 (ID baru) nonaktifkan lalu aktifkan lewat menu aksi.
 * - @DEL-04 / @DEL-05 (dipakai ulang dari docs/6) hapus fasilitas ditolak 409
 *   selama direferensikan, lalu 204 setelah kunjungan referensi dihapus.
 * - @NAV-03 (dipakai ulang) admin dipulangkan dari /facilities.
 *
 * Catatan cakupan:
 * - `system-contract.spec.ts` @SYS-05 sudah menguji POST /locations = 403
 *   untuk admin/security/vendor; `auth-ui.spec.ts` @NAV-03 sudah menguji guard
 *   UI vendor/security untuk /facilities. Keduanya sengaja tidak diduplikasi.
 * - Semua fasilitas uji memakai nama unik; seed tidak pernah diubah/dihapus.
 * - Setiap fasilitas yang dibuat dicatat dan dihapus di `finally`; cleanup
 *   memverifikasi baris benar-benar hilang dan DELETE ulang menjawab 404.
 */

import type { Locator, Page } from '@playwright/test'
import { expect, test, type Harness } from '../fixtures'
import {
  LOCATIONS,
  apiFetch,
  apiFetchRaw,
  deleteVisitViaApi,
  type ApiEnvelope,
} from '../helpers/api'
import { gotoApp } from '../helpers/nav'

type FacilityType = 'pusat' | 'cabang' | 'pop' | 'minipop'
type FacilityTimezone = 'WIB' | 'WITA' | 'WIT'

interface FacilityRow {
  id: string
  name: string
  type: FacilityType
  address: string
  city: string
  timezone: FacilityTimezone
  is_active?: boolean
}

interface TrackedFacility {
  name: string
  id?: string
}

interface CreateFacilityInput {
  name: string
  type: FacilityType
  address?: string
  city?: string
  timezone?: FacilityTimezone
}

function expectData<T>(body: ApiEnvelope<T>, context: string): T {
  if (body.success !== true) {
    throw new Error(`[e2e-facilities] ${context}: ${body.error.code} - ${body.error.message}`)
  }
  return body.data
}

async function listFacilities(token: string): Promise<FacilityRow[]> {
  const result = await apiFetch<ApiEnvelope<FacilityRow[]>>(
    token,
    'GET',
    '/locations?active_only=false',
  )
  return expectData(result.body, 'GET /locations?active_only=false')
}

async function createFacility(
  token: string,
  input: CreateFacilityInput,
): Promise<FacilityRow> {
  const payload: Record<string, unknown> = {
    name: input.name,
    type: input.type,
    timezone: input.timezone ?? 'WIB',
  }
  if (input.address !== undefined) payload.address = input.address
  if (input.city !== undefined) payload.city = input.city

  const result = await apiFetch<ApiEnvelope<FacilityRow>>(
    token,
    'POST',
    '/locations',
    payload,
  )
  const created = expectData(result.body, 'POST /locations')
  console.log(`[e2e-facilities] create ${created.name} -> ${created.id}`)
  return created
}

async function deleteFacilityRaw(token: string, id: string): Promise<number> {
  const result = await apiFetchRaw(
    token,
    'DELETE',
    `/locations/${encodeURIComponent(id)}`,
  )
  return result.status
}

function makeFacilityTracker() {
  const items: TrackedFacility[] = []

  return {
    track(name: string): void {
      if (!items.some((item) => item.name === name)) {
        items.push({ name })
      }
    },
    remember(name: string, id: string): void {
      const tracked = items.find((item) => item.name === name)
      if (tracked === undefined) {
        items.push({ name, id })
        return
      }
      tracked.id = id
    },
    async cleanup(h: Harness): Promise<void> {
      if (items.length === 0) return

      const token = await h.tokenAs('super')
      for (const item of items) {
        let id = item.id
        if (id === undefined) {
          const rows = await listFacilities(token)
          id = rows.find((row) => row.name === item.name)?.id
        }

        if (id !== undefined) {
          const firstDelete = await deleteFacilityRaw(token, id)
          expect(
            [204, 404],
            `cleanup DELETE fasilitas ${item.name} (${id}) harus 204/404, dapat ${firstDelete}`,
          ).toContain(firstDelete)
        }

        const remaining = await listFacilities(token)
        const leftover = remaining.find(
          (row) => (id !== undefined && row.id === id) || row.name === item.name,
        )
        expect(
          leftover,
          `fasilitas ${item.name}${id !== undefined ? ` (${id})` : ''} harus benar-benar hilang`,
        ).toBeUndefined()

        if (id !== undefined) {
          const secondDelete = await deleteFacilityRaw(token, id)
          expect(
            secondDelete,
            `DELETE ulang fasilitas ${id} harus 404`,
          ).toBe(404)
        }
      }
    },
  }
}

function tableRowWith(page: Page, text: string): Locator {
  return page.locator('tbody tr').filter({ hasText: text })
}

/**
 * Buka menu aksi baris lalu pilih satu item. Klik pembuka diulang bila menu
 * hilang karena tabel selesai refetch tepat setelah menu dibuka.
 */
async function selectRowAction(
  page: Page,
  trigger: Locator,
  itemLabel: string,
): Promise<void> {
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

async function expectToast(page: Page, text: string | RegExp): Promise<void> {
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: text }).first(),
  ).toBeVisible()
}

async function openFacilities(h: Harness): Promise<Page> {
  const page = await h.openAs('super')
  await gotoApp(page, '/facilities')
  await expect(
    page.getByRole('heading', { name: 'Fasilitas & Cabang', exact: true }),
  ).toBeVisible()
  return page
}

async function searchFacilities(page: Page, term: string): Promise<void> {
  await page.getByLabel('Cari fasilitas').fill(term)
}

test('@FAC-01 super_admin melihat daftar fasilitas dan mencari fasilitas seed', async ({
  h,
}) => {
  const superToken = await h.tokenAs('super')
  const apiRows = await listFacilities(superToken)
  expect(apiRows.length).toBeGreaterThan(0)

  const seeded = apiRows.find((row) => row.id === LOCATIONS.hq) ?? apiRows[0]
  if (seeded === undefined) {
    throw new Error('[e2e-facilities] tidak ada fasilitas seed untuk diuji.')
  }

  const page = await openFacilities(h)
  await expect(
    page.getByRole('button', { name: 'Tambah Fasilitas', exact: true }),
  ).toBeVisible()

  await searchFacilities(page, seeded.name)
  const row = tableRowWith(page, seeded.name)
  await expect(row).toHaveCount(1)
  await expect(row).toContainText(seeded.name)
})

test('@FAC-02 super_admin menambah fasilitas non-pusat lewat modal dan API mengonfirmasi', async ({
  h,
}) => {
  const tracker = makeFacilityTracker()
  const name = `${h.unique('FAC02')} Fasilitas`
  tracker.track(name)

  try {
    const page = await openFacilities(h)
    await page.getByRole('button', { name: 'Tambah Fasilitas', exact: true }).click()

    const dialog = page.getByRole('dialog')
    await expect(
      dialog.getByRole('heading', { name: 'Tambah Fasilitas', exact: true }),
    ).toBeVisible()
    await dialog.getByLabel('Nama Fasilitas').fill(name)
    await dialog.getByLabel('Tipe Fasilitas').selectOption({ label: 'POP' })
    await dialog.getByLabel('Alamat').fill('Jl. E2E No. 1')
    await dialog.getByLabel('Kota').fill('Pontianak')
    await dialog
      .getByRole('button', { name: 'Tambah Fasilitas', exact: true })
      .click()

    await expectToast(page, `${name} berhasil ditambahkan`)
    await expect(dialog).toHaveCount(0)

    await searchFacilities(page, name)
    const row = tableRowWith(page, name)
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('POP')

    const superToken = await h.tokenAs('super')
    const apiRows = await listFacilities(superToken)
    const created = apiRows.find((entry) => entry.name === name)
    expect(created, `fasilitas ${name} harus ada lewat API`).toBeDefined()
    if (created === undefined) {
      throw new Error(`[e2e-facilities] fasilitas ${name} tidak ditemukan lewat API.`)
    }
    tracker.remember(name, created.id)

    expect(created.type).toBe('pop')
    expect(created.city).toBe('Pontianak')
    expect(created.is_active).not.toBe(false)
  } finally {
    await tracker.cleanup(h)
  }
})

test('@FAC-03 super_admin mengubah nama dan kota fasilitas lewat modal Ubah; persist setelah reload', async ({
  h,
}) => {
  const tracker = makeFacilityTracker()
  const originalName = `${h.unique('FAC03')} Fasilitas`
  const updatedName = `${h.unique('FAC03BARU')} Fasilitas`

  try {
    const superToken = await h.tokenAs('super')
    const created = await createFacility(superToken, {
      name: originalName,
      type: 'cabang',
      address: 'Jl. E2E No. 3',
      city: 'Sambas',
    })
    tracker.remember(originalName, created.id)

    const page = await openFacilities(h)
    await searchFacilities(page, originalName)
    const row = tableRowWith(page, originalName)
    await expect(row).toHaveCount(1)

    await selectRowAction(
      page,
      row.getByRole('button', { name: `Aksi untuk ${originalName}` }),
      'Ubah',
    )

    const dialog = page.getByRole('dialog')
    await expect(
      dialog.getByRole('heading', { name: `Ubah ${originalName}`, exact: true }),
    ).toBeVisible()
    await dialog.getByLabel('Nama Fasilitas').fill(updatedName)
    await dialog.getByLabel('Kota').fill('Singkawang')
    await dialog.getByRole('button', { name: 'Simpan Perubahan' }).click()

    await expectToast(page, `${updatedName} berhasil diperbarui`)
    await expect(dialog).toHaveCount(0)

    await page.reload()
    await expect(
      page.getByRole('heading', { name: 'Fasilitas & Cabang', exact: true }),
    ).toBeVisible()

    await searchFacilities(page, originalName)
    await expect(tableRowWith(page, originalName)).toHaveCount(0)
    await expect(
      page.getByText('Tidak ada fasilitas yang cocok', { exact: true }),
    ).toBeVisible()

    await searchFacilities(page, updatedName)
    const updatedRow = tableRowWith(page, updatedName)
    await expect(updatedRow).toHaveCount(1)
    await expect(updatedRow).toContainText('Singkawang')

    const apiRows = await listFacilities(superToken)
    const updated = apiRows.find((entry) => entry.id === created.id)
    expect(updated?.name).toBe(updatedName)
    expect(updated?.city).toBe('Singkawang')
  } finally {
    await tracker.cleanup(h)
  }
})

test('@FAC-04 super_admin menonaktifkan lalu mengaktifkan fasilitas lewat menu aksi', async ({
  h,
}) => {
  const tracker = makeFacilityTracker()
  const name = `${h.unique('FAC04')} Fasilitas`

  try {
    const superToken = await h.tokenAs('super')
    const created = await createFacility(superToken, {
      name,
      type: 'minipop',
      address: 'Jl. E2E No. 4',
      city: 'Mempawah',
    })
    tracker.remember(name, created.id)

    const page = await openFacilities(h)
    await searchFacilities(page, name)
    const row = tableRowWith(page, name)
    await expect(row).toHaveCount(1)
    await expect(row.getByText('Aktif', { exact: true })).toBeVisible()

    await selectRowAction(
      page,
      row.getByRole('button', { name: `Aksi untuk ${name}` }),
      'Nonaktifkan',
    )
    await expectToast(page, `${name} dinonaktifkan`)
    await expect(row.getByText('Nonaktif', { exact: true })).toBeVisible()

    let apiRows = await listFacilities(superToken)
    let current = apiRows.find((entry) => entry.id === created.id)
    expect(current?.is_active).toBe(false)

    await page.reload()
    await expect(
      page.getByRole('heading', { name: 'Fasilitas & Cabang', exact: true }),
    ).toBeVisible()
    await searchFacilities(page, name)
    const reloadedRow = tableRowWith(page, name)
    await expect(reloadedRow).toHaveCount(1)
    await expect(
      reloadedRow.getByText('Nonaktif', { exact: true }),
    ).toBeVisible()

    await selectRowAction(
      page,
      reloadedRow.getByRole('button', { name: `Aksi untuk ${name}` }),
      'Aktifkan',
    )
    await expectToast(page, `${name} diaktifkan`)
    await expect(reloadedRow.getByText('Aktif', { exact: true })).toBeVisible()

    apiRows = await listFacilities(superToken)
    current = apiRows.find((entry) => entry.id === created.id)
    expect(current?.is_active).not.toBe(false)
  } finally {
    await tracker.cleanup(h)
  }
})

test('@DEL-04 @DEL-05 hapus fasilitas ditolak 409 saat direferensikan, lalu 204 setelah kunjungan dihapus', async ({
  h,
}) => {
  const tracker = makeFacilityTracker()
  const name = `${h.unique('DEL04')} Fasilitas`
  let visitId: string | undefined

  try {
    const superToken = await h.tokenAs('super')
    const created = await createFacility(superToken, {
      name,
      type: 'pop',
      address: 'Jl. E2E No. 5',
      city: 'Aruk',
    })
    tracker.remember(name, created.id)

    const visit = await h.createVisit('DEL04', {
      locationId: created.id,
      withFiles: false,
      approve: false,
    })
    visitId = visit.id

    const page = await openFacilities(h)
    await searchFacilities(page, name)
    const row = tableRowWith(page, name)
    await expect(row).toHaveCount(1)

    await selectRowAction(
      page,
      row.getByRole('button', { name: `Aksi untuk ${name}` }),
      'Hapus',
    )

    const dialog = page.getByRole('dialog')
    await expect(
      dialog.getByRole('heading', { name: `Hapus ${name}`, exact: true }),
    ).toBeVisible()
    await expect(dialog).toContainText(
      `Hapus permanen fasilitas "${name}"?`,
    )
    await dialog.getByRole('button', { name: 'Hapus Permanen' }).click()

    await expectToast(page, /Fasilitas masih memiliki 1 kunjungan/)
    await expect(dialog).toBeVisible()

    const blocked = await apiFetchRaw<ApiEnvelope<unknown>>(
      superToken,
      'DELETE',
      `/locations/${encodeURIComponent(created.id)}`,
    )
    expect(blocked.status).toBe(409)
    if (blocked.body.success) {
      throw new Error('[e2e-facilities] DELETE lokasi seharusnya ditolak 409.')
    }
    expect(blocked.body.error.code).toBe('CONFLICT')
    expect(blocked.body.error.message).toContain('1 kunjungan')

    const stillThere = await listFacilities(superToken)
    expect(stillThere.some((entry) => entry.id === created.id)).toBe(true)

    await deleteVisitViaApi(superToken, visit.id)
    const verifyVisit = await apiFetchRaw(
      superToken,
      'GET',
      `/visits/${encodeURIComponent(visit.id)}`,
    )
    expect(verifyVisit.status).toBe(404)

    await dialog.getByRole('button', { name: 'Hapus Permanen' }).click()
    await expectToast(page, `${name} dihapus permanen`)
    await expect(dialog).toHaveCount(0)
    await expect(row).toHaveCount(0)

    const after = await listFacilities(superToken)
    expect(after.some((entry) => entry.id === created.id)).toBe(false)

    const secondDelete = await apiFetchRaw(
      superToken,
      'DELETE',
      `/locations/${encodeURIComponent(created.id)}`,
    )
    expect(secondDelete.status).toBe(404)
    visitId = undefined
  } finally {
    const superToken = await h.tokenAs('super')
    if (visitId !== undefined) {
      const firstDelete = await apiFetchRaw(
        superToken,
        'DELETE',
        `/visits/${encodeURIComponent(visitId)}`,
      )
      expect(
        [204, 404],
        `cleanup DELETE kunjungan ${visitId} harus 204/404, dapat ${firstDelete.status}`,
      ).toContain(firstDelete.status)

      const verifyVisit = await apiFetchRaw(
        superToken,
        'GET',
        `/visits/${encodeURIComponent(visitId)}`,
      )
      expect(verifyVisit.status).toBe(404)
    }

    await tracker.cleanup(h)
  }
})

test('@NAV-03 admin dipulangkan dari /facilities ke /dashboard tanpa kontrol tambah', async ({
  h,
}) => {
  const page = await h.openAs('admin')
  await gotoApp(page, '/facilities')

  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(
    page.getByRole('heading', { name: 'Dashboard Kunjungan', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Fasilitas & Cabang', exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Tambah Fasilitas', exact: true }),
  ).toHaveCount(0)
})
