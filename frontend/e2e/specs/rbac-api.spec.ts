/**
 * Matriks RBAC + isolasi data THC VMS di lapisan API (tanpa browser).
 *
 * Spec ini sengaja hanya memakai `apiFetchRaw`/helper API sehingga tidak
 * bergantung pada `storageState` per peran maupun UI. Semua kunjungan yang
 * dibuat lewat harness otomatis dihapus pada teardown; uji negatif pada akun
 * seed (DELETE/PATCH user) diharapkan ditolak backend sehingga data seed utuh.
 *
 * Bentuk respons nyata yang dipakai (diinspeksi dari backend berjalan):
 * - `GET /visits` -> `{ success, data: { items: VisitDetail[], total, page, limit } }`
 *   dan setiap item membawa `location.id` (BUKAN `location_id` di level item).
 * - `GET /users/security` -> `{ success, data: User[] }`.
 * - `GET /users?role=vendor` -> `{ success, data: User[] }`.
 */

import { expect, test } from '../fixtures'
import {
  ACCOUNTS,
  DEFAULT_PASSWORD,
  LOCATIONS,
  apiFetchRaw,
  getVisitViaApi,
  loginViaApi,
  type ApiEnvelope,
  type ApiFailure,
  type ApiResult,
  type Role,
  type User,
  type VisitRecord,
} from '../helpers/api'

const ROLES: readonly Role[] = [
  'super',
  'admin',
  'admin-sambas',
  'security',
  'security-sambas',
  'vendor',
]

/** Item list kunjungan: `VisitRecord` + relasi vendor yang dipakai uji isolasi. */
interface VisitListItem extends VisitRecord {
  vendor_user?: { id: string; name?: string; email?: string }
}

interface VisitListData {
  items: VisitListItem[]
  total: number
  page: number
  limit: number
}

/** GET helper dengan amplop mentah; melempar bila bukan 200/success. */
async function request(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<ApiEnvelope<unknown>>> {
  return apiFetchRaw<ApiEnvelope<unknown>>(token, method, path, body)
}

function readSuccess<T>(result: ApiResult<ApiEnvelope<T>>, label: string): T {
  expect(result.status, `${label}: HTTP ${result.status}`).toBe(200)
  if (result.body.success !== true) {
    throw new Error(`${label}: respons gagal HTTP ${result.status} ${JSON.stringify(result.body)}`)
  }
  return result.body.data
}

/**
 * Uji negatif: catat status + body nyata ke output, pastikan status termasuk
 * yang diizinkan dan amplop gagal membawa `error.code` yang terisi.
 */
function expectFailure(
  result: ApiResult<ApiEnvelope<unknown>>,
  allowed: readonly number[],
  label: string,
): ApiFailure {
  console.log(`[${label}] HTTP ${result.status} body=${JSON.stringify(result.body)}`)
  expect(
    allowed.includes(result.status),
    `${label}: HTTP ${result.status} tidak termasuk [${allowed.join(', ')}]`,
  ).toBe(true)
  expect(result.body.success, `${label}: amplop wajib success:false`).toBe(false)
  if (result.body.success) {
    throw new Error(`${label}: respons sukses tidak terduga`)
  }
  expect(result.body.error.code.length, `${label}: error.code wajib terisi`).toBeGreaterThan(0)
  expect(result.body.error.message.length, `${label}: error.message wajib terisi`).toBeGreaterThan(
    0,
  )
  return result.body
}

async function listVisits(token: string, query = 'limit=100'): Promise<VisitListData> {
  const result = await apiFetchRaw<ApiEnvelope<VisitListData>>(token, 'GET', `/visits?${query}`)
  return readSuccess(result, `GET /visits?${query}`)
}

async function listSecurityUsers(token: string): Promise<User[]> {
  const result = await apiFetchRaw<ApiEnvelope<User[]>>(token, 'GET', '/users/security')
  return readSuccess(result, 'GET /users/security')
}

async function listManagedUsers(token: string, query: string): Promise<User[]> {
  const result = await apiFetchRaw<ApiEnvelope<User[]>>(token, 'GET', `/users?${query}`)
  return readSuccess(result, `GET /users?${query}`)
}

// ---------------------------------------------------------------------------
// @AUTH-03 — isolasi daftar kunjungan admin cabang
// ---------------------------------------------------------------------------
test('@AUTH-03 isolasi admin: GET /visits hanya memuat kunjungan cabang HQ', async ({ h }) => {
  const data = await listVisits(await h.tokenAs('admin'))

  expect(data.items.length, 'admin HQ harus melihat minimal satu kunjungan seed').toBeGreaterThan(0)

  const missingLocation = data.items.filter((item) => typeof item.location?.id !== 'string')
  expect(missingLocation, 'setiap item list wajib membawa location.id').toEqual([])

  const foreign: VisitListItem[] = data.items.filter(
    (item) => item.location?.id !== LOCATIONS.hq,
  )
  console.log(
    `[@AUTH-03] total=${data.total} item=${data.items.length} lokasi=${[
      ...new Set(data.items.map((item) => item.location?.id)),
    ].join(',')}`,
  )
  expect(
    foreign.map((item) => ({ id: item.id, location: item.location?.id })),
    'admin HQ tidak boleh melihat kunjungan cabang lain',
  ).toEqual([])
})

// ---------------------------------------------------------------------------
// @AUTH-04 — admin cabang lain tidak boleh approve kunjungan HQ
// ---------------------------------------------------------------------------
test('@AUTH-04 admin cabang lain ditolak saat approve kunjungan HQ', async ({ h }) => {
  const visit = await h.createVisit('rbac-cross-approve', { locationId: LOCATIONS.hq })
  expect(visit.status).toBe('approved')

  const result = await request(
    await h.tokenAs('admin-sambas'),
    'POST',
    `/visits/${encodeURIComponent(visit.id)}/approve`,
    { notes: 'E2E @AUTH-04 percobaan lintas cabang.' },
  )
  // Backend menjawab 403 FORBIDDEN_BRANCH (bukan 404); keduanya diterima kontrak.
  expectFailure(result, [403, 404], '@AUTH-04')

  const after = await getVisitViaApi(await h.tokenAs('super'), visit.id)
  expect(after.status, 'status kunjungan tidak boleh berubah oleh admin cabang lain').toBe(
    'approved',
  )
  expect(after.location_id).toBe(LOCATIONS.hq)
})

// ---------------------------------------------------------------------------
// @AUTH-05 — super_admin lintas cabang + filter lokasi
// ---------------------------------------------------------------------------
test('@AUTH-05 super_admin melihat lintas cabang dan filter location_id bekerja', async ({
  h,
}) => {
  const token = await h.tokenAs('super')

  const all = await listVisits(token)
  expect(all.items.length, 'super_admin harus melihat kunjungan seed').toBeGreaterThan(0)
  const allLocations = [...new Set(all.items.map((item) => item.location?.id))]
  console.log(`[@AUTH-05] semua cabang terlihat: ${allLocations.join(',')}`)

  const sambas = await listVisits(token, `location_id=${LOCATIONS.sambas}&limit=100`)
  expect(sambas.items.length, 'cabang Sambas harus punya kunjungan seed').toBeGreaterThan(0)
  expect([...new Set(sambas.items.map((item) => item.location?.id))]).toEqual([LOCATIONS.sambas])
  expect(sambas.total).toBe(sambas.items.length)
})

// ---------------------------------------------------------------------------
// @AUTH-06 — isolasi daftar kunjungan vendor
// ---------------------------------------------------------------------------
test('@AUTH-06 vendor hanya melihat kunjungan miliknya sendiri', async ({ h }) => {
  const created = await h.createVisit('rbac-vendor-isolation')

  const vendorA = await loginViaApi(ACCOUNTS.vendor.email, ACCOUNTS.vendor.password)
  const own = await listVisits(vendorA.token)
  const ownIds = own.items.map((item) => item.id)
  expect(ownIds, 'vendor1a harus melihat kunjungan yang baru ia buat').toContain(created.id)
  expect(
    own.items.filter((item) => item.vendor_user?.id !== vendorA.user.id),
    'daftar vendor1a hanya boleh memuat kunjungan miliknya',
  ).toEqual([])

  const vendorB = await loginViaApi('vendor1b@transhybrid.net.id', DEFAULT_PASSWORD)
  const other = await listVisits(vendorB.token)
  console.log(
    `[@AUTH-06] vendor1b melihat ${other.items.length} kunjungan; ` +
      `kunjungan vendor1a ${created.id} ada? ${other.items.some((item) => item.id === created.id)}`,
  )
  expect(
    other.items.some((item) => item.id === created.id),
    'vendor1b tidak boleh melihat kunjungan vendor1a',
  ).toBe(false)
  expect(
    other.items.some((item) => item.vendor_user?.id === vendorA.user.id),
    `vendor1b tidak boleh menerima item milik vendor1a (${vendorA.user.id})`,
  ).toBe(false)
  expect(
    other.items.filter((item) => item.vendor_user?.id !== vendorB.user.id),
    'daftar vendor1b hanya boleh memuat kunjungan miliknya',
  ).toEqual([])
})

// ---------------------------------------------------------------------------
// @APPR-04 — vendor dilarang approve
// ---------------------------------------------------------------------------
test('@APPR-04 vendor tidak boleh approve kunjungannya sendiri', async ({ h }) => {
  const visit = await h.createVisit('rbac-vendor-approve')
  expect(visit.status).toBe('approved')

  const result = await request(
    await h.tokenAs('vendor'),
    'POST',
    `/visits/${encodeURIComponent(visit.id)}/approve`,
    { notes: 'E2E @APPR-04 vendor mencoba approve.' },
  )
  expectFailure(result, [403], '@APPR-04')
})

// ---------------------------------------------------------------------------
// @DEL-02 — admin cabang tidak bisa hapus pengawas cabang lain
// ---------------------------------------------------------------------------
test('@DEL-02 admin cabang tidak bisa menghapus pengawas security cabang lain', async ({
  h,
}) => {
  const superToken = await h.tokenAs('super')
  const securityUsers = await listSecurityUsers(superToken)
  const hqSecurity = securityUsers.find((user) => user.location_id === LOCATIONS.hq)
  expect(hqSecurity, 'seed security HQ harus ada').toBeDefined()
  if (hqSecurity === undefined) return

  const result = await request(
    await h.tokenAs('admin-sambas'),
    'DELETE',
    `/users/security/${encodeURIComponent(hqSecurity.id)}`,
  )
  expectFailure(result, [403], '@DEL-02')

  const after = await listSecurityUsers(superToken)
  expect(
    after.some((user) => user.id === hqSecurity.id),
    'akun security HQ harus tetap ada setelah penolakan',
  ).toBe(true)
})

// ---------------------------------------------------------------------------
// @DEL-04 — hapus user yang masih direferensikan kunjungan -> 409
// ---------------------------------------------------------------------------
test('@DEL-04 super_admin tidak bisa menghapus vendor yang masih punya kunjungan', async ({
  h,
}) => {
  const superToken = await h.tokenAs('super')

  // vendor1a punya kunjungan seed; login untuk memperoleh UUID akunnya.
  const vendorA = await loginViaApi(ACCOUNTS.vendor.email, ACCOUNTS.vendor.password)
  const before = await listManagedUsers(superToken, 'role=vendor')
  expect(
    before.some((user) => user.id === vendorA.user.id),
    'vendor1a harus terdaftar sebelum uji',
  ).toBe(true)

  const result = await request(superToken, 'DELETE', `/users/${encodeURIComponent(vendorA.user.id)}`)
  // Ekspektasi: 409 CONFLICT. 204 berarti akun seed benar-benar terhapus -> gagal.
  expectFailure(result, [409], '@DEL-04')

  const after = await listManagedUsers(superToken, 'role=vendor')
  expect(
    after.some((user) => user.id === vendorA.user.id),
    'vendor1a wajib tetap ada setelah penolakan 409',
  ).toBe(true)
})

// ---------------------------------------------------------------------------
// @DEL-06 — super_admin tidak bisa menghapus dirinya sendiri
// ---------------------------------------------------------------------------
test('@DEL-06 super_admin tidak bisa menghapus akun sendiri', async ({ h }) => {
  const superToken = await h.tokenAs('super')
  const me = await request(superToken, 'GET', '/auth/me')
  const profile = readSuccess(
    me as ApiResult<ApiEnvelope<{ id: string; email: string; role: string }>>,
    'GET /auth/me',
  )

  const result = await request(superToken, 'DELETE', `/users/${encodeURIComponent(profile.id)}`)
  expectFailure(result, [403], '@DEL-06')

  const stillThere = await request(superToken, 'GET', '/auth/me')
  expect(stillThere.status, 'token super_admin harus tetap valid setelah penolakan').toBe(200)
})

// ---------------------------------------------------------------------------
// @EDT-04 — admin cabang tidak bisa PATCH pengawas cabang lain
// ---------------------------------------------------------------------------
test('@EDT-04 admin cabang tidak bisa mengubah pengawas security cabang lain', async ({
  h,
}) => {
  const superToken = await h.tokenAs('super')
  const securityUsers = await listSecurityUsers(superToken)
  const sambasSecurity = securityUsers.find((user) => user.location_id === LOCATIONS.sambas)
  expect(sambasSecurity, 'seed security Sambas harus ada').toBeDefined()
  if (sambasSecurity === undefined) return

  const result = await request(
    await h.tokenAs('admin'),
    'PATCH',
    `/users/security/${encodeURIComponent(sambasSecurity.id)}`,
    { name: 'E2E @EDT-04 perubahan tidak sah' },
  )
  expectFailure(result, [403], '@EDT-04')

  const after = await listSecurityUsers(superToken)
  const unchanged = after.find((user) => user.id === sambasSecurity.id)
  expect(unchanged?.name, 'nama pengawas Sambas tidak boleh berubah').toBe(sambasSecurity.name)
})

// ---------------------------------------------------------------------------
// @AUTH-01b — login API sukses untuk semua peran
// ---------------------------------------------------------------------------
test('@AUTH-01b login API sukses dan mengembalikan token + role yang benar', async () => {
  for (const role of ROLES) {
    const account = ACCOUNTS[role]
    const { token, user } = await loginViaApi(account.email, account.password)
    expect(token.length, `${role}: token wajib non-kosong`).toBeGreaterThan(0)
    expect(user.role, `${role}: role harus ${account.role}`).toBe(account.role)
    expect(user.email, `${role}: email harus cocok`).toBe(account.email)
    if (account.locationId !== null) {
      expect(user.location_id, `${role}: location_id harus cocok`).toBe(account.locationId)
    }
  }
})

// ---------------------------------------------------------------------------
// @AUTH-02b — login password salah
// ---------------------------------------------------------------------------
test('@AUTH-02b login dengan password salah ditolak 401 dengan amplop gagal', async () => {
  const result = await request('', 'POST', '/auth/login', {
    email: ACCOUNTS.admin.email,
    password: 'PasswordYangSalah!',
  })

  const failure = expectFailure(result, [401], '@AUTH-02b')
  expect(failure.error.code).toBe('INVALID_CREDENTIALS')
})
