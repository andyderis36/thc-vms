import { describe, expect, it } from 'vitest'

import { VISIT_STATUS_META } from '@/lib/visits/status-badge'

type Tone = 'info' | 'success' | 'danger' | 'neutral' | 'warning'

const EXPECTED_META: Record<string, { label: string; tone: Tone }> = {
  requested: { label: 'Diminta', tone: 'info' },
  approved: { label: 'Disetujui', tone: 'success' },
  visiting: { label: 'Sedang di Lokasi', tone: 'info' },
  completed: { label: 'Selesai', tone: 'success' },
  not_visit: { label: 'Tidak Hadir', tone: 'danger' },
  rejected: { label: 'Ditolak', tone: 'danger' },
  cancelled: { label: 'Dibatalkan', tone: 'neutral' },
  rescheduled: { label: 'Jadwal Digeser', tone: 'warning' },
}

const EXPECTED_STATUSES = Object.keys(EXPECTED_META)

const VALID_TONES: readonly Tone[] = [
  'info',
  'success',
  'danger',
  'neutral',
  'warning',
]

describe('VISIT_STATUS_META', () => {
  it('is keyed by exactly the 8 visit statuses', () => {
    expect(Object.keys(VISIT_STATUS_META)).toHaveLength(8)
  })

  it('has exactly the expected key set (no missing, no extra)', () => {
    expect(Object.keys(VISIT_STATUS_META).sort()).toEqual(
      [...EXPECTED_STATUSES].sort(),
    )
  })

  it.each(EXPECTED_STATUSES)('maps %s to its expected label and tone', (status) => {
    expect(VISIT_STATUS_META).toEqual(
      expect.objectContaining({
        [status]: EXPECTED_META[status],
      }),
    )
  })

  it('matches the whole table exactly', () => {
    expect(VISIT_STATUS_META).toEqual(EXPECTED_META)
  })
})

describe('VISIT_STATUS_META entry shape', () => {
  it('every entry exposes only label and tone', () => {
    for (const [status, meta] of Object.entries(VISIT_STATUS_META)) {
      expect(Object.keys(meta).sort()).toEqual(['label', 'tone'])
      expect(status).not.toBe('')
    }
  })

  it('every label is a non-empty string', () => {
    for (const meta of Object.values(VISIT_STATUS_META)) {
      expect(typeof meta.label).toBe('string')
      expect(meta.label.length).toBeGreaterThan(0)
    }
  })

  it('every label differs from its raw status token', () => {
    for (const [status, meta] of Object.entries(VISIT_STATUS_META)) {
      expect(meta.label).not.toBe(status)
    }
  })

  it('every tone is one of the 5 allowed tones', () => {
    for (const [status, meta] of Object.entries(VISIT_STATUS_META)) {
      expect(VALID_TONES).toContain(meta.tone)
      expect(status).not.toBe('')
    }
  })
})
