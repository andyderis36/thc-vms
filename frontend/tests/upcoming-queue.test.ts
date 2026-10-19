import { describe, expect, it } from 'vitest'

import type { VisitDetail, VisitStatus } from '@/lib/api/types'
import {
  CHECKIN_CLOSE_GRACE_MS,
  isCheckinWindowOpen,
  mergeUpcomingQueue,
} from '@/lib/visits/upcoming-queue'

/** Fixture minimal — helper hanya memakai `id` + `start_date`. */
function makeVisit(
  id: string,
  start_date: string,
  status: VisitStatus = 'approved',
): VisitDetail {
  return {
    id,
    visit_id: `VST-${id}`,
    status,
    location: {} as VisitDetail['location'],
    purposes: [],
    vendor_user: {} as VisitDetail['vendor_user'],
    vendor_name: 'PT Maju Jaya',
    start_date,
    end_date: start_date,
    assignment_letter_url: null,
    notes: null,
    visitors: [],
    created_at: start_date,
  }
}

describe('mergeUpcomingQueue', () => {
  it('deduplicates by visit.id — a visit present in both lists appears once (approved copy wins)', () => {
    const approved = [makeVisit('v1', '2026-10-01T09:00:00+07:00')]
    const rescheduled = [
      makeVisit('v1', '2026-10-03T09:00:00+07:00', 'rescheduled'),
      makeVisit('v2', '2026-10-02T09:00:00+07:00', 'rescheduled'),
    ]

    const merged = mergeUpcomingQueue(approved, rescheduled)

    expect(merged.map((v) => v.id)).toEqual(['v1', 'v2'])
    // Versi approved (didahulukan) yang menang, bukan salinan rescheduled.
    expect(merged[0]?.start_date).toBe('2026-10-01T09:00:00+07:00')
    expect(merged[0]?.status).toBe('approved')
  })

  it('sorts the merged queue chronologically by start_date ascending', () => {
    const approved = [
      makeVisit('late', '2026-10-05T10:00:00+07:00'),
      makeVisit('mid', '2026-10-03T10:00:00+07:00'),
    ]
    const rescheduled = [
      makeVisit('resched-later', '2026-10-06T10:00:00+07:00', 'rescheduled'),
      makeVisit('resched-first', '2026-10-01T10:00:00+07:00', 'rescheduled'),
    ]

    const merged = mergeUpcomingQueue(approved, rescheduled)

    expect(merged.map((v) => v.id)).toEqual([
      'resched-first',
      'mid',
      'late',
      'resched-later',
    ])
  })

  it('returns the approved list when the rescheduled side is empty', () => {
    const approved = [
      makeVisit('b', '2026-10-02T08:00:00+07:00'),
      makeVisit('a', '2026-10-01T08:00:00+07:00'),
    ]

    const merged = mergeUpcomingQueue(approved, [])

    expect(merged.map((v) => v.id)).toEqual(['a', 'b'])
  })

  it('returns the rescheduled list when the approved side is empty', () => {
    const rescheduled = [
      makeVisit('r2', '2026-10-04T08:00:00+07:00', 'rescheduled'),
      makeVisit('r1', '2026-10-02T08:00:00+07:00', 'rescheduled'),
    ]

    const merged = mergeUpcomingQueue([], rescheduled)

    expect(merged.map((v) => v.id)).toEqual(['r1', 'r2'])
    expect(merged.every((v) => v.status === 'rescheduled')).toBe(true)
  })

  it('returns an empty array when both sides are empty', () => {
    expect(mergeUpcomingQueue([], [])).toEqual([])
  })
})

describe('isCheckinWindowOpen (filter tab "Akan Hadir" /gate)', () => {
  /** Fixed "now": 12:00 WIB — semua fixture di bawah memakai jam ini. */
  const NOW = new Date('2026-10-18T12:00:00+07:00')

  it('CHECKIN_CLOSE_GRACE_MS is the 2h check-in tolerance in milliseconds', () => {
    expect(CHECKIN_CLOSE_GRACE_MS).toBe(2 * 3_600_000)
  })

  it('drops a row whose end_date + 2h is already in the past', () => {
    // end 09:00 + 2h = 11:00 < 12:00 -> ditutup.
    const closed = makeVisit('closed', '2026-10-18T09:00:00+07:00')
    const stillOpen = makeVisit('open', '2026-10-18T11:00:00+07:00')

    expect(isCheckinWindowOpen(closed, NOW)).toBe(false)

    const queue = mergeUpcomingQueue([closed, stillOpen], []).filter((visit) =>
      isCheckinWindowOpen(visit, NOW),
    )
    expect(queue.map((v) => v.id)).toEqual(['open'])
  })

  it('keeps a row still within the 2h grace after end_date', () => {
    // end 11:00 + 2h = 13:00 > 12:00 -> masih dalam grace, walaupun
    // jadwalnya sudah lewat 1 jam.
    const withinGrace = makeVisit('grace', '2026-10-18T11:00:00+07:00')

    expect(isCheckinWindowOpen(withinGrace, NOW)).toBe(true)

    const queue = mergeUpcomingQueue([withinGrace], []).filter((visit) =>
      isCheckinWindowOpen(visit, NOW),
    )
    expect(queue.map((v) => v.id)).toEqual(['grace'])
  })

  it('treats end_date + 2h == now as closed (deterministic <= boundary)', () => {
    // end 10:00 + 2h = 12:00 == NOW -> TEPAT di batas: dibuang (<=).
    const boundary = makeVisit('boundary', '2026-10-18T10:00:00+07:00')

    expect(boundary.end_date).toBeTruthy()
    expect(isCheckinWindowOpen(boundary, NOW)).toBe(false)
    expect(isCheckinWindowOpen(boundary, new Date(NOW.getTime() - 1))).toBe(true)
  })

  it('defaults now to the wall clock when omitted', () => {
    expect(
      isCheckinWindowOpen(makeVisit('future', '2099-01-01T00:00:00+07:00')),
    ).toBe(true)
    expect(
      isCheckinWindowOpen(makeVisit('ancient', '2000-01-01T00:00:00+07:00')),
    ).toBe(false)
  })
})
