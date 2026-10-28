/**
 * API helper untuk harness E2E THC VMS.
 *
 * Kontrak mengikuti `docs/4. openapi.yaml` dan `backend/internal/delivery/http/router.go`:
 * - Semua endpoint berada di bawah `/api/v1` (tanpa prefix `/api/v1` ganda).
 * - Respons sukses selalu `{ success: true, data: ... }`; gagal
 *   `{ success: false, error: { code, message } }`.
 * - Token JWT dikirim sebagai `Authorization: Bearer <token>` (bukan cookie).
 *
 * Helper level-tinggi (`createVisitViaApi`, `approveVisitViaApi`, dst.) membuka
 * amplop dan mengembalikan data yang sudah dinormalisasi. `apiFetch` melempar
 * `Error` berisi status + body untuk respons non-2xx / `success !== true`,
 * sedangkan `apiFetchRaw` sengaja TIDAK melempar agar spec negatif bisa
 * memeriksa status dan kode error sendiri.
 */

// Env override agar suite yang sama bisa menembak produksi; default tetap lokal.
export const API_BASE = process.env.E2E_API_BASE_URL ?? 'http://localhost:8080/api/v1'
export const FRONTEND_BASE = process.env.E2E_FRONTEND_BASE_URL ?? 'http://localhost:3210'
export const TOKEN_STORAGE_KEY = 'thc_vms_token'
export const DEFAULT_PASSWORD = 'Password123!'

export type Role = 'super' | 'admin' | 'admin-sambas' | 'security' | 'security-sambas' | 'vendor'

export interface Account {
  email: string
  password: string
  /** Peran yang dikembalikan `GET /auth/me` untuk akun ini. */
  role: string
  locationId: string | null
}

export const ACCOUNTS: Record<Role, Account> = {
  super: {
    email: 'superadmin@thc.net.id',
    password: DEFAULT_PASSWORD,
    role: 'super_admin',
    locationId: null,
  },
  admin: {
    email: 'admin1@thc.com',
    password: DEFAULT_PASSWORD,
    role: 'admin',
    locationId: '868430ab-ed33-552b-8619-0b7376537262',
  },
  'admin-sambas': {
    email: 'admin2@thc.com',
    password: DEFAULT_PASSWORD,
    role: 'admin',
    locationId: '7a6ce73e-2759-572d-bfe9-c5c4c7faee67',
  },
  security: {
    email: 'security1a@thc.com',
    password: DEFAULT_PASSWORD,
    role: 'security',
    locationId: '868430ab-ed33-552b-8619-0b7376537262',
  },
  'security-sambas': {
    email: 'security2a@thc.com',
    password: DEFAULT_PASSWORD,
    role: 'security',
    locationId: '7a6ce73e-2759-572d-bfe9-c5c4c7faee67',
  },
  vendor: {
    email: 'vendor1a@thc.com',
    password: DEFAULT_PASSWORD,
    role: 'vendor',
    locationId: null,
  },
}

/** ID fasilitas seed (lihat docs/5. LOCAL_DEV.md). */
export const LOCATIONS = {
  hq: '868430ab-ed33-552b-8619-0b7376537262',
  sambas: '7a6ce73e-2759-572d-bfe9-c5c4c7faee67',
  mempawah: 'f985f658-08ac-506e-a4ca-675d9de8cac7',
  singkawang: 'fcc5f32d-51a2-511f-a88f-571177d33e32',
  aruk: '78485f37-b174-5d35-871e-6ae6082147b9',
} as const

/** Peta nama purpose katalog -> UUID (seed). */
export const PURPOSES: Record<string, string> = {
  'Splicing & Maintenance Kabel Fiber Optik': 'f97105bd-08d4-56c1-9a49-494bfe5f5482',
  'Maintenance Genset & Sistem Catu Daya UPS': '66e53f2d-8e3b-54dd-b444-6be64be802c8',
  'Troubleshooting Perangkat Server & Router ISP': '0c3a0afa-c7bb-525a-b4f7-e205e1f1b240',
  'Preventive Maintenance & Kebersihan Shelter': 'c1e5e97b-a8d2-5d8f-ab7d-6974e9791ee8',
  'Pengantaran / Penarikan Perangkat & Sparepart': '7774470a-b79f-5446-bbad-d2e00635a98f',
  'Survey Jalur / Audit Infrastruktur': '883b74bc-38b5-5bb7-96b2-e45287b55255',
}

export interface User {
  id: string
  name: string
  email: string
  phone?: string
  nik: string | null
  role: string
  location_id: string | null
  location_name: string | null
  status: string
  type: string
  vendor_name: string | null
}

export interface LoginResult {
  token: string
  user: User
}

/**
 * Bentuk minimal `VisitDetail` dari openapi yang dipakai harness. Field
 * opsional hanya diisi bila backend benar-benar mengirimkannya.
 */
export interface VisitRecord {
  id: string
  visit_id?: string
  status: string
  location_id?: string
  start_date?: string
  end_date?: string
  notes?: string
  location?: { id: string; name?: string; type?: string }
  visitors?: Array<{
    id?: string
    name: string
    id_number: string
    phone: string
    id_card_photo_url?: string | null
    photo_url?: string | null
  }>
}

export interface ApiSuccess<T> {
  success: true
  data: T
}

export interface ApiFailure {
  success: false
  error: { code: string; message: string }
}

export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure

export interface ApiResult<T> {
  status: number
  body: T
}

function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path
  }
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFailureEnvelope(value: unknown): value is ApiFailure {
  return (
    isRecord(value) &&
    value.success === false &&
    isRecord(value.error) &&
    typeof value.error.message === 'string'
  )
}

function parseBody(text: string): unknown {
  if (text === '') {
    return undefined
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function describeBody(body: unknown): string {
  if (typeof body === 'string') {
    return body
  }
  try {
    return JSON.stringify(body)
  } catch {
    return String(body)
  }
}

// Produksi membatasi login 5/menit/IP (fixed window, `AUTH_RATE_LIMIT`).
// Suite LIVE berbagi satu IP dengan pengguna nyata, jadi anggaran login dijaga
// di sini - bukan dengan melonggarkan batas keamanan server. Dua syarat
// berlaku sekaligus: jarak minimum `E2E_LOGIN_PACING_MS` antar-percobaan dan
// kuota bergulir 4 login/60 detik (satu slot di bawah batas server) supaya
// jalur API dan UI tidak pernah bertabrakan menjadi burst. Default 0 = tanpa
// pacing (lokal).
const LOGIN_PACING_MS = Number(process.env.E2E_LOGIN_PACING_MS ?? 0)
const AUTH_WINDOW_MS = 60_000
const AUTH_MAX_PER_WINDOW = 4
const AUTH_RETRIES_ON_429 = 2
const loginHits: number[] = []
let nextLoginAt = 0

/**
 * Ambil satu slot login: tunggu sampai jarak minimum dan kuota bergulir
 * terpenuhi, lalu catat percobaannya. Dipakai juga oleh `auth-ui.spec.ts`
 * agar login lewat UI dan lewat API berbagi satu anggaran yang sama.
 */
export async function awaitLoginSlot(): Promise<void> {
  if (LOGIN_PACING_MS <= 0) {
    return
  }
  for (;;) {
    const now = Date.now()
    while (loginHits.length > 0 && now - (loginHits[0] ?? now) >= AUTH_WINDOW_MS) {
      loginHits.shift()
    }
    const oldest = loginHits[0]
    const spacingWait = Math.max(0, nextLoginAt - now)
    const quotaWait =
      oldest !== undefined && loginHits.length >= AUTH_MAX_PER_WINDOW
        ? AUTH_WINDOW_MS - (now - oldest)
        : 0
    const waitMs = Math.max(spacingWait, quotaWait)
    if (waitMs <= 0) {
      break
    }
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs))
  }
  const now = Date.now()
  loginHits.push(now)
  nextLoginAt = now + LOGIN_PACING_MS
}

/**
 * Kirim request dan kembalikan status + body MENTAH (tanpa melempar).
 * Body JSON hanya dikirim bila `body !== undefined`; respons 204 dibiarkan
 * `undefined`.
 */
export async function apiFetchRaw<T = unknown>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const isLogin = method === 'POST' && path === '/auth/login'
  const maxAttempts = isLogin ? AUTH_RETRIES_ON_429 + 1 : 1
  const headers: Record<string, string> = {
    accept: 'application/json',
  }
  if (token !== '') {
    headers.authorization = `Bearer ${token}`
  }
  const init: RequestInit = { method, headers }
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }

  for (let attempt = 1; ; attempt += 1) {
    if (isLogin) {
      await awaitLoginSlot()
    }
    let response: Response
    try {
      response = await fetch(apiUrl(path), init)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`[api] ${method} ${path} gagal terhubung ke backend: ${reason}`)
    }

    const text = await response.text()
    const result: ApiResult<T> = { status: response.status, body: parseBody(text) as T }
    if (!isLogin || result.status !== 429 || attempt >= maxAttempts) {
      return result
    }
    await new Promise<void>((resolve) => setTimeout(resolve, AUTH_WINDOW_MS))
  }
}

/**
 * Seperti `apiFetchRaw`, tetapi melempar `Error` (status + body) bila respons
 * bukan 2xx atau amplop sukses tidak membawa `success: true`.
 */
export async function apiFetch<T = unknown>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const result = await apiFetchRaw<T>(token, method, path, body)
  if (result.status < 200 || result.status >= 300) {
    throw new Error(
      `[api] ${method} ${path} -> HTTP ${result.status}: ${describeBody(result.body)}`,
    )
  }
  if (isFailureEnvelope(result.body)) {
    throw new Error(
      `[api] ${method} ${path} -> ${result.body.error.code}: ${result.body.error.message}`,
    )
  }
  return result
}

const cachedLogins = new Map<string, LoginResult>()

/**
 * Varian `loginViaApi` dengan cache proses: satu peran cukup login sekali per
 * worker. Spec yang memang menguji login tetap memakai `loginViaApi` mentah.
 */
export async function loginViaApiCached(
  email: string,
  password: string,
): Promise<LoginResult> {
  const key = `${email}\u0000${password}`
  const cached = cachedLogins.get(key)
  if (cached !== undefined) {
    return cached
  }
  const result = await loginViaApi(email, password)
  cachedLogins.set(key, result)
  return result
}

/** Login lewat API (bukan UI) dan kembalikan token + profil user. */
export async function loginViaApi(email: string, password: string): Promise<LoginResult> {
  const result = await apiFetchRaw<ApiEnvelope<LoginResult>>('', 'POST', '/auth/login', {
    email,
    password,
  })
  if (result.status !== 200 || !isRecord(result.body) || result.body.success !== true) {
    throw new Error(
      `[api] login ${email} gagal (HTTP ${result.status}): ${describeBody(result.body)}`,
    )
  }
  const data = result.body.data
  if (!isRecord(data) || typeof data.token !== 'string' || !isRecord(data.user)) {
    throw new Error(`[api] login ${email}: respons tidak memuat token/user yang valid.`)
  }
  return { token: data.token, user: data.user as unknown as User }
}

function toVisitRecord(data: unknown): VisitRecord {
  if (!isRecord(data) || typeof data.id !== 'string' || typeof data.status !== 'string') {
    throw new Error(`[api] respons kunjungan tidak valid: ${describeBody(data)}`)
  }
  const location = isRecord(data.location) ? data.location : undefined
  const locationId =
    location !== undefined && typeof location.id === 'string' ? location.id : undefined
  const record: VisitRecord = {
    id: data.id,
    status: data.status,
  }
  if (typeof data.visit_id === 'string') record.visit_id = data.visit_id
  if (typeof data.start_date === 'string') record.start_date = data.start_date
  if (typeof data.end_date === 'string') record.end_date = data.end_date
  if (typeof data.notes === 'string') record.notes = data.notes
  if (locationId !== undefined) record.location_id = locationId
  if (location !== undefined) {
    record.location = {
      id: locationId ?? '',
      ...(typeof location.name === 'string' ? { name: location.name } : {}),
      ...(typeof location.type === 'string' ? { type: location.type } : {}),
    }
  }
  if (Array.isArray(data.visitors)) {
    record.visitors = data.visitors.filter(isRecord).map((visitor) => ({
      name: typeof visitor.name === 'string' ? visitor.name : '',
      id_number: typeof visitor.id_number === 'string' ? visitor.id_number : '',
      phone: typeof visitor.phone === 'string' ? visitor.phone : '',
      ...(typeof visitor.id_card_photo_url === 'string' || visitor.id_card_photo_url === null
        ? { id_card_photo_url: visitor.id_card_photo_url }
        : {}),
      ...(typeof visitor.photo_url === 'string' || visitor.photo_url === null
        ? { photo_url: visitor.photo_url }
        : {}),
      ...(typeof visitor.id === 'string' ? { id: visitor.id } : {}),
    }))
  }
  return record
}

/** `POST /visits` — membuat kunjungan (status awal `requested`). */
export async function createVisitViaApi(
  token: string,
  payload: Record<string, unknown>,
): Promise<VisitRecord> {
  const result = await apiFetch<ApiEnvelope<unknown>>(token, 'POST', '/visits', payload)
  if (!isRecord(result.body) || result.body.success !== true) {
    throw new Error(`[api] create visit: amplop sukses tidak valid.`)
  }
  return toVisitRecord(result.body.data)
}

/** `GET /visits/{id}` — UUID maupun kode `VST-...` diterima backend. */
export async function getVisitViaApi(token: string, id: string): Promise<VisitRecord> {
  const result = await apiFetch<ApiEnvelope<unknown>>(
    token,
    'GET',
    `/visits/${encodeURIComponent(id)}`,
  )
  if (!isRecord(result.body) || result.body.success !== true) {
    throw new Error(`[api] get visit: amplop sukses tidak valid.`)
  }
  return toVisitRecord(result.body.data)
}

/**
 * `POST /uploads` (multipart/form-data) — field `category` + `file`.
 * Backend memvalidasi MIME dari header part (pdf/jpeg/png) dan ukuran <= 5 MB.
 */
export async function uploadFileViaApi(
  token: string,
  category: string,
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<{ fileUrl: string; fileName: string }> {
  const form = new FormData()
  form.append('category', category)
  form.append(
    'file',
    new Blob([new Uint8Array(file.buffer)], { type: file.mimeType }),
    file.name,
  )

  let response: Response
  try {
    response = await fetch(apiUrl('/uploads'), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: form,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`[api] POST /uploads gagal terhubung ke backend: ${reason}`)
  }

  const text = await response.text()
  const body = parseBody(text)
  if (!response.ok || isFailureEnvelope(body)) {
    throw new Error(`[api] POST /uploads -> HTTP ${response.status}: ${describeBody(body)}`)
  }
  if (!isRecord(body) || body.success !== true || !isRecord(body.data)) {
    throw new Error(`[api] POST /uploads: amplop sukses tidak valid: ${text}`)
  }
  const fileUrl = body.data.file_url
  const fileName = body.data.file_name
  if (typeof fileUrl !== 'string' || typeof fileName !== 'string') {
    throw new Error(`[api] POST /uploads: data.file_url/file_name tidak ada: ${text}`)
  }
  return { fileUrl, fileName }
}

/** `POST /visits/{id}/approve` — body opsional `{ notes }`. */
export async function approveVisitViaApi(
  token: string,
  id: string,
  note?: string,
): Promise<void> {
  await apiFetch(token, 'POST', `/visits/${encodeURIComponent(id)}/approve`, {
    notes: note ?? '',
  })
}

/** `POST /visits/{id}/reject` — body wajib `{ reason }` (min 5 karakter). */
export async function rejectVisitViaApi(
  token: string,
  id: string,
  reason: string,
): Promise<void> {
  await apiFetch(token, 'POST', `/visits/${encodeURIComponent(id)}/reject`, { reason })
}

/**
 * `POST /visits/{id}/reschedule` — openapi mewajibkan `start_date`, `end_date`,
 * dan `reason`. Signature kontrak tidak membawa `reason`, jadi helper memakai
 * alasan tetap yang jelas; spec yang butuh alasan khusus bisa memanggil
 * `apiFetch` langsung.
 */
export async function rescheduleVisitViaApi(
  token: string,
  id: string,
  startDate: string,
  endDate: string,
): Promise<void> {
  await apiFetch(token, 'POST', `/visits/${encodeURIComponent(id)}/reschedule`, {
    start_date: startDate,
    end_date: endDate,
    reason: 'Penjadwalan ulang oleh harness E2E.',
  })
}

/** `POST /visits/{id}/checkin` — body opsional; token harus gate staff. */
export async function checkInViaApi(token: string, id: string): Promise<void> {
  await apiFetch(token, 'POST', `/visits/${encodeURIComponent(id)}/checkin`, {})
}

/** `POST /visits/{id}/checkout` — id harus UUID (backend tidak menerima VST code). */
export async function checkOutViaApi(token: string, id: string): Promise<void> {
  await apiFetch(token, 'POST', `/visits/${encodeURIComponent(id)}/checkout`, {})
}

/** `DELETE /visits/{id}` — super_admin, 204 tanpa body. */
export async function deleteVisitViaApi(token: string, id: string): Promise<void> {
  await apiFetch(token, 'DELETE', `/visits/${encodeURIComponent(id)}`)
}
