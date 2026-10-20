import type { VisitDetail } from '@/lib/api/types'

/**
 * Pilih tiket QR aktif milik vendor dari daftar kunjungan.
 *
 * HANYA `visiting`/`approved` - status yang benar-benar menampilkan kartu QR
 * di SCR-04. Kunjungan yang belum disetujui SENGAJA tidak pernah dipilih:
 * `/qr` akan mengarahkan ke detail yang tab aktifnya "Kunjungan Saya",
 * bertentangan dengan tab "Tiket QR" yang baru saja ditekan (bug yang
 * dilaporkan). Tanpa tiket aktif, resolver membiarkan pengguna di `/qr`
 * untuk melihat empty state.
 */
export function selectActiveQrVisit(items: VisitDetail[]): VisitDetail | null {
  return (
    items.find((visit) => visit.status === 'visiting') ??
    items.find((visit) => visit.status === 'approved') ??
    null
  )
}
