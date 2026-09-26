import { describe, expect, it } from 'vitest'

import { can, getLoginRedirect } from '@/lib/auth/capabilities'
import type { Capability, Role } from '@/lib/auth/capabilities'

const ROLES: readonly Role[] = ['super_admin', 'admin', 'security', 'pic']

const CAPABILITIES: readonly Capability[] = [
  'viewAllBranches',
  'submitVisit',
  'approveVisit',
  'rejectVisit',
  'rescheduleVisit',
  'cancelVisit',
  'checkIn',
  'checkOut',
  'manageSecurity',
]

/**
 * Expected matrix from PRD v3.1 §4 permission table.
 * One boolean per (role, capability) cell — 4 roles x 9 capabilities = 36 cells.
 */
const EXPECTED: Record<Role, readonly Capability[]> = {
  super_admin: CAPABILITIES,
  admin: [
    'submitVisit',
    'approveVisit',
    'rejectVisit',
    'rescheduleVisit',
    'cancelVisit',
    'checkIn',
    'checkOut',
    'manageSecurity',
  ],
  security: ['checkIn', 'checkOut'],
  pic: ['submitVisit', 'rescheduleVisit', 'cancelVisit'],
}

/** Expected landing page after login, per role. */
const EXPECTED_REDIRECT: Record<Role, string> = {
  super_admin: '/dashboard',
  admin: '/dashboard',
  security: '/gate',
  pic: '/dashboard',
}

/** Every (role, capability) cell, expanded for `it.each`. */
const CELLS = ROLES.flatMap((role) =>
  CAPABILITIES.map((capability) => ({
    role,
    capability,
    expected: (EXPECTED[role] as readonly Capability[]).includes(capability),
  })),
)

describe('can', () => {
  it.each(CELLS)(
    '$role / $capability -> $expected',
    ({ role, capability, expected }) => {
      expect(can(role, capability)).toBe(expected)
    },
  )

  it('covers the full 4 roles x 9 capabilities grid', () => {
    expect(CELLS).toHaveLength(36)
  })
})

describe('role capability totals', () => {
  it('super_admin is allowed every capability', () => {
    const allowed = CAPABILITIES.filter((c) => can('super_admin', c))
    expect(allowed).toEqual([...CAPABILITIES])
  })

  it('admin is allowed every capability except viewAllBranches (branch-locked)', () => {
    expect(can('admin', 'viewAllBranches')).toBe(false)
    const allowed = CAPABILITIES.filter((c) => can('admin', c))
    expect(allowed).toHaveLength(8)
  })

  it('security is allowed only checkIn and checkOut', () => {
    const allowed = CAPABILITIES.filter((c) => can('security', c))
    expect(allowed).toEqual(['checkIn', 'checkOut'])
  })

  it('pic is allowed only submitVisit, rescheduleVisit and cancelVisit', () => {
    const allowed = CAPABILITIES.filter((c) => can('pic', c))
    expect(allowed).toEqual(['submitVisit', 'rescheduleVisit', 'cancelVisit'])
  })
})

describe('getLoginRedirect', () => {
  it.each(ROLES)('%s -> %s', (role) => {
    expect(getLoginRedirect(role)).toBe(EXPECTED_REDIRECT[role])
  })

  it('sends security to the gate kiosk and everyone else to the dashboard', () => {
    expect(getLoginRedirect('security')).toBe('/gate')
    expect(getLoginRedirect('super_admin')).toBe('/dashboard')
    expect(getLoginRedirect('admin')).toBe('/dashboard')
    expect(getLoginRedirect('pic')).toBe('/dashboard')
  })
})
