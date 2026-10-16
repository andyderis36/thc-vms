/**
 * RED-wave contract test — klien penyaji berkas kunjungan (frontend, tests-only).
 *
 * Modul produksi yang DITARGETKAN (diimplementasikan pada wave GREEN):
 *   - `src/lib/api/files.ts`
 *       · `buildVisitFileUrl(visitId: string, kind: VisitFileKind, visitorId?: string): string`
 *       · `fetchVisitFileBlob(...)` (diuji lewat hook — lihat `tests/useVisitFile.test.ts`)
 *
 * Kontrak URL: `${API_BASE}/visits/{visitId}/file?kind={kind}` — melayani BERKAS
 * (bukan presigned MinIO). `API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL`.
 * `id_card` / `selfie` WAJIB menerima `visitor_id`; tanpa itu → lempar galat
 * validasi berbahasa Indonesia. Kind di luar daftar → lempar galat.
 *
 * Strategi RED (modul belum ada, tapi `tsc --noEmit` tetap hijau):
 * specifier dynamic-import disimpan pada variabel bertipe `string` (NON-literal),
 * sehingga TypeScript tidak me-resolve modul, sementara Vitest gagal saat runtime
 * dengan "Failed to resolve import" (module-not-found).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/** Kind berkas yang didukung endpoint `GET /visits/{id}/file?kind=...`. */
type VisitFileKind = 'assignment_letter' | 'id_card' | 'selfie'

/** Bentuk API publik `src/lib/api/files.ts` yang ditargetkan (kontrak GREEN). */
interface FilesApi {
  buildVisitFileUrl(visitId: string, kind: VisitFileKind, visitorId?: string): string
}

/** Specifier NON-LITERAL: `tsc` tidak me-resolve, Vitest me-resolve saat runtime. */
const FILES_MODULE_PATH: string = '@/lib/api/files'

const TEST_API_BASE = 'http://api.thc.test/api/v1'

beforeAll(() => {
  vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', TEST_API_BASE)
})

afterAll(() => {
  vi.unstubAllEnvs()
})

let filesApiPromise: Promise<FilesApi> | undefined

function loadFilesApi(): Promise<FilesApi> {
  filesApiPromise ??= import(/* @vite-ignore */ FILES_MODULE_PATH) as unknown as Promise<FilesApi>
  return filesApiPromise
}

describe('buildVisitFileUrl — kind assignment_letter', () => {
  it('membangun URL backend tanpa query presigned & tanpa host MinIO', async () => {
    const { buildVisitFileUrl } = await loadFilesApi()

    const url = buildVisitFileUrl('VST-001', 'assignment_letter')

    expect(url).toBe(`${TEST_API_BASE}/visits/VST-001/file?kind=assignment_letter`)
    expect(url).not.toContain('localhost:9000')
    expect(url).not.toContain('X-Amz')
    expect(url).not.toContain('Signature')
  })

  it('tidak menambahkan visitor_id untuk assignment_letter', async () => {
    const { buildVisitFileUrl } = await loadFilesApi()

    const url = buildVisitFileUrl('VST-001', 'assignment_letter')

    expect(url).not.toContain('visitor_id')
  })
})

describe('buildVisitFileUrl — id_card/selfie wajib visitor_id', () => {
  it('melempar galat validasi Indonesia saat visitor_id id_card tidak diberikan', async () => {
    const { buildVisitFileUrl } = await loadFilesApi()

    expect(() => buildVisitFileUrl('VST-001', 'id_card')).toThrow(/visitor/i)
  })

  it('melempar galat validasi Indonesia saat visitor_id selfie tidak diberikan', async () => {
    const { buildVisitFileUrl } = await loadFilesApi()

    expect(() => buildVisitFileUrl('VST-001', 'selfie')).toThrow(/visitor/i)
  })

  it('menyertakan visitor_id pada URL saat diberikan (id_card)', async () => {
    const { buildVisitFileUrl } = await loadFilesApi()

    const url = buildVisitFileUrl('VST-001', 'id_card', 'VIS-1')

    expect(url).toContain('/visits/VST-001/file')
    expect(url).toContain('kind=id_card')
    expect(url).toContain('VIS-1')
  })

  it('menyertakan visitor_id pada URL saat diberikan (selfie)', async () => {
    const { buildVisitFileUrl } = await loadFilesApi()

    const url = buildVisitFileUrl('VST-001', 'selfie', 'VIS-9')

    expect(url).toContain('kind=selfie')
    expect(url).toContain('VIS-9')
  })
})

describe('buildVisitFileUrl — kind tidak dikenal', () => {
  it('melempar galat untuk kind di luar daftar yang didukung', async () => {
    const { buildVisitFileUrl } = await loadFilesApi()

    expect(() =>
      buildVisitFileUrl('VST-001', 'laporan_fiskal' as unknown as VisitFileKind),
    ).toThrow()
  })
})
