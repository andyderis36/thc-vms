/**
 * E2E jejak audit (super_admin) — halaman `/audit` + kontrak `GET /audit-logs`.
 *
 * Tag judul:
 * - @AUD-01 (ID baru) filter tanggal menyaring daftar lalu Reset Filter memulihkan.
 * - @AUD-02 (ID baru) hapus kunjungan lewat API menghasilkan `visit.delete`
 *   yang terlihat di tabel dan modal detail.
 * - @AUD-03 (ID baru) GET /audit-logs menolak admin/security/vendor dengan 403.
 * - @NAV-03 (dipakai ulang dari docs/6) admin dipulangkan dari /audit.
 *
 * Catatan cakupan:
 * - Guard UI vendor/security untuk /audit sudah diuji `auth-ui.spec.ts`
 *   (@NAV-03), jadi tidak diduplikasi di sini.
 * - Satu-satunya mutasi adalah membuat lalu menghapus satu kunjungan. `finally`
 *   menghapus ulang (204/404) dan memverifikasi GET 404. Baris audit bersifat
 *   append-only (tidak ada API hapus), jadi residu audit dibiarkan.
 */

import { expect, test } from '../fixtures'
import {
  apiFetch,
  apiFetchRaw,
  deleteVisitViaApi,
  type ApiEnvelope,
  type Role,
} from '../helpers/api'
import { gotoApp } from '../helpers/nav'

interface AuditRow {
  id: string
  user_id: string | null
  action: string
  entity: string
  entity_id: string | null
  timestamp: string
  ip: string
  user_agent: string
  metadata: Record<string, string>
}

interface AuditPage {
  items: AuditRow[]
  total: number
  page: number
  limit: number
}

function expectData<T>(body: ApiEnvelope<T>, context: string): T {
  if (body.success !== true) {
    throw new Error(`[e2e-audit] ${context}: ${body.error.code} - ${body.error.message}`)
  }
  return body.data
}

async function listAuditLogs(token: string, params: URLSearchParams): Promise<AuditPage> {
  const search = params.toString()
  const path = search === '' ? '/audit-logs' : `/audit-logs?${search}`
  const result = await apiFetch<ApiEnvelope<AuditPage>>(token, 'GET', path)
  return expectData(result.body, `GET ${path}`)
}

test('@AUD-01 super_admin melihat jejak audit; filter tanggal menyaring lalu Reset Filter memulihkan', async ({
  h,
}) => {
  const page = await h.openAs('super')
  await gotoApp(page, '/audit')

  await expect(
    page.getByRole('heading', { name: 'Jejak Audit', exact: true }),
  ).toBeVisible()

  const rows = page.locator('tbody tr')
  await expect(rows.first()).toBeVisible()

  // Tanggal jauh di masa depan dijamin tidak memiliki baris, tanpa bergantung
  // pada zona waktu server saat suite berjalan pagi hari.
  await page.getByLabel('Dari Tanggal').fill('2099-01-01')
  await expect(
    page.getByText('Tidak ada jejak audit yang cocok', { exact: true }),
  ).toBeVisible()

  await page
    .getByTestId('audit-filter-reset')
    .getByRole('button', { name: 'Reset Filter', exact: true })
    .click()
  await expect(rows.first()).toBeVisible()
  await expect(
    page.getByText('Tidak ada jejak audit yang cocok', { exact: true }),
  ).toHaveCount(0)
})

test('@AUD-02 hapus kunjungan lewat API menghasilkan baris visit.delete di tabel dan modal detail', async ({
  h,
}) => {
  const superToken = await h.tokenAs('super')
  const visit = await h.createVisit('AUD02', {
    withFiles: false,
    approve: false,
  })

  try {
    await deleteVisitViaApi(superToken, visit.id)

    const pageData = await listAuditLogs(
      superToken,
      new URLSearchParams({ action: 'visit.delete', page: '1', limit: '50' }),
    )
    const auditRow = pageData.items.find(
      (item) => item.action === 'visit.delete' && item.entity_id === visit.id,
    )
    expect(auditRow, `baris visit.delete untuk ${visit.id} harus ada`).toBeDefined()
    if (auditRow === undefined) {
      throw new Error(`[e2e-audit] visit.delete ${visit.id} tidak ditemukan lewat API.`)
    }
    expect(auditRow.entity).toBe('visit')
    expect(auditRow.metadata['visit_code']).toBe(visit.code)

    const page = await h.openAs('super')
    await gotoApp(page, '/audit')
    await expect(
      page.getByRole('heading', { name: 'Jejak Audit', exact: true }),
    ).toBeVisible()

    await page.getByLabel('Aksi').selectOption({ value: 'visit.delete' })

    const row = page.locator('tbody tr').filter({ hasText: visit.code })
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('Hapus kunjungan')

    await row.click()
    const dialog = page.getByRole('dialog')
    await expect(
      dialog.getByRole('heading', {
        name: 'Detail Jejak Audit — Hapus kunjungan',
        exact: true,
      }),
    ).toBeVisible()
    await expect(dialog.getByText(visit.id, { exact: true })).toBeVisible()
    await expect(dialog.getByText(visit.code, { exact: true })).toBeVisible()

    await dialog
      .locator('footer')
      .getByRole('button', { name: 'Tutup', exact: true })
      .click()
    await expect(dialog).toHaveCount(0)
  } finally {
    const cleanupToken = await h.tokenAs('super')
    const firstDelete = await apiFetchRaw(
      cleanupToken,
      'DELETE',
      `/visits/${encodeURIComponent(visit.id)}`,
    )
    expect(
      [204, 404],
      `cleanup DELETE kunjungan ${visit.id} harus 204/404, dapat ${firstDelete.status}`,
    ).toContain(firstDelete.status)

    const verify = await apiFetchRaw(
      cleanupToken,
      'GET',
      `/visits/${encodeURIComponent(visit.id)}`,
    )
    expect(verify.status, `kunjungan ${visit.id} harus benar-benar hilang`).toBe(404)
  }
})

test('@AUD-03 GET /audit-logs menolak admin, security, dan vendor; super_admin mendapat 200', async ({
  h,
}) => {
  const forbiddenRoles: readonly Role[] = ['admin', 'security', 'vendor']

  for (const role of forbiddenRoles) {
    const token = await h.tokenAs(role)
    const result = await apiFetchRaw<ApiEnvelope<AuditPage>>(
      token,
      'GET',
      '/audit-logs',
    )

    expect(result.status, `${role} harus ditolak 403`).toBe(403)
    expect(result.body.success).toBe(false)
    if (result.body.success) {
      throw new Error(`[e2e-audit] ${role} tidak boleh membaca /audit-logs.`)
    }
    expect(result.body.error.code).toBe('FORBIDDEN_BRANCH')
  }

  const superToken = await h.tokenAs('super')
  const allowed = await apiFetchRaw<ApiEnvelope<AuditPage>>(
    superToken,
    'GET',
    '/audit-logs',
  )

  expect(allowed.status).toBe(200)
  if (allowed.body.success !== true) {
    throw new Error('[e2e-audit] super_admin harus dapat membaca /audit-logs.')
  }
  expect(allowed.body.data.page).toBe(1)
  expect(allowed.body.data.limit).toBe(50)
})

test('@NAV-03 admin dipulangkan dari /audit ke /dashboard', async ({ h }) => {
  const page = await h.openAs('admin')
  await gotoApp(page, '/audit')

  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(
    page.getByRole('heading', { name: 'Dashboard Kunjungan', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Jejak Audit', exact: true }),
  ).toHaveCount(0)
})
