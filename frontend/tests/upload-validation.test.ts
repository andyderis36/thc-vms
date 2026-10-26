import { describe, expect, it } from 'vitest'

import {
  ALLOWED_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_INGEST_BYTES,
  validateStoredUpload,
  validateUpload,
  validateUploadIngest,
} from '@/lib/uploads/validation'

/** 1.5 MB, expressed without a date/math library. */
const MB = 1024 * 1024
const ONE_AND_HALF_MB = Math.floor(1.5 * MB)
const SIX_POINT_TWO_MB = Math.floor(6.2 * MB)
const EIGHT_MB = 8 * MB

const PDF = { name: 'surat-tugas.pdf', type: 'application/pdf', size: ONE_AND_HALF_MB }
const JPEG = { name: 'ktp.jpg', type: 'image/jpeg', size: ONE_AND_HALF_MB }
const PNG = { name: 'foto-id.png', type: 'image/png', size: ONE_AND_HALF_MB }

describe('MAX_UPLOAD_BYTES', () => {
  it('equals 5 * 1024 * 1024', () => {
    expect(MAX_UPLOAD_BYTES).toBe(5 * 1024 * 1024)
  })

  it('is 5242880', () => {
    expect(MAX_UPLOAD_BYTES).toBe(5_242_880)
  })
})

describe('MAX_UPLOAD_INGEST_BYTES', () => {
  it('equals 20 * 1024 * 1024', () => {
    expect(MAX_UPLOAD_INGEST_BYTES).toBe(20 * 1024 * 1024)
  })

  it('is 20971520', () => {
    expect(MAX_UPLOAD_INGEST_BYTES).toBe(20_971_520)
  })

  it('is strictly larger than the stored ceiling', () => {
    expect(MAX_UPLOAD_INGEST_BYTES).toBeGreaterThan(MAX_UPLOAD_BYTES)
  })
})

describe('ALLOWED_MIME_TYPES', () => {
  it('is exactly the pdf/jpeg/png tuple in that order', () => {
    expect(ALLOWED_MIME_TYPES).toEqual([
      'application/pdf',
      'image/jpeg',
      'image/png',
    ])
  })

  it('has 3 entries and no duplicates', () => {
    expect(ALLOWED_MIME_TYPES).toHaveLength(3)
    expect(new Set(ALLOWED_MIME_TYPES).size).toBe(3)
  })
})

describe('validateUpload — accepted files', () => {
  it('accepts a 1.5 MB pdf', () => {
    expect(validateUpload(PDF)).toEqual({ ok: true })
  })

  it('accepts a 5 MB pdf exactly at the limit (boundary)', () => {
    expect(
      validateUpload({ name: 'limit.pdf', type: 'application/pdf', size: MAX_UPLOAD_BYTES }),
    ).toEqual({ ok: true })
  })

  it('accepts a jpeg', () => {
    expect(validateUpload(JPEG)).toEqual({ ok: true })
  })

  it('accepts a png', () => {
    expect(validateUpload(PNG)).toEqual({ ok: true })
  })
})

describe('validateUpload — size rejections', () => {
  it('rejects 5 MB + 1 byte and mentions the 5 MB limit', () => {
    const result = validateUpload({
      name: 'too-big.pdf',
      type: 'application/pdf',
      size: MAX_UPLOAD_BYTES + 1,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(result.message).toContain('5 MB')
  })

  it('rejects a 6.2 MB pdf and mentions the 5 MB limit', () => {
    const result = validateUpload({
      name: 'huge.pdf',
      type: 'application/pdf',
      size: SIX_POINT_TWO_MB,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(result.message).toContain('5 MB')
  })
})

describe('validateUpload — MIME rejections', () => {
  const rejected: ReadonlyArray<{ label: string; file: { name: string; type: string; size: number } }> = [
    { label: '.exe', file: { name: 'installer.exe', type: 'application/x-msdownload', size: 1024 } },
    { label: '.sh', file: { name: 'payload.sh', type: 'application/x-sh', size: 1024 } },
    { label: '.zip', file: { name: 'bundle.zip', type: 'application/zip', size: 1024 } },
    {
      label: 'octet-stream with a .pdf name',
      file: { name: 'disguised.pdf', type: 'application/octet-stream', size: 1024 },
    },
  ]

  it.each(rejected)('rejects $label', ({ file }) => {
    const result = validateUpload(file)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(typeof result.message).toBe('string')
    expect(result.message.length).toBeGreaterThan(0)
  })
})

describe('validateUpload — check order is size before MIME', () => {
  it('reports the size violation for an oversized file with a forbidden MIME', () => {
    // Both checks would fail. The returned message must be the SIZE one,
    // proving size is evaluated first.
    const result = validateUpload({
      name: 'oversized.exe',
      type: 'application/x-msdownload',
      size: MAX_UPLOAD_BYTES + 1,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(result.message).toContain('5 MB')
  })

  it('reports the MIME violation for a small file with a forbidden MIME', () => {
    const result = validateUpload({
      name: 'small.exe',
      type: 'application/x-msdownload',
      size: 1024,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(result.message).not.toContain('5 MB')
  })
})

describe('validateUploadIngest — 20 MB transport ceiling', () => {
  it('accepts an 8 MB pdf that the stored ceiling would reject', () => {
    expect(
      validateUploadIngest({ name: 'besar.pdf', type: 'application/pdf', size: EIGHT_MB }),
    ).toEqual({ ok: true })
  })

  it('accepts a pdf exactly at the 20 MB boundary', () => {
    expect(
      validateUploadIngest({
        name: 'limit.pdf',
        type: 'application/pdf',
        size: MAX_UPLOAD_INGEST_BYTES,
      }),
    ).toEqual({ ok: true })
  })

  it('rejects 20 MB + 1 byte and names both the 20 MB limit and the file', () => {
    const result = validateUploadIngest({
      name: 'terlalu-besar.pdf',
      type: 'application/pdf',
      size: MAX_UPLOAD_INGEST_BYTES + 1,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(result.message).toContain('20 MB')
    expect(result.message).toContain('terlalu-besar.pdf')
    expect(result.message).not.toContain('5 MB')
  })

  it('still rejects a forbidden MIME with the Indonesian format message', () => {
    const result = validateUploadIngest({
      name: 'payload.exe',
      type: 'application/x-msdownload',
      size: 1024,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(result.message).toContain('tidak didukung')
  })
})

describe('validateStoredUpload — 5 MB stored ceiling', () => {
  it('accepts a photo exactly at the 5 MB boundary', () => {
    expect(
      validateStoredUpload({ name: 'ktp.jpg', type: 'image/jpeg', size: MAX_UPLOAD_BYTES }),
    ).toEqual({ ok: true })
  })

  it('rejects 5 MB + 1 byte and mentions the 5 MB limit', () => {
    const result = validateStoredUpload({
      name: 'hasil-kompresi.jpg',
      type: 'image/jpeg',
      size: MAX_UPLOAD_BYTES + 1,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(result.message).toContain('5 MB')
    expect(result.message).toContain('hasil-kompresi.jpg')
  })

  it('behaves exactly like the legacy validateUpload on the same inputs', () => {
    const files = [
      PDF,
      JPEG,
      { name: 'too-big.pdf', type: 'application/pdf', size: MAX_UPLOAD_BYTES + 1 },
      { name: 'installer.exe', type: 'application/x-msdownload', size: 1024 },
    ]
    for (const file of files) {
      expect(validateStoredUpload(file)).toEqual(validateUpload(file))
    }
  })
})
