/**
 * Lonceng superadmin menampilkan pendaftaran vendor menunggu (S1).
 *
 * Live-safe: hanya akun vendor temp @example.com yang dibuat dan dihapus
 * per-test; tidak ada mutasi akun seed/prod.
 */

import { expect, test } from '../fixtures'
import {
  ACCOUNTS,
  DEFAULT_PASSWORD,
  apiFetchRaw,
  loginViaApiCached,
  type ApiEnvelope,
} from '../helpers/api'
import { gotoApp } from '../helpers/nav'

function makeNik(): string {
  const time = String(Date.now()).slice(-9).padStart(9, '0')
  const rand = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')
  return `9${time}${rand}`
}

function makeExampleEmail(h: { unique: (label: string) => string }, label: string): string {
  return `${h.unique(label).toLowerCase()}@example.com`
}

async function registerPendingVendor(
  h: { unique: (label: string) => string },
  trackedIds: string[],
  label: string,
): Promise<{ id: string; email: string; name: string }> {
  const email = makeExampleEmail(h, label)
  const name = `E2E BellPending ${label}`
  const created = await apiFetchRaw<ApiEnvelope<{ id: string }>>('', 'POST', '/auth/register', {
    name,
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
  return { id, email, name }
}

async function deleteTempVendor(id: string): Promise<void> {
  const superToken = (await loginViaApiCached(ACCOUNTS.super.email, ACCOUNTS.super.password)).token
  const first = await apiFetchRaw(superToken, 'DELETE', `/users/${encodeURIComponent(id)}`)
  if (first.status !== 204 && first.status !== 404) {
    throw new Error(`DELETE /users/${id} -> HTTP ${first.status}`)
  }
}

test('@BELLREG-01 lonceng superadmin menampilkan pendaftaran vendor menunggu', async ({
  h,
}) => {
  const trackedVendorIds: string[] = []
  try {
    const vendor = await registerPendingVendor(h, trackedVendorIds, 'bellreg01')

    const page = await h.openAs('super')
    await gotoApp(page, '/')

    const trigger = page.getByRole('button', { name: /^Notifikasi/ })
    await expect(trigger).toBeVisible()
    await trigger.click()
    await expect(page.getByRole('menu')).toBeVisible()

    await expect(page.getByTestId('pending-registrations-section')).toBeVisible()
    await expect(page.getByText(vendor.name)).toBeVisible()
  } finally {
    for (const id of trackedVendorIds) {
      try {
        await deleteTempVendor(id)
      } catch (error) {
        console.log(`[e2e-cleanup] DELETE vendor ${id} dilewati: ${String(error)}`)
      }
    }
  }
})
