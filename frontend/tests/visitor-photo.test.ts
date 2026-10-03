import { describe, expect, it } from 'vitest'

import { photoAltText, photoPreviewAriaLabel } from '@/features/visits/detail/VisitorPhoto'

/**
 * Pure-logic tests only (konvensi vitest.config.ts: environment 'node',
 * tanpa DOM/React renderer). Perilaku dialog (buka/klik/fallback) diverifikasi
 * lewat baris QA manual, bukan unit test ini.
 */
describe('photoPreviewAriaLabel', () => {
  it('builds the Indonesian open-preview aria-label for selfie', () => {
    expect(photoPreviewAriaLabel('selfie', 'Budi Santoso')).toBe(
      'Lihat foto Foto selfie Budi Santoso lebih besar',
    )
  })

  it('builds the Indonesian open-preview aria-label for ktp', () => {
    expect(photoPreviewAriaLabel('ktp', 'Budi Santoso')).toBe(
      'Lihat foto Foto KTP Budi Santoso lebih besar',
    )
  })

  it('always contains the action, the visitor name and "lebih besar"', () => {
    for (const variant of ['selfie', 'ktp'] as const) {
      const label = photoPreviewAriaLabel(variant, 'Ani')
      expect(label).toContain('Lihat foto')
      expect(label).toContain('Ani')
      expect(label).toContain('lebih besar')
      expect(label.trim().length).toBeGreaterThan(0)
    }
  })

  it('differs between selfie and ktp variants', () => {
    expect(photoPreviewAriaLabel('selfie', 'Ani')).not.toBe(photoPreviewAriaLabel('ktp', 'Ani'))
  })
})

describe('photoAltText', () => {
  it.each([
    ['selfie', 'Foto selfie Andi Wijaya'],
    ['ktp', 'Foto KTP Andi Wijaya'],
  ] as const)('alt for %s is the Indonesian label plus the visitor name', (variant, expected) => {
    expect(photoAltText(variant, 'Andi Wijaya')).toBe(expected)
  })

  it('keeps selfie and KTP distinguishable for screen readers', () => {
    expect(photoAltText('selfie', 'X').startsWith('Foto selfie')).toBe(true)
    expect(photoAltText('ktp', 'X').startsWith('Foto KTP')).toBe(true)
    expect(photoAltText('selfie', 'X')).not.toBe(photoAltText('ktp', 'X'))
  })

  it('always includes the visitor name', () => {
    expect(photoAltText('selfie', 'Siti Aminah')).toContain('Siti Aminah')
    expect(photoAltText('ktp', 'Siti Aminah')).toContain('Siti Aminah')
  })
})
