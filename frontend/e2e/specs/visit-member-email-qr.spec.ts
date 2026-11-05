/**
 * Buat kunjungan dengan email anggota: baris Email tampil + kunjungan
 * disetujui menampilkan kartu QR (S3).
 *
 * Live-safe: hanya akun vendor temp @example.com yang dibuat dan dihapus
 * per-test; katalog di-resolve runtime; kunjungan dibersihkan di finally.
 */

import type { Browser, Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import {
  ACCOUNTS,
  DEFAULT_PASSWORD,
  FRONTEND_BASE,
  TOKEN_STORAGE_KEY,
  apiFetchRaw,
  approveVisitViaApi,
  createVisitViaApi,
  deleteVisitViaApi,
  loginViaApi,
  loginViaApiCached,
  resolveLiveCatalog,
  uploadFileViaApi,
  type ApiEnvelope,
} from '../helpers/api'
import { gotoApp } from '../helpers/nav'
import { pdfBuffer } from '../helpers/assets'

function makeNik(): string {
  const time = String(Date.now()).slice(-9).padStart(9, '0')
  const rand = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')
  return `9${time}${rand}`
}

function makeExampleEmail(h: { unique: (label: string) => string }, label: string): string {
  return `${h.unique(label).toLowerCase()}@example.com`
}

async function registerTempVendor(
  h: { unique: (label: string) => string },
  trackedIds: string[],
  label: string,
): Promise<{ id: string; email: string }> {
  const email = makeExampleEmail(h, label)
  const created = await apiFetchRaw<ApiEnvelope<{ id: string }>>('', 'POST', '/auth/register', {
    name: `E2E MemberEmail ${label}`,
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

async function deleteTempVendor(id: string): Promise<void> {
  const superToken = (await loginViaApiCached(ACCOUNTS.super.email, ACCOUNTS.super.password)).token
  const first = await apiFetchRaw(superToken, 'DELETE', `/users/${encodeURIComponent(id)}`)
  if (first.status !== 204 && first.status !== 404) {
    throw new Error(`DELETE /users/${id} -> HTTP ${first.status}`)
  }
}

async function createVisitWithMemberEmail(
  token: string,
  marker: string,
  memberEmail: string,
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
        email: memberEmail,
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

test('@MEMEMAILQR-01 kunjungan dengan email anggota menampilkan baris Email dan kartu QR setelah disetujui', async ({
  h,
  browser,
}) => {
  const trackedVendorIds: string[] = []
  let visitId = ''
  try {
    const vendor = await registerTempVendor(h, trackedVendorIds, 'mememailqr01')
    const loginResult = await loginViaApi(vendor.email, DEFAULT_PASSWORD)
    const token = loginResult.token
    const memberEmail = `teknisi-${Date.now()}@example.com`
    const visit = await createVisitWithMemberEmail(token, h.unique('mememailqr01'), memberEmail)
    visitId = visit.id

    const superToken = (await loginViaApiCached(ACCOUNTS.super.email, ACCOUNTS.super.password)).token
    await approveVisitViaApi(superToken, visit.id)

    const page = await openAsToken(browser, token)
    try {
      await gotoApp(page, `/visits/${visit.id}`)
      await expect(page.getByRole('heading', { level: 1 })).toContainText(visit.code)

      await expect(page.getByText(/Email:/)).toContainText(memberEmail)
      await expect(page.getByText('Pas Masuk QR Code')).toBeVisible()
      await expect(page.getByText('QR Code terbit setelah izin disetujui')).toHaveCount(0)
    } finally {
      await page.context().close()
    }
  } finally {
    if (visitId !== '') {
      try {
        const superToken = (await loginViaApiCached(ACCOUNTS.super.email, ACCOUNTS.super.password)).token
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
