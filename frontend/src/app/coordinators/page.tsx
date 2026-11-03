'use client'

import { ManagedUsersScreen } from '@/features/users/components/ManagedUsersScreen'
import type { ManagedPageRole } from '@/features/users/managed-user-filters'
import { RequireRole } from '@/lib/auth/guards'

/**
 * Peran yang DICAKUP halaman ini: Koordinator Wilayah (`admin`) DAN akun
 * tingkat atas (`super_admin`). Keduanya dulu punya halaman sendiri; kini
 * dipisah lewat filter peran di kolom "Peran".
 */
export const COORDINATORS_PAGE_ROLES = [
  'admin',
  'super_admin',
] as const satisfies readonly ManagedPageRole[]

/**
 * PRD §4 — Manajemen User & Vendor (superadmin).
 *
 * Halaman akun internal: Koordinator Wilayah (`admin`) di seluruh cabang &
 * POP, berikut akun tingkat atas (`super_admin`) di Kantor Pusat. Peran
 * dibedakan lewat filter di kolom "Peran", bukan lewat halaman per-peran;
 * akun Vendor/Mitra tetap terpisah di `/vendor-registrations`. Guard penuh
 * `RequireRole allow=['super_admin']` + SuperadminShell.
 */
export default function CoordinatorsPage() {
  return (
    <RequireRole allow={['super_admin']}>
      <ManagedUsersScreen
        roles={COORDINATORS_PAGE_ROLES}
        activeHref="/coordinators"
        title="Koordinator Wilayah & Superadmin"
        subtitle="Kelola akun Koordinator Wilayah di seluruh kantor cabang dan POP THC, berikut akun tingkat atas (Superadmin) di Kantor Pusat."
        countNoun="akun"
      />
    </RequireRole>
  )
}
