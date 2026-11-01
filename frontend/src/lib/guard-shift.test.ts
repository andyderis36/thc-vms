import { describe, expect, it } from 'vitest'

import { getGuardShiftLabel } from './guard-shift'

/**
 * Konstruksi waktu memakai offset eksplisit `+07:00` (WIB tanpa DST),
 * sehingga hasilnya identik di mesin dengan zona waktu sistem berbeda.
 */
function wib(isoLocal: string): Date {
  return new Date(`${isoLocal}+07:00`)
}

describe('getGuardShiftLabel — batas shift WIB', () => {
  it.each([
    ['2026-03-10T00:00:00', 'Shift Malam'],
    ['2026-03-10T07:59:00', 'Shift Malam'],
    ['2026-03-10T08:00:00', 'Shift Pagi'],
    ['2026-03-10T15:59:00', 'Shift Pagi'],
    ['2026-03-10T16:00:00', 'Shift Sore'],
    ['2026-03-10T23:59:00', 'Shift Sore'],
  ] as const)('%s WIB → %s', (local, expected) => {
    expect(getGuardShiftLabel(wib(local))).toBe(expected)
  })
})
