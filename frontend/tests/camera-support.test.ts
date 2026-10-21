import { describe, expect, it } from 'vitest'

import {
  cameraFailureMessage,
  classifyCameraFailure,
  type CameraSupport,
} from '@/features/gate/camera-support'

const secure: CameraSupport = { secureContext: true, mediaDevicesAvailable: true }
const insecure: CameraSupport = { secureContext: false, mediaDevicesAvailable: false }

describe('classifyCameraFailure', () => {
  it('konteks non-sesecure dibedakan dari penolakan izin', () => {
    expect(classifyCameraFailure(insecure)).toBe('insecure-context')
    expect(classifyCameraFailure(insecure, 'NotAllowedError')).toBe('insecure-context')
  })

  it('konteks aman tanpa mediaDevices tetap non-secure-context', () => {
    expect(
      classifyCameraFailure({ secureContext: true, mediaDevicesAvailable: false }),
    ).toBe('insecure-context')
  })

  it('penolakan izin dipetakan sendiri', () => {
    expect(classifyCameraFailure(secure, 'NotAllowedError')).toBe('permission-denied')
    expect(classifyCameraFailure(secure, 'SecurityError')).toBe('permission-denied')
  })

  it('kamera tidak ditemukan dipetakan sendiri', () => {
    expect(classifyCameraFailure(secure, 'NotFoundError')).toBe('not-found')
  })

  it('penyebab lain jadi unknown', () => {
    expect(classifyCameraFailure(secure, 'NotReadableError')).toBe('unknown')
    expect(classifyCameraFailure(secure)).toBe('unknown')
  })
})

describe('cameraFailureMessage', () => {
  it('pesan non-secure-context menyebut HTTPS dan alternatif mode', () => {
    const message = cameraFailureMessage('insecure-context')
    expect(message).toContain('HTTPS')
    expect(message).toContain('Input Manual')
    expect(message.toLowerCase()).toContain('unggah gambar qr')
  })

  it('pesan penolakan izin menyebut izin kamera', () => {
    expect(cameraFailureMessage('permission-denied')).toContain('Izin kamera ditolak')
  })

  it('setiap kegagalan punya pesan non-kosong', () => {
    for (const failure of [
      'insecure-context',
      'permission-denied',
      'not-found',
      'unknown',
    ] as const) {
      expect(cameraFailureMessage(failure).length).toBeGreaterThan(20)
    }
  })
})
