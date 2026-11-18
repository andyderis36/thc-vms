import { describe, expect, it } from 'vitest'

import {
  CHECKIN_TOLERANCE_HOURS,
  getCheckinBlockReason,
  isWithinCheckinWindow,
} from '@/lib/visits/tolerance'

const HOUR_MS = 3600_000

/** Fixed base instant: 2026-09-25T09:00:00+07:00. No date library, no `Date.now()`. */
const START = new Date('2026-09-25T09:00:00+07:00')
/** Visit window is 4 hours long. */
const END = new Date(START.getTime() + 4 * HOUR_MS)

/** Local helper: shift an instant by a whole number of hours. */
const shiftHours = (base: Date, hours: number): Date =>
  new Date(base.getTime() + hours * HOUR_MS)

/** Local helper: shift an instant by a millisecond count (for sub-hour boundaries). */
const shiftMs = (base: Date, ms: number): Date => new Date(base.getTime() + ms)

describe('CHECKIN_TOLERANCE_HOURS', () => {
  it('is the number 2', () => {
    expect(CHECKIN_TOLERANCE_HOURS).toBe(2)
  })
})

describe('isWithinCheckinWindow', () => {
  it('allows now exactly at start minus 2h (inclusive lower boundary)', () => {
    const now = shiftHours(START, -CHECKIN_TOLERANCE_HOURS)
    expect(isWithinCheckinWindow(now, START, END)).toBe(true)
  })

  it('allows now at start minus 1h 59m', () => {
    const now = shiftMs(shiftHours(START, -CHECKIN_TOLERANCE_HOURS), 60_000)
    expect(isWithinCheckinWindow(now, START, END)).toBe(true)
  })

  it('allows now in the middle of the visit window', () => {
    const now = shiftHours(START, 2)
    expect(isWithinCheckinWindow(now, START, END)).toBe(true)
  })

  it('allows now exactly at end (inclusive upper boundary, no 2h grace)', () => {
    expect(isWithinCheckinWindow(END, START, END)).toBe(true)
  })

  it('rejects now at end plus 1ms', () => {
    const now = shiftMs(END, 1)
    expect(isWithinCheckinWindow(now, START, END)).toBe(false)
  })

  it('rejects now at start minus 2h and 1ms', () => {
    const now = shiftMs(shiftHours(START, -CHECKIN_TOLERANCE_HOURS), -1)
    expect(isWithinCheckinWindow(now, START, END)).toBe(false)
  })

  it('rejects now 3h before start', () => {
    const now = shiftHours(START, -3)
    expect(isWithinCheckinWindow(now, START, END)).toBe(false)
  })

  it('rejects now 3h after end', () => {
    const now = shiftHours(END, 3)
    expect(isWithinCheckinWindow(now, START, END)).toBe(false)
  })
})

describe('isWithinCheckinWindow argument coercion', () => {
  it('accepts Date instances', () => {
    expect(isWithinCheckinWindow(START, START, END)).toBe(true)
  })

  it('accepts ISO strings for now, start and end', () => {
    expect(
      isWithinCheckinWindow(START.toISOString(), START.toISOString(), END.toISOString()),
    ).toBe(true)
  })

  it('accepts epoch milliseconds for now, start and end', () => {
    expect(isWithinCheckinWindow(START.getTime(), START.getTime(), END.getTime())).toBe(
      true,
    )
  })
})

describe('getCheckinBlockReason', () => {
  it('returns null (allowed) at the inclusive lower boundary', () => {
    const now = shiftHours(START, -CHECKIN_TOLERANCE_HOURS)
    expect(getCheckinBlockReason(now, START, END)).toBeNull()
  })

  it('returns null (allowed) mid-window', () => {
    const now = shiftHours(START, 2)
    expect(getCheckinBlockReason(now, START, END)).toBeNull()
  })

  it('returns null (allowed) at the inclusive upper boundary', () => {
    expect(getCheckinBlockReason(END, START, END)).toBeNull()
  })

  it('returns a non-empty string when 1ms before the lower boundary', () => {
    const now = shiftMs(shiftHours(START, -CHECKIN_TOLERANCE_HOURS), -1)
    const reason = getCheckinBlockReason(now, START, END)
    expect(typeof reason).toBe('string')
    expect(reason).not.toBe('')
  })

  it('returns a non-empty string when 3h before start', () => {
    const reason = getCheckinBlockReason(shiftHours(START, -3), START, END)
    expect(typeof reason).toBe('string')
    expect(reason).not.toBe('')
  })

  it('returns a non-empty string when 1ms after the upper boundary', () => {
    const now = shiftMs(END, 1)
    const reason = getCheckinBlockReason(now, START, END)
    expect(typeof reason).toBe('string')
    expect(reason).not.toBe('')
  })

  it('returns a non-empty string when 3h after end', () => {
    const reason = getCheckinBlockReason(shiftHours(END, 3), START, END)
    expect(typeof reason).toBe('string')
    expect(reason).not.toBe('')
  })
})
