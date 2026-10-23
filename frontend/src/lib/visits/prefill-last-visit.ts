/**
 * Prefill SCR-03 dari kunjungan terakhir vendor — modul MURNI (tanpa I/O,
 * tanpa React). Dipanggil HANYA saat tombol "Gunakan data kunjungan
 * terakhir" ditekan, tidak pernah otomatis, agar tidak bertabrakan dengan
 * efek autosave roster / prefill nama vendor akun di `VisitForm`.
 *
 * Kontrak pemetaan (`VisitDetail` → `TechnicianFormValues[]`) ROSTER SAJA:
 * data anggota stabil antar-pengajuan (kru yang sama), sedangkan fasilitas,
 * tujuan, jadwal, surat tugas, dan catatan selalu bervariasi per kunjungan
 * sehingga TIDAK PERNAH diwarisi — field dinamis itu tetap pada nilai awal
 * kosong formulir.
 * - Foto: URL dibawa VERBATIM (tanpa memotong query presigned —
 *   pembersihan dilakukan backend saat menyimpan ulang, lihat `stored_url.go`).
 * - Nama berkas diturunkan dari segmen terakhir pathname URL (di-decode),
 *   fallback `"berkas"`.
 *
 * Pemilihan kunjungan terakhir memakai `selectLatestVisit` (maks `created_at`
 * di sisi klien): pengurutan backend `GET /visits` adalah `start_date DESC`,
 * BUKAN `created_at`, jadi baris pertama bukan yang terbaru dibuat.
 */

import type { TechnicianFormValues } from '@/features/visits/form/visit-schema'
import type { VisitDetail } from '@/lib/api/types'

/** Nama berkas bila URL tak punya segmen terakhir yang terbaca. */
const FALLBACK_FILE_NAME = 'berkas'

/**
 * Nama berkas tampilan dari URL: segmen terakhir pathname (query presigned
 * seperti `?X-Amz-…` otomatis gugur) yang di-`decodeURIComponent`.
 * Gagal parse / kosong → `"berkas"`.
 */
function fileNameFromUrl(url: string): string {
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''
    const decoded = decodeURIComponent(segment)
    return decoded === '' ? FALLBACK_FILE_NAME : decoded
  } catch {
    return FALLBACK_FILE_NAME
  }
}

/** Waktu `created_at` sebagai epoch; nilai tak terbaca dianggap terlama. */
function createdAtTime(visit: VisitDetail): number {
  const time = Date.parse(visit.created_at)
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time
}

/**
 * Pilih kunjungan dengan `created_at` paling baru dari satu halaman daftar.
 * Urutan input bebas (backend mengurutkan `start_date DESC`); daftar kosong
 * atau absen → `undefined`.
 */
export function selectLatestVisit(
  items: readonly VisitDetail[] | undefined,
): VisitDetail | undefined {
  if (items === undefined || items.length === 0) return undefined
  return items.reduce((latest, item) =>
    createdAtTime(item) > createdAtTime(latest) ? item : latest,
  )
}

/**
 * Petakan satu `VisitDetail` menjadi baris-baris roster anggota SCR-03.
 * HANYA roster yang diwarisi (nama, nomor identitas, No. HP, teks vendor,
 * foto KTP + selfie VERBATIM) dan SEMUANYA tetap bisa diedit — pemanggil
 * wajib menerapkan hasilnya lewat `setValue('technicians', …)` bertarget
 * agar nilai + status dirty field lain (fasilitas, tujuan, jadwal, SPK,
 * catatan, SOP) tidak tersentuh.
 */
export function toTechnicianRows(visit: VisitDetail): TechnicianFormValues[] {
  return visit.visitors.map((visitor) => ({
    name: visitor.name,
    id_number: visitor.id_number,
    phone: visitor.phone,
    // Foto KTP wajib di skema — tanpa foto lama pakai sentinel kosong agar
    // error tampil per-baris saat dikirim tanpa foto baru.
    id_card_photo: visitor.id_card_photo_url
      ? {
          url: visitor.id_card_photo_url,
          name: fileNameFromUrl(visitor.id_card_photo_url),
        }
      : { url: '', name: '' },
    // Selfie wajib di skema — tanpa foto lama pakai sentinel kosong agar
    // error tampil per-baris saat dikirim tanpa selfie baru.
    selfie: visitor.photo_url
      ? { url: visitor.photo_url, name: fileNameFromUrl(visitor.photo_url) }
      : { url: '', name: '' },
    jabatan: visitor.jabatan ?? '',
    vendor_name: visitor.vendor_name ?? '',
  }))
}
