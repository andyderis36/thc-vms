/**
 * Smoke test pembuktian harness.
 *
 * Tidak memakai project storageState per peran: setiap test memanggil
 * `h.openAs(role)` agar benar-benar menguji token per peran dari nol.
 */

import { expect, test } from '../fixtures'
import { getVisitViaApi, LOCATIONS, type Role } from '../helpers/api'
import { gotoApp } from '../helpers/nav'

const ROLES: readonly Role[] = [
  'super',
  'admin',
  'admin-sambas',
  'security',
  'security-sambas',
  'vendor',
]

for (const role of ROLES) {
  test(`@SMOKE ${role} diarahkan ke halaman awal sesuai peran`, async ({ h }) => {
    const page = await h.openAs(role)
    await gotoApp(page, '/')

    if (role === 'security' || role === 'security-sambas') {
      await expect(page).toHaveURL(/\/gate$/)
      await expect(page.getByRole('tab', { name: 'Kamera', exact: true })).toBeVisible()
      await expect(page.getByRole('tab', { name: 'Input Manual', exact: true })).toBeVisible()
      return
    }

    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(
      page.getByRole('heading', { name: 'Dashboard Kunjungan', exact: true }),
    ).toBeVisible()
  })
}

test('@SMOKE createVisit menghasilkan kunjungan approved yang bisa dibaca ulang', async ({
  h,
}) => {
  const created = await h.createVisit('smoke')

  expect(created.status).toBe('approved')
  expect(created.code).toMatch(/^VST-/)
  expect(created.locationId).toBe(LOCATIONS.hq)

  const fetched = await getVisitViaApi(await h.tokenAs('super'), created.id)
  expect(fetched.id).toBe(created.id)
  expect(fetched.visit_id).toBe(created.code)
  expect(fetched.status).toBe('approved')
  expect(fetched.location_id).toBe(LOCATIONS.hq)
})
