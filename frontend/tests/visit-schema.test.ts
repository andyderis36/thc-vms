import { describe, expect, it } from 'vitest'

import { visitFormSchema } from '@/features/visits/form/visit-schema'
import {
  EMAIL_MAX_LENGTH,
  NAME_MAX_LENGTH,
  PURPOSE_NOTE_MAX_LENGTH,
  TEXT_MAX_LENGTH,
} from '@/lib/limits'

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
        name: 'Anggota Satu',
        id_number: '3201234567890001',
        phone: '081200000000',
        // Foto KTP WAJIB (keputusan produk): baris valid selalu menyertakan
        // foto KTP — kasus tanpa foto diuji di `VisitForm.test.tsx`.
        id_card_photo: { url: 's3://bucket/ktp.jpg', name: 'ktp.jpg' },
        selfie: { url: 's3://bucket/selfie.jpg', name: 'selfie.jpg' },
        jabatan: 'Mandor',
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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- pola "omit": assignment_letter sengaja dibuang dari objek uji
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

function formWithTechnician(overrides: Record<string, unknown>) {
  return baseForm({
    technicians: [
      {
        name: 'Anggota Satu',
        id_number: '3201234567890001',
        phone: '081200000000',
        id_card_photo: { url: 's3://bucket/ktp.jpg', name: 'ktp.jpg' },
        selfie: { url: 's3://bucket/selfie.jpg', name: 'selfie.jpg' },
        jabatan: 'Mandor',
        vendor_name: '',
        ...overrides,
      },
    ],
  })
}

function issueAt(
  result: ReturnType<typeof visitFormSchema.safeParse>,
  path: string,
): { message: string } | undefined {
  if (result.success) return undefined
  return result.error.issues.find((issue) => issue.path.join('.') === path)
}

describe('visitFormSchema — batas identitas anggota', () => {
  it('menerima payload baseline valid', () => {
    expect(visitFormSchema.safeParse(formWithTechnician({})).success).toBe(true)
  })

  it('menolak nama lebih dari NAME_MAX_LENGTH karakter', () => {
    const result = visitFormSchema.safeParse(
      formWithTechnician({ name: 'a'.repeat(NAME_MAX_LENGTH + 1) }),
    )

    expect(result.success).toBe(false)
    expect(issueAt(result, 'technicians.0.name')?.message).toBe(
      `Nama lengkap anggota maksimal ${NAME_MAX_LENGTH} karakter.`,
    )
  })

  it('menerima nama tepat NAME_MAX_LENGTH karakter', () => {
    const result = visitFormSchema.safeParse(
      formWithTechnician({ name: 'a'.repeat(NAME_MAX_LENGTH) }),
    )

    expect(result.success).toBe(true)
  })
})

describe('visitFormSchema — nomor HP anggota', () => {
  it('menolak nomor HP yang mengandung huruf', () => {
    const result = visitFormSchema.safeParse(
      formWithTechnician({ phone: '0812345678a' }),
    )

    expect(result.success).toBe(false)
    expect(issueAt(result, 'technicians.0.phone')?.message).toBe(
      'Nomor HP tidak boleh mengandung huruf.',
    )
  })

  it('menerima nomor HP 16 digit', () => {
    const result = visitFormSchema.safeParse(
      formWithTechnician({ phone: '0812345678901234' }),
    )

    expect(result.success).toBe(true)
  })

  it('menerima format +62 dengan spasi dan tanda hubung', () => {
    const result = visitFormSchema.safeParse(
      formWithTechnician({ phone: '+62 812-3456-7890' }),
    )

    expect(result.success).toBe(true)
  })

  it('menolak nomor HP kosong (wajib)', () => {
    const result = visitFormSchema.safeParse(
      formWithTechnician({ phone: '   ' }),
    )

    expect(result.success).toBe(false)
    expect(issueAt(result, 'technicians.0.phone')?.message).toBe(
      'Nomor HP anggota wajib diisi.',
    )
  })
})

describe('visitFormSchema — nomor identitas anggota', () => {
  it('menolak id_number "1234" (kurang dari 8 karakter)', () => {
    const result = visitFormSchema.safeParse(
      formWithTechnician({ id_number: '1234' }),
    )

    expect(result.success).toBe(false)
    expect(issueAt(result, 'technicians.0.id_number')).toBeDefined()
  })

  it('menerima id_number 16 digit', () => {
    const result = visitFormSchema.safeParse(
      formWithTechnician({ id_number: '1234567890123456' }),
    )

    expect(result.success).toBe(true)
  })

  it('menolak id_number kosong (wajib)', () => {
    const result = visitFormSchema.safeParse(
      formWithTechnician({ id_number: '  ' }),
    )

    expect(result.success).toBe(false)
    expect(issueAt(result, 'technicians.0.id_number')?.message).toBe(
      'Nomor KTP/SIM anggota wajib diisi.',
    )
  })
})

describe('visitFormSchema — email anggota (opsional)', () => {
  it('menerima payload tanpa field email (opsional)', () => {
    expect(visitFormSchema.safeParse(formWithTechnician({})).success).toBe(true)
  })

  it('menerima email kosong dan hanya spasi (dianggap absen)', () => {
    expect(
      visitFormSchema.safeParse(formWithTechnician({ email: '' })).success,
    ).toBe(true)
    expect(
      visitFormSchema.safeParse(formWithTechnician({ email: '   ' })).success,
    ).toBe(true)
  })

  it('menerima email valid', () => {
    const result = visitFormSchema.safeParse(
      formWithTechnician({ email: 'teknisi@vendor.co.id' }),
    )

    expect(result.success).toBe(true)
  })

  it('menolak email tanpa @ dengan pesan Indonesia', () => {
    const result = visitFormSchema.safeParse(
      formWithTechnician({ email: 'bukan-email' }),
    )

    expect(result.success).toBe(false)
    expect(issueAt(result, 'technicians.0.email')?.message).toBe(
      'Format email tidak valid.',
    )
  })

  it('menolak email dengan spasi di tengah', () => {
    const result = visitFormSchema.safeParse(
      formWithTechnician({ email: 'dua@contoh.id @x.co' }),
    )

    expect(result.success).toBe(false)
    expect(issueAt(result, 'technicians.0.email')?.message).toBe(
      'Format email tidak valid.',
    )
  })

  it('menolak email lebih dari EMAIL_MAX_LENGTH karakter', () => {
    // 243 huruf + '@example.com' (12) = 255 karakter.
    const overlong = `${'a'.repeat(EMAIL_MAX_LENGTH - 11)}@example.com`
    const result = visitFormSchema.safeParse(
      formWithTechnician({ email: overlong }),
    )

    expect(result.success).toBe(false)
    expect(issueAt(result, 'technicians.0.email')?.message).toBe(
      `Email maksimal ${EMAIL_MAX_LENGTH} karakter.`,
    )
  })

  it('menerima email tepat EMAIL_MAX_LENGTH karakter', () => {
    const exact = `${'a'.repeat(EMAIL_MAX_LENGTH - 12)}@example.com`
    const result = visitFormSchema.safeParse(
      formWithTechnician({ email: exact }),
    )

    expect(result.success).toBe(true)
  })
})

describe('visitFormSchema — batas catatan dan keperluan lain', () => {
  it('menolak notes lebih dari TEXT_MAX_LENGTH karakter', () => {
    const result = visitFormSchema.safeParse(
      baseForm({ notes: 'a'.repeat(TEXT_MAX_LENGTH + 1) }),
    )

    expect(result.success).toBe(false)
    expect(issueAt(result, 'notes')?.message).toBe(
      `Catatan maksimal ${TEXT_MAX_LENGTH} karakter.`,
    )
  })

  it('menerima notes tepat TEXT_MAX_LENGTH karakter', () => {
    const result = visitFormSchema.safeParse(
      baseForm({ notes: 'a'.repeat(TEXT_MAX_LENGTH) }),
    )

    expect(result.success).toBe(true)
  })

  it('menolak purpose_note lebih dari PURPOSE_NOTE_MAX_LENGTH karakter', () => {
    const result = visitFormSchema.safeParse(
      baseForm({ purpose_note: 'a'.repeat(PURPOSE_NOTE_MAX_LENGTH + 1) }),
    )

    expect(result.success).toBe(false)
    expect(issueAt(result, 'purpose_note')?.message).toBe(
      `Keperluan lain maksimal ${PURPOSE_NOTE_MAX_LENGTH} karakter.`,
    )
  })

  it('menerima purpose_note tepat PURPOSE_NOTE_MAX_LENGTH karakter', () => {
    const result = visitFormSchema.safeParse(
      baseForm({ purpose_note: 'a'.repeat(PURPOSE_NOTE_MAX_LENGTH) }),
    )

    expect(result.success).toBe(true)
  })
})

describe('visitFormSchema — akun vendor pemilik kunjungan (opsional)', () => {
  it('menerima payload tanpa vendor_user_id', () => {
    const withoutAccount = { ...baseForm(), vendor_user_id: undefined }

    const result = visitFormSchema.safeParse(withoutAccount)

    expect(result.success).toBe(true)
  })

  it('menerima vendor_user_id dan memangkas spasi tepi', () => {
    const result = visitFormSchema.safeParse(
      baseForm({ vendor_user_id: '  vendor-user-1  ' }),
    )

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.vendor_user_id).toBe('vendor-user-1')
  })

  it('string kosong tetap sah (dianggap tanpa akun vendor)', () => {
    const result = visitFormSchema.safeParse(baseForm({ vendor_user_id: '' }))

    expect(result.success).toBe(true)
  })
})
