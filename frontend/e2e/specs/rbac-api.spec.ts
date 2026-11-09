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
  createVisitViaApi,
  deleteVisitViaApi,
  getVisitViaApi,
  isLiveRun,
  loginViaApi,
  resolveLiveCatalog,
  uploadFileViaApi,
  type ApiEnvelope,
  type ApiFailure,
  type ApiResult,
  type Role,
  type User,
  type VisitRecord,
} from '../helpers/api'
import { pdfBuffer } from '../helpers/assets'

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
 * Uji negatif: catat status + body nyata, pastikan status termasuk
 * yang diizinkan dan amplop gagal membawa `error.code` yang terisi.
 */

function expectFailure(
  result: ApiResult<ApiEnvelope<unknown>>,
  allowed: readonly number[],
  label: string,
): ApiFailure {  console.log(`[${label}] HTTP ${result.status} body=${JSON.stringify(result.body)}`)
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

function makeNik(): string {
  const time = String(Date.now()).slice(-9).padStart(9, "0")
  const rand = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")
  return `9${time}${rand}`
}

// ---------------------------------------------------------------------------
// @AUTH-03 - isolasi daftar kunjungan admin cabang
// ---------------------------------------------------------------------------
test('@AUTH-03 isolasi admin: GET /visits memuat seluruh cabang dalam cakupannya', async ({ h }) => {
  test.skip(
    isLiveRun(),
    'live: akun admin temp + kunjungan temp; asumsi seed lintas-cabang tidak ada di prod.',
  )
  const trackedVisitIds: string[] = []
  const email = `${h.unique('auth03admin').toLowerCase()}@transhybrid.net.id`
  let userId = ''
  try {
    const superToken = await h.tokenAs('super')

    // Admin temp dengan cakupan [HQ, Sambas]; pola POST /users dari MBR-01.
    const created = await apiFetchRaw<ApiEnvelope<{ id: string }>>(superToken, 'POST', '/users', {
      name: `E2E AUTH03 Admin ${h.unique('name')}`,
      email,
      password: 'Password123!',
      phone: `0812${String(Date.now()).slice(-8)}`,
      nik: makeNik(),
      role: 'admin',
      location_id: LOCATIONS.hq,
      location_ids: [LOCATIONS.hq, LOCATIONS.sambas],
    })
    expect(created.status, 'POST /users admin temp harus 201').toBe(201)
    userId = (created.body as { data: { id: string } }).data.id

    const { token: adminToken } = await loginViaApi(email, 'Password123!')

    // Cakupan runtime dari GET /auth/me: union location_ids, fallback [primary].
    const me = await apiFetchRaw<
      ApiEnvelope<{ location_id: string | null; location_ids?: string[] }>
    >(adminToken, 'GET', '/auth/me')
    expect(me.status, 'GET /auth/me admin temp harus 200').toBe(200)
    if (!me.body.success) {
      throw new Error(`GET /auth/me admin temp gagal: ${me.body.error.code}`)
    }
    const primaryId = me.body.data.location_id
    const scope: string[] =
      me.body.data.location_ids !== undefined && me.body.data.location_ids.length > 0
        ? me.body.data.location_ids
        : primaryId !== null
          ? [primaryId]
          : []
    expect(scope, 'cakupan runtime admin temp harus memuat HQ').toContain(LOCATIONS.hq)
    expect(scope, 'cakupan runtime admin temp harus memuat Sambas').toContain(LOCATIONS.sambas)

    // Satu cabang di luar cakupan via helper; bila helper mengembalikan cabang
    // yang justru di dalam cakupan temp (seed admin single-branch melaporkan
    // Sambas sebagai luar), cari cabang luar yang sebenarnya via /locations.
    let outsideId = await h.outOfScopeLocation('admin')
    if (scope.includes(outsideId)) {
      const catalog = await apiFetchRaw<ApiEnvelope<Array<{ id: string }>>>(
        adminToken,
        'GET',
        '/locations',
      )
      expect(catalog.status, 'GET /locations harus 200').toBe(200)
      if (!catalog.body.success) {
        throw new Error(`GET /locations gagal: ${catalog.body.error.code}`)
      }
      const fallback = catalog.body.data.find((location) => !scope.includes(location.id))
      expect(fallback, 'butuh cabang di luar cakupan admin temp').toBeDefined()
      if (fallback === undefined) throw new Error('[e2e] cabang luar cakupan tidak ada.')
      outsideId = fallback.id
    }
    expect(scope, 'cabang luar tidak boleh masuk cakupan').not.toContain(outsideId)

    // Kunjungan di KEDUA cabang dalam cakupan + satu di luar sebagai pembanding.
    const vendorToken = await h.tokenAs('vendor')
    const liveCatalog = await resolveLiveCatalog(vendorToken)

    async function makeVisit(locationId: string, approverToken: string): Promise<string> {
      const marker = h.unique('auth03visit')
      const spk = await uploadFileViaApi(vendorToken, 'assignment_letter', {
        name: `spk-auth03-${locationId}.pdf`,
        mimeType: 'application/pdf',
        buffer: pdfBuffer(8),
      })
      const now = Date.now()
      const payload: Record<string, unknown> = {
        location_id: locationId,
        start_date: new Date(now - 30 * 60_000).toISOString(),
        end_date: new Date(now + 180 * 60_000).toISOString(),
        is_nda_accepted: true,
        assignment_letter_url: spk.fileUrl,
        notes: `AUTH03 ${locationId} ${marker}`,
        visitors: [
          {
            name: 'AUTH03 Anggota',
            id_number: `${String(now).slice(-13)}001`,
            phone: `0812${String(now).slice(-8)}`,
          },
        ],
      }
      if (liveCatalog.purposeId !== null) {
        payload.purpose_ids = [liveCatalog.purposeId]
      } else {
        payload.purpose_note = 'E2E AUTH03 purpose'
      }
      const visit = await createVisitViaApi(vendorToken, payload)
      trackedVisitIds.push(visit.id)
      const approve = await apiFetchRaw(
        approverToken,
        'POST',
        `/visits/${encodeURIComponent(visit.id)}/approve`,
        { notes: 'Disetujui harness E2E @AUTH-03.' },
      )
      expect(approve.status, `approve ${locationId} harus sukses`).toBeLessThan(300)
      return visit.id
    }

    const idA = await makeVisit(LOCATIONS.hq, adminToken)
    const idB = await makeVisit(LOCATIONS.sambas, adminToken)
    const idOutside = await makeVisit(outsideId, superToken)

    const data = await listVisits(adminToken, 'limit=200')
    const ids = new Set(data.items.map((item) => item.id))
    console.log(
      `[@AUTH-03] total=${data.total} item=${data.items.length} lokasi=${[
        ...new Set(data.items.map((item) => item.location?.id)),
      ].join(',')}`,
    )
    expect(ids, 'admin temp harus melihat kunjungan HQ').toContain(idA)
    expect(ids, 'admin temp harus melihat kunjungan Sambas').toContain(idB)
    expect(ids.has(idOutside), 'kunjungan luar cakupan tidak boleh terlihat').toBe(false)

    const hqOnly = await listVisits(adminToken, `location_id=${LOCATIONS.hq}&limit=100`)
    expect(
      hqOnly.items.map((item) => item.id),
      'filter HQ harus memuat kunjungan HQ',
    ).toContain(idA)
    const sbsOnly = await listVisits(adminToken, `location_id=${LOCATIONS.sambas}&limit=100`)
    expect(
      sbsOnly.items.map((item) => item.id),
      'filter Sambas harus memuat kunjungan Sambas',
    ).toContain(idB)

    const missingLocation = data.items.filter((item) => typeof item.location?.id !== 'string')
    expect(missingLocation, 'setiap item list wajib membawa location.id').toEqual([])

    const foreign: VisitListItem[] = data.items.filter(
      (item) => !scope.includes(item.location?.id ?? ''),
    )
    expect(
      foreign.map((item) => ({ id: item.id, location: item.location?.id })),
      'admin hanya melihat kunjungan cabang dalam cakupannya',
    ).toEqual([])

    const seen = new Set(data.items.map((item) => item.location?.id))
    expect(seen.has(LOCATIONS.hq), 'daftar harus memuat minimal satu item HQ').toBe(true)
    expect(seen.has(LOCATIONS.sambas), 'daftar harus memuat minimal satu item Sambas').toBe(true)
  } finally {
    if (trackedVisitIds.length > 0) {
      try {
        const superToken = await h.tokenAs('super')
        for (const vid of trackedVisitIds) {
          try {
            await deleteVisitViaApi(superToken, vid)
          } catch (e) {
            console.log(`[e2e-cleanup] delete visit ${vid}: ${String(e)}`)
          }
        }
      } catch (e) {
        console.log(`[e2e-cleanup] ${String(e)}`)
      }
    }
    if (userId !== '') {
      try {
        const superToken = await h.tokenAs('super')
        await apiFetchRaw(superToken, 'DELETE', `/users/${userId}`)
      } catch (e) {
        console.log(`[e2e-cleanup] delete user ${userId}: ${String(e)}`)
      }
    }
  }
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
  expect(after.location_id).toBe(visit.locationId)
})

// ---------------------------------------------------------------------------
// @AUTH-05 — super_admin lintas cabang + filter lokasi
// ---------------------------------------------------------------------------
test('@AUTH-05 super_admin melihat lintas cabang dan filter location_id bekerja', async ({
  h,
}) => {
  test.skip(
    isLiveRun(),
    'live: asumsi riwayat seed lintas-cabang (HQ + Sambas) tidak ada di prod.',
  )
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

  const vendorB = await loginViaApi(process.env.E2E_EMAIL_VENDOR2 ?? 'vendor1b@transhybrid.net.id', DEFAULT_PASSWORD)
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
  test.skip(
    isLiveRun(),
    'live: akun security seed cabang HQ bukan data uji; penghapusan akun prod dilarang.',
  )
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
  test.skip(
    isLiveRun(),
    'live: riwayat kunjungan seed vendor1a tidak ada di prod; penghapusan akun prod dilarang.',
  )
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
test('@EDT-04 admin cabang tidak bisa mengubah pengawas security di luar cakupannya', async ({
  h,
}) => {
  test.skip(
    isLiveRun(),
    'live: PATCH (upaya rename) akun pengawas prod dilarang; riwayat seed luar-cakupan tidak ada di prod.',
  )
  const superToken = await h.tokenAs('super')
  const securityUsers = await listSecurityUsers(superToken)
  const outsideId = await h.outOfScopeLocation('admin')
  const outsideSecurity = securityUsers.find((user) => user.location_id === outsideId)
  expect(outsideSecurity, 'seed security di luar cakupan admin harus ada').toBeDefined()
  if (outsideSecurity === undefined) return

  const result = await request(
    await h.tokenAs('admin'),
    'PATCH',
    `/users/security/${encodeURIComponent(outsideSecurity.id)}`,
    { name: 'E2E @EDT-04 perubahan tidak sah' },
  )
  expectFailure(result, [403], '@EDT-04')

  const after = await listSecurityUsers(superToken)
  const unchanged = after.find((user) => user.id === outsideSecurity.id)
  expect(unchanged?.name, 'nama pengawas di luar cakupan tidak boleh berubah').toBe(
    outsideSecurity.name,
  )
})

// ---------------------------------------------------------------------------
// @AUTH-01b — login API sukses untuk semua peran
// ---------------------------------------------------------------------------
test('@AUTH-01b login API sukses dan mengembalikan token + role yang benar', async () => {
  // Akun provision memakai location_id RUNTIME, sedangkan ACCOUNTS.*.locationId
  // memegang UUID seed lokal. resolveLiveCatalog mengembalikan nilai seed
  // tanpa network saat lokal (identik dengan perilaku lama) dan nilai runtime
  // saat live, jadi dipakai tanpa cabang isLiveRun.
  const bootstrap = await loginViaApi(ACCOUNTS.super.email, ACCOUNTS.super.password)
  const catalog = await resolveLiveCatalog(bootstrap.token)
  const expectedLocationId = (role: Role): string | null => {
    if (role === 'admin' || role === 'security') return catalog.hqId
    if (role === 'admin-sambas' || role === 'security-sambas') return catalog.secondId
    return null
  }
  for (const role of ROLES) {
    const account = ACCOUNTS[role]
    const { token, user } = await loginViaApi(account.email, account.password)
    expect(token.length, `${role}: token wajib non-kosong`).toBeGreaterThan(0)
    expect(user.role, `${role}: role harus ${account.role}`).toBe(account.role)
    expect(user.email, `${role}: email harus cocok`).toBe(account.email)
    const expected = expectedLocationId(role)
    if (expected !== null) {
      expect(user.location_id, `${role}: location_id harus cocok`).toBe(expected)
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
