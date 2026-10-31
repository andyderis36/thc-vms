import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AVATAR_JPEG_QUALITY,
  AVATAR_MAX_EDGE_PX,
  avatarCropGeometry,
  avatarJpegName,
  cropAvatar,
  CROP_SOURCE_MAX_EDGE_PX,
  MAX_CROP_SOURCE_PIXELS,
  prepareCropSource,
  scaledSourceDimensions,
  type CropSource,
} from '@/lib/uploads/cropImage'

/**
 * Node tidak punya canvas maupun decoder gambar, sehingga rasterizer browser
 * (`createImageBitmap`, `document.createElement('canvas')`, `URL.createObjectURL`)
 * di-stub. Yang diuji tetap milik kode produksi: perhitungan geometri, urutan
 * pemanggilan, pembersihan sumber daya, dan kontrak berkas hasil ekspor.
 */

type FakeContext = {
  fillStyle: string
  fillRect: (x: number, y: number, width: number, height: number) => void
  drawImage: (...args: unknown[]) => void
}

type FakeCanvas = {
  width: number
  height: number
  getContext: (kind: string) => FakeContext | null
  toBlob: (
    callback: (blob: Blob | null) => void,
    type?: string,
    quality?: number,
  ) => void
}

type CanvasState = {
  canvases: FakeCanvas[]
  drawn: unknown[][]
  fills: number[][]
  encode: { type: string; quality: number | undefined } | null
}

function stubCanvasEnvironment(
  config: { context?: boolean; blob?: Blob | null } = {},
): CanvasState {
  const state: CanvasState = { canvases: [], drawn: [], fills: [], encode: null }

  vi.stubGlobal('document', {
    createElement: (tag: string): FakeCanvas => {
      if (tag !== 'canvas') {
        throw new Error(`unexpected createElement: ${tag}`)
      }
      const canvas: FakeCanvas = {
        width: 0,
        height: 0,
        getContext: (kind: string) => {
          if (config.context === false || kind !== '2d') {
            return null
          }
          return {
            fillStyle: '#000000',
            fillRect: (x, y, width, height) => {
              state.fills.push([x, y, width, height])
            },
            drawImage: (...args: unknown[]) => {
              state.drawn.push(args)
            },
          }
        },
        toBlob: (callback, type, quality) => {
          state.encode = { type: type ?? '', quality }
          if (config.blob === null) {
            callback(null)
            return
          }
          callback(config.blob ?? new Blob(['avatar'], { type: type ?? 'image/png' }))
        },
      }
      state.canvases.push(canvas)
      return canvas
    },
  })

  return state
}

type BitmapState = { closed: number; options: unknown }

function stubBitmap(width: number, height: number): BitmapState {
  const state: BitmapState = { closed: 0, options: undefined }

  vi.stubGlobal('createImageBitmap', async (_file: File, options?: unknown) => {
    state.options = options
    return {
      width,
      height,
      close: () => {
        state.closed += 1
      },
    }
  })

  return state
}

type ObjectUrlState = { created: string[]; revoked: string[] }

function stubObjectUrl(): ObjectUrlState {
  const state: ObjectUrlState = { created: [], revoked: [] }
  let counter = 0

  vi.stubGlobal('URL', {
    createObjectURL: () => {
      counter += 1
      const url = `blob:test/${counter}`
      state.created.push(url)
      return url
    },
    revokeObjectURL: (url: string) => {
      state.revoked.push(url)
    },
  })

  return state
}

function makeSource(width: number, height: number): CropSource {
  const canvas = { width, height } as unknown as HTMLCanvasElement
  return { url: 'blob:test/source', width, height, canvas, dispose: () => {} }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('scaledSourceDimensions — batasi sisi terpanjang tanpa memperbesar', () => {
  it('scales a landscape source down to the 2048px longest edge', () => {
    expect(scaledSourceDimensions(4000, 2000, CROP_SOURCE_MAX_EDGE_PX)).toEqual({
      width: 2048,
      height: 1024,
    })
  })

  it('scales a portrait source down to the 2048px longest edge', () => {
    expect(scaledSourceDimensions(2000, 4000, CROP_SOURCE_MAX_EDGE_PX)).toEqual({
      width: 1024,
      height: 2048,
    })
  })

  it('leaves a source already under the limit untouched', () => {
    expect(scaledSourceDimensions(1200, 800, CROP_SOURCE_MAX_EDGE_PX)).toEqual({
      width: 1200,
      height: 800,
    })
  })

  it('never upscales a source smaller than the limit', () => {
    expect(scaledSourceDimensions(800, 600, CROP_SOURCE_MAX_EDGE_PX)).toEqual({
      width: 800,
      height: 600,
    })
    expect(scaledSourceDimensions(10, 10, CROP_SOURCE_MAX_EDGE_PX)).toEqual({
      width: 10,
      height: 10,
    })
  })
})

describe('avatarCropGeometry — persegi 1:1 terpusat dengan plafon 512px', () => {
  it('takes the largest centered square from a landscape source', () => {
    expect(
      avatarCropGeometry(4000, 3000, { x: 0, y: 0, width: 4000, height: 3000 }),
    ).toEqual({ sx: 500, sy: 0, side: 3000, outputSize: 512 })
  })

  it('centers the square inside a non-square crop rect', () => {
    expect(
      avatarCropGeometry(1000, 1000, { x: 100, y: 50, width: 400, height: 200 }),
    ).toEqual({ sx: 200, sy: 50, side: 200, outputSize: 200 })
  })

  it('clamps an area that extends past the source bounds', () => {
    expect(
      avatarCropGeometry(1000, 800, { x: -50, y: -50, width: 2000, height: 2000 }),
    ).toEqual({ sx: 100, sy: 0, side: 800, outputSize: 512 })
  })

  it('does not upscale a crop smaller than the output ceiling', () => {
    expect(
      avatarCropGeometry(1000, 1000, { x: 0, y: 0, width: 240, height: 300 }),
    ).toEqual({ sx: 0, sy: 30, side: 240, outputSize: 240 })
  })

  it('honours a custom max edge', () => {
    expect(
      avatarCropGeometry(1000, 1000, { x: 0, y: 0, width: 1000, height: 1000 }, 128),
    ).toEqual({ sx: 0, sy: 0, side: 1000, outputSize: 128 })
  })

  it('throws on a non-positive source dimension', () => {
    expect(() =>
      avatarCropGeometry(0, 800, { x: 0, y: 0, width: 100, height: 100 }),
    ).toThrow(/tidak valid/)
  })

  it('throws on a non-positive crop area', () => {
    expect(() =>
      avatarCropGeometry(1000, 800, { x: 0, y: 0, width: 0, height: 100 }),
    ).toThrow(/tidak valid/)
  })

  it('throws when the area falls entirely outside the source', () => {
    expect(() =>
      avatarCropGeometry(1000, 800, { x: 2000, y: 0, width: 100, height: 100 }),
    ).toThrow(/di luar gambar/)
  })
})

describe('avatarJpegName — selalu berakhiran .jpg', () => {
  it('replaces a .png extension', () => {
    expect(avatarJpegName('foto.png')).toBe('foto.jpg')
  })

  it('replaces .jpg and .jpeg case-insensitively', () => {
    expect(avatarJpegName('FOTO.JPEG')).toBe('FOTO.jpg')
    expect(avatarJpegName('foto.JPG')).toBe('foto.jpg')
    expect(avatarJpegName('foto.jpg')).toBe('foto.jpg')
  })

  it('appends .jpg when no recognized extension exists', () => {
    expect(avatarJpegName('foto')).toBe('foto.jpg')
    expect(avatarJpegName('foto.webp')).toBe('foto.webp.jpg')
  })
})

describe('prepareCropSource — dekode sekali, batasi 2048px, miliki sumber daya', () => {
  it('keeps a 1200×800 source at native size and draws it white-filled', async () => {
    const bitmapState = stubBitmap(1200, 800)
    const canvasState = stubCanvasEnvironment()
    const urlState = stubObjectUrl()
    const file = new File(['foto'], 'profil.jpg', { type: 'image/jpeg' })

    const source = await prepareCropSource(file)

    expect(bitmapState.options).toEqual({ imageOrientation: 'from-image' })
    expect(source.width).toBe(1200)
    expect(source.height).toBe(800)
    expect(source.url).toBe(urlState.created[0])
    expect(canvasState.canvases).toHaveLength(1)
    expect(canvasState.canvases[0]?.width).toBe(1200)
    expect(canvasState.canvases[0]?.height).toBe(800)
    expect(canvasState.fills[0]).toEqual([0, 0, 1200, 800])
    expect(canvasState.drawn[0]?.slice(1)).toEqual([0, 0, 1200, 800])
  })

  it('scales a 4000×2000 source to 2048×1024', async () => {
    stubBitmap(4000, 2000)
    const canvasState = stubCanvasEnvironment()
    stubObjectUrl()
    const file = new File(['foto'], 'besar.jpg', { type: 'image/jpeg' })

    const source = await prepareCropSource(file)

    expect(source.width).toBe(2048)
    expect(source.height).toBe(1024)
    expect(canvasState.canvases[0]?.width).toBe(2048)
    expect(canvasState.canvases[0]?.height).toBe(1024)
    expect(canvasState.drawn[0]?.slice(1)).toEqual([0, 0, 2048, 1024])
  })

  it('rejects a source above 40 megapixels and closes the bitmap', async () => {
    const bitmapState = stubBitmap(8000, 6000)
    const canvasState = stubCanvasEnvironment()
    const urlState = stubObjectUrl()
    const file = new File(['foto'], 'raksasa.jpg', { type: 'image/jpeg' })

    expect(8000 * 6000).toBeGreaterThan(MAX_CROP_SOURCE_PIXELS)
    await expect(prepareCropSource(file)).rejects.toThrow(/megapiksel/)
    expect(bitmapState.closed).toBe(1)
    expect(canvasState.canvases).toHaveLength(0)
    expect(urlState.created).toHaveLength(0)
  })

  it('rejects when the 2d context is unavailable and cleans the bitmap up', async () => {
    const bitmapState = stubBitmap(1200, 800)
    stubCanvasEnvironment({ context: false })
    const urlState = stubObjectUrl()
    const file = new File(['foto'], 'profil.jpg', { type: 'image/jpeg' })

    await expect(prepareCropSource(file)).rejects.toThrow(/context/)
    expect(bitmapState.closed).toBe(1)
    expect(urlState.created).toHaveLength(0)
    expect(urlState.revoked).toHaveLength(0)
  })

  it('dispose closes the bitmap and revokes the URL exactly once', async () => {
    const bitmapState = stubBitmap(1200, 800)
    stubCanvasEnvironment()
    const urlState = stubObjectUrl()
    const file = new File(['foto'], 'profil.jpg', { type: 'image/jpeg' })

    const source = await prepareCropSource(file)
    expect(bitmapState.closed).toBe(0)
    expect(urlState.revoked).toHaveLength(0)

    source.dispose()
    source.dispose()

    expect(bitmapState.closed).toBe(1)
    expect(urlState.revoked).toEqual([source.url])
  })
})

describe('cropAvatar — potong persegi lalu encode JPEG q0.82', () => {
  it('exports a large crop at 512×512 with the expected draw rectangle', async () => {
    const canvasState = stubCanvasEnvironment()

    const output = await cropAvatar(
      makeSource(2048, 2048),
      { x: 0, y: 0, width: 2048, height: 2048 },
      'profil.png',
    )

    expect(AVATAR_MAX_EDGE_PX).toBe(512)
    expect(canvasState.canvases[0]?.width).toBe(512)
    expect(canvasState.canvases[0]?.height).toBe(512)
    expect(canvasState.fills[0]).toEqual([0, 0, 512, 512])
    expect(canvasState.drawn[0]?.slice(1)).toEqual([0, 0, 2048, 2048, 0, 0, 512, 512])
    expect(canvasState.encode).toEqual({ type: 'image/jpeg', quality: AVATAR_JPEG_QUALITY })
    expect(AVATAR_JPEG_QUALITY).toBe(0.82)
    expect(output.type).toBe('image/jpeg')
    expect(output.name).toBe('profil.jpg')
  })

  it('exports a 240px crop at 240×240, centred in the requested area', async () => {
    const canvasState = stubCanvasEnvironment()

    const output = await cropAvatar(
      makeSource(1000, 1000),
      { x: 100, y: 120, width: 240, height: 240 },
      'kecil.jpeg',
    )

    expect(canvasState.canvases[0]?.width).toBe(240)
    expect(canvasState.canvases[0]?.height).toBe(240)
    expect(canvasState.drawn[0]?.slice(1)).toEqual([100, 120, 240, 240, 0, 0, 240, 240])
    expect(output.name).toBe('kecil.jpg')
  })

  it('never upscales a source smaller than 512px', async () => {
    const canvasState = stubCanvasEnvironment()

    await cropAvatar(
      makeSource(100, 100),
      { x: 0, y: 0, width: 100, height: 100 },
      'mungil.jpg',
    )

    expect(canvasState.canvases[0]?.width).toBe(100)
    expect(canvasState.drawn[0]?.slice(1)).toEqual([0, 0, 100, 100, 0, 0, 100, 100])
  })

  it('stamps the export with a fresh lastModified', async () => {
    stubCanvasEnvironment()
    const before = Date.now()

    const output = await cropAvatar(
      makeSource(600, 600),
      { x: 0, y: 0, width: 600, height: 600 },
      'profil.jpg',
    )

    expect(output.lastModified).toBeGreaterThanOrEqual(before)
    expect(output.lastModified).toBeLessThanOrEqual(Date.now())
  })

  it('rejects when encoding yields a null blob', async () => {
    stubCanvasEnvironment({ blob: null })

    await expect(
      cropAvatar(makeSource(600, 600), { x: 0, y: 0, width: 600, height: 600 }, 'profil.jpg'),
    ).rejects.toThrow(/JPEG/)
  })

  it('rejects when the destination 2d context is unavailable', async () => {
    stubCanvasEnvironment({ context: false })

    await expect(
      cropAvatar(makeSource(600, 600), { x: 0, y: 0, width: 600, height: 600 }, 'profil.jpg'),
    ).rejects.toThrow(/context/)
  })
})
