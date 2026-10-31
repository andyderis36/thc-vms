import { describe, expect, it } from 'vitest'

import { can, getLoginRedirect, getRoleLabel, isSuperAdminRole } from '@/lib/auth/capabilities'
import type { Capability, Role } from '@/lib/auth/capabilities'

const ROLES: readonly Role[] = ['super_admin', 'dev-superadmin', 'admin', 'security', 'vendor']

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
  'dev-superadmin': CAPABILITIES,
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
  vendor: ['submitVisit', 'rescheduleVisit', 'cancelVisit'],
}

/** Expected landing page after login, per role. */
const EXPECTED_REDIRECT: Record<Role, string> = {
  super_admin: '/dashboard',
  'dev-superadmin': '/dashboard',
  admin: '/dashboard',
  security: '/gate',
  vendor: '/dashboard',
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

  it('covers the full 5 roles x 9 capabilities grid', () => {
    expect(CELLS).toHaveLength(45)
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

  it('vendor is allowed only submitVisit, rescheduleVisit and cancelVisit (mantan pic)', () => {
    const allowed = CAPABILITIES.filter((c) => can('vendor', c))
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
    expect(getLoginRedirect('dev-superadmin')).toBe('/dashboard')
    expect(getLoginRedirect('admin')).toBe('/dashboard')
    expect(getLoginRedirect('vendor')).toBe('/dashboard')
  })
})

describe('isSuperAdminRole', () => {
  it('admits super_admin and the hidden dev-superadmin only', () => {
    expect(isSuperAdminRole('super_admin')).toBe(true)
    expect(isSuperAdminRole('dev-superadmin')).toBe(true)
    expect(isSuperAdminRole('admin')).toBe(false)
    expect(isSuperAdminRole('security')).toBe(false)
    expect(isSuperAdminRole('vendor')).toBe(false)
  })
})

describe('dev-superadmin capabilities (hidden highest role)', () => {
  it('dev-superadmin is allowed every capability like super_admin', () => {
    const allowed = CAPABILITIES.filter((c) => can('dev-superadmin', c))
    expect(allowed).toEqual([...CAPABILITIES])
  })

  it('dev-superadmin never gains a capability super_admin lacks', () => {
    for (const capability of CAPABILITIES) {
      expect(can('dev-superadmin', capability)).toBe(can('super_admin', capability))
    }
  })
})

describe('getRoleLabel', () => {
  it("pins getRoleLabel('vendor') to the approved label 'Vendor/Mitra'", () => {
    expect(getRoleLabel('vendor')).toBe('Vendor/Mitra')
  })

  it('keeps the other role labels byte-identical', () => {
    expect(getRoleLabel('super_admin')).toBe('Superadmin')
    expect(getRoleLabel('dev-superadmin')).toBe('Developer Superadmin')
    expect(getRoleLabel('admin')).toBe('Koordinator Wilayah')
    expect(getRoleLabel('security')).toBe('Pengawas')
  })

  it('no longer maps any label under the retired `pic` role key', () => {
    // @ts-expect-error 'pic' is no longer a member of Role after the rename.
    const retired = getRoleLabel('pic')
    expect(retired).toBeUndefined()
  })
})

describe('vendor capabilities (renamed from pic)', () => {
  const OLD_PIC_SET: readonly Capability[] = [
    'submitVisit',
    'rescheduleVisit',
    'cancelVisit',
  ]

  it('vendor capability set equals the old pic set exactly', () => {
    const allowed = CAPABILITIES.filter((c) => can('vendor', c))
    expect(allowed).toEqual([...OLD_PIC_SET])
  })

  it('vendor never gains approval or management capabilities', () => {
    expect(can('vendor', 'approveVisit')).toBe(false)
    expect(can('vendor', 'rejectVisit')).toBe(false)
    expect(can('vendor', 'manageSecurity')).toBe(false)
    expect(can('vendor', 'deleteSecurity')).toBe(false)
    expect(can('vendor', 'deleteRecords')).toBe(false)
    expect(can('vendor', 'viewAllBranches')).toBe(false)
  })
})
