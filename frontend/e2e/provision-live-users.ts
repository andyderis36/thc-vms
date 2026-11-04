/**
 * Provisi akun E2E sekali pakai untuk target LIVE maupun lokal.
 *
 * Dipanggil oleh `e2e.ps1` SEBELUM suite berjalan supaya run yang menembak
 * backend tanpa akun seed (produksi) tetap punya enam akun harness
 * (admin, security, vendor, admin2, security2, vendor2) yang terisolasi
 * per run-id.
 *
 * Pemakaian:
 *   E2E_API_BASE_URL=http://localhost:8080/api/v1 E2E_LOCAL_PROVISION=1 node e2e/provision-live-users.ts
 *   E2E_API_BASE_URL=https://thc.example.com/api/v1 E2E_LIVE_PROVISION=1 node e2e/provision-live-users.ts
 *
 * Aturan aman:
 * - GATING: tanpa `E2E_API_BASE_URL` + (`E2E_LIVE_PROVISION=1` ATAU
 *   `E2E_LOCAL_PROVISION=1`) + kredensial superadmin yang lolos login,
 *   skrip exit 0 sebagai no-op ("provisioning skipped") TANPA satu pun
 *   panggilan HTTP.
 * - Email selalu `e2e-<runid>-<role>@<domain E2E_EMAIL_SUPERADMIN>` sehingga
 *   cocok dengan USER_MARKER di `sweep.ts` (sapuan pra-run berikutnya dapat
 *   membersihkannya) dan tidak pernah menabrak akun seed.
 * - Vendor dibuat lewat `POST /auth/register` (role selalu vendor, status
 *   awal pending — backend baru; legacy inactive tetap diterima) lalu
 *   diaktifkan superadmin via `PATCH /users/{id}/status {"status":"active"}`;
 *   admin cabang (HQ) lewat
 *   `POST /users` role admin; pengawas lewat `POST /users/security`.
 *   Payload mengikuti `backend/internal/delivery/http/handlers/*_handler.go`
 *   dan `docs/4. openapi.yaml` — bukan dari ingatan.
 * - Seluruh akun memakai kata sandi operator yang sama (`E2E_PASSWORD`,
 *   juga dipakai `ACCOUNTS.*.password`): menimpa `E2E_PASSWORD` dengan nilai
 *   acak akan MERUSAK login superadmin untuk sisa run, jadi tidak ada kata
 *   sandi acak dan tidak ada ekspor rahasia apa pun.
 * - Langkah berjalan sekuensial dengan jeda `E2E_LOGIN_PACING_MS`
 *   (default 13000) antar-langkah agar tidak menabrak rate limiter login.
 *
 * Ekspor: blok `BEGIN_EXPORT`/`END_EXPORT` berisi baris `KEY=VALUE`
 * (`E2E_RUN_ID`, `E2E_EMAIL_ADMIN`, `E2E_EMAIL_SECURITY`, `E2E_EMAIL_VENDOR`,
 * `E2E_EMAIL_ADMIN2`, `E2E_EMAIL_SECURITY2`, `E2E_EMAIL_VENDOR2`) untuk
 * diinjeksi `e2e.ps1` ke environment run. Tanpa baris rahasia.
 *
 * Teardown mandiri (ledger-based self-delete):
 *   node e2e/provision-live-users.ts --teardown-only [--run-id <id>]
 *     [--email <addr> ...] [--ledger <path>]
 * Membaca email target dari argv (`--email`/`--run-id`), env (`E2E_RUN_ID`,
 * `E2E_EMAIL_ADMIN`/`E2E_EMAIL_SECURITY`/`E2E_EMAIL_VENDOR`,
 * `E2E_EMAIL_ADMIN2`/`E2E_EMAIL_SECURITY2`/`E2E_EMAIL_VENDOR2`,
 * `E2E_PROVISION_LEDGER`), dan ledger temp
 * (`$TEMP/e2e-provision-<runid>.json`, ditulis otomatis tiap provisi sukses;
 * bila `--run-id` tak dikenal, seluruh ledger temp dipindai). Lookup
 * exact-email via `GET /users` + `GET /users/security`, hapus via
 * `DELETE /users/{id}` + `/users/security/{id}`; 204/404 toleran, kunjungan
 * TIDAK disentuh di sini (itu tugas `sweep.ts`), himpunan parsial aman
 * (email tak dikenal = dilewati dengan log). Hanya email berpola harness
 * `e2e-...` yang boleh dihapus sehingga akun seed tak pernah tersentuh;
 * sapuan pola `sweep.ts` tetap menjadi fallback.
 *
 * Login/token/base URL memakai ulang `e2e/helpers/api.ts` (bukan klien HTTP
 * baru). Node 24 menjalankan `.ts` via type stripping, jadi tidak perlu
 * dependency tambahan.
 */

import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Row = Record<string, unknown>

interface ApiResponse {
  status: number
  body: unknown
}

interface ProvisionApi {
  ACCOUNTS: Record<string, { email: string; password: string }>
  LOCATIONS: { hq: string }
  loginViaApi(email: string, password: string): Promise<{ token: string }>
  apiFetchRaw(token: string, method: string, path: string, body?: unknown): Promise<ApiResponse>
}

export interface ProvisionEmails {
  admin: string
  security: string
  vendor: string
  admin2: string
  security2: string
  vendor2: string
}

interface GateDecision {
  proceed: boolean
  reason: string
}

const API_MODULE_URL = new URL('./helpers/api.ts', import.meta.url).href
const DEFAULT_DOMAIN = 'transhybrid.net.id'
const DEFAULT_PACING_MS = 13000
const EXPORT_BEGIN = 'BEGIN_EXPORT'
const EXPORT_END = 'END_EXPORT'

function log(message: string): void {
  console.log(`[e2e-provision] ${message}`)
}

function fail(message: string): never {
  console.error(`[e2e-provision] ABORT ${message}`)
  process.exit(1)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function describe(value: unknown): string {
  if (typeof value === 'string') {
    return value.slice(0, 300)
  }
  try {
    return (JSON.stringify(value) ?? '').slice(0, 300)
  } catch {
    return String(value)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/** Jeda antar-langkah; default 13000, override via `E2E_LOGIN_PACING_MS`. */
export function pacingMs(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.E2E_LOGIN_PACING_MS ?? '').trim()
  if (raw === '') {
    return DEFAULT_PACING_MS
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_PACING_MS
  }
  return Math.trunc(parsed)
}

/**
 * Keputusan gating MURNI (tanpa I/O): lanjut hanya bila base URL diset dan
 * salah satu flag provisi aktif. Autentikasi superadmin dicek menyusul di
 * `main` (gagal login = skipped, bukan abort).
 */
export function evaluateGate(env: Record<string, string | undefined> = process.env): GateDecision {
  if ((env.E2E_API_BASE_URL ?? '').trim() === '') {
    return { proceed: false, reason: 'E2E_API_BASE_URL belum diset' }
  }
  if (env.E2E_LIVE_PROVISION !== '1' && env.E2E_LOCAL_PROVISION !== '1') {
    return { proceed: false, reason: 'E2E_LIVE_PROVISION/E2E_LOCAL_PROVISION bukan 1' }
  }
  return { proceed: true, reason: 'ok' }
}

/** Normalisasi run-id ke huruf kecil alfanumerik-strip (cocok USER_MARKER). */
export function sanitizeRunId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
}

/** Run-id dari `E2E_RUN_ID`, atau hasil generate `base36(time)+acak`. */
export function makeRunId(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = sanitizeRunId(env.E2E_RUN_ID ?? '')
  if (fromEnv !== '') {
    return fromEnv
  }
  const time = Date.now().toString(36)
  const rand = randomBytes(3).toString('hex')
  return sanitizeRunId(`${time}-${rand}`)
}

/** Domain email harness = domain `E2E_EMAIL_SUPERADMIN` (default seed lokal). */
export function emailDomain(env: Record<string, string | undefined> = process.env): string {
  const superEmail = (env.E2E_EMAIL_SUPERADMIN ?? '').trim()
  if (superEmail.includes('@')) {
    const domain = superEmail.split('@')[1] ?? ''
    if (domain !== '') {
      return domain.toLowerCase()
    }
  }
  return DEFAULT_DOMAIN
}

/** `e2e-<runid>-<role>@<domain>`: unik per run, cocok USER_MARKER sweep.ts. */
export function buildEmails(runId: string, domain: string): ProvisionEmails {
  const local = `e2e-${sanitizeRunId(runId)}`
  return {
    admin: `${local}-admin@${domain.toLowerCase()}`,
    security: `${local}-security@${domain.toLowerCase()}`,
    vendor: `${local}-vendor@${domain.toLowerCase()}`,
    admin2: `${local}-admin2@${domain.toLowerCase()}`,
    security2: `${local}-security2@${domain.toLowerCase()}`,
    vendor2: `${local}-vendor2@${domain.toLowerCase()}`,
  }
}

/** Lokasi provision = hasil GET /locations saat runtime (UUID lokal beda dgn prod). */
export interface ProvisionLocation {
  id: string
  name: string
}

/** Pilih lokasi: nama mengandung "pusat" (case-insensitive), else pertama abjad. */
export function resolveProvisionLocationId(locations: ProvisionLocation[]): string {
  const sorted = [...locations]
    .filter((l) => l.id !== '')
    .sort((a, b) => a.name.localeCompare(b.name))
  const hq = sorted.find((l) => l.name.toLowerCase().includes('pusat'))
  const picked = hq ?? sorted[0]
  return picked === undefined ? '' : picked.id
}

/**
 * Pilih lokasi KEDUA untuk admin2/security2: non-primer pertama abjad,
 * prefer nama mengandung "sambas" (case-insensitive); fallback id primer
 * (HQ) bila tidak ada kandidat lain.
 */
export function resolveSecondLocationId(locations: ProvisionLocation[], primaryId: string): string {
  const candidates = [...locations]
    .filter((l) => l.id !== '' && l.id !== primaryId)
    .sort((a, b) => a.name.localeCompare(b.name))
  if (candidates.length === 0) {
    return primaryId
  }
  const sambas = candidates.find((l) => l.name.toLowerCase().includes('sambas'))
  const picked = sambas ?? candidates[0]
  return picked === undefined ? primaryId : picked.id
}

/** NIK 16-digit unik (`9` + 9 digit waktu + 6 digit acak kripto; kolom NIK UNIQUE). */
export function makeNik(): string {
  const time = String(Date.now()).slice(-9).padStart(9, '0')
  const rand = String(randomBytes(4).readUInt32BE(0) % 1000000).padStart(6, '0')
  return `9${time}${rand}`
}

/** Baris ekspor `KEY=VALUE` untuk injeksi `e2e.ps1` (tanpa rahasia). */
export function buildExportLines(runId: string, emails: ProvisionEmails): string[] {
  return [
    `E2E_RUN_ID=${runId}`,
    `E2E_EMAIL_ADMIN=${emails.admin}`,
    `E2E_EMAIL_SECURITY=${emails.security}`,
    `E2E_EMAIL_VENDOR=${emails.vendor}`,
    `E2E_EMAIL_ADMIN2=${emails.admin2}`,
    `E2E_EMAIL_SECURITY2=${emails.security2}`,
    `E2E_EMAIL_VENDOR2=${emails.vendor2}`,
  ]
}

/** `true` bila argv meminta mode teardown (`--teardown-only`). */
export function isTeardownOnly(argv: string[] = process.argv.slice(2)): boolean {
  return argv.includes('--teardown-only')
}

export interface TeardownArgs {
  runId: string
  emails: string[]
  ledgerPath: string
}

/** Parse argv teardown: `--run-id <id>`, `--email <addr>` (berulang), `--ledger <path>`. */
export function parseTeardownArgs(argv: string[] = process.argv.slice(2)): TeardownArgs {
  let runId = ''
  const emails: string[] = []
  let ledgerPath = ''
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? ''
    if (arg === '--run-id' && i + 1 < argv.length) {
      runId = sanitizeRunId(argv[i + 1] ?? '')
      i += 1
    } else if (arg.startsWith('--run-id=')) {
      runId = sanitizeRunId(arg.slice('--run-id='.length))
    } else if (arg === '--email' && i + 1 < argv.length) {
      emails.push((argv[i + 1] ?? '').trim())
      i += 1
    } else if (arg.startsWith('--email=')) {
      emails.push(arg.slice('--email='.length).trim())
    } else if (arg === '--ledger' && i + 1 < argv.length) {
      ledgerPath = (argv[i + 1] ?? '').trim()
      i += 1
    } else if (arg.startsWith('--ledger=')) {
      ledgerPath = arg.slice('--ledger='.length).trim()
    }
  }
  return { runId, emails: emails.filter((email) => email !== ''), ledgerPath }
}

const LEDGER_PREFIX = 'e2e-provision-'

/** Path ledger temp untuk satu run-id (`E2E_PROVISION_LEDGER_DIR` override dir). */
export function ledgerPathFor(
  runId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const dir = (env.E2E_PROVISION_LEDGER_DIR ?? '').trim() !== ''
    ? (env.E2E_PROVISION_LEDGER_DIR ?? '').trim()
    : tmpdir()
  return join(dir, `${LEDGER_PREFIX}${sanitizeRunId(runId)}.json`)
}

/**
 * Tulis ledger temp `{ runId, emails }` (best-effort: TIDAK PERNAH
 * menggagalkan provisi; hanya di memori + file temp, tanpa kata sandi).
 */
export function writeLedger(
  runId: string,
  emails: ProvisionEmails,
  env: Record<string, string | undefined> = process.env,
): string {
  const path = ledgerPathFor(runId, env)
  try {
    writeFileSync(
      path,
      JSON.stringify({
        runId,
        emails: [emails.admin, emails.security, emails.vendor, emails.admin2, emails.security2, emails.vendor2],
      }),
      'utf8',
    )
    return path
  } catch {
    return ''
  }
}

/** Baca satu berkas ledger; korup/hilang = `{ runId: '', emails: [] }`. */
export function readLedgerFile(path: string): { runId: string; emails: string[] } {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { runId: '', emails: [] }
    }
    const row = parsed as Record<string, unknown>
    const runId = typeof row.runId === 'string' ? sanitizeRunId(row.runId) : ''
    const emails = Array.isArray(row.emails)
      ? row.emails.filter((email): email is string => typeof email === 'string' && email !== '')
      : []
    return { runId, emails }
  } catch {
    return { runId: '', emails: [] }
  }
}

/** Pindai seluruh ledger temp; bila `runId` dikenal hanya ledger itu yang dibaca. Berkas korup dilewati diam-diam (partial-set safe). */
export function scanTempLedgers(
  runId: string,
  envOrScanDir: Record<string, string | undefined> | string = process.env,
  scanDir: string = tmpdir(),
): string[] {
  const env =
    typeof envOrScanDir === 'string'
      ? { ...process.env, E2E_PROVISION_LEDGER_DIR: envOrScanDir }
      : envOrScanDir
  const dir =
    typeof envOrScanDir === 'string'
      ? envOrScanDir
      : (env.E2E_PROVISION_LEDGER_DIR ?? '').trim() !== ''
        ? (env.E2E_PROVISION_LEDGER_DIR ?? '').trim()
        : scanDir
  if (runId !== '') {
    return readLedgerFile(ledgerPathFor(runId, env)).emails
  }
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of names) {
    if (!name.startsWith(LEDGER_PREFIX) || !name.endsWith('.json')) {
      continue
    }
    out.push(...readLedgerFile(join(dir, name)).emails)
  }
  return out
}

/**
 * Hanya email harness `e2e-...@domain` yang boleh dihapus. Akun seed
 * (`vendor1a@`, `admin1@`, ...) tak berpola ini sehingga tak pernah cocok —
 * penjaga terakhir bila ledger korup.
 */
export function isHarnessEmail(email: string): boolean {
  return /^(?:[a-z0-9]+\.)?e2e-[a-z0-9][a-z0-9-]*@[^@\s]+$/i.test(email.trim())
}

export interface TeardownTargets {
  runId: string
  emails: string[]
}

/**
 * Kumpulkan email teardown (MURNI, tanpa I/O selain opendir temp):
 * argv `--email`/`--ledger`, env `E2E_EMAIL_*` + `E2E_RUN_ID`, ledger eksplisit
 * (`--ledger`/`E2E_PROVISION_LEDGER`), pindaian temp, dan rekonstruksi
 * `e2e-<runid>-<role>@domain` bila run-id dikenal. Dedup + huruf kecil.
 */
export function collectTeardownTargets(
  env: Record<string, string | undefined> = process.env,
  argv: string[] = process.argv.slice(2),
  scanDir: string = tmpdir(),
): TeardownTargets {
  const args = parseTeardownArgs(argv)
  const runId = args.runId !== '' ? args.runId : sanitizeRunId(env.E2E_RUN_ID ?? '')
  const found = new Map<string, string>()
  const add = (email: string): void => {
    const normalized = email.trim().toLowerCase()
    if (normalized !== '' && !found.has(normalized)) {
      found.set(normalized, normalized)
    }
  }
  for (const email of args.emails) {
    add(email)
  }
  for (const key of ['E2E_EMAIL_ADMIN', 'E2E_EMAIL_SECURITY', 'E2E_EMAIL_VENDOR', 'E2E_EMAIL_ADMIN2', 'E2E_EMAIL_SECURITY2', 'E2E_EMAIL_VENDOR2'] as const) {
    const value = env[key]
    if (value !== undefined) {
      add(value)
    }
  }
  const explicitLedger = args.ledgerPath !== '' ? args.ledgerPath : (env.E2E_PROVISION_LEDGER ?? '').trim()
  if (explicitLedger !== '') {
    for (const email of readLedgerFile(explicitLedger).emails) {
      add(email)
    }
  }
  for (const email of scanTempLedgers(runId, env, scanDir)) {
    add(email)
  }
  if (runId !== '') {
    const rebuilt = buildEmails(runId, emailDomain(env))
    add(rebuilt.admin)
    add(rebuilt.security)
    add(rebuilt.vendor)
    add(rebuilt.admin2)
    add(rebuilt.security2)
    add(rebuilt.vendor2)
  }
  return { runId, emails: [...found.values()] }
}

/**
 * Hapus akun teardown via lookup exact-email (`GET /users` +
 * `GET /users/security`) lalu `DELETE` endpoint per peran. 204/404 toleran
 * (idempoten); email tak terdaftar = dilewati dengan log (parsial aman);
 * email non-harness = dilewati (seed tak tersentuh). Kunjungan TIDAK
 * disentuh — `sweep.ts -Apply` (visits-first) harus jalan lebih dulu supaya
 * akun tak lagi menggendong kunjungan. Status selain 204/404 = batal.
 */
export async function teardownAccounts(
  api: ProvisionApi,
  token: string,
  emails: string[],
): Promise<{ deleted: string[]; missing: string[]; skipped: string[] }> {
  const wanted = new Map<string, string>()
  const skipped: string[] = []
  for (const email of emails) {
    const normalized = email.trim().toLowerCase()
    if (normalized === '' || wanted.has(normalized)) {
      continue
    }
    if (!isHarnessEmail(normalized)) {
      skipped.push(normalized)
      log(`lewati non-harness ${normalized} (bukan pola e2e-)`)
      continue
    }
    wanted.set(normalized, normalized)
  }
  if (wanted.size === 0) {
    return { deleted: [], missing: [], skipped }
  }
  const managed = expectArray(await api.apiFetchRaw(token, 'GET', '/users'), 'GET /users')
  const securities = expectArray(
    await api.apiFetchRaw(token, 'GET', '/users/security'),
    'GET /users/security',
  )
  const byEmail = new Map<string, { id: string; role: string }>()
  for (const row of [...managed, ...securities]) {
    const email = str(row.email).trim().toLowerCase()
    const id = str(row.id)
    if (!wanted.has(email) || id === '' || byEmail.has(email)) {
      continue
    }
    byEmail.set(email, { id, role: str(row.role) === 'security' ? 'security' : 'managed' })
  }
  const deleted: string[] = []
  const missing: string[] = []
  for (const email of wanted.keys()) {
    const hit = byEmail.get(email)
    if (hit === undefined) {
      missing.push(email)
      log(`teardown ${email} -> tidak terdaftar (lewati)`)
      continue
    }
    const endpoint = endpointFor(hit.role, hit.id)
    const result = await api.apiFetchRaw(token, 'DELETE', endpoint)
    if (result.status !== 204 && result.status !== 404) {
      fail(
        `teardown ${email} -> HTTP ${result.status} (harus 204/404): ${describe(result.body)}. ` +
          `Jalankan sweep -Apply dulu (kunjungan menggendong akun), lalu ulangi teardown.`,
      )
    }
    deleted.push(email)
    log(`teardown ${email} -> ${result.status}`)
  }
  return { deleted, missing, skipped }
}

/** Mode `--teardown-only`: butuh `E2E_API_BASE_URL` saja (tanpa flag provisi). */
async function runTeardown(argv: string[]): Promise<void> {
  const base = (process.env.E2E_API_BASE_URL ?? '').trim()
  if (base === '') {
    fail('E2E_API_BASE_URL belum diset; teardown dibatalkan')
  }
  if ((process.env.E2E_LOGIN_PACING_MS ?? '').trim() === '') {
    process.env.E2E_LOGIN_PACING_MS = String(DEFAULT_PACING_MS)
  }
  const api = await loadApi()
  const superAccount = api.ACCOUNTS.super
  if (superAccount === undefined) {
    fail('akun super tidak ada di helper ACCOUNTS')
  }
  let superToken: string
  try {
    superToken = (await api.loginViaApi(superAccount.email, superAccount.password)).token
  } catch (error) {
    fail(`login superadmin ${superAccount.email} gagal: ${errorMessage(error)}`)
  }
  const targets = collectTeardownTargets(process.env, argv)
  if (targets.emails.length === 0) {
    log('tidak ada target teardown (argv/env/ledger kosong); anggap bersih')
    return
  }
  log(
    `teardown ${targets.emails.length} email` +
      (targets.runId !== '' ? ` (run ${targets.runId})` : '') +
      '; kunjungan disentuh sweep, bukan di sini',
  )
  const result = await teardownAccounts(api, superToken, targets.emails)
  log(
    `teardown selesai: hapus=${result.deleted.length} ` +
      `tak-terdaftar=${result.missing.length} lewati-non-harness=${result.skipped.length}`,
  )
}

async function loadApi(): Promise<ProvisionApi> {
  try {
    return (await import(API_MODULE_URL)) as unknown as ProvisionApi
  } catch (error) {
    fail(`gagal memuat helper API (${API_MODULE_URL}): ${errorMessage(error)}`)
  }
}

/** Buka amplop `{ success, data: [...] }`; status/amplop aneh = batal. */
function expectArray(result: ApiResponse, context: string): Row[] {
  if (result.status !== 200) {
    fail(`${context} -> HTTP ${result.status}: ${describe(result.body)}`)
  }
  if (!isRecord(result.body) || result.body.success !== true) {
    fail(`${context} -> amplop respons tidak valid: ${describe(result.body)}`)
  }
  const data = result.body.data
  if (!Array.isArray(data)) {
    fail(`${context} -> data bukan array: ${describe(data)}`)
  }
  return data.filter(isRecord)
}

/** Ambil `data.id` dari amplop sukses create/patch; amplop aneh = batal. */
function expectId(result: ApiResponse, expectedStatus: number, context: string): string {
  if (result.status !== expectedStatus) {
    fail(`${context} -> HTTP ${result.status} (harus ${expectedStatus}): ${describe(result.body)}`)
  }
  if (!isRecord(result.body) || result.body.success !== true || !isRecord(result.body.data)) {
    fail(`${context} -> amplop respons tidak valid: ${describe(result.body)}`)
  }
  const id = str((result.body.data as Row).id)
  if (id === '') {
    fail(`${context} -> respons tanpa id: ${describe(result.body)}`)
  }
  return id
}

function endpointFor(role: string, id: string): string {
  const encoded = encodeURIComponent(id)
  return role === 'security' ? `/users/security/${encoded}` : `/users/${encoded}`
}

/**
 * Pra-hapus akun sisa run ini (cocok email persis): tabrakan 409 tidak boleh
 * terjadi karena email unik per run-id. Hapus gagal selain 204/404 = batal
 * dengan pesan eksplisit (mis. akun menggendong kunjungan).
 */
async function preDeleteRunAccounts(
  api: ProvisionApi,
  token: string,
  emails: ProvisionEmails,
): Promise<void> {
  const targets = new Map<string, string>([
    [emails.admin, 'admin'],
    [emails.security, 'security'],
    [emails.vendor, 'vendor'],
    [emails.admin2, 'admin'],
    [emails.security2, 'security'],
    [emails.vendor2, 'vendor'],
  ])
  const managed = expectArray(await api.apiFetchRaw(token, 'GET', '/users'), 'GET /users')
  const securities = expectArray(
    await api.apiFetchRaw(token, 'GET', '/users/security'),
    'GET /users/security',
  )
  const seen = new Set<string>()
  for (const row of [...managed, ...securities]) {
    const email = str(row.email).trim().toLowerCase()
    const id = str(row.id)
    const role = targets.get(email) ?? (str(row.role) === 'security' ? 'security' : 'managed')
    if (!targets.has(email) || id === '' || seen.has(id)) {
      continue
    }
    seen.add(id)
    const endpoint = endpointFor(role, id)
    const result = await api.apiFetchRaw(token, 'DELETE', endpoint)
    if (result.status !== 204 && result.status !== 404) {
      fail(
        `pra-hapus ${email} -> HTTP ${result.status} (harus 204/404): ${describe(result.body)}. ` +
          `Hapus manual akun tersebut sebelum run ulang.`,
      )
    }
    log(`pra-hapus ${email} -> ${result.status}`)
  }
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (isTeardownOnly(argv)) {
    await runTeardown(argv)
    return
  }
  const gate = evaluateGate()
  if (!gate.proceed) {
    log(`provisioning skipped (${gate.reason})`)
    return
  }
  // Default pacing 13000 diset SEBELUM helper diimpor: `helpers/api.ts`
  // membaca `E2E_LOGIN_PACING_MS` sekali saat modul dievaluasi, sehingga
  // login lewat helper ikut terjaga jaraknya.
  if ((process.env.E2E_LOGIN_PACING_MS ?? '').trim() === '') {
    process.env.E2E_LOGIN_PACING_MS = String(DEFAULT_PACING_MS)
  }

  const api = await loadApi()
  const superAccount = api.ACCOUNTS.super
  if (superAccount === undefined) {
    fail('akun super tidak ada di helper ACCOUNTS')
  }

  let superToken: string
  try {
    superToken = (await api.loginViaApi(superAccount.email, superAccount.password)).token
  } catch (error) {
    log(`provisioning skipped (login superadmin ${superAccount.email} gagal: ${errorMessage(error)})`)
    return
  }

  const runId = makeRunId()
  const emails = buildEmails(runId, emailDomain())
  // Kata sandi operator bersama (sama yang dipakai ACCOUNTS): acak/export
  // ulang E2E_PASSWORD akan merusak login superadmin sisa run.
  const password = process.env.E2E_PASSWORD ?? 'Password123!'
  const locRes = await api.apiFetchRaw(superToken, 'GET', '/locations')
  if (locRes.status !== 200) {
    fail(`GET /locations -> HTTP ${locRes.status} (harus 200): ${describe(locRes.body)}`)
  }
  const locList = (
    Array.isArray(locRes.body) ? locRes.body : ((locRes.body as { data?: unknown }).data ?? [])
  ) as ProvisionLocation[]
  const hq = resolveProvisionLocationId(locList)
  if (hq === '') {
    fail('GET /locations kosong: tidak ada lokasi untuk akun admin/security')
  }
  const second = resolveSecondLocationId(locList, hq)
  log(`run-id ${runId} domain ${emailDomain()} (6 akun: admin/security/vendor + admin2/security2/vendor2; lokasi kedua ${second})`)

  const pace = async (label: string): Promise<void> => {
    const ms = pacingMs()
    log(`jeda ${ms}ms sebelum ${label} (E2E_LOGIN_PACING_MS)`)
    await sleep(ms)
  }

  await preDeleteRunAccounts(api, superToken, emails)

  // ---- 1. vendor: register publik -> inactive, lalu aktifkan superadmin ----
  await pace('register vendor')
  const vendorId = expectId(
    await api.apiFetchRaw('', 'POST', '/auth/register', {
      name: `E2E Provision Vendor ${runId}`,
      email: emails.vendor,
      password,
      nik: makeNik(),
    }),
    201,
    'POST /auth/register (vendor)',
  )
  log(`register vendor ${emails.vendor} -> 201 id=${vendorId}`)

  await pace('aktivasi vendor')
  expectId(
    await api.apiFetchRaw(superToken, 'PATCH', `/users/${encodeURIComponent(vendorId)}/status`, {
      status: 'active',
    }),
    200,
    'PATCH /users/{vendorId}/status active',
  )
  log(`aktivasi vendor ${emails.vendor} -> 200 active`)

  await pace('verifikasi login vendor')
  const vendorLogin = await api.apiFetchRaw('', 'POST', '/auth/login', {
    email: emails.vendor,
    password,
  })
  if (vendorLogin.status !== 200) {
    fail(`login vendor ${emails.vendor} -> HTTP ${vendorLogin.status} (harus 200): ${describe(vendorLogin.body)}`)
  }
  log(`login vendor ${emails.vendor} -> 200`)

  // ---- 2. admin cabang HQ via POST /users (superadmin-only) ----
  await pace('create admin')
  const adminId = expectId(
    await api.apiFetchRaw(superToken, 'POST', '/users', {
      name: `E2E Provision Admin ${runId}`,
      email: emails.admin,
      password,
      nik: makeNik(),
      role: 'admin',
      location_id: hq,
    }),
    201,
    'POST /users (admin)',
  )
  log(`create admin ${emails.admin} -> 201 id=${adminId}`)

  await pace('verifikasi login admin')
  const adminLogin = await api.apiFetchRaw('', 'POST', '/auth/login', {
    email: emails.admin,
    password,
  })
  if (adminLogin.status !== 200) {
    fail(`login admin ${emails.admin} -> HTTP ${adminLogin.status} (harus 200): ${describe(adminLogin.body)}`)
  }
  log(`login admin ${emails.admin} -> 200`)

  // ---- 3. security via POST /users/security (superadmin wajib location_id) ----
  await pace('create security')
  const securityId = expectId(
    await api.apiFetchRaw(superToken, 'POST', '/users/security', {
      name: `E2E Provision Security ${runId}`,
      email: emails.security,
      password,
      location_id: hq,
    }),
    201,
    'POST /users/security',
  )
  log(`create security ${emails.security} -> 201 id=${securityId}`)

  await pace('verifikasi login security')
  const securityLogin = await api.apiFetchRaw('', 'POST', '/auth/login', {
    email: emails.security,
    password,
  })
  if (securityLogin.status !== 200) {
    fail(`login security ${emails.security} -> HTTP ${securityLogin.status} (harus 200): ${describe(securityLogin.body)}`)
  }
  log(`login security ${emails.security} -> 200`)

  // ---- 4. vendor2: register publik -> active, lalu verifikasi login ----
  await pace('register vendor2')
  const vendor2Id = expectId(
    await api.apiFetchRaw('', 'POST', '/auth/register', {
      name: `E2E Provision Vendor2 ${runId}`,
      email: emails.vendor2,
      password,
      nik: makeNik(),
    }),
    201,
    'POST /auth/register (vendor2)',
  )
  log(`register vendor2 ${emails.vendor2} -> 201 id=${vendor2Id}`)

  await pace('aktivasi vendor2')
  expectId(
    await api.apiFetchRaw(superToken, 'PATCH', `/users/${encodeURIComponent(vendor2Id)}/status`, {
      status: 'active',
    }),
    200,
    'PATCH /users/{vendor2Id}/status active',
  )
  log(`aktivasi vendor2 ${emails.vendor2} -> 200 active`)

  await pace('verifikasi login vendor2')
  const vendor2Login = await api.apiFetchRaw('', 'POST', '/auth/login', {
    email: emails.vendor2,
    password,
  })
  if (vendor2Login.status !== 200) {
    fail(`login vendor2 ${emails.vendor2} -> HTTP ${vendor2Login.status} (harus 200): ${describe(vendor2Login.body)}`)
  }
  log(`login vendor2 ${emails.vendor2} -> 200`)

  // ---- 5. admin2 lokasi kedua via POST /users (superadmin-only) ----
  await pace('create admin2')
  const admin2Id = expectId(
    await api.apiFetchRaw(superToken, 'POST', '/users', {
      name: `E2E Provision Admin2 ${runId}`,
      email: emails.admin2,
      password,
      nik: makeNik(),
      role: 'admin',
      location_id: second,
    }),
    201,
    'POST /users (admin2)',
  )
  log(`create admin2 ${emails.admin2} -> 201 id=${admin2Id}`)

  await pace('verifikasi login admin2')
  const admin2Login = await api.apiFetchRaw('', 'POST', '/auth/login', {
    email: emails.admin2,
    password,
  })
  if (admin2Login.status !== 200) {
    fail(`login admin2 ${emails.admin2} -> HTTP ${admin2Login.status} (harus 200): ${describe(admin2Login.body)}`)
  }
  log(`login admin2 ${emails.admin2} -> 200`)

  // ---- 6. security2 lokasi kedua via POST /users/security ----
  await pace('create security2')
  const security2Id = expectId(
    await api.apiFetchRaw(superToken, 'POST', '/users/security', {
      name: `E2E Provision Security2 ${runId}`,
      email: emails.security2,
      password,
      location_id: second,
    }),
    201,
    'POST /users/security (security2)',
  )
  log(`create security2 ${emails.security2} -> 201 id=${security2Id}`)

  await pace('verifikasi login security2')
  const security2Login = await api.apiFetchRaw('', 'POST', '/auth/login', {
    email: emails.security2,
    password,
  })
  if (security2Login.status !== 200) {
    fail(`login security2 ${emails.security2} -> HTTP ${security2Login.status} (harus 200): ${describe(security2Login.body)}`)
  }
  log(`login security2 ${emails.security2} -> 200`)

  for (const line of buildExportLines(runId, emails)) {
    log(line)
  }
  const ledgerPath = writeLedger(runId, emails)
  if (ledgerPath !== '') {
    log(`ledger teardown: ${ledgerPath}`)
  }
  console.log(`[e2e-provision] ${EXPORT_BEGIN}`)
  for (const line of buildExportLines(runId, emails)) {
    console.log(line)
  }
  console.log(`[e2e-provision] ${EXPORT_END}`)
  log('provisi 6 akun selesai (admin+security+vendor+admin2+security2+vendor2 login 200)')
}

const invokedAsScript = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('e2e/provision-live-users.ts')

if (invokedAsScript) {
  await main()
}
