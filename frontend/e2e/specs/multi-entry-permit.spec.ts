/**
 * Multi-Entry Permit — subset E2E untuk Wave 5 (SSOT + uji alur multi-entry).
 *
 * Cakupan (3 test, berpadanan dengan baris `@ME-*` di `docs/6. QA_CHECKLIST.md`):
 * - `@ME-01` re-entry check-in setelah check-out pada VST yang sama;
 *   `visit_logs` bertambah menjadi `in, out, in`.
 * - `@ME-03` check-out dua kali berturut-turut dari `offsite` ditolak state
 *   guard (`ResolveGateTransition` -> 409 CONFLICT), tanpa baris log baru.
 * - `@ME-04` tombol "Selesaikan" (`POST /visits/{id}/complete`) oleh admin
 *   cabang menutup permit menjadi `completed`; security ditolak 403.
 *
 * Semantik yang DIBACA dari kode (bukan tebakan):
 * - `backend/internal/domain/gate_transition.go`: approved->visiting (check-in),
 *   visiting->offsite (check-out), offsite->visiting (re-entry).
 * - `backend/internal/usecase/gate/checkout.go`: check-out dari status selain
 *   `visiting` ditolak `domain.Conflict` -> HTTP 409 `CONFLICT`.
 * - `backend/internal/usecase/gate/complete.go`: hanya admin/super_admin cabang
 *   permit; status selain visiting/offsite ditolak 409 CONFLICT.
 * - `backend/internal/delivery/http/handlers/visit_log_handler.go`:
 *   `GET /visits/{id}/logs` -> `{ success: true, data: [...] }`, urut tertua ke
 *   terbaru, field `id`, `visit_request_id`, `direction`, `actor_user_id`,
 *   `actor_role`, `created_at` (`actor_name` opsional).
 *
 * Semua kunjungan dibuat lewat `h.createVisit` (marker `E2E-...` di `notes`,
 * auto-cleanup teardown super_admin) sehingga sweep-safe. Akun admin tersedia
 * lewat harness (`E2E_EMAIL_ADMIN` / `h.tokenAs('admin')`, diprovisi juga oleh
 * `provision-live-users.ts`) — tidak ada test yang di-skip. Tanpa
 * `waitForTimeout`/`networkidle`: sinkronisasi memakai `expect`/`expect.poll`.
 */

import { expect, test } from '../fixtures'
import {
  apiFetchRaw,
  checkInViaApi,
  checkOutViaApi,
  getVisitViaApi,
  type ApiResult,
} from '../helpers/api'

interface VisitLogRow {
  id: string
  visit_request_id: string
  direction: 'in' | 'out'
  actor_user_id: string | null
  actor_role: string | null
  created_at: string
}

interface RefusalData {
  code: string
  message: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Buka amplop `{ success: true, data: [...] }` dari GET /visits/:id/logs. */
function readLogs(result: ApiResult<unknown>): VisitLogRow[] {
  expect(result.status, 'GET /visits/:id/logs harus 200').toBe(200)
  const body = result.body
  if (!isRecord(body) || body.success !== true || !Array.isArray(body.data)) {
    throw new Error(`Respons logs tidak valid: ${JSON.stringify(body)}`)
  }
  return body.data.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new Error(`Baris log ke-${index} bukan objek: ${JSON.stringify(raw)}`)
    }
    const { id, visit_request_id, direction, actor_user_id, actor_role, created_at } = raw
    if (
      typeof id !== 'string' ||
      typeof visit_request_id !== 'string' ||
      (direction !== 'in' && direction !== 'out') ||
      typeof created_at !== 'string'
    ) {
      throw new Error(`Baris log ke-${index} tidak valid: ${JSON.stringify(raw)}`)
    }
    return {
      id,
      visit_request_id,
      direction,
      actor_user_id: typeof actor_user_id === 'string' ? actor_user_id : null,
      actor_role: typeof actor_role === 'string' ? actor_role : null,
      created_at,
    }
  })
}

/** Baca amplop gagal dan pastikan status HTTP persis seperti kontrak usecase. */
function readRefusal(result: ApiResult<unknown>, expectedStatus: number): RefusalData {
  expect(result.status, `HTTP harus ${expectedStatus}`).toBe(expectedStatus)
  const body = result.body
  if (!isRecord(body) || body.success !== false || !isRecord(body.error)) {
    throw new Error(`Amplop gagal tidak valid: ${JSON.stringify(body)}`)
  }
  const { code, message } = body.error
  if (typeof code !== 'string' || typeof message !== 'string') {
    throw new Error(`Amplop gagal tanpa code/message: ${JSON.stringify(body)}`)
  }
  return { code, message }
}

test('@ME-01 re-entry check-in setelah check-out pada VST yang sama menghasilkan 3 baris visit_logs', async ({
  h,
}) => {
  const visit = await h.createVisit('me01', { withFiles: false })
  const securityToken = await h.tokenAs('security')
  const superToken = await h.tokenAs('super')

  // Siklus pertama: approved -> visiting -> offsite.
  await checkInViaApi(securityToken, visit.id)
  expect((await getVisitViaApi(superToken, visit.id)).status).toBe('visiting')
  await checkOutViaApi(securityToken, visit.id)
  expect((await getVisitViaApi(superToken, visit.id)).status).toBe('offsite')

  const firstCycle = readLogs(await apiFetchRaw(securityToken, 'GET', `/visits/${visit.id}/logs`))
  expect(firstCycle.map((row) => row.direction)).toEqual(['in', 'out'])
  expect(firstCycle.every((row) => row.visit_request_id === visit.id)).toBe(true)

  // Re-entry memakai QR / Visit ID yang sama, masih dalam jendela [start-2h, end].
  await checkInViaApi(securityToken, visit.id)
  expect((await getVisitViaApi(superToken, visit.id)).status).toBe('visiting')

  const afterReEntry = readLogs(await apiFetchRaw(securityToken, 'GET', `/visits/${visit.id}/logs`))
  expect(afterReEntry).toHaveLength(3)
  expect(afterReEntry.map((row) => row.direction)).toEqual(['in', 'out', 'in'])
  expect(afterReEntry.every((row) => row.visit_request_id === visit.id)).toBe(true)
})

test('@ME-03 check-out dua kali berturut-turut dari offsite ditolak state guard', async ({ h }) => {
  const visit = await h.createVisit('me03', { withFiles: false })
  const securityToken = await h.tokenAs('security')
  const superToken = await h.tokenAs('super')

  await checkInViaApi(securityToken, visit.id)
  await checkOutViaApi(securityToken, visit.id)
  expect((await getVisitViaApi(superToken, visit.id)).status).toBe('offsite')

  const before = readLogs(await apiFetchRaw(securityToken, 'GET', `/visits/${visit.id}/logs`))
  expect(before.map((row) => row.direction)).toEqual(['in', 'out'])

  // Dua percobaan berurutan dari offsite: keduanya ditolak ResolveGateTransition.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const rejection = await apiFetchRaw(securityToken, 'POST', `/visits/${visit.id}/checkout`, {})
    const refusal = readRefusal(rejection, 409)
    expect(refusal.code).toBe('CONFLICT')
    expect(refusal.message).toContain('offsite')
    expect((await getVisitViaApi(superToken, visit.id)).status).toBe('offsite')
  }

  const after = readLogs(await apiFetchRaw(securityToken, 'GET', `/visits/${visit.id}/logs`))
  expect(after.map((row) => row.direction)).toEqual(['in', 'out'])
})

test('@ME-04 Selesaikan oleh admin cabang menutup permit menjadi completed', async ({ h }) => {
  const visit = await h.createVisit('me04', { withFiles: false })
  const securityToken = await h.tokenAs('security')
  const adminToken = await h.tokenAs('admin')
  const superToken = await h.tokenAs('super')

  await checkInViaApi(securityToken, visit.id)
  await checkOutViaApi(securityToken, visit.id)
  expect((await getVisitViaApi(superToken, visit.id)).status).toBe('offsite')

  // Role gate: security mengeksekusi scan gerbang, tetapi tidak boleh menyelesaikan.
  const forbidden = await apiFetchRaw(securityToken, 'POST', `/visits/${visit.id}/complete`, {})
  expect(readRefusal(forbidden, 403).code).toBe('FORBIDDEN')
  expect((await getVisitViaApi(superToken, visit.id)).status).toBe('offsite')

  const completed = await apiFetchRaw(adminToken, 'POST', `/visits/${visit.id}/complete`, {})
  expect(completed.status, 'POST /visits/:id/complete harus 200').toBe(200)
  expect((await getVisitViaApi(superToken, visit.id)).status).toBe('completed')
})
