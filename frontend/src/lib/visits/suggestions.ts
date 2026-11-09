/**
 * Saran isian untuk SCR-03 (T9 identitas vendor + T11 reuse anggota) —
 * modul MURNI tanpa React/I/O. Empat tanggung jawab:
 *
 * 1. `clampSuggestionQuery` — batas `?q=` (80 karakter rune, cermin
 *    `validation.SuggestionQueryMaxLength` di backend; 81 sudah 400).
 * 2. `mergeSuggestionNames` — gabung feed `GET /vendors/suggestions` dengan
 *    katalog `GET /vendors` supaya nama yang dulu tampil tidak pernah hilang
 *    (feed 403/galat untuk peran vendor, atau nama katalog di luar feed).
 * 3. `toMemberSuggestionOptions` — siapkan opsi `<datalist>` anggota; nilai
 *    opsi diberi akhiran nomor HP HANYA bila nama ternormalisasi duplikat,
 *    agar dua orang bernama sama tetap dapat dipilih terpisah.
 * 4. `toMemberSuggestionPatch` — petakan detail anggota ke baris formulir
 *    (termasuk foto VERBATIM dan perusahaan milik anggota itu sendiri);
 *    hasilnya MENGGANTI seluruh baris, jadi perusahaan kosong pun menimpa.
 *
 * URL foto tidak pernah dicatat/di-log di mana pun — hanya hidup di state
 * formulir baris yang memilih.
 */

import type {
  MemberSuggestion,
  MemberSuggestionDetail,
  VendorSuggestion,
} from '@/lib/api/types'
import type { TechnicianFormValues } from '@/features/visits/form/visit-schema'
import { fileNameFromUrl } from './prefill-last-visit'
import type { VendorCatalogEntry } from './vendor-input'

/** Cermin backend `validation.SuggestionQueryMaxLength` — 81 karakter = 400. */
export const SUGGESTION_QUERY_MAX_LENGTH = 80

/** Cermin backend `suggestionResultLimit` (feed vendor) — plafon datalist. */
export const MAX_VENDOR_SUGGESTION_OPTIONS = 50

/** Cermin SQL `LIMIT 20` (feed anggota) — plafon datalist per baris. */
export const MAX_MEMBER_SUGGESTION_OPTIONS = 20

/**
 * Teks baris saran anggota: `Nama · Jabatan · Email`. Datalist native
 * menampilkan `value` (nama) di baris utama dan `label` di sub-baris, jadi
 * label hanya menambah atribut yang membantu memilih. Jabatan/email kosong
 * dilewati; bila keduanya kosong, nomor HP dipakai supaya dua orang bernama
 * sama tetap bisa dibedakan.
 */
export function memberSuggestionLabel(item: MemberSuggestion): string {
  const jabatan = item.jabatan?.trim() ?? ''
  const email = item.email?.trim() ?? ''
  const parts = [item.name]
  if (jabatan !== '') parts.push(jabatan)
  if (email !== '') parts.push(email)
  if (jabatan === '' && email === '') parts.push(item.phone)
  return parts.join(' · ')
}

/** Satu baris hasil pilihan saran anggota yang siap diterapkan ke formulir. */
export type MemberSuggestionPatch = Pick<
  TechnicianFormValues,
  'name' | 'id_number' | 'phone' | 'email' | 'jabatan' | 'vendor_name' | 'id_card_photo' | 'selfie'
>

/** Identitas pilihan dari `<option>` datalist: id visitor + nama kanonis. */
export interface SuggestionPick {
  visitorId: string
  name: string
}

/** Satu opsi `<datalist>` anggota: nilai tampil + identitas untuk autofill. */
export interface MemberSuggestionOption {
  visitorId: string
  /** Nama kanonis yang disimpan ke formulir setelah autofill. */
  name: string
  /** Nilai `<option>`; `Nama (HP)` hanya saat nama duplikat. */
  value: string
  label: string
}

/**
 * Bangun opsi datalist anggota dari feed saran.
 *
 * Nama dinormalisasi (trim + case-insensitive) untuk mendeteksi duplikat:
 * hanya nama yang muncul lebih dari sekali yang `value`-nya diberi akhiran
 * `(nomor HP)`, sehingga pemilihan tidak selalu jatuh ke orang pertama.
 * Nama unik tetap memakai nama apa adanya. Hasil dibatasi `cap` (default
 * cermin `LIMIT 20` backend).
 */
export function toMemberSuggestionOptions(
  items: readonly MemberSuggestion[] | undefined,
  cap: number = MAX_MEMBER_SUGGESTION_OPTIONS,
): MemberSuggestionOption[] {
  const sliced = (items ?? []).slice(0, cap)
  const nameCounts = new Map<string, number>()
  for (const item of sliced) {
    const key = item.name.trim().toLowerCase()
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1)
  }
  return sliced.map((item) => {
    const key = item.name.trim().toLowerCase()
    const duplicated = (nameCounts.get(key) ?? 0) > 1
    const phone = item.phone.trim()
    return {
      visitorId: item.visitor_id,
      name: item.name,
      value: duplicated && phone !== '' ? `${item.name} (${phone})` : item.name,
      label: memberSuggestionLabel(item),
    }
  })
}

/**
 * Trim + potong ke batas `?q=` backend (dihitung per rune, bukan UTF-16, agar
 * sejajar `RuneLen` Go). Nilai kosong/spasi → `''` (tanpa param `q`).
 */
export function clampSuggestionQuery(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim()
  const runes = Array.from(trimmed)
  return runes.length <= SUGGESTION_QUERY_MAX_LENGTH
    ? trimmed
    : runes.slice(0, SUGGESTION_QUERY_MAX_LENGTH).join('')
}

/**
 * Gabung nama saran (lebih dulu) dengan katalog pelengkap, terdedupe
 * case-insensitive (nama saran menang), dan dibatasi `cap` entri agar datalist
 * tidak meledak. Nama kosong dibuang.
 */
export function mergeSuggestionNames(
  suggestions: readonly VendorSuggestion[] | undefined,
  catalogue: readonly VendorCatalogEntry[],
  cap: number = MAX_VENDOR_SUGGESTION_OPTIONS,
): string[] {
  const seen = new Set<string>()
  const merged: string[] = []
  const push = (name: string): void => {
    const trimmed = name.trim()
    if (trimmed === '') return
    const key = trimmed.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    merged.push(trimmed)
  }
  for (const item of suggestions ?? []) push(item.name)
  for (const item of catalogue) push(item.name)
  return merged.slice(0, cap)
}

/**
 * Petakan detail anggota pilihan ke patch baris formulir. Pemilihan saran
 * MENGGANTI seluruh baris: setiap field selalu ada di patch (properti tidak
 * opsional), sehingga nilai baris lama — termasuk perusahaan vendor — tidak
 * pernah tersisa.
 * - teks diambil apa adanya (`email`/`jabatan` null → `''`);
 * - foto VERBATIM dari URL presigned (tanpa memotong query — pembersihan
 *   dilakukan backend saat menyimpan, lihat `stored_url.go`), nama berkas
 *   diturunkan `fileNameFromUrl`; tidak ada berkas → sentinel kosong
 *   (galat wajib-isi tampil per baris, perilaku sama `toTechnicianRows`);
 * - `vendor_name` di-trim; anggota tanpa perusahaan (null/kosong) →
 *   `''`, yang MENGHAPUS perusahaan pada baris sebelumnya.
 */
export function toMemberSuggestionPatch(
  detail: MemberSuggestionDetail,
): MemberSuggestionPatch {
  return {
    name: detail.name,
    id_number: detail.id_number,
    phone: detail.phone,
    email: detail.email ?? '',
    jabatan: detail.jabatan ?? '',
    vendor_name: detail.vendor_name?.trim() ?? '',
    id_card_photo: detail.id_card_photo_url
      ? {
          url: detail.id_card_photo_url,
          name: fileNameFromUrl(detail.id_card_photo_url),
        }
      : { url: '', name: '' },
    selfie: detail.photo_url
      ? { url: detail.photo_url, name: fileNameFromUrl(detail.photo_url) }
      : { url: '', name: '' },
  }
}
