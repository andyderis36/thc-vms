/**
 * Sapuan pra-run artefak E2E di target LIVE.
 *
 * Dipanggil oleh `e2e.ps1` SEBELUM suite berjalan (hanya mode live) supaya run
 * yang terputus (jaringan mati, Ctrl+C) tidak meninggalkan kunjungan/akun/
 * fasilitas uji yang lalu mempoison run berikutnya (mis. @QR-02/@QR-03 yang
 * mengharapkan vendor tanpa tiket aktif).
 *
 * Pemakaian:
 *   node e2e/sweep.ts           # DRY-RUN: daftar kandidat, tidak menghapus
 *   node e2e/sweep.ts --apply   # hapus kandidat; status selain 204/404 = batal
 *
 * Aturan aman:
 * - Hanya baris yang cocok pola nama harness yang disentuh:
 *   kunjungan: visit_id/notes/visitor name berawalan `E2E-`
  *   pengguna : `<prefix>.e2e-...@transhybrid.net.id` atau `e2e-...@transhybrid.net.id`
  *   fasilitas: nama berawalan `E2E-FAC`
  * - Akun seed (`vendor1a@transhybrid.net.id`, `security1a@transhybrid.net.id`, dst.) tidak pernah
 *   cocok dengan pola di atas.
 * - Respons hapus yang bukan 204/404 menghentikan seluruh sapuan (exit 1)
 *   supaya runner tidak lanjut menembak suite di atas state yang tidak bersih.
 *
 * Login/token/base URL memakai ulang `e2e/helpers/api.ts` (bukan klien HTTP
 * baru). Node 24 menjalankan `.ts` via type stripping, jadi tidak perlu
 * dependency tambahan.
 */

type Row = Record<string, unknown>

interface ApiResponse {
  status: number
  body: unknown
}

interface SweepApi {
  ACCOUNTS: Record<string, { email: string; password: string }>
  loginViaApi(email: string, password: string): Promise<{ token: string }>
  apiFetchRaw(token: string, method: string, path: string): Promise<ApiResponse>
}

type Kind = 'visit' | 'user' | 'facility'

interface Candidate {
  kind: Kind
  id: string
  endpoint: string
  detail: string
}

const APPLY = process.argv.includes('--apply')
const API_MODULE_URL = new URL('./helpers/api.ts', import.meta.url).href
const MAX_VISIT_PAGES = 200
const VISIT_MARKER = /(?:^|\|\s*)E2E-[A-Za-z0-9]/
// Domain akun seed bisa di-override (prod memakai @thc.net.id/@thc.com); regex
// dibangun dari env yang sama dengan ACCOUNTS, default transhybrid.net.id, dan
// tetap menerima domain default agar sapuan lokal tidak regresi.
const SWEEP_USER_DOMAINS = new Set<string>(['transhybrid.net.id'])
for (const candidate of [
  process.env.E2E_EMAIL_SUPERADMIN,
  process.env.E2E_EMAIL_ADMIN,
  process.env.E2E_EMAIL_ADMIN2,
  process.env.E2E_EMAIL_SECURITY,
  process.env.E2E_EMAIL_SECURITY2,
  process.env.E2E_EMAIL_VENDOR,
]) {
  const domain = candidate?.includes('@') ? candidate.split('@')[1] : ''
  if (domain) SWEEP_USER_DOMAINS.add(domain)
}
const USER_MARKER = new RegExp(
  `^(?:[a-z0-9]+\\.)?e2e-[a-z0-9][a-z0-9-]*@(?:${[...SWEEP_USER_DOMAINS]
    .map((d) => d.replace(/\./g, '\\.'))
    .join('|')})$`,
  'i',
)
const FACILITY_MARKER = /^E2E-FAC/i

function log(message: string): void {
  console.log(`[e2e-sweep] ${message}`)
}

function fail(message: string): never {
  console.error(`[e2e-sweep] ABORT ${message}`)
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

async function loadApi(): Promise<SweepApi> {
  try {
    return (await import(API_MODULE_URL)) as unknown as SweepApi
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

/** Telusuri seluruh halaman `GET /visits` (maks 100 baris/halaman). */
async function listAllVisits(api: SweepApi, token: string): Promise<Row[]> {
  const items: Row[] = []
  for (let page = 1; page <= MAX_VISIT_PAGES; page += 1) {
    const path = `/visits?page=${page}&limit=100&sort_by=created_at&order=desc`
    const result = await api.apiFetchRaw(token, 'GET', path)
    if (result.status !== 200) {
      fail(`GET /visits?page=${page} -> HTTP ${result.status}: ${describe(result.body)}`)
    }
    if (
      !isRecord(result.body) ||
      result.body.success !== true ||
      !isRecord(result.body.data)
    ) {
      fail(`GET /visits?page=${page} -> amplop respons tidak valid`)
    }
    const data = result.body.data
    const pageItems = data.items
    if (!Array.isArray(pageItems)) {
      fail(`GET /visits?page=${page} -> items bukan array`)
    }
    items.push(...pageItems.filter(isRecord))
    const total = typeof data.total === 'number' ? data.total : items.length
    if (pageItems.length === 0 || items.length >= total) {
      return items
    }
  }
  fail(`paginasi /visits melebihi ${MAX_VISIT_PAGES} halaman; hentikan sapuan`)
}

function isE2EVisit(row: Row): boolean {
  if (/^E2E-/i.test(str(row.visit_id))) {
    return true
  }
  if (VISIT_MARKER.test(str(row.notes).trim())) {
    return true
  }
  const visitors = row.visitors
  return Array.isArray(visitors)
    ? visitors.some((visitor) => isRecord(visitor) && /^E2E-/i.test(str(visitor.name)))
    : false
}

function visitDetail(row: Row): string {
  const vendor = isRecord(row.vendor_user) ? str(row.vendor_user.email) : ''
  const location = isRecord(row.location) ? str(row.location.name) : ''
  const notes = str(row.notes).replace(/\s+/g, ' ').slice(0, 70)
  const parts = [
    `visit_id=${str(row.visit_id) || '-'}`,
    `status=${str(row.status) || '-'}`,
  ]
  if (vendor !== '') parts.push(`vendor=${vendor}`)
  if (location !== '') parts.push(`location="${location}"`)
  if (notes !== '') parts.push(`notes="${notes}"`)
  return parts.join(' ')
}

function isE2EUser(row: Row): boolean {
  return USER_MARKER.test(str(row.email).trim())
}

function userEndpoint(row: Row): string {
  const id = encodeURIComponent(str(row.id))
  return str(row.role) === 'security' ? `/users/security/${id}` : `/users/${id}`
}

function userDetail(row: Row): string {
  return `email=${str(row.email)} role=${str(row.role) || '-'} name="${str(row.name)}"`
}

function isE2EFacility(row: Row): boolean {
  return FACILITY_MARKER.test(str(row.name).trim())
}

function facilityDetail(row: Row): string {
  return `name="${str(row.name)}" type=${str(row.type) || '-'}`
}

function toCandidate(
  kind: Kind,
  row: Row,
  endpoint: string,
  detail: string,
): Candidate {
  const id = str(row.id)
  if (id === '') {
    fail(`baris ${kind} cocok pola E2E tetapi tanpa id: ${detail}`)
  }
  return { kind, id, endpoint, detail }
}

async function main(): Promise<void> {
  if (!process.env.E2E_API_BASE_URL) {
    fail('E2E_API_BASE_URL belum diset; sapuan hanya boleh menembak target live')
  }

  const api = await loadApi()
  const account = api.ACCOUNTS.super
  if (account === undefined) {
    fail('akun super tidak ada di helper ACCOUNTS')
  }

  let token: string
  try {
    token = (await api.loginViaApi(account.email, account.password)).token
  } catch (error) {
    fail(`login ${account.email} gagal: ${errorMessage(error)}`)
  }

  const visits = (await listAllVisits(api, token)).filter(isE2EVisit)
  const managedUsers = expectArray(await api.apiFetchRaw(token, 'GET', '/users'), 'GET /users')
  const securityUsers = expectArray(
    await api.apiFetchRaw(token, 'GET', '/users/security'),
    'GET /users/security',
  )
  const facilities = expectArray(
    await api.apiFetchRaw(token, 'GET', '/locations?active_only=false'),
    'GET /locations?active_only=false',
  )

  const seenUsers = new Set<string>()
  const users = [...managedUsers, ...securityUsers].filter((row) => {
    if (!isE2EUser(row)) return false
    const id = str(row.id)
    if (id === '' || seenUsers.has(id)) return false
    seenUsers.add(id)
    return true
  })

  // Urutan penting: kunjungan dulu (melepas referensi), lalu pengguna
  // (melepas referensi lokasi), terakhir fasilitas.
  const candidates: Candidate[] = [
    ...visits.map((row) =>
      toCandidate(
        'visit',
        row,
        `/visits/${encodeURIComponent(str(row.id))}`,
        visitDetail(row),
      ),
    ),
    ...users.map((row) => toCandidate('user', row, userEndpoint(row), userDetail(row))),
    ...facilities
      .filter(isE2EFacility)
      .map((row) =>
        toCandidate(
          'facility',
          row,
          `/locations/${encodeURIComponent(str(row.id))}`,
          facilityDetail(row),
        ),
      ),
  ]

  const counts: Record<Kind, number> = { visit: 0, user: 0, facility: 0 }

  if (candidates.length === 0) {
    log('tidak ada artefak E2E tersisa')
  }

  for (const candidate of candidates) {
    if (!APPLY) {
      log(`DRY-RUN ${candidate.kind} ${candidate.id} | ${candidate.detail}`)
      counts[candidate.kind] += 1
      continue
    }

    const result = await api.apiFetchRaw(token, 'DELETE', candidate.endpoint)
    if (result.status !== 204 && result.status !== 404) {
      fail(
        `DELETE ${candidate.kind} ${candidate.id} -> HTTP ${result.status} ` +
          `(harus 204/404): ${describe(result.body)}`,
      )
    }
    log(`DELETE ${candidate.kind} ${candidate.id} -> ${result.status}`)
    counts[candidate.kind] += 1
  }

  const total = counts.visit + counts.user + counts.facility
  const label = APPLY ? 'ringkasan' : 'ringkasan (dry-run)'
  log(
    `${label}: visits=${counts.visit} users=${counts.user} ` +
      `facilities=${counts.facility} total=${total}`,
  )
}

await main()
