import type { VisitDetail } from '@/lib/api/types'

/**
 * Pilih tiket QR aktif milik vendor dari daftar kunjungan.
 *
 * HANYA status yang benar-benar menampilkan kartu QR di SCR-04, dengan
 * prioritas `visiting` -> `offsite` -> `approved` (kecocokan pertama menang).
 * `offsite` = permit multi-entry yang masih aktif di luar lokasi; QR yang sama
 * dipakai untuk check-in ulang (re-entry) di gerbang, sama seperti
 * `visiting`/`approved`. Kunjungan yang belum disetujui SENGAJA tidak pernah
 * dipilih: `/qr` akan mengarahkan ke detail yang tab aktifnya "Kunjungan
 * Saya", bertentangan dengan tab "Tiket QR" yang baru saja ditekan (bug yang
 * dilaporkan). Tanpa tiket aktif, resolver membiarkan pengguna di `/qr`
 * untuk melihat empty state.
 */
export function selectActiveQrVisit(items: VisitDetail[]): VisitDetail | null {
  return (
    items.find((visit) => visit.status === 'visiting') ??
    items.find((visit) => visit.status === 'offsite') ??
    items.find((visit) => visit.status === 'approved') ??
    null
  )
}
