/**
 * Autosave lokal (browser, per-akun) untuk daftar tim teknisi SCR-03.
 *
 * Setelah permohonan berhasil dikirim, HANYA 3 field teks per baris —
 * **nama, No. HP, dan nama vendor** — disimpan ke `localStorage` di bawah
 * kunci `thc-vms:technicians:<userId>` agar pengajuan berikutnya oleh akun
 * yang sama bisa pre-fill roster tanpa mengetik ulang. Field yang TIDAK
 * PERNAH disimpan:
 *
 * - `id_number` (Nomor KTP/SIM) — data PII; tidak pernah dipersist, tidak
 *   pernah dimigrasikan, dan prefill selalu mengosongkan kolomnya.
 * - Foto/berkas (KTP, selfie) — URL bersifat sementara; unduhan ulang wajib
 *   lewat pemilihan berkas ulang oleh pengguna.
 *
 * Ketahanan:
 * - Kunci selalu memuat user id: data tidak pernah bocor antar-akun di
 *   peramban yang sama, dan tetap bertahan logout/login pada akun yang sama.
 * - Semua akses `localStorage` dibungkus try/catch: mode privat Safari
 *   (getter melempar), kuota penuh, atau storage dimatikan tidak boleh
 *   melempar ke pemanggil.
 * - Envelope JSON berversi (`{ version, rows }`); data rusak / versi tak
 *   dikenal / struktur salah dibuang diam-diam saat load (return `null`).
 * - `ROSTER_VERSION` = 2. Versi 1 (yang ikut menyimpan `id_number`) dianggap
 *   usang: envelope versi 1 → `null` (tidak dimigrasikan — PII lama tidak
 *   pernah dibawa ke bentuk baru; data lama tertimpa oleh save berikutnya
 *   atau dibersihkan `clearTechnicianRoster`). Baris dalam envelope versi 2
 *   yang kebetulan masih memuat kunci `id_number` TIDAK membuang roster:
 *   field asing di-strip zod, field yang tersisa tetap dimuat.
 * - Validasi bentuk pakai zod; hanya 3 field teks yang dikenal skema
 *   (field foto/identitas tidak pernah).
 */

import { z } from 'zod'

import { isBlank, MAX_TECHNICIANS, VENDOR_NAME_MAX_LENGTH } from './vendor-input'

/** Prefiks kunci storage — userId selalu diikat agar antar-akun terisolasi. */
const KEY_PREFIX = 'thc-vms:technicians:'

/**
 * Versi envelope JSON. Versi berbeda = data tidak bisa dipercaya → dibuang
 * (jangan menebak bentuk lama). Versi 2 membuang `id_number` (PII) dari
 * format tersimpan; envelope versi 1 dianggap usang → `null`.
 */
const ROSTER_VERSION = 2

/**
 * Satu baris roster tersimpan: HANYA nama, No. HP, dan nama vendor.
 * `id_number` (PII) dan foto/URL tidak pernah ikut.
 */
export interface SavedTechnicianRow {
  name: string
  phone: string
  vendor_name: string
}

/**
 * Bentuk masukan `saveTechnicianRoster`: struktural, sehingga baris form
 * `TechnicianFormValues` (yang juga membawa `id_number`, `selfie` /
 * `id_card_photo`) bisa langsung dilewatkan — `id_number` sengaja tidak
 * dipetakan (dipotong, tidak pernah persist) dan properti ekstra lain
 * dipotong oleh pemetaan di bawah.
 */
export interface TechnicianRosterInputRow {
  name: string
  id_number: string
  phone: string
  vendor_name?: string | null
}

/**
 * Skema baris tersimpan — hanya 3 field teks. Kunci apa pun di luar ini
 * (sisa `id_number` dari format lama, potongan foto, dll.) di-strip zod,
 * sehingga field yang tersisa tetap terbaca tanpa membuang roster.
 */
const savedRowSchema = z.object({
  name: z.string(),
  phone: z.string(),
  vendor_name: z.string().max(VENDOR_NAME_MAX_LENGTH).optional(),
})

/**
 * Envelope berversi. `rows` sengaja `unknown[]`: setiap baris divalidasi
 * terpisah agar satu baris korup hanya membuang baris itu, bukan seluruh
 * roster (properti tak dikenal seperti sisa foto otomatis di-strip zod).
 * Hanya `ROSTER_VERSION` yang diterima; envelope versi lama (1) → `null`.
 */
const envelopeSchema = z.object({
  version: z.literal(ROSTER_VERSION),
  rows: z.array(z.unknown()),
})

/** Kunci storage untuk satu akun. */
export function technicianRosterStorageKey(userId: string): string {
  return `${KEY_PREFIX}${userId}`
}

/**
 * Ambil `localStorage` dengan aman: SSR (`undefined`) dan mode privat
 * Safari (getter melempar `SecurityError`) sama-sama menghasilkan `null`.
 */
function getStorage(): Storage | null {
  try {
    const storage: Storage | undefined = globalThis.localStorage
    return storage ?? null
  } catch {
    return null
  }
}

/**
 * True bila SEMUA field teks yang ikut dipersist (nama, No. HP, nama
 * vendor) kosong / hanya spasi. `id_number` tidak dihitung — field itu
 * tidak pernah persist sehingga tidak boleh menentukan "ada isi".
 */
function rowHasNoText(
  row: Pick<TechnicianRosterInputRow, 'name' | 'phone' | 'vendor_name'>,
): boolean {
  return (
    isBlank(row.name) && isBlank(row.phone) && isBlank(row.vendor_name)
  )
}

/**
 * True bila semua baris masih kosong (atau daftarnya kosong) — syarat aman
 * untuk pre-fill dari roster tersimpan tanpa menimpa ketikan pengguna.
 */
export function areTechnicianRowsBlank(
  rows: readonly TechnicianRosterInputRow[],
): boolean {
  return rows.every(rowHasNoText)
}

/**
 * Simpan roster teks milik `userId` (menimpa kunci akun tersebut).
 *
 * Hanya 3 field teks yang dipersist — nama, No. HP, nama vendor — di-trim;
 * `id_number` dari baris form sengaja TIDAK ikut dipetakan (dipangkas di
 * sini, bukan sekadar disembunyikan saat load). Baris yang seluruhnya
 * kosong dilewati dan jumlah baris dibatasi `MAX_TECHNICIANS`. Bila tak ada
 * satu pun baris ber-teks, kunci dihapus (dianggap tidak ada roster).
 * Kegagalan storage (kuota / mode privat) diam-diam no-op: TIDAK PERNAH
 * melempar.
 */
export function saveTechnicianRoster(
  userId: string,
  rows: readonly TechnicianRosterInputRow[],
): void {
  if (userId.trim() === '') return
  const storage = getStorage()
  if (storage === null) return

  const kept: SavedTechnicianRow[] = []
  for (const row of rows) {
    if (rowHasNoText(row)) continue
    // Pemetaan sadar-PII: `id_number` tidak pernah masuk payload storage.
    kept.push({
      name: row.name.trim(),
      phone: row.phone.trim(),
      vendor_name: (row.vendor_name ?? '').trim(),
    })
    if (kept.length >= MAX_TECHNICIANS) break
  }

  const key = technicianRosterStorageKey(userId)
  try {
    if (kept.length === 0) {
      storage.removeItem(key)
      return
    }
    storage.setItem(
      key,
      JSON.stringify({ version: ROSTER_VERSION, rows: kept }),
    )
  } catch {
    // Kuota penuh / mode privat: diam — autosave bersifat pelengkap.
  }
}

/**
 * Muat roster teks untuk `userId`.
 *
 * `null` bila: tidak ada data, JSON rusak, versi lama/tak dikenal (termasuk
 * envelope versi 1 yang menyimpan PII), bentuk tidak sah, storage tidak
 * tersedia, atau tidak ada satu pun baris ber-teks — semuanya dibuang
 * diam-diam. Baris yang lolos sudah di-trim, hanya 3 field teks (kunci
 * `id_number` yang tersisa di envelope versi 2 di-strip, baris tetap
 * dimuat), dan dibatasi `MAX_TECHNICIANS`.
 */
export function loadTechnicianRoster(
  userId: string,
): SavedTechnicianRow[] | null {
  if (userId.trim() === '') return null
  const storage = getStorage()
  if (storage === null) return null

  let raw: string | null = null
  try {
    raw = storage.getItem(technicianRosterStorageKey(userId))
  } catch {
    return null
  }
  if (raw === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  const envelope = envelopeSchema.safeParse(parsed)
  if (!envelope.success) return null

  const rows: SavedTechnicianRow[] = []
  for (const entry of envelope.data.rows) {
    const result = savedRowSchema.safeParse(entry)
    if (!result.success) continue // Baris korup: buang diam-diam.
    const saved: SavedTechnicianRow = {
      name: result.data.name.trim(),
      phone: result.data.phone.trim(),
      vendor_name: (result.data.vendor_name ?? '').trim(),
    }
    if (rowHasNoText(saved)) continue
    rows.push(saved)
    if (rows.length >= MAX_TECHNICIANS) break
  }

  return rows.length > 0 ? rows : null
}

/** Hapus roster milik `userId`. No-op bila userId kosong / storage gagal. */
export function clearTechnicianRoster(userId: string): void {
  if (userId.trim() === '') return
  const storage = getStorage()
  if (storage === null) return
  try {
    storage.removeItem(technicianRosterStorageKey(userId))
  } catch {
    // Abaikan — lihat `getStorage`.
  }
}
