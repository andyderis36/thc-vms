import type { Role } from '@/lib/api/types'

export type { Role } from '@/lib/api/types'

/**
 * Matriks kapabilitas RBAC. Sumber kebenaran: PRD v3.1 §4.
 *
 * Aturan emas: isolasi cabang ditegakkan di backend. `viewAllBranches` hanya
 * dimiliki `super_admin` (Kantor Pusat); `admin` terkunci pada `location_id`
 * cabangnya. Satpam hanya boleh check-in/out, dan PIC tidak pernah bisa
 * menyetujui, menolak, atau mengelola satpam.
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
  ]),
  security: new Set<Capability>(['checkIn', 'checkOut']),
  pic: new Set<Capability>(['submitVisit', 'rescheduleVisit', 'cancelVisit']),
}

const LOGIN_REDIRECT_BY_ROLE: Record<Role, '/gate' | '/dashboard'> = {
  super_admin: '/dashboard',
  admin: '/dashboard',
  security: '/gate',
  pic: '/dashboard',
}

export function can(role: Role, capability: Capability): boolean {
  return CAPABILITIES_BY_ROLE[role].has(capability)
}

/** Layar tujuan setelah login: kiosk gerbang untuk satpam, dashboard untuk peran lain. */
export function getLoginRedirect(role: Role): '/gate' | '/dashboard' {
  return LOGIN_REDIRECT_BY_ROLE[role]
}
