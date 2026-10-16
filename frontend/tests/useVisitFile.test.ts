// @vitest-environment jsdom
/**
 * RED-wave contract test — hook penyaji berkas kunjungan (frontend, tests-only).
 *
 * Modul produksi yang DITARGETKAN (diimplementasikan pada wave GREEN):
 *   - `src/features/visits/hooks/useVisitFile.ts`
 *       · `useVisitFile({ visitId, kind, visitorId? })`
 *         → `{ objectUrl: string | null; loading: boolean; error: string | null; retry: () => void }`
 *   - `src/lib/api/files.ts` → `fetchVisitFileBlob(visitId, kind, visitorId?)` (di-mock di sini).
 *
 * Kontrak perilaku hook (kontrak GREEN):
 *   · Sukses    → `objectUrl` diawali `"blob:"` (hasil `URL.createObjectURL`).
 *   · Unmount   → `URL.revokeObjectURL(objectUrl)` dipanggil.
 *   · HTTP 403  → `error` Indonesia memuat "tidak memiliki akses", `retry` tersedia.
 *   · HTTP 404  → `error === 'Berkas tidak tersedia.'`, `objectUrl` null (placeholder netral).
 *   · Network   → `error` generik berbahasa Indonesia (mis. memuat "Gagal"), tidak melempar ke pemanggil.
 *
 * Strategi RED (hook belum ada, tapi `tsc --noEmit` tetap hijau):
 * specifier dynamic-import disimpan pada variabel bertipe `string` (NON-literal),
 * sehingga TypeScript tidak me-resolve modul, sementara Vitest gagal saat runtime
 * dengan "Failed to resolve import" (module-not-found).
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/lib/api/fetcher'

type VisitFileKind = 'assignment_letter' | 'id_card' | 'selfie'

interface UseVisitFileParams {
  visitId: string
  kind: VisitFileKind
  visitorId?: string
}

interface UseVisitFileResult {
  objectUrl: string | null
  loading: boolean
  error: string | null
  retry: () => void
}

type UseVisitFileHook = (params: UseVisitFileParams) => UseVisitFileResult

/** Specifier NON-LITERAL: `tsc` tidak me-resolve, Vitest me-resolve saat runtime. */
const HOOK_MODULE_PATH: string = '@/features/visits/hooks/useVisitFile'

const OBJECT_URL = 'blob:http://localhost/thc-vms-object-url'

const { fetchVisitFileBlob } = vi.hoisted(() => ({ fetchVisitFileBlob: vi.fn() }))

vi.mock('@/lib/api/files', () => ({ fetchVisitFileBlob }))

const createObjectURL = vi.fn(() => OBJECT_URL)
const revokeObjectURL = vi.fn()

let hookPromise: Promise<UseVisitFileHook> | undefined

function loadUseVisitFile(): Promise<UseVisitFileHook> {
  hookPromise ??= (
    import(/* @vite-ignore */ HOOK_MODULE_PATH) as unknown as Promise<{
      useVisitFile: UseVisitFileHook
    }>
  ).then((mod) => mod.useVisitFile)
  return hookPromise
}

beforeEach(() => {
  fetchVisitFileBlob.mockReset()
  createObjectURL.mockReset().mockReturnValue(OBJECT_URL)
  revokeObjectURL.mockReset()
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: createObjectURL,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: revokeObjectURL,
  })
})

afterEach(() => {
  cleanup()
})

describe('useVisitFile — sukses', () => {
  it('objectUrl diawali "blob:" dan berkas diambil lewat fetchVisitFileBlob', async () => {
    const useVisitFile = await loadUseVisitFile()
    fetchVisitFileBlob.mockResolvedValue(new Blob(['surat'], { type: 'application/pdf' }))

    const { result } = renderHook(() =>
      useVisitFile({ visitId: 'VST-001', kind: 'assignment_letter' }),
    )

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).toBeNull()
    expect(result.current.objectUrl).toMatch(/^blob:/)
    expect(result.current.objectUrl).toBe(OBJECT_URL)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(fetchVisitFileBlob).toHaveBeenCalledTimes(1)
    expect(fetchVisitFileBlob.mock.calls[0]?.[0]).toBe('VST-001')
    expect(fetchVisitFileBlob.mock.calls[0]?.[1]).toBe('assignment_letter')
  })

  it('saat unmount memanggil revokeObjectURL dengan objectUrl yang dibuat', async () => {
    const useVisitFile = await loadUseVisitFile()
    fetchVisitFileBlob.mockResolvedValue(new Blob(['x']))

    const { result, unmount } = renderHook(() =>
      useVisitFile({ visitId: 'VST-001', kind: 'assignment_letter' }),
    )

    await waitFor(() => expect(result.current.objectUrl).toBe(OBJECT_URL))

    unmount()

    expect(revokeObjectURL).toHaveBeenCalledWith(OBJECT_URL)
  })
})

describe('useVisitFile — galat HTTP', () => {
  it('HTTP 403 menampilkan galat "tidak memiliki akses" dan menyediakan retry', async () => {
    const useVisitFile = await loadUseVisitFile()
    fetchVisitFileBlob.mockRejectedValue(new ApiError('Forbidden', 403, 'FORBIDDEN'))

    const { result } = renderHook(() =>
      useVisitFile({ visitId: 'VST-001', kind: 'assignment_letter' }),
    )

    await waitFor(() => expect(result.current.error).not.toBeNull())

    expect(result.current.error?.toLowerCase()).toContain('tidak memiliki akses')
    expect(result.current.objectUrl).toBeNull()
    expect(typeof result.current.retry).toBe('function')
  })

  it('HTTP 404 menampilkan "Berkas tidak tersedia." dan state placeholder netral', async () => {
    const useVisitFile = await loadUseVisitFile()
    fetchVisitFileBlob.mockRejectedValue(new ApiError('Not Found', 404, 'NOT_FOUND'))

    const { result } = renderHook(() =>
      useVisitFile({ visitId: 'VST-001', kind: 'assignment_letter' }),
    )

    await waitFor(() => expect(result.current.error).toBe('Berkas tidak tersedia.'))

    expect(result.current.objectUrl).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('retry memicu pengambilan ulang berkas setelah gagal', async () => {
    const useVisitFile = await loadUseVisitFile()
    fetchVisitFileBlob.mockRejectedValueOnce(new ApiError('Forbidden', 403, 'FORBIDDEN'))
    fetchVisitFileBlob.mockResolvedValueOnce(new Blob(['ok']))

    const { result } = renderHook(() =>
      useVisitFile({ visitId: 'VST-001', kind: 'assignment_letter' }),
    )

    await waitFor(() => expect(result.current.error).not.toBeNull())

    await act(async () => {
      result.current.retry()
    })

    await waitFor(() => expect(fetchVisitFileBlob).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.objectUrl).toBe(OBJECT_URL))
  })
})

describe('useVisitFile — galat jaringan', () => {
  it('network throw menjadi galat generik Indonesia, tidak melempar ke pemanggil', async () => {
    const useVisitFile = await loadUseVisitFile()
    fetchVisitFileBlob.mockRejectedValue(new TypeError('Failed to fetch'))

    const { result } = renderHook(() =>
      useVisitFile({ visitId: 'VST-001', kind: 'assignment_letter' }),
    )

    await waitFor(() => expect(result.current.error).not.toBeNull())

    expect(result.current.error?.toLowerCase()).toContain('gagal')
    expect(result.current.error).not.toBe('Failed to fetch')
    expect(result.current.objectUrl).toBeNull()
  })
})
