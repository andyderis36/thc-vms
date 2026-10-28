/**
 * Kontrak sistem terakhir yang belum tersentuh spec lain:
 *
 * - @SYS-01 / @SYS-02  probe liveness (`GET /health`) dan readiness (`GET /ready`)
 *   tanpa token. Bentuk body diambil dari `backend/internal/delivery/http/health_handler.go`
 *   (status, uptime, timestamp) dan `docs/4. openapi.yaml` HealthResponse.
 * - @SYS-03  jalur yang SENGAJA tidak dirutekan menurut `router.go` L163-165
 *   (`POST /visits/{id}/feedback`, `POST /visits/{id}/incident`) menjawab 404.
 *   Tidak ada `NoRoute` kustom, jadi Gin menjawab teks polos; bila suatu saat
 *   handler NoRoute ditambahkan, body objek wajib memakai amplop gagal.
 * - @SYS-04  katalog master data (`/locations`, `/purposes`, `/vendors`,
 *   `/jabatan`) untuk kelima peran. `MasterHandler` TIDAK melakukan scoping
 *   cabang (hanya `/visits` dan `/users*` yang di-scope), sehingga jumlah baris
 *   lokasi wajib identik antar peran — bukan asumsi, melainkan perilaku handler.
 * - @SYS-05  penulisan katalog `POST /locations` hanya super_admin.
 * - @SYS-06  siklus status akun security: aktif -> login -> nonaktif -> login
 *   ditolak 401 -> aktif kembali -> hapus (204) -> verifikasi 404.
 * - @SYS-07  isolasi cabang pada `PATCH /users/security/{id}/status`.
 * - @SYS-08  siklus status akun non-security lewat `PATCH /users/{id}/status`.
 *
 * SENGAJA DITINGGALKAN ke spec lain (tidak diduplikasi):
 * - `backoffice.spec.ts`: @DEL-01 (hapus pengawas via UI), @EDT-01..03
 *   (ubah nama/reset sandi/pengawas se-cabang), @NAV-06 (halaman /users 404).
 * - `rbac-api.spec.ts`: @DEL-02 (hapus pengawas lintas cabang), @DEL-04
 *   (hapus vendor ber-referensi), @DEL-06 (hapus akun sendiri), @EDT-04
 *   (PATCH pengawas lintas cabang).
 *
 * KESELAMATAN DATA: akun seed (`ACCOUNTS`) tidak pernah diubah status/dihapus.
 * Semua mutasi hanya pada akun sekali-pakai yang dibuat di dalam test. Setiap
 * akun dilacak dan dihapus di `finally`; DELETE pertama harus 204/404 dan
 * DELETE verifikasi wajib 404 — kegagalan cleanup menggagalkan test. Ini juga
 * melindungi mode LIVE (`e2e-live.cmd`) yang menembak produksi.
 */

import { expect, test } from '../fixtures'
import {
  ACCOUNTS,
  LOCATIONS,
  apiFetch,
  apiFetchRaw,
  loginViaApiCached,
  type ApiEnvelope,
  type ApiResult,
  type Role,
} from '../helpers/api'

const PASSWORD = 'Password123!'

const CATALOGUE_ROLES: readonly Role[] = [
  'super',
  'admin',
  'admin-sambas',
  'security',
  'vendor',
]

// ---------------------------------------------------------------------------
// Tipe & helper lokal (tidak menyentuh fixtures/helpers bersama)
// ---------------------------------------------------------------------------

interface HealthData {
  status: string
  uptime: string
  timestamp: string
}

interface AccountRow {
  id: string
  email: string
  role: string
  status: string
  location_id: string | null
}

interface CreatedAccount {
  kind: 'security' | 'managed'
  id: string
  email: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Amplop gagal menurut docs/4: `{success:false,error:{code,message}}`. */
function isFailureEnvelope(value: unknown): boolean {
  return isRecord(value) && value.success === false && isRecord(value.error)
}

function readSuccess<T>(result: ApiResult<ApiEnvelope<T>>, label: string): T {
  if (result.body.success !== true) {
    throw new Error(
      `[e2e-sys] ${label}: ${result.body.error.code} - ${result.body.error.message}`,
    )
  }
  return result.body.data
}

/** Catat status + body nyata, lalu kembalikan `error.code`. */
function failureCode<T>(result: ApiResult<ApiEnvelope<T>>, label: string): string {
  console.log(`[e2e-sys] ${label} -> HTTP ${result.status} body=${JSON.stringify(result.body)}`)
  expect(result.body.success, `${label}: amplop wajib success:false`).toBe(false)
  if (result.body.success) {
    throw new Error(`[e2e-sys] ${label}: respons sukses tidak terduga`)
  }
  expect(result.body.error.code.length, `${label}: error.code wajib terisi`).toBeGreaterThan(0)
  return result.body.error.code
}

/** GET list dengan amplop 200 + success:true, dikembalikan sebagai array. */
async function fetchList<T>(token: string, path: string): Promise<T[]> {
  const result = await apiFetchRaw<ApiEnvelope<T[]>>(token, 'GET', path)
  expect(result.status, `GET ${path}: HTTP ${result.status}`).toBe(200)
  return readSuccess(result, `GET ${path}`)
}

async function superToken(): Promise<string> {
  const login = await loginViaApiCached(ACCOUNTS.super.email, ACCOUNTS.super.password)
  return login.token
}

async function createSecurityAccount(
  token: string,
  input: { name: string; email: string; locationId: string },
): Promise<AccountRow> {
  const result = await apiFetch<ApiEnvelope<AccountRow>>(token, 'POST', '/users/security', {
    name: input.name,
    email: input.email,
    password: PASSWORD,
    location_id: input.locationId,
  })
  return readSuccess(result, `POST /users/security ${input.email}`)
}

let nikSequence = 0

/** NIK 16 digit numerik yang unik antar test. */
function uniqueNik(): string {
  nikSequence += 1
  const time = String(Date.now()).slice(-12)
  const random = String(Math.floor(Math.random() * 1000)).padStart(3, '0')
  return `${time}${random}${nikSequence % 10}`
}

/**
 * Hapus setiap akun uji lalu buktikan hilang: DELETE pertama boleh 204 (masih
 * ada) atau 404 (test sudah menghapusnya), DELETE verifikasi WAJIB 404.
 * Dipanggil dari `finally` sehingga kegagalan cleanup menggagalkan test.
 */
async function cleanupAccounts(
  token: string,
  accounts: readonly CreatedAccount[],
): Promise<void> {
  for (const account of accounts) {
    const path =
      account.kind === 'security'
        ? `/users/security/${account.id}`
        : `/users/${account.id}`
    const first = await apiFetchRaw<unknown>(token, 'DELETE', path)
    console.log(
      `[e2e-sys] cleanup DELETE ${account.kind} ${account.email} -> HTTP ${first.status}`,
    )
    expect(
      [204, 404],
      `cleanup ${account.email}: DELETE pertama harus 204/404, dapat ${first.status}`,
    ).toContain(first.status)
    const verify = await apiFetchRaw<unknown>(token, 'DELETE', path)
    expect(
      verify.status,
      `cleanup ${account.email}: verifikasi DELETE ulang harus 404, dapat ${verify.status}`,
    ).toBe(404)
  }
}

// ---------------------------------------------------------------------------
// @SYS-01 — liveness probe tanpa token
// ---------------------------------------------------------------------------
test('@SYS-01 GET /health menjawab 200 tanpa token dengan status healthy, uptime, dan timestamp', async () => {
  const result = await apiFetchRaw<ApiEnvelope<HealthData>>('', 'GET', '/health')

  expect(result.status, 'GET /health harus 200 tanpa Authorization').toBe(200)
  const data = readSuccess(result, '@SYS-01 GET /health')
  expect(data.status).toBe('healthy')
  expect(typeof data.uptime, 'uptime wajib string durasi').toBe('string')
  expect(data.uptime.length).toBeGreaterThan(0)
  expect(Number.isNaN(Date.parse(data.timestamp)), 'timestamp wajib RFC3339').toBe(false)
})

// ---------------------------------------------------------------------------
// @SYS-02 — readiness probe tanpa token
// ---------------------------------------------------------------------------
test('@SYS-02 GET /ready menjawab 200 tanpa token dan melaporkan status ready', async () => {
  const result = await apiFetchRaw<ApiEnvelope<HealthData>>('', 'GET', '/ready')

  expect(result.status, 'GET /ready harus 200 saat database siap').toBe(200)
  const data = readSuccess(result, '@SYS-02 GET /ready')
  expect(data.status).toBe('ready')
  expect(typeof data.uptime, 'uptime wajib string durasi').toBe('string')
  expect(data.uptime.length).toBeGreaterThan(0)
  expect(Number.isNaN(Date.parse(data.timestamp)), 'timestamp wajib RFC3339').toBe(false)
})

// ---------------------------------------------------------------------------
// @SYS-03 — jalur yang sengaja tidak dirutekan
// ---------------------------------------------------------------------------
test('@SYS-03 endpoint feedback/incident yang tidak dirutekan menjawab 404 untuk visit nyata', async ({
  h,
}) => {
  // Kunjungan NYATA: 404 di bawah tidak bisa disalahartikan sebagai ID invalid.
  const visit = await h.createVisit('sys03-unrouted', { withFiles: false, approve: false })
  const token = await h.tokenAs('vendor')
  const paths = [
    `/visits/${encodeURIComponent(visit.id)}/feedback`,
    `/visits/${encodeURIComponent(visit.id)}/incident`,
  ]

  for (const path of paths) {
    const result = await apiFetchRaw<unknown>(token, 'POST', path, {})
    console.log(`[e2e-sys] POST ${path} -> HTTP ${result.status} body=${JSON.stringify(result.body)}`)

    expect(
      result.status,
      `POST ${path} sengaja TIDAK dirutekan router.go dan wajib 404`,
    ).toBe(404)

    // Router tanpa NoRoute kustom menjawab teks polos Gin. Bila kelak ada
    // handler NoRoute berbentuk JSON, ia wajib memakai amplop gagal standar.
    if (typeof result.body !== 'string') {
      expect(
        isFailureEnvelope(result.body),
        `POST ${path}: body non-teks harus {success:false,error:{code,message}}`,
      ).toBe(true)
    }
  }
})

// ---------------------------------------------------------------------------
// @SYS-04 — katalog master data untuk semua peran
// ---------------------------------------------------------------------------
test('@SYS-04 katalog /locations, /purposes, /vendors, /jabatan terbaca untuk kelima peran', async ({
  h,
}) => {
  // Pastikan /jabatan punya minimal satu nilai: fixture menulis `jabatan: Teknisi`.
  await h.createVisit('sys04-jabatan', { withFiles: false, approve: false })

  const locationCounts = new Map<Role, number>()

  for (const role of CATALOGUE_ROLES) {
    const token = await h.tokenAs(role)

    const locations = await fetchList<Record<string, unknown>>(token, '/locations')
    expect(locations.length, `${role}: katalog lokasi tidak boleh kosong`).toBeGreaterThan(0)
    for (const row of locations) {
      expect(typeof row.id, `${role}: location.id wajib string`).toBe('string')
      expect(typeof row.name, `${role}: location.name wajib string`).toBe('string')
      expect(
        ['pusat', 'cabang', 'pop', 'minipop'],
        `${role}: location.type di luar enum openapi`,
      ).toContain(row.type)
      expect(typeof row.address, `${role}: location.address wajib string`).toBe('string')
      expect(typeof row.city, `${role}: location.city wajib string`).toBe('string')
      expect(['WIB', 'WITA', 'WIT'], `${role}: location.timezone di luar enum`).toContain(
        row.timezone,
      )
      expect(typeof row.is_active, `${role}: location.is_active wajib boolean`).toBe('boolean')
    }
    const ids = locations.map((row) => row.id)
    expect(ids, `${role}: katalog wajib memuat HQ dan Sambas`).toEqual(
      expect.arrayContaining([LOCATIONS.hq, LOCATIONS.sambas]),
    )
    locationCounts.set(role, locations.length)

    const purposes = await fetchList<Record<string, unknown>>(token, '/purposes')
    expect(purposes.length, `${role}: katalog purpose tidak boleh kosong`).toBeGreaterThan(0)
    for (const row of purposes) {
      expect(typeof row.id, `${role}: purpose.id wajib string`).toBe('string')
      expect(typeof row.name, `${role}: purpose.name wajib string`).toBe('string')
    }

    const vendors = await fetchList<Record<string, unknown>>(token, '/vendors')
    expect(vendors.length, `${role}: katalog vendor tidak boleh kosong`).toBeGreaterThan(0)
    for (const row of vendors) {
      expect(typeof row.id, `${role}: vendor.id wajib string`).toBe('string')
      expect(typeof row.name, `${role}: vendor.name wajib string`).toBe('string')
    }

    const jabatan = await fetchList<unknown>(token, '/jabatan')
    expect(jabatan.length, `${role}: saran jabatan tidak boleh kosong setelah visit dibuat`).toBeGreaterThan(
      0,
    )
    for (const value of jabatan) {
      expect(typeof value, `${role}: setiap saran jabatan wajib string`).toBe('string')
    }
  }

  const counts = [...locationCounts.values()]
  console.log(`[e2e-sys] jumlah lokasi per peran: ${JSON.stringify([...locationCounts.entries()])}`)
  expect(
    new Set(counts).size,
    'MasterHandler.ListLocations tidak di-scope cabang: semua peran melihat jumlah yang sama',
  ).toBe(1)
})

// ---------------------------------------------------------------------------
// @SYS-05 — tulis katalog hanya super_admin
// ---------------------------------------------------------------------------
test('@SYS-05 POST /locations ditolak 403 untuk admin, security, dan vendor tanpa membuat baris', async ({
  h,
}) => {
  const token = await superToken()
  const before = await fetchList<Record<string, unknown>>(token, '/locations?active_only=false')
  const name = `${h.unique('SYS05')} Fasilitas`
  const refusedRoles: readonly Role[] = ['admin', 'security', 'vendor']

  for (const role of refusedRoles) {
    const result = await apiFetchRaw<ApiEnvelope<unknown>>(
      await h.tokenAs(role),
      'POST',
      '/locations',
      { name, type: 'pop' },
    )
    expect(result.status, `${role}: POST /locations wajib 403`).toBe(403)
    expect(failureCode(result, `@SYS-05 POST /locations sebagai ${role}`)).toBe(
      'FORBIDDEN_BRANCH',
    )
  }

  const after = await fetchList<Record<string, unknown>>(token, '/locations?active_only=false')
  expect(after.length, 'jumlah lokasi tidak boleh bertambah setelah penolakan').toBe(
    before.length,
  )
  expect(
    after.some((row) => row.name === name),
    'tidak boleh ada baris lokasi yang tercipta dari request yang ditolak',
  ).toBe(false)
})

// ---------------------------------------------------------------------------
// @SYS-06 — status akun security: nonaktif memblokir login
// ---------------------------------------------------------------------------
test('@SYS-06 status akun security nonaktif memblokir login, aktif kembali lalu dihapus permanen', async ({
  h,
}) => {
  const token = await superToken()
  const email = `${h.unique('sys06').toLowerCase()}@thc.com`
  const created: CreatedAccount[] = []

  try {
    const account = await createSecurityAccount(token, {
      name: `${h.unique('SYS06')} Pengawas`,
      email,
      locationId: LOCATIONS.hq,
    })
    created.push({ kind: 'security', id: account.id, email })
    expect(account.role).toBe('security')
    expect(account.status).toBe('active')
    expect(account.location_id).toBe(LOCATIONS.hq)
    expect(account.email).toBe(email)

    // 1) Nonaktifkan lebih dulu: login sukses menulis audit_log.user_id, dan FK
    //    NO ACTION membuat akun mustahil dihapus pada langkah berikutnya.
    const deactivated = await apiFetch<ApiEnvelope<AccountRow>>(
      token,
      'PATCH',
      `/users/security/${account.id}/status`,
      { status: 'inactive' },
    )
    expect(readSuccess(deactivated, '@SYS-06 nonaktifkan akun').status).toBe('inactive')

    // 2) Login ditolak dengan kredensial generik (bukan 403/404).
    const refused = await apiFetchRaw<ApiEnvelope<unknown>>('', 'POST', '/auth/login', {
      email,
      password: PASSWORD,
    })
    expect(refused.status, 'login akun nonaktif wajib 401').toBe(401)
    expect(failureCode(refused, '@SYS-06 login akun nonaktif')).toBe('INVALID_CREDENTIALS')

    // 3) Aktifkan kembali.
    const restored = await apiFetch<ApiEnvelope<AccountRow>>(
      token,
      'PATCH',
      `/users/security/${account.id}/status`,
      { status: 'active' },
    )
    expect(readSuccess(restored, '@SYS-06 aktifkan kembali').status).toBe('active')

    // 4) Hapus permanen lalu buktikan 404.
    const deleted = await apiFetchRaw<unknown>(token, 'DELETE', `/users/security/${account.id}`)
    expect(deleted.status, 'DELETE /users/security/{id} wajib 204').toBe(204)
    const gone = await apiFetchRaw<unknown>(token, 'DELETE', `/users/security/${account.id}`)
    expect(gone.status, 'akun yang sudah dihapus wajib 404').toBe(404)
  } finally {
    await cleanupAccounts(token, created)
  }
})

// ---------------------------------------------------------------------------
// @SYS-07 — admin tidak boleh menyentuh status pengawas cabang lain
// ---------------------------------------------------------------------------
test('@SYS-07 admin HQ tidak boleh mengubah status akun security cabang Sambas', async ({ h }) => {
  const token = await superToken()
  const email = `${h.unique('sys07').toLowerCase()}@thc.com`
  const created: CreatedAccount[] = []

  try {
    // Akun sekali-pakai di Sambas; akun seed tidak pernah disentuh.
    const account = await createSecurityAccount(token, {
      name: `${h.unique('SYS07')} Pengawas Sambas`,
      email,
      locationId: LOCATIONS.sambas,
    })
    created.push({ kind: 'security', id: account.id, email })
    expect(account.location_id).toBe(LOCATIONS.sambas)
    expect(account.status).toBe('active')

    const adminToken = await h.tokenAs('admin')
    const refused = await apiFetchRaw<ApiEnvelope<unknown>>(
      adminToken,
      'PATCH',
      `/users/security/${account.id}/status`,
      { status: 'inactive' },
    )
    expect(refused.status, 'admin HQ lintas cabang wajib 403').toBe(403)
    expect(failureCode(refused, '@SYS-07 admin HQ -> pengawas Sambas')).toBe(
      'FORBIDDEN_BRANCH',
    )

    // Status target tidak berubah.
    const sambasRows = await fetchList<AccountRow>(
      token,
      `/users/security?location_id=${encodeURIComponent(LOCATIONS.sambas)}`,
    )
    const target = sambasRows.find((row) => row.id === account.id)
    expect(target, 'akun uji Sambas harus tetap terdaftar').toBeDefined()
    expect(target?.status, 'status akun Sambas tidak boleh berubah').toBe('active')
  } finally {
    await cleanupAccounts(token, created)
  }
})

// ---------------------------------------------------------------------------
// @SYS-08 — status akun non-security lewat permukaan superadmin
// ---------------------------------------------------------------------------
test('@SYS-08 superadmin menonaktifkan akun non-security lewat PATCH /users/{id}/status', async ({
  h,
}) => {
  const token = await superToken()
  const email = `${h.unique('sys08').toLowerCase()}@thc.com`
  const created: CreatedAccount[] = []

  try {
    const result = await apiFetch<ApiEnvelope<AccountRow>>(token, 'POST', '/users', {
      name: `${h.unique('SYS08')} Vendor`,
      email,
      password: PASSWORD,
      role: 'vendor',
      nik: uniqueNik(),
    })
    const account = readSuccess(result, '@SYS-08 POST /users')
    created.push({ kind: 'managed', id: account.id, email })
    expect(account.role).toBe('vendor')
    expect(account.status).toBe('active')

    // Permukaan security menolak target non-security dengan 404 (bukan 403),
    // sesuai UserHandler.UpdateSecurityStatus.
    const wrongSurface = await apiFetchRaw<ApiEnvelope<unknown>>(
      token,
      'PATCH',
      `/users/security/${account.id}/status`,
      { status: 'inactive' },
    )
    expect(wrongSurface.status, 'PATCH /users/security/{id}/status atas vendor wajib 404').toBe(
      404,
    )
    expect(failureCode(wrongSurface, '@SYS-08 permukaan security atas vendor')).toBe('NOT_FOUND')

    // Permukaan superadmin: nonaktif -> login ditolak 401.
    const deactivated = await apiFetch<ApiEnvelope<AccountRow>>(
      token,
      'PATCH',
      `/users/${account.id}/status`,
      { status: 'inactive' },
    )
    expect(readSuccess(deactivated, '@SYS-08 nonaktifkan vendor').status).toBe('inactive')

    const refused = await apiFetchRaw<ApiEnvelope<unknown>>('', 'POST', '/auth/login', {
      email,
      password: PASSWORD,
    })
    expect(refused.status, 'login akun non-security nonaktif wajib 401').toBe(401)
    expect(failureCode(refused, '@SYS-08 login vendor nonaktif')).toBe('INVALID_CREDENTIALS')

    // Aktif kembali.
    const restored = await apiFetch<ApiEnvelope<AccountRow>>(
      token,
      'PATCH',
      `/users/${account.id}/status`,
      { status: 'active' },
    )
    expect(readSuccess(restored, '@SYS-08 aktifkan kembali vendor').status).toBe('active')

    // Hapus permanen lewat /users/{id} lalu buktikan 404.
    const deleted = await apiFetchRaw<unknown>(token, 'DELETE', `/users/${account.id}`)
    expect(deleted.status, 'DELETE /users/{id} wajib 204').toBe(204)
    const gone = await apiFetchRaw<unknown>(token, 'DELETE', `/users/${account.id}`)
    expect(gone.status, 'akun yang sudah dihapus wajib 404').toBe(404)
  } finally {
    await cleanupAccounts(token, created)
  }
})
