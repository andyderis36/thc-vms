/**
 * Kontak anggota (No. HP saja) — ubah inline oleh pembuat via
 * `PATCH /visits/{id}/visitors/{visitorId}` beserta pill `(diubah)`.
 *
 * Kontrak yang dibaca sebelum menulis spec ini (bukan asumsi):
 * - `frontend/src/lib/api/client.ts` `updateVisitorContact` (+ `hooks.ts`
 *   `useUpdateVisitorContactMutation`): `PATCH` phone-only, respons
 *   `VisitorItem` membawa `phone_edited`.
 * - `frontend/src/app/visits/[id]/page.tsx` `VisitorContactRow`: tombol
 *   `Ubah kontak <nama>` hanya untuk `role==='vendor'` pembuat pada status
 *   `requested`/`rescheduled`; pill `(diubah)` dari flag server; form hanya
 *   menampilkan input Nomor HP.
 * - Pola buka-detail + guard heading mengikuti
 *   `e2e/specs/visit-lifecycle.spec.ts` (`openDetail`); pola akun temp
 *   mengikuti `e2e/specs/email-change.spec.ts` (register publik
 *   `POST /auth/register` -> aktivasi superadmin -> hapus + verifikasi 404,
 *   domain `@example.com` Mailpit-only).
 *
 * KESELAMATAN LIVE: hanya akun vendor temp `@example.com` yang dibuat dan
 * dihapus per-test (`trackedVendorIds` + hapus kunjungan via superadmin di
 * `finally`); tidak ada mutasi akun seed/prod. `test.skip` tidak dipakai —
 * spec ini aman live maupun lokal.
 */

import type { Browser, Page } from '@playwright/test'
import { expect, test, type Harness } from '../fixtures'
import {
  ACCOUNTS,
  DEFAULT_PASSWORD,
  FRONTEND_BASE,
  TOKEN_STORAGE_KEY,
  apiFetchRaw,
  approveVisitViaApi,
  createVisitViaApi,
  deleteVisitViaApi,
  getVisitViaApi,
  loginViaApi,
  loginViaApiCached,
  resolveLiveCatalog,
  uploadFileViaApi,
  type ApiEnvelope,
} from '../helpers/api'
import { pdfBuffer } from '../helpers/assets'
import { gotoApp } from '../helpers/nav'

function makeNik(): string {
  const time = String(Date.now()).slice(-9).padStart(9, '0')
  const rand = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')
  return `9${time}${rand}`
}

/** Email Mailpit-only: unik per test DAN per run, tidak pernah domain asli. */
function makeExampleEmail(h: Harness, label: string): string {
  return `${h.unique(label).toLowerCase()}@example.com`
}

/** Register + aktivasi vendor temp; id dicatat untuk cleanup `finally`. */
async function registerTempVendor(
  h: Harness,
  trackedIds: string[],
  label: string,
): Promise<{ id: string; email: string }> {
  const email = makeExampleEmail(h, label)
  const created = await apiFetchRaw<ApiEnvelope<{ id: string }>>('', 'POST', '/auth/register', {
    name: `E2E Memberct ${label}`,
    email,
    password: DEFAULT_PASSWORD,
    nik: makeNik(),
    phone: `0812${String(Date.now()).slice(-8)}`,
  })
  expect(created.status, `POST /auth/register ${email} -> HTTP ${created.status}`).toBe(201)
  if (created.body.success !== true) {
    throw new Error(`register ${email} gagal: ${JSON.stringify(created.body)}`)
  }
  const id = (created.body.data as { id: string }).id
  trackedIds.push(id)

  const superToken = (await loginViaApiCached(ACCOUNTS.super.email, ACCOUNTS.super.password)).token
  const activated = await apiFetchRaw(superToken, 'PATCH', `/users/${encodeURIComponent(id)}/status`, {
    status: 'active',
  })
  expect(activated.status, `aktivasi ${email} -> HTTP ${activated.status}`).toBe(200)
  return { id, email }
}

/** Login sebagai vendor temp (akun unik, tanpa cache proses). */
async function loginTempVendor(email: string): Promise<string> {
  return (await loginViaApi(email, DEFAULT_PASSWORD)).token
}

/** Hapus akun temp; DELETE ulang harus 404 (bukti bersih). */
async function deleteTempVendor(id: string): Promise<void> {
  const superToken = (await loginViaApiCached(ACCOUNTS.super.email, ACCOUNTS.super.password)).token
  const first = await apiFetchRaw(superToken, 'DELETE', `/users/${encodeURIComponent(id)}`)
  expect(first.status, `DELETE /users/${id} -> HTTP ${first.status}`).toBe(204)
  const second = await apiFetchRaw(superToken, 'DELETE', `/users/${encodeURIComponent(id)}`)
  expect(second.status, `DELETE ulang /users/${id} harus 404, dapat ${second.status}`).toBe(404)
}

/**
 * Buat kunjungan `requested` sebagai token pembuat (tanpa approval — status
 * awal sudah dalam gerbang ubah). Katalog di-resolve runtime agar aman live.
 */
async function createVisitAsCreator(
  token: string,
  marker: string,
): Promise<{ id: string; code: string }> {
  const catalog = await resolveLiveCatalog(token)
  const spk = await uploadFileViaApi(token, 'assignment_letter', {
    name: `spk-${marker}.pdf`,
    mimeType: 'application/pdf',
    buffer: pdfBuffer(8),
  })
  const now = Date.now()
  const payload: Record<string, unknown> = {
    location_id: catalog.hqId,
    start_date: new Date(now - 30 * 60_000).toISOString(),
    end_date: new Date(now + 180 * 60_000).toISOString(),
    is_nda_accepted: true,
    assignment_letter_url: spk.fileUrl,
    notes: marker,
    visitors: [
      {
        name: `${marker} Anggota 1`,
        id_number: `${String(now).slice(-13)}001`,
        phone: `0812${String(now).slice(-8)}`,
      },
    ],
  }
  if (catalog.purposeId !== null) {
    payload.purpose_ids = [catalog.purposeId]
  } else {
    payload.purpose_note = `E2E ${marker} purpose`.slice(0, 200)
  }
  const created = await createVisitViaApi(token, payload)
  if (created.visit_id === undefined) {
    throw new Error(`createVisit ${marker}: respons tidak memuat visit_id.`)
  }
  return { id: created.id, code: created.visit_id }
}

/** Buka frontend sebagai token arbitrer (cermin `h.openAs` untuk akun temp). */
async function openAsToken(browser: Browser, token: string): Promise<Page> {
  const context = await browser.newContext({
    baseURL: FRONTEND_BASE,
    storageState: {
      cookies: [],
      origins: [
        {
          origin: FRONTEND_BASE,
          localStorage: [{ name: TOKEN_STORAGE_KEY, value: token }],
        },
      ],
    },
  })
  return context.newPage()
}

/** Buka `/visits/{id}` lalu tunggu guard heading kode kunjungan (sesi lolos). */
async function openDetail(page: Page, visitId: string, code: string): Promise<void> {
  await gotoApp(page, `/visits/${visitId}`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText(code)
}

test('@VMCE-01 pembuat mengubah HP anggota via UI dan pill (diubah) muncul', async ({
  h,
  browser,
}) => {
  const trackedVendorIds: string[] = []
  let visitId = ''
  try {
    const vendor = await registerTempVendor(h, trackedVendorIds, 'vmce01')
    const token = await loginTempVendor(vendor.email)
    const visit = await createVisitAsCreator(token, h.unique('vmce01'))
    visitId = visit.id

    const page = await openAsToken(browser, token)
    try {
      await openDetail(page, visit.id, visit.code)
        await page.getByRole('button', { name: /Ubah kontak/ }).click()
        await expect(page.getByLabel('No. Identitas')).toHaveCount(0)
        const newPhone = `0813${String(Date.now()).slice(-8)}`
      await page.getByLabel('Nomor HP').fill(newPhone)
      await page.getByRole('button', { name: 'Simpan', exact: true }).click()
      await expect(page.getByText('Kontak anggota berhasil diperbarui.')).toBeVisible()
      await expect(page.getByText('(diubah)', { exact: true })).toBeVisible()

      const fetched = await getVisitViaApi(token, visit.id)
      expect(fetched.visitors?.[0]?.phone).toBe(newPhone)
    } finally {
      await page.context().close()
    }
  } finally {
    if (visitId !== '') {
      try {
        const superToken = await loginViaApiCached(ACCOUNTS.super.email, ACCOUNTS.super.password)
          .then((result) => result.token)
        await deleteVisitViaApi(superToken, visitId)
      } catch (error) {
        console.log(`[e2e-cleanup] DELETE visit ${visitId} dilewati: ${String(error)}`)
      }
    }
    for (const id of trackedVendorIds) {
      try {
        await deleteTempVendor(id)
      } catch (error) {
        console.log(`[e2e-cleanup] DELETE vendor ${id} dilewati: ${String(error)}`)
      }
    }
  }
})

test('@VMCE-02 vendor lain mendapat 404 dari API dan tidak melihat tombol Ubah', async ({
  h,
  browser,
}) => {
  const trackedVendorIds: string[] = []
  let visitId = ''
  try {
    const creator = await registerTempVendor(h, trackedVendorIds, 'vmce02a')
    const other = await registerTempVendor(h, trackedVendorIds, 'vmce02b')
    const creatorToken = await loginTempVendor(creator.email)
    const otherToken = await loginTempVendor(other.email)
    const visit = await createVisitAsCreator(creatorToken, h.unique('vmce02'))
    visitId = visit.id

    const fetched = await getVisitViaApi(creatorToken, visit.id)
    const visitorId = fetched.visitors?.[0]?.id
    if (visitorId === undefined || visitorId === '') {
      throw new Error('visit tanpa visitor id — backend tidak mengembalikan id baris.')
    }
    const denied = await apiFetchRaw(
      otherToken,
      'PATCH',
      `/visits/${visit.id}/visitors/${visitorId}`,
      { phone: '081299988877' },
    )
    expect(denied.status, `PATCH vendor lain harus 404, dapat ${denied.status}`).toBe(404)

    const page = await openAsToken(browser, otherToken)
    try {
      await gotoApp(page, `/visits/${visit.id}`)
      await expect(page.getByText('Kunjungan tidak ditemukan')).toBeVisible()
      await expect(page.getByRole('button', { name: /Ubah kontak/ })).toHaveCount(0)
    } finally {
      await page.context().close()
    }
  } finally {
    if (visitId !== '') {
      try {
        const superToken = await loginViaApiCached(ACCOUNTS.super.email, ACCOUNTS.super.password)
          .then((result) => result.token)
        await deleteVisitViaApi(superToken, visitId)
      } catch (error) {
        console.log(`[e2e-cleanup] DELETE visit ${visitId} dilewati: ${String(error)}`)
      }
    }
    for (const id of trackedVendorIds) {
      try {
        await deleteTempVendor(id)
      } catch (error) {
        console.log(`[e2e-cleanup] DELETE vendor ${id} dilewati: ${String(error)}`)
      }
    }
  }
})

test('@VMCE-03 kunjungan approved menolak koreksi kontak (API 400 + tanpa tombol Ubah)', async ({
  h,
  browser,
}) => {
  const trackedVendorIds: string[] = []
  let visitId = ''
  try {
    const vendor = await registerTempVendor(h, trackedVendorIds, 'vmce03')
    const token = await loginTempVendor(vendor.email)
    const visit = await createVisitAsCreator(token, h.unique('vmce03'))
    visitId = visit.id

    const superToken = (await loginViaApiCached(ACCOUNTS.super.email, ACCOUNTS.super.password)).token
    await approveVisitViaApi(superToken, visit.id)

    const fetched = await getVisitViaApi(token, visit.id)
    const visitorId = fetched.visitors?.[0]?.id
    if (visitorId === undefined || visitorId === '') {
      throw new Error('visit tanpa visitor id — backend tidak mengembalikan id baris.')
    }
    const denied = await apiFetchRaw(
      token,
      'PATCH',
      `/visits/${visit.id}/visitors/${visitorId}`,
      { phone: '081299988877' },
    )
    expect(denied.status, `PATCH approved harus 400, dapat ${denied.status}`).toBe(400)

    const page = await openAsToken(browser, token)
    try {
      await openDetail(page, visit.id, visit.code)
      await expect(page.getByRole('button', { name: /Ubah kontak/ })).toHaveCount(0)
    } finally {
      await page.context().close()
    }
  } finally {
    if (visitId !== '') {
      try {
        const superToken = await loginViaApiCached(ACCOUNTS.super.email, ACCOUNTS.super.password)
          .then((result) => result.token)
        await deleteVisitViaApi(superToken, visitId)
      } catch (error) {
        console.log(`[e2e-cleanup] DELETE visit ${visitId} dilewati: ${String(error)}`)
      }
    }
    for (const id of trackedVendorIds) {
      try {
        await deleteTempVendor(id)
      } catch (error) {
        console.log(`[e2e-cleanup] DELETE vendor ${id} dilewati: ${String(error)}`)
      }
    }
  }
})
