import { describe, expect, it } from 'vitest'

import { visitFormSchema } from '@/features/visits/form/visit-schema'

/**
 * SCR-03 — Surat Tugas / SPK WAJIB pada pengajuan baru.
 * Pesan selaras backend: "Surat Tugas / SPK wajib diunggah."
 */
const REQUIRED_MESSAGE = 'Surat Tugas / SPK wajib diunggah.'

/** Payload minimal valid; tiap kasus hanya menimpa `assignment_letter`. */
function baseForm(overrides: Record<string, unknown> = {}) {
  return {
    location_id: 'loc-1',
    purpose_ids: ['purpose-1'],
    purpose_note: '',
    start_date: '2026-09-01T09:00:00.000Z',
    end_date: '2026-09-01T17:00:00.000Z',
    is_multi_day: false,
    assignment_letter: { url: 's3://bucket/spk.pdf', name: 'spk.pdf' },
    notes: '',
    technicians: [
      {
        name: 'Teknisi Satu',
        id_number: '3201234567890001',
        phone: '081200000000',
        id_card_photo: null,
        selfie: { url: 's3://bucket/selfie.jpg', name: 'selfie.jpg' },
        vendor_name: '',
      },
    ],
    is_nda_accepted: true,
    ...overrides,
  }
}

describe('visitFormSchema — assignment_letter wajib', () => {
  it('menerima Surat Tugas / SPK valid', () => {
    const result = visitFormSchema.safeParse(baseForm())

    expect(result.success).toBe(true)
  })

  it('menolak assignment_letter null dengan pesan Indonesia', () => {
    const result = visitFormSchema.safeParse(
      baseForm({ assignment_letter: null }),
    )

    expect(result.success).toBe(false)
    if (result.success) return

    const issue = result.error.issues.find(
      (i) => i.path[0] === 'assignment_letter',
    )
    expect(issue?.message).toBe(REQUIRED_MESSAGE)
  })

  it('menolak assignment_letter yang hilang (undefined) dengan pesan Indonesia', () => {
    const { assignment_letter: _omitted, ...withoutLetter } = baseForm()

    const result = visitFormSchema.safeParse(withoutLetter)

    expect(result.success).toBe(false)
    if (result.success) return

    const issue = result.error.issues.find(
      (i) => i.path[0] === 'assignment_letter',
    )
    expect(issue?.message).toBe(REQUIRED_MESSAGE)
  })
})
