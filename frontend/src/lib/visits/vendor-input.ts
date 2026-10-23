/**
 * Pemetaan isian "Perusahaan Vendor" bebas-teks ke kontrak BE.
 *
 * Field vendor pada form SCR-03 dan layar akun terkelola menerima teks bebas (bukan hanya
 * pilihan dropdown): pengguna boleh memilih nama dari katalog terdaftar
 * (`GET /vendors`) ATAU mengetik nama manual. Aturan kontrak (sudah dikunci):
 *
 * - Teks yang PERSIS cocok (case-insensitive, trim) dengan nama vendor
 *   terdaftar → kirim `vendor_id` (vendor_id menang bila keduanya ada).
 * - Selain itu → kirim `vendor_name` (teks manual, ≤120 karakter).
 * - Kosong / hanya spasi → `{}` (tidak kirim field apa pun).
 * - Teks manual >120 karakter → `{}` — DITOLAK di FE, tidak pernah terkirim.
 *
 * Katalog hanya menjadi SARAN (`<datalist>`); nama ketikan manual tidak
 * pernah ditambahkan ke daftar mana pun — katalog adalah master data milik
 * Superadmin.
 */

/** Minimum data katalog vendor dari `GET /vendors` untuk pencocokan nama. */
export interface VendorCatalogEntry {
  id: string
  name: string
}

/** Hasil pemetaan: satu field menang, atau `{}` bila tak ada isian sah. */
export interface ResolvedVendorInput {
  vendor_id?: string
  vendor_name?: string
}

/** Batas kontrak BE untuk `vendor_name` manual. */
export const VENDOR_NAME_MAX_LENGTH = 120

/**
 * Batas anggota tim per kunjungan — openapi `visitors.maxItems` = 10.
 *
 * Konstanta domain diletakkan di sini (bukan di `visit-schema.ts`) agar
 * modul `lib/` — termasuk `technician-autosave.ts` — tidak perlu mengimpor
 * dari `features/` (edge arsitektur lib→features dilarang). `visit-schema.ts`
 * me-re-export nilai ini sehingga importir lama tetap berfungsi tanpa ubahan.
 */
export const MAX_TECHNICIANS = 10

/** True bila nilai kosong, `null`/`undefined`, atau hanya berisi spasi. */
export function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === ''
}

/**
 * Petakan teks hasil ketikan pengguna ke field kontrak BE.
 *
 * @param typed teks apa adanya dari input (boleh kosong / spasi tepi)
 * @param vendors katalog vendor terdaftar (`GET /vendors`)
 * @returns `{vendor_id}` bila cocok persis dengan katalog, `{vendor_name}`
 *          bila teks manual valid, `{}` bila kosong atau terlalu panjang.
 */
export function resolveVendorInput(
  typed: string | null | undefined,
  vendors: readonly VendorCatalogEntry[],
): ResolvedVendorInput {
  const text = (typed ?? '').trim()
  if (text === '') return {}

  // vendor_id menang: kecocokan nama terdaftar (case-insensitive, trim).
  const lowered = text.toLowerCase()
  const matched = vendors.find(
    (vendor) => vendor.name.trim().toLowerCase() === lowered,
  )
  if (matched !== undefined) return { vendor_id: matched.id }

  // Selain itu teks manual; di luar batas kontrak = ditolak FE (tak dikirim).
  if (text.length > VENDOR_NAME_MAX_LENGTH) return {}
  return { vendor_name: text }
}
