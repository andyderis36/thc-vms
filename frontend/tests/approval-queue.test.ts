import { describe, expect, it } from 'vitest'

import type { VisitDetail, VisitStatus } from '@/lib/api/types'
import { mergeUpcomingQueue } from '@/lib/visits/upcoming-queue'

/**
 * Kontrak antrean APPROVAL (`/approvals` + tab "Menunggu Approval" SCR-02):
 * gabungan `requested` + `rescheduled` — keduanya menunggu keputusan, jadi
 * keduanya harus tampil di antrean approval tanpa refresh halaman.
 * `mergeUpcomingQueue` yang sama dipakai oleh antrean "Akan Hadir" gerbang
 * (lihat `upcoming-queue.test.ts`); file ini mengunci sisi approval-nya.
 */

/** Fixture minimal — helper hanya memakai `id` + `start_date` (+ `status` untuk asersi). */
function makeVisit(
  id: string,
  start_date: string,
  status: VisitStatus = 'requested',
): VisitDetail {
  return {
    id,
    visit_id: `VST-${id}`,
    status,
    location: {} as VisitDetail['location'],
    purposes: [],
    pic_user: {} as VisitDetail['pic_user'],
    vendor_name: 'PT Maju Jaya',
    start_date,
    end_date: start_date,
    assignment_letter_url: null,
    notes: null,
    visitors: [],
    created_at: start_date,
  }
}

describe('mergeUpcomingQueue — antrean approval (requested + rescheduled)', () => {
  it('deduplicates by visit.id — a visit present in both lists appears once (requested copy wins)', () => {
    const requested = [makeVisit('v1', '2026-10-01T09:00:00+07:00')]
    const rescheduled = [
      makeVisit('v1', '2026-10-03T09:00:00+07:00', 'rescheduled'),
      makeVisit('v2', '2026-10-02T09:00:00+07:00', 'rescheduled'),
    ]

    const merged = mergeUpcomingQueue(requested, rescheduled)

    expect(merged.map((v) => v.id)).toEqual(['v1', 'v2'])
    // Versi requested (didahulukan) yang menang, bukan salinan rescheduled.
    expect(merged[0]?.start_date).toBe('2026-10-01T09:00:00+07:00')
    expect(merged[0]?.status).toBe('requested')
  })

  it('sorts the merged approval queue chronologically by start_date ascending', () => {
    const requested = [
      makeVisit('late', '2026-10-05T10:00:00+07:00'),
      makeVisit('mid', '2026-10-03T10:00:00+07:00'),
    ]
    const rescheduled = [
      makeVisit('resched-later', '2026-10-06T10:00:00+07:00', 'rescheduled'),
      makeVisit('resched-first', '2026-10-01T10:00:00+07:00', 'rescheduled'),
    ]

    const merged = mergeUpcomingQueue(requested, rescheduled)

    expect(merged.map((v) => v.id)).toEqual([
      'resched-first',
      'mid',
      'late',
      'resched-later',
    ])
  })

  it('keeps each rescheduled entry\'s status — the approve gate reads VisitDetail.status', () => {
    const merged = mergeUpcomingQueue(
      [makeVisit('req', '2026-10-02T09:00:00+07:00', 'requested')],
      [makeVisit('resched', '2026-10-04T09:00:00+07:00', 'rescheduled')],
    )

    expect(merged.map((v) => v.status)).toEqual(['requested', 'rescheduled'])
  })

  it('returns the requested list when the rescheduled side is empty', () => {
    const requested = [
      makeVisit('b', '2026-10-02T08:00:00+07:00'),
      makeVisit('a', '2026-10-01T08:00:00+07:00'),
    ]

    const merged = mergeUpcomingQueue(requested, [])

    expect(merged.map((v) => v.id)).toEqual(['a', 'b'])
  })

  it('returns the rescheduled list when the requested side is empty', () => {
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

  it('never mutates its arguments — a fresh array is returned every call', () => {
    const requested = [makeVisit('b', '2026-10-05T08:00:00+07:00')]
    const rescheduled = [makeVisit('a', '2026-10-01T08:00:00+07:00', 'rescheduled')]
    const requestedOrder = requested.map((v) => v.id)
    const rescheduledOrder = rescheduled.map((v) => v.id)

    const merged = mergeUpcomingQueue(requested, rescheduled)

    expect(merged).not.toBe(requested)
    expect(merged).not.toBe(rescheduled)
    expect(requested.map((v) => v.id)).toEqual(requestedOrder)
    expect(rescheduled.map((v) => v.id)).toEqual(rescheduledOrder)
  })
})
