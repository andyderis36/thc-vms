import { act } from '@testing-library/react'
import { vi, type Mock } from 'vitest'

/** Object URL deterministik yang dikembalikan stub `URL.createObjectURL`. */
export const AVATAR_OBJECT_URL = 'blob:avatar-test'

/**
 * Respons gambar untuk stub `fetch`: body byte + `Content-Type` eksplisit.
 * `response.blob()` mengambil tipe dari header; `Blob` lintas-realm tidak bisa
 * dipakai langsung karena `Response` Node membacanya sebagai teks.
 */
export function imageResponse(): Response {
  return new Response(new Uint8Array([137, 80, 78, 71]), {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  })
}

/** Respons galat tanpa body gambar (mis. 404 avatar tidak tersedia). */
export function errorResponse(status: number): Response {
  return new Response('gagal', { status })
}

/** Tunggu satu putaran event loop + mikro-task agar rantai fetch/effect selesai. */
export async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
  })
}

export interface AvatarFetchStubs {
  fetchMock: Mock<typeof fetch>
  createObjectURL: Mock<() => string>
  revokeObjectURL: Mock<(url: string) => void>
}

/**
 * Buat `fetch` selalu menjawab gambar. Tiap panggilan memakai `Response` BARU:
 * body respons hanya bisa dibaca sekali, jadi satu `Response` bersama akan
 * gagal (`Body is unusable`) pada render kedua di berkas uji yang sama.
 */
export function mockAvatarImage(fetchMock: Mock<typeof fetch>): void {
  fetchMock.mockImplementation(() => Promise.resolve(imageResponse()))
}

/**
 * Pasang stub `fetch` + object URL agar avatar merender `blob:` secara
 * deterministik (jsdom tidak menjamin nilai object URL stabil untuk asersi).
 * Pemanggil mengatur sendiri hasil `fetchMock` (sukses/gagal).
 */
export function installAvatarFetchStubs(): AvatarFetchStubs {
  const fetchMock = vi.fn<typeof fetch>()
  // Default menggantung: berkas uji yang tidak menguji avatar tidak boleh
  // menghasilkan state update SETELAH test selesai (peringatan act). Uji yang
  // memang mengharapkan gambar memanggil `mockAvatarImage`.
  fetchMock.mockImplementation(() => new Promise<Response>(() => undefined))
  const createObjectURL = vi.fn<() => string>(() => AVATAR_OBJECT_URL)
  const revokeObjectURL = vi.fn<(url: string) => void>()

  vi.stubGlobal('fetch', fetchMock)
  Object.defineProperty(URL, 'createObjectURL', {
    value: createObjectURL,
    configurable: true,
    writable: true,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    value: revokeObjectURL,
    configurable: true,
    writable: true,
  })

  return { fetchMock, createObjectURL, revokeObjectURL }
}
