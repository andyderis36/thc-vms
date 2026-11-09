/**
 * Pembersihan objek MinIO hasil unggahan test.
 *
 * `DELETE /visits/{id}` hanya menghapus baris database; objek di bucket tetap
 * ada. Helper ini menghapus objek berdasarkan URL berkas yang dikembalikan
 * backend lalu memverifikasi objek benar-benar hilang.
 */

import { Client } from 'minio'

const ENDPOINT = process.env.E2E_S3_ENDPOINT ?? 'localhost'
const PORT = Number(process.env.E2E_S3_PORT ?? 9000)
const ACCESS_KEY = process.env.E2E_S3_ACCESS_KEY ?? 'minioadmin'
const SECRET_KEY = process.env.E2E_S3_SECRET_KEY ?? 'minioadmin'
const BUCKET = process.env.E2E_S3_BUCKET ?? 'thc-vms-bucket'

const FILE_URL_KEYS = new Set([
  'assignment_letter_url',
  'id_card_photo_url',
  'photo_url',
  'selfie_url',
])

let client: Client | null = null

function storage(): Client {
  if (client === null) {
    client = new Client({
      endPoint: ENDPOINT,
      port: PORT,
      useSSL: false,
      accessKey: ACCESS_KEY,
      secretKey: SECRET_KEY,
    })
  }
  return client
}

/** Ubah URL publik berkas menjadi object key di bucket; null bila bukan milik bucket. */
export function objectKeyFromUrl(fileUrl: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(fileUrl)
  } catch {
    return null
  }
  const prefix = `/${BUCKET}/`
  const start = parsed.pathname.indexOf(prefix)
  if (start === -1) {
    return null
  }
  const rawKey = parsed.pathname.slice(start + prefix.length)
  let key: string
  try {
    key = decodeURIComponent(rawKey)
  } catch {
    key = rawKey
  }
  return key === '' ? null : key
}

/** Kumpulkan seluruh URL berkas yang dapat dihapus dari payload kunjungan. */
export function collectFileUrls(payload: unknown): string[] {
  const urls = new Set<string>()
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (node === null || typeof node !== 'object') {
      return
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (
        typeof value === 'string' &&
        FILE_URL_KEYS.has(key) &&
        objectKeyFromUrl(value) !== null
      ) {
        urls.add(value)
        continue
      }
      walk(value)
    }
  }
  walk(payload)
  return [...urls]
}

function isNotFound(error: unknown): boolean {
  if (error === null || typeof error !== 'object') {
    return false
  }
  const code = (error as { code?: unknown }).code
  return code === 'NotFound' || code === 'NoSuchKey'
}

/**
 * Galat koneksi SEMENTARA pada socket HTTP (MinIO menutup keep-alive di
 * tengah beban run) — layak diulang; selain itu langsung melempar.
 */
function isTransientNetworkError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') {
    return false
  }
  const code = (error as { code?: unknown }).code
  const message = error instanceof Error ? error.message : String(error)
  return (
    code === 'ECONNRESET' ||
    /ECONNRESET|EPIPE|ETIMEDOUT|socket hang up|terminated/i.test(message)
  )
}

/**
 * Ulang maks3 kali dengan backoff untuk galat koneksi sementara saja.
 * `removeObject` idempoten dan blok "objek masih ada" bukan galat jaringan,
 * jadi retry tidak pernah menyembunyikan kegagalan pembersihan yang nyata.
 */
async function withTransientRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (attempt >= 3 || !isTransientNetworkError(error)) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt))
    }
  }
}

/** Hapus objek lalu pastikan objek tidak lagi ada; melempar bila masih tersisa. */
export async function deleteUploadedFiles(fileUrls: readonly string[]): Promise<void> {
  const keys: string[] = []
  for (const fileUrl of fileUrls) {
    const key = objectKeyFromUrl(fileUrl)
    if (key === null) {
      console.log(`[e2e-storage] URL di luar bucket ${BUCKET} dilewati: ${fileUrl}`)
      continue
    }
    keys.push(key)
  }
  for (const key of [...new Set(keys)]) {
    await withTransientRetry(async () => {
      await storage().removeObject(BUCKET, key)
      try {
        await storage().statObject(BUCKET, key)
      } catch (error) {
        if (isNotFound(error)) {
          console.log(`[e2e-storage] objek ${key} terhapus (stat -> NotFound)`)
          return
        }
        throw error
      }
      throw new Error(`[e2e-storage] objek ${key} masih ada setelah penghapusan`)
    })
  }
}
