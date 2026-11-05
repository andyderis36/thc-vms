/**
 * Registrasi lalu approval mengaktifkan vendor (S2).
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
): Promise<{ id: string; email: string }> {
  const email = makeExampleEmail(h, label)
  const created = await apiFetchRaw<ApiEnvelope<{ id: string }>>('', 'POST', '/auth/register', {
    name: `E2E RegApprove ${label}`,
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
  return { id, email }
}

async function deleteTempVendor(id: string): Promise<void> {
  const superToken = (await loginViaApiCached(ACCOUNTS.super.email, ACCOUNTS.super.password)).token
  const first = await apiFetchRaw(superToken, 'DELETE', `/users/${encodeURIComponent(id)}`)
  if (first.status !== 204 && first.status !== 404) {
    throw new Error(`DELETE /users/${id} -> HTTP ${first.status}`)
  }
}

test('@REGAPPROVE-01 registrasi lalu approval mengaktifkan vendor', async ({ h }) => {
  const trackedVendorIds: string[] = []
  try {
    const vendor = await registerPendingVendor(h, trackedVendorIds, 'regapprove01')

    const superToken = (await loginViaApiCached(ACCOUNTS.super.email, ACCOUNTS.super.password)).token
    const approved = await apiFetchRaw(superToken, 'PATCH', `/users/${encodeURIComponent(vendor.id)}/status`, {
      status: 'active',
    })
    expect(approved.status, `approval -> HTTP ${approved.status}`).toBe(200)

    const login = await apiFetchRaw('', 'POST', '/auth/login', {
      email: vendor.email,
      password: DEFAULT_PASSWORD,
    })
    expect(login.status, `login vendor aktif -> HTTP ${login.status}`).toBe(200)
    if (!(login.body as { success?: boolean }).success) {
      throw new Error(`login vendor aktif gagal: ${JSON.stringify(login.body)}`)
    }
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
