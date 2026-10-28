/**
 * Kontrak avatar backend (SSOT: `docs/4. openapi.yaml`).
 *
 * `GET /api/v1/avatars/<uuid>?v=<8hex>` mewajibkan `Authorization: Bearer` dan
 * mengembalikan byte gambar. Frontend mengambilnya lewat `fetch` lalu merender
 * `blob:`—jadi E2E TIDAK boleh mengasumsikan URL storage/presigned maupun
 * object key apa pun. Bukti yang sah hanya dua:
 * 1. gambar benar-benar ter-decode (`naturalWidth > 0`), dan
 * 2. ada respons 200 dari path `/api/v1/avatars/<uuid>` yang membawa Bearer.
 */

import { expect, type Locator, type Page, type Request } from '@playwright/test'

/** Path kontrak; query `?v=` sengaja diabaikan saat membandingkan placement. */
const AVATAR_PATH_PATTERN = /^\/api\/v1\/avatars\/[0-9a-f-]{36}$/

/** `true` bila request adalah GET ke endpoint avatar backend. */
export function isAvatarRequest(request: Request): boolean {
  if (request.method() !== 'GET') {
    return false
  }
  return AVATAR_PATH_PATTERN.test(new URL(request.url()).pathname)
}

/** Pathname avatar tanpa query — bentuk stabil untuk dibandingkan antar-placement. */
export function avatarPath(request: Request): string {
  return new URL(request.url()).pathname
}

export interface AvatarLoad {
  path: string
  status: number
  request: Request
}

/**
 * Rekam setiap respons avatar di halaman. Dipasang SEBELUM navigasi agar
 * permintaan pertama saat hidrasi tidak terlewat.
 */
export function trackAvatarLoads(page: Page): AvatarLoad[] {
  const loads: AvatarLoad[] = []
  page.on('response', (response) => {
    const request = response.request()
    if (!isAvatarRequest(request)) {
      return
    }
    loads.push({ path: avatarPath(request), status: response.status(), request })
  })
  return loads
}

/**
 * Tunggu respons 200 avatar yang muncul sejak indeks `from`, lalu pastikan
 * request-nya membawa Bearer. `from` memisahkan load antar-navigasi/placement.
 */
export async function expectAvatarLoad(
  loads: AvatarLoad[],
  from: number,
  label: string,
): Promise<AvatarLoad> {
  await expect
    .poll(() => loads.slice(from).filter((load) => load.status === 200).length, {
      message: `${label}: respons 200 /api/v1/avatars/ tidak muncul`,
    })
    .toBeGreaterThan(0)

  const load = loads.slice(from).find((entry) => entry.status === 200)
  if (load === undefined) {
    throw new Error(`[e2e-avatar] ${label}: respons avatar 200 tidak ditemukan.`)
  }

  const authorization = load.request.headers()['authorization'] ?? ''
  expect(
    authorization,
    `${label}: permintaan ${load.path} wajib membawa Authorization: Bearer`,
  ).toMatch(/^Bearer\s+\S+/)

  return load
}

/**
 * Bukti render sesungguhnya: `<img>` terlihat DAN byte-nya ter-decode.
 * `src` yang ada tetapi gagal diambil (401/404) selalu berakhir `naturalWidth` 0.
 */
export async function expectImageDecoded(img: Locator, label: string): Promise<void> {
  await expect(img, `${label} harus terlihat`).toBeVisible()
  await expect
    .poll(
      () => img.evaluate((el) => (el instanceof HTMLImageElement ? el.naturalWidth : 0)),
      { message: `${label} harus termuat (naturalWidth > 0)` },
    )
    .toBeGreaterThan(0)
}
