import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, uploadFile } from '@/lib/api/fetcher'
import {
  compressImage,
  JPEG_QUALITY,
  MAX_IMAGE_EDGE_PX,
  prepareUpload,
} from '@/lib/uploads/compressImage'
import { MAX_UPLOAD_BYTES } from '@/lib/uploads/validation'

/**
 * Kompresi foto sisi-klien sebelum `uploadFile` mengirim (S2 tepi ukuran +
 * S5 tahan uplink lemah). Node tidak punya canvas, sehingga rasterizer
 * browser (`createImageBitmap` + `canvas.getContext('2d').toBlob`) di-stub
 * — MATRIKS & PANGGILAN yang diuji adalah milik kode produksi, hanya
 * mesin raster browser-nya yang diganti.
 */

const MB = 1024 * 1024
const EXIF_MARKER = new TextEncoder().encode('Exif\0\0')

type Pixels = { width: number; height: number }

type RasterizerCalls = {
  decodeCalls: { file: File; options: unknown }[]
  drawn: Pixels | null
  encodeArgs: { type: string; quality: number } | null
  closed: boolean
}

function makeJpegBytes(size: number, withExif = false): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size)
  bytes[0] = 0xff // SOI
  bytes[1] = 0xd8
  if (withExif) {
    bytes[2] = 0xff // APP1
    bytes[3] = 0xe1
    bytes.set(EXIF_MARKER, 4)
  }
  for (let i = 64; i < size; i += 1) {
    bytes[i] = i % 251
  }
  return bytes
}

function makePdfBytes(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size)
  bytes.set(new TextEncoder().encode('%PDF-1.7\n'))
  for (let i = 64; i < size; i += 1) {
    bytes[i] = i % 251
  }
  return bytes
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    let hit = true
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        hit = false
        break
      }
    }
    if (hit) {
      return true
    }
  }
  return false
}

/**
 * Perbandingan byte-identik dengan loop polos: `toEqual` vitest melakukan
 * equality struktural elemen-demi-elemen dan melebihi batas waktu 5 dtk
 * pada berkas megabita.
 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false
    }
  }
  return true
}

/**
 * Pasang stub untuk `createImageBitmap` + `document.createElement('canvas')`
 * sehingga `compressImage` berjalan penuh di Node. `encode` menentukan
 * byte hasil — produksi memanggilnya dengan sisi hasil skala.
 */
function stubRasterizer(config: {
  pixels: Pixels
  encode: (width: number, height: number) => Uint8Array<ArrayBuffer>
}): RasterizerCalls {
  const calls: RasterizerCalls = {
    decodeCalls: [],
    drawn: null,
    encodeArgs: null,
    closed: false,
  }

  vi.stubGlobal('createImageBitmap', async (file: File, options?: unknown) => {
    calls.decodeCalls.push({ file, options })
    return {
      width: config.pixels.width,
      height: config.pixels.height,
      close: () => {
        calls.closed = true
      },
    }
  })

  const canvas: Record<string, unknown> = {
    width: 0,
    height: 0,
    getContext: (kind: string) => {
      if (kind !== '2d') {
        return null
      }
      return {
        drawImage: (_source: unknown, _dx: number, _dy: number, dw: number, dh: number) => {
          calls.drawn = { width: dw, height: dh }
        },
      }
    },
    toBlob: (callback: (blob: Blob | null) => void, type?: string, quality?: number) => {
      calls.encodeArgs = { type: type ?? '', quality: quality ?? -1 }
      const width = canvas['width'] as number
      const height = canvas['height'] as number
      callback(new Blob([config.encode(width, height)], { type: type ?? 'image/png' }))
    },
  }

  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      if (tag !== 'canvas') {
        throw new Error(`unexpected createElement: ${tag}`)
      }
      return canvas
    },
  })

  return calls
}

function stubDecodeFailure(error: Error): RasterizerCalls {
  const calls: RasterizerCalls = { decodeCalls: [], drawn: null, encodeArgs: null, closed: false }
  vi.stubGlobal('createImageBitmap', async (file: File, options?: unknown) => {
    calls.decodeCalls.push({ file, options })
    throw error
  })
  return calls
}

function stubFetchSuccess(): { calls: { input: unknown; init?: RequestInit }[] } {
  const state: { calls: { input: unknown; init?: RequestInit }[] } = { calls: [] }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      state.calls.push({ input, init })
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            file_url: 'http://localhost:9000/thc-uploads/id_cards/x/ktp.jpg',
            file_name: 'ktp.jpg',
            file_size: 1234,
            mime_type: 'image/jpeg',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }),
  )
  return state
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('compressImage — downscale + JPEG q0.82', () => {
  it('shrinks a 4000×3000 jpeg to a ≤1600px longest edge and drops its bytes', async () => {
    const calls = stubRasterizer({
      pixels: { width: 4000, height: 3000 },
      encode: (width, height) => new Uint8Array(width * height),
    })
    const input = new File([makeJpegBytes(4.5 * MB)], 'ktp.jpg', { type: 'image/jpeg' })

    const output = await compressImage(input)

    expect(calls.drawn).toEqual({ width: 1600, height: 1200 })
    expect(MAX_IMAGE_EDGE_PX).toBe(1600)
    expect(calls.encodeArgs).toEqual({ type: 'image/jpeg', quality: JPEG_QUALITY })
    expect(JPEG_QUALITY).toBe(0.82)
    expect(output.type).toBe('image/jpeg')
    expect(output.name).toBe('ktp.jpg')
    expect(output.size).toBeLessThan(input.size)
  })

  it('re-encodes an already-small jpeg at native dimensions (no upscale, still q0.82)', async () => {
    const calls = stubRasterizer({
      pixels: { width: 800, height: 600 },
      encode: (width, height) => new Uint8Array(Math.floor((width * height) / 4)),
    })
    const input = new File([makeJpegBytes(400_000)], 'kecil.jpg', { type: 'image/jpeg' })

    const output = await compressImage(input)

    expect(calls.drawn).toEqual({ width: 800, height: 600 })
    expect(calls.encodeArgs).toEqual({ type: 'image/jpeg', quality: 0.82 })
    expect(output.type).toBe('image/jpeg')
    expect(output.size).toBeLessThan(input.size)
  })

  it('converts a png photo to jpeg and renames the .png extension to .jpg', async () => {
    stubRasterizer({
      pixels: { width: 3000, height: 2000 },
      encode: (width, height) => new Uint8Array(Math.floor((width * height) / 8)),
    })
    const input = new File([makeJpegBytes(2 * MB)], 'bukti.png', { type: 'image/png' })

    const output = await compressImage(input)

    expect(output.type).toBe('image/jpeg')
    expect(output.name).toBe('bukti.jpg')
    expect(output.size).toBeLessThan(input.size)
  })
})

describe('compressImage — PDF passthrough', () => {
  it('returns the pdf byte-identical and never touches the rasterizer', async () => {
    const calls = stubRasterizer({
      pixels: { width: 4000, height: 3000 },
      encode: () => new Uint8Array(0),
    })
    const bytes = makePdfBytes(1.5 * MB)
    const pdf = new File([bytes], 'surat-tugas.pdf', { type: 'application/pdf' })

    const output = await compressImage(pdf)

    expect(calls.decodeCalls).toHaveLength(0)
    expect(output.size).toBe(pdf.size)
    expect(bytesEqual(new Uint8Array(await output.arrayBuffer()), bytes)).toBe(true)
  })
})

describe('compressImage — EXIF independence', () => {
  it('takes dimensions from the decoder (never from EXIF bytes) and strips EXIF from the output', async () => {
    const inputBytes = makeJpegBytes(3 * MB, true)
    expect(containsBytes(inputBytes, EXIF_MARKER)).toBe(true)

    const calls = stubRasterizer({
      pixels: { width: 4000, height: 3000 },
      // Hasil encode segar tanpa metadata apa pun — sama seperti canvas.
      encode: (width, height) => {
        const out = new Uint8Array(Math.floor((width * height) / 8))
        out.fill(0x2a)
        return out
      },
    })
    const input = new File([inputBytes], 'portrait.jpg', { type: 'image/jpeg' })

    const output = await compressImage(input)

    // Orientasi diserahkan ke decoder browser, bukan diparsing dari EXIF.
    expect(calls.decodeCalls).toHaveLength(1)
    expect(calls.decodeCalls[0]?.options).toEqual({ imageOrientation: 'from-image' })
    // Skala murni berasal dari piksel hasil decode (4000×3000 → 1600×1200),
    // mengabaikan klaim dimensi apa pun di dalam segmen EXIF.
    expect(calls.drawn).toEqual({ width: 1600, height: 1200 })
    const outputBytes = new Uint8Array(await output.arrayBuffer())
    expect(containsBytes(outputBytes, EXIF_MARKER)).toBe(false)
    expect(calls.closed).toBe(true)
  })
})

describe('prepareUpload — dua langkah: ingest 20 MB lalu stored 5 MB (pesan Indonesia)', () => {
  it('rejects a photo over the 20 MB ingest ceiling BEFORE compression with the Indonesian 20 MB message', async () => {
    const calls = stubRasterizer({
      pixels: { width: 4000, height: 3000 },
      encode: () => new Uint8Array(1024),
    })
    const oversized = new File([makeJpegBytes(21 * MB)], 'raksasa.jpg', { type: 'image/jpeg' })

    const result = await prepareUpload(oversized)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(result.message).toContain('20 MB')
    expect(result.message).toContain('raksasa.jpg')
    expect(calls.decodeCalls).toHaveLength(0)
  })

  it('compresses a photo above the old flat 5 MB cap instead of rejecting it outright', async () => {
    stubRasterizer({
      pixels: { width: 4000, height: 3000 },
      encode: (width, height) => new Uint8Array(Math.floor((width * height) / 8)),
    })
    const input = new File([makeJpegBytes(6 * MB)], 'foto-besar.jpg', { type: 'image/jpeg' })

    const result = await prepareUpload(input)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    expect(result.file.size).toBeLessThan(MAX_UPLOAD_BYTES)
    expect(result.file.size).toBeLessThan(input.size)
  })

  it('rejects an unsupported MIME before compression with the Indonesian format message', async () => {
    const calls = stubRasterizer({
      pixels: { width: 100, height: 100 },
      encode: () => new Uint8Array(10),
    })
    const exe = new File([makePdfBytes(1024)], 'payload.exe', {
      type: 'application/x-msdownload',
    })

    const result = await prepareUpload(exe)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(result.message).toContain('tidak didukung')
    expect(calls.decodeCalls).toHaveLength(0)
  })

  it('rejects a still-oversize compression result AFTER compression (post-check) in Indonesian', async () => {
    const calls = stubRasterizer({
      pixels: { width: 4000, height: 3000 },
      // Hasil "encode" sengaja tetap di atas 5 MB.
      encode: () => new Uint8Array(MAX_UPLOAD_BYTES + 1),
    })
    const input = new File([makeJpegBytes(4 * MB)], 'gagal-kecil.jpg', { type: 'image/jpeg' })

    const result = await prepareUpload(input)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(result.message).toContain('5 MB')
    expect(calls.decodeCalls).toHaveLength(1)
  })

  it('returns the compressed jpeg when both validation passes succeed', async () => {
    stubRasterizer({
      pixels: { width: 4000, height: 3000 },
      encode: (width, height) => new Uint8Array(Math.floor((width * height) / 8)),
    })
    const input = new File([makeJpegBytes(4 * MB)], 'ktp.jpg', { type: 'image/jpeg' })

    const result = await prepareUpload(input)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    expect(result.file.type).toBe('image/jpeg')
    expect(result.file.size).toBeLessThan(input.size)
  })

  it('passes a valid pdf through untouched (byte-identical)', async () => {
    stubRasterizer({
      pixels: { width: 10, height: 10 },
      encode: () => new Uint8Array(0),
    })
    const bytes = makePdfBytes(1.5 * MB)
    const pdf = new File([bytes], 'surat-tugas.pdf', { type: 'application/pdf' })

    const result = await prepareUpload(pdf)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    expect(bytesEqual(new Uint8Array(await result.file.arrayBuffer()), bytes)).toBe(true)
  })

  it('accepts an 8 MB pdf at ingest — the stored 5 MB cap is deferred to the server', async () => {
    const calls = stubRasterizer({
      pixels: { width: 10, height: 10 },
      encode: () => new Uint8Array(0),
    })
    const bytes = makePdfBytes(8 * MB)
    const pdf = new File([bytes], 'surat-tugas-besar.pdf', { type: 'application/pdf' })

    const result = await prepareUpload(pdf)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    expect(result.file.size).toBeGreaterThan(MAX_UPLOAD_BYTES)
    expect(bytesEqual(new Uint8Array(await result.file.arrayBuffer()), bytes)).toBe(true)
    expect(calls.decodeCalls).toHaveLength(0)
  })

  it('refuses a 21 MB pdf at ingest with the Indonesian 20 MB message, never a 5 MB one', async () => {
    const calls = stubRasterizer({
      pixels: { width: 10, height: 10 },
      encode: () => new Uint8Array(0),
    })
    const pdf = new File([makePdfBytes(21 * MB)], 'terlalu-besar.pdf', {
      type: 'application/pdf',
    })

    const result = await prepareUpload(pdf)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(result.message).toContain('20 MB')
    expect(result.message).toContain('terlalu-besar.pdf')
    expect(result.message).not.toContain('5 MB')
    expect(calls.decodeCalls).toHaveLength(0)
  })

  it('reports a rasterizer failure with an Indonesian message instead of leaking a DOM error', async () => {
    stubDecodeFailure(new Error('decode error: The source image is corrupt'))
    const input = new File([makeJpegBytes(1 * MB)], 'rusak.jpg', { type: 'image/jpeg' })

    const result = await prepareUpload(input)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(result.message).toContain('rusak.jpg')
    expect(result.message).not.toContain('corrupt')
  })
})

describe('uploadFile — kompresi terjadi SEBELUM data dikirim', () => {
  it('appends the compressed jpeg (≤1600px, fewer bytes) to the FormData', async () => {
    stubRasterizer({
      pixels: { width: 4000, height: 3000 },
      encode: (width, height) => new Uint8Array(Math.floor((width * height) / 8)),
    })
    const fetchState = stubFetchSuccess()
    const input = new File([makeJpegBytes(4.5 * MB)], 'ktp.jpg', { type: 'image/jpeg' })

    await uploadFile(input, 'id_card')

    expect(fetchState.calls).toHaveLength(1)
    const init = fetchState.calls[0]?.init
    expect(init?.method).toBe('POST')
    const body = init?.body
    expect(body).toBeInstanceOf(FormData)
    const sent = (body as FormData).get('file')
    expect(sent).toBeInstanceOf(File)
    if (!(sent instanceof File)) throw new Error('expected file part')
    expect(sent.type).toBe('image/jpeg')
    expect(sent.size).toBeLessThan(input.size)
    expect((body as FormData).get('category')).toBe('id_card')
  })

  it('throws ApiError with the Indonesian 20 MB message and never hits the network when the file exceeds the ingest ceiling', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const oversized = new File([makeJpegBytes(21 * MB)], 'raksasa.jpg', { type: 'image/jpeg' })

    const failure = await uploadFile(oversized, 'checkin_photo').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiError)
    const apiError = failure as ApiError
    expect(apiError.message).toContain('20 MB')
    expect(apiError.message).toContain('raksasa.jpg')
    expect(apiError.status).toBe(400)
    expect(apiError.code).toBe('VALIDATION_ERROR')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
