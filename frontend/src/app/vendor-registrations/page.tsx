'use client'

import { ManagedUsersScreen } from '@/features/users/components/ManagedUsersScreen'
import type { ManagedPageRole } from '@/features/users/managed-user-filters'
import { RequireRole } from '@/lib/auth/guards'

/** Peran yang DICAKUP halaman ini — satu layar = satu peran. */
export const VENDOR_REGISTRATIONS_PAGE_ROLES = [
  'vendor',
] as const satisfies readonly ManagedPageRole[]

/**
 * PRD §4 — Manajemen User & Vendor (superadmin).
 *
 * Halaman khusus pendaftaran akun Vendor/Mitra (`vendor`) — teknisi mitra
 * eksternal yang mengajukan izin kunjungan. Terpisah dari `/coordinators`
 * (Koordinator Wilayah + Superadmin) sehingga peran tak tercampur dalam satu
 * tabel. Karena cakupannya cuma satu peran, kontrol filter peran di kolom
 * "Peran" tak dirender (satu opsi = derau). Guard penuh
 * `RequireRole allow=['super_admin']` + SuperadminShell.
 */
export default function VendorRegistrationsPage() {
  return (
    <RequireRole allow={['super_admin']}>
      <ManagedUsersScreen
        roles={VENDOR_REGISTRATIONS_PAGE_ROLES}
        activeHref="/vendor-registrations"
        title="Pendaftaran Vendor/Mitra"
        subtitle="Kelola akun Vendor/Mitra (teknisi mitra eksternal) yang terdaftar di THC."
      />
    </RequireRole>
  )
}
