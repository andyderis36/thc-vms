import { visitVendorUser } from './vendor-user'

/**
 * Bentuk minimum yang dibaca helper ini dari objek kunjungan — sengaja
 * dilepas dari `VisitDetail` penuh agar bisa dipakai fixture/parameter
 * parsial tanpa memutar seluruh type.
 */
interface VisitCompanySource {
  vendor_name?: string | null
  vendor_user?: { name?: string | null; vendor_name?: string | null }
  /** @deprecated Fase-1 rename `pic_user`→`vendor_user`: fallback transisi. */
  pic_user?: { name?: string | null; vendor_name?: string | null }
}

/**
 * Perusahaan Vendor/Mitra pengaju sebuah kunjungan untuk kartu Informasi
 * Kunjungan (SCR-04) — SATU-satunya jalur baca di UI.
 *
 * Urutan menang: override manual per kunjungan (`visit.vendor_name`,
 * migrasi 000017) → perusahaan akun vendor pengaju
 * (`vendor_user.vendor_name`) → nama pemegang akun (`vendor_user.name`).
 */
export function visitVendorCompany(visit: VisitCompanySource): string {
  const override = (visit.vendor_name ?? '').trim()
  if (override !== '') return override
  const vendorUser = visitVendorUser(visit)
  const accountCompany = (vendorUser?.vendor_name ?? '').trim()
  if (accountCompany !== '') return accountCompany
  const holder = (vendorUser?.name ?? '').trim()
  return holder !== '' ? holder : '—'
}
