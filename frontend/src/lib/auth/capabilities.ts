import type { Role } from '@/lib/api/types'

export type { Role } from '@/lib/api/types'

/**
 * Matriks kapabilitas RBAC. Sumber kebenaran: PRD v3.1 §4.
 *
 * Aturan emas: isolasi cabang ditegakkan di backend. `viewAllBranches` hanya
 * dimiliki `super_admin` (Kantor Pusat); `admin` terkunci pada `location_id`
 * cabangnya. Satpam hanya boleh check-in/out, dan vendor (Vendor/Mitra)
 * tidak pernah bisa
 * menyetujui, menolak, atau mengelola satpam. Hapus permanen
 * (`deleteRecords`: DELETE /visits, /users, /locations) hanya super_admin;
 * `admin` tidak memiliki kapabilitas ini. Hapus satpam cabang
 * (`deleteSecurity`: DELETE /users/security/{id}) dimiliki super_admin
 * dan admin cabang (terkunci ke cabangnya); vendor/security tidak.
 */

export type Capability =
  | 'viewAllBranches'
  | 'submitVisit'
  | 'approveVisit'
  | 'rejectVisit'
  | 'rescheduleVisit'
  | 'cancelVisit'
  | 'checkIn'
  | 'checkOut'
  | 'manageSecurity'
  | 'deleteSecurity'
  | 'deleteRecords'

const CAPABILITIES_BY_ROLE: Record<Role, ReadonlySet<Capability>> = {
  super_admin: new Set<Capability>([
    'viewAllBranches',
    'submitVisit',
    'approveVisit',
    'rejectVisit',
    'rescheduleVisit',
    'cancelVisit',
    'checkIn',
    'checkOut',
    'manageSecurity',
    'deleteSecurity',
    'deleteRecords',
  ]),
  admin: new Set<Capability>([
    'submitVisit',
    'approveVisit',
    'rejectVisit',
    'rescheduleVisit',
    'cancelVisit',
    'checkIn',
    'checkOut',
    'manageSecurity',
    'deleteSecurity',
  ]),
  security: new Set<Capability>(['checkIn', 'checkOut']),
  vendor: new Set<Capability>(['submitVisit', 'rescheduleVisit', 'cancelVisit']),
}

const LOGIN_REDIRECT_BY_ROLE: Record<Role, '/gate' | '/dashboard'> = {
  super_admin: '/dashboard',
  admin: '/dashboard',
  security: '/gate',
  vendor: '/dashboard',
}

/**
 * Label tampilan peran (display-only, Bahasa Indonesia).
 * SATU-SATUNYA sumber kebenaran label peran di seluruh frontend.
 * Enum/logika RBAC berjalan pada nilai wire `role` (mis. `role === 'vendor'`,
 * JWT, API, DB); pemetaan teks yang dilihat pengguna ada di sini.
 * Nilai wire `pic` telah diganti menjadi `vendor` (kontrak FE/BE baru) —
 * label tampilan peran mitra kini `Vendor/Mitra`.
 */
const ROLE_LABEL_BY_ROLE: Record<Role, string> = {
  super_admin: 'Superadmin',
  admin: 'Koordinator Wilayah',
  security: 'Pengawas',
  vendor: 'Vendor/Mitra',
}

/** Label tampilan peran untuk UI (shell, sidebar, demo grup, judul, toast). */
export function getRoleLabel(role: Role): string {
  return ROLE_LABEL_BY_ROLE[role]
}

export function can(role: Role, capability: Capability): boolean {
  return CAPABILITIES_BY_ROLE[role].has(capability)
}

/** Layar tujuan setelah login: kiosk gerbang untuk satpam, dashboard untuk peran lain. */
export function getLoginRedirect(role: Role): '/gate' | '/dashboard' {
  return LOGIN_REDIRECT_BY_ROLE[role]
}
