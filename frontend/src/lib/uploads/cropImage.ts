/**
 * Pemotongan & ekspor avatar sisi-klien untuk formulir profil.
 *
 * Alurnya dua tahap: `prepareCropSource` mendekode berkas sekali menjadi
 * bitmap yang sudah berorientasi EXIF dan dibatasi `CROP_SOURCE_MAX_EDGE_PX`,
 * lalu `cropAvatar` memotong persegi dari kanvas sumber tersebut dan
 * mengodekannya sebagai JPEG q0.82 dengan sisi maksimum `AVATAR_MAX_EDGE_PX`.
 *
 * Sumber di-dekode lebih dulu agar `react-easy-crop` dapat menampilkan pratinjau
 * dari URL objek yang sama, sementara ekspor membaca kanvas yang sudah
 * diperkecil — bukan berkas mentah — sehingga biaya memori tetap wajar.
 */

/** Sisi terpanjang avatar hasil ekspor (persegi 512×512). */
export const AVATAR_MAX_EDGE_PX = 512

/** Kualitas JPEG hasil ekspor avatar (sama dengan kompresi unggahan biasa). */
export const AVATAR_JPEG_QUALITY = 0.82

/** Sisi terpanjang kanvas sumber pemotong; tidak pernah diperbesar. */
export const CROP_SOURCE_MAX_EDGE_PX = 2048

/** Plafon piksel sumber (40 MP) sebelum didekode, untuk mencegah kehabisan memori. */
export const MAX_CROP_SOURCE_PIXELS = 40_000_000

/** Persegi potong dari `react-easy-crop`, dalam piksel ruang gambar sumber. */
export type CropArea = { x: number; y: number; width: number; height: number }

/** Sumber potong siap pakai: pratinjau lewat `url`, ekspor lewat `canvas`. */
export type CropSource = {
  url: string
  width: number
  height: number
  /** Dimensi asli berkas sebelum diskalakan (ruang koordinat cropper). */
  naturalWidth?: number
  naturalHeight?: number
  canvas: HTMLCanvasElement
  dispose: () => void
}

export type AvatarCropGeometry = {
  sx: number
  sy: number
  side: number
  outputSize: number
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

/**
 * Hitung dimensi sumber setelah sisi terpanjangnya dibatasi `maxEdge`.
 * Tidak pernah memperbesar: `maxEdge` lebih besar dari sisi asli menghasilkan
 * dimensi aslinya.
 */
export function scaledSourceDimensions(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const longestEdge = Math.max(width, height)
  const scale = Math.min(1, maxEdge / longestEdge)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/**
 * Geometri potong persegi 1:1 dari area yang dilaporkan `react-easy-crop`.
 *
 * Area dijepit ke batas sumber, lalu diambil persegi terbesar yang terpusat di
 * dalamnya (`side = min(width, height)`) — sehingga hasil selalu persegi walau
 * cropper mengirim rect non-persegi. Keluaran tidak pernah diperbesar melebihi
 * `maxEdge`.
 */
export function avatarCropGeometry(
  sourceWidth: number,
  sourceHeight: number,
  area: CropArea,
  maxEdge: number = AVATAR_MAX_EDGE_PX,
): AvatarCropGeometry {
  if (!isPositiveFinite(sourceWidth) || !isPositiveFinite(sourceHeight)) {
    throw new Error('Dimensi gambar sumber tidak valid.')
  }
  if (!isPositiveFinite(area.width) || !isPositiveFinite(area.height)) {
    throw new Error('Area potong tidak valid.')
  }
  if (!Number.isFinite(area.x) || !Number.isFinite(area.y)) {
    throw new Error('Area potong tidak valid.')
  }
  if (!isPositiveFinite(maxEdge)) {
    throw new Error('Batas ukuran avatar tidak valid.')
  }

  const left = clamp(area.x, 0, sourceWidth)
  const top = clamp(area.y, 0, sourceHeight)
  const right = clamp(area.x + area.width, 0, sourceWidth)
  const bottom = clamp(area.y + area.height, 0, sourceHeight)
  const width = Math.max(0, right - left)
  const height = Math.max(0, bottom - top)

  if (width <= 0 || height <= 0) {
    throw new Error('Area potong berada di luar gambar.')
  }

  const side = Math.max(1, Math.round(Math.min(width, height)))
  const sx = clamp(Math.round(left + (width - side) / 2), 0, sourceWidth - side)
  const sy = clamp(Math.round(top + (height - side) / 2), 0, sourceHeight - side)
  const outputSize = Math.min(maxEdge, Math.max(1, Math.round(side)))

  return { sx, sy, side, outputSize }
}

/**
 * Nama berkas hasil ekspor selalu berakhiran `.jpg`: ekstensi gambar yang
 * dikenali (`.png`, `.jpg`, `.jpeg`, tanpa peduli huruf besar/kecil) diganti,
 * nama tanpa ekstensi dikenal cukup ditambahi `.jpg`.
 */
export function avatarJpegName(name: string): string {
  return `${name.replace(/\.(?:png|jpe?g)$/i, '')}.jpg`
}

/**
 * Dekode berkas menjadi kanvas sumber terbatas, sekali saja.
 *
 * Orientasi EXIF diterapkan oleh decoder browser (`imageOrientation:
 * 'from-image'`). Bitmap dan URL objek dimiliki bersama oleh `dispose`, yang
 * idempoten sehingga aman dipanggil berkali-kali (mis. cleanup ganda React).
 * Bila langkah apa pun gagal setelah bitmap dibuat, bitmap ditutup dan URL
 * objek yang sudah terlanjur dibuat dicabut sebelum galat dilempar.
 */
export async function prepareCropSource(file: File): Promise<CropSource> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  let objectUrl: string | null = null

  try {
    if (bitmap.width * bitmap.height > MAX_CROP_SOURCE_PIXELS) {
      throw new Error(
        `Gambar "${file.name}" terlalu besar (maksimal ${MAX_CROP_SOURCE_PIXELS / 1_000_000} megapiksel).`,
      )
    }

    const scaled = scaledSourceDimensions(
      bitmap.width,
      bitmap.height,
      CROP_SOURCE_MAX_EDGE_PX,
    )
    const canvas = document.createElement('canvas')
    canvas.width = scaled.width
    canvas.height = scaled.height
    const context = canvas.getContext('2d')
    if (context === null) {
      throw new Error('canvas 2d context tidak tersedia')
    }
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, scaled.width, scaled.height)
    context.drawImage(bitmap, 0, 0, scaled.width, scaled.height)

    objectUrl = URL.createObjectURL(file)
    const url = objectUrl
    let disposed = false
    const dispose = () => {
      if (disposed) {
        return
      }
      disposed = true
      bitmap.close()
      URL.revokeObjectURL(url)
    }

    return {
      url,
      width: scaled.width,
      height: scaled.height,
      // Dimensi asli bitmap (sudah berorientasi EXIF) — ruang koordinat
      // yang dilaporkan react-easy-crop. Dipakai untuk memetakan area
      // potong ke kanvas yang sudah diskalakan.
      naturalWidth: bitmap.width,
      naturalHeight: bitmap.height,
      canvas,
      dispose,
    }
  } catch (error) {
    bitmap.close()
    if (objectUrl !== null) {
      URL.revokeObjectURL(objectUrl)
    }
    throw error
  }
}

/**
 * Potong persegi dari kanvas sumber dan ekspor sebagai JPEG q0.82.
 * Latar putih dipasang agar area transparan (PNG) tidak menjadi hitam saat
 * dikodekan sebagai JPEG.
 */
export async function cropAvatar(
  source: CropSource,
  area: CropArea,
  fileName: string,
): Promise<File> {
  // `react-easy-crop` melaporkan area dalam piksel gambar asli, sedangkan
  // kanvas sumber mungkin sudah diskalakan (<=2048px). Petakan area ke ruang
  // kanvas sebelum dihitung geometrinya; tanpa pemetaan ini crop pada foto
  // besar akan terpotong/clamp ke seluruh kanvas.
  const naturalWidth =
    source.naturalWidth !== undefined && source.naturalWidth > 0
      ? source.naturalWidth
      : source.width
  const naturalHeight =
    source.naturalHeight !== undefined && source.naturalHeight > 0
      ? source.naturalHeight
      : source.height
  const scaleX = source.width / naturalWidth
  const scaleY = source.height / naturalHeight
  const scaledArea: CropArea = {
    x: area.x * scaleX,
    y: area.y * scaleY,
    width: area.width * scaleX,
    height: area.height * scaleY,
  }
  const geometry = avatarCropGeometry(source.width, source.height, scaledArea)
  const canvas = document.createElement('canvas')
  canvas.width = geometry.outputSize
  canvas.height = geometry.outputSize
  const context = canvas.getContext('2d')
  if (context === null) {
    throw new Error('canvas 2d context tidak tersedia')
  }
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, geometry.outputSize, geometry.outputSize)
  context.drawImage(
    source.canvas,
    geometry.sx,
    geometry.sy,
    geometry.side,
    geometry.side,
    0,
    0,
    geometry.outputSize,
    geometry.outputSize,
  )

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) => {
        if (result === null) {
          reject(new Error('encode JPEG gagal'))
          return
        }
        resolve(result)
      },
      'image/jpeg',
      AVATAR_JPEG_QUALITY,
    )
  })

  return new File([blob], avatarJpegName(fileName), {
    type: 'image/jpeg',
    lastModified: Date.now(),
  })
}
