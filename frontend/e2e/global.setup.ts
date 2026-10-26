/**
 * Global setup Playwright: preflight konektivitas.
 *
 * Tugasnya HANYA memeriksa bahwa backend Go dan frontend Next.js sudah hidup
 * sebelum suite dijalankan. Skrip ini tidak pernah menyalakan server sendiri —
 * server sengaja dikelola manual oleh developer/CI.
 */

const BACKEND_HEALTH_URL = `${process.env.E2E_API_BASE_URL ?? 'http://localhost:8080/api/v1'}/health`
const FRONTEND_LOGIN_URL = `${process.env.E2E_FRONTEND_BASE_URL ?? 'http://localhost:3210'}/login`
const PROBE_TIMEOUT_MS = 10_000

const BACKEND_HINT =
  'Jalankan dari folder backend/: `docker compose up -d` (Postgres + MinIO) lalu `go run cmd/server/main.go`.'
const FRONTEND_HINT = 'Jalankan dari folder frontend/: `npm run dev` (port 3210).'

async function probe(url: string): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: 'manual',
      headers: { accept: 'application/json, text/html;q=0.9, */*;q=0.8' },
    })
  } finally {
    clearTimeout(timer)
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'AbortError'
      ? `timeout setelah ${PROBE_TIMEOUT_MS / 1000} detik`
      : error.message
  }
  return String(error)
}

async function checkBackend(): Promise<string | null> {
  try {
    const response = await probe(BACKEND_HEALTH_URL)
    if (response.status !== 200) {
      return `backend menjawab HTTP ${response.status} pada /api/v1/health (butuh 200). ${BACKEND_HINT}`
    }

    const body: unknown = await response.json()
    const data =
      typeof body === 'object' && body !== null && 'data' in body
        ? (body as { data?: unknown }).data
        : undefined
    const status =
      typeof data === 'object' && data !== null && 'status' in data
        ? (data as { status?: unknown }).status
        : undefined

    if (!status) {
      return `backend hidup tetapi respons /api/v1/health tidak berisi data.status. ${BACKEND_HINT}`
    }
    return null
  } catch (error) {
    return `backend TIDAK dapat dihubungi di ${BACKEND_HEALTH_URL} (${describeError(error)}). ${BACKEND_HINT}`
  }
}

async function checkFrontend(): Promise<string | null> {
  try {
    const response = await probe(FRONTEND_LOGIN_URL)
    if (response.status < 200 || response.status >= 400) {
      return `frontend menjawab HTTP ${response.status} pada /login (butuh 2xx/3xx). ${FRONTEND_HINT}`
    }
    return null
  } catch (error) {
    return `frontend TIDAK dapat dihubungi di ${FRONTEND_LOGIN_URL} (${describeError(error)}). ${FRONTEND_HINT}`
  }
}

export default async function globalSetup(): Promise<void> {
  const failures = (await Promise.all([checkBackend(), checkFrontend()])).filter(
    (failure): failure is string => failure !== null,
  )

  if (failures.length > 0) {
    throw new Error(
      [
        '[preflight] Lingkungan belum siap untuk E2E:',
        ...failures.map((failure, index) => `  ${index + 1}. ${failure}`),
        'Setelah layanan hidup, ulangi `npm run e2e`.',
      ].join('\n'),
    )
  }

  console.log('[preflight] backend & frontend siap')
}
