import { beforeEach, describe, expect, it } from 'vitest'

import {
  clearNetworkFailure,
  describeConnectivity,
  getNetworkFailureSnapshot,
  isOfflineError,
  reportNetworkFailure,
  resolveConnectivityState,
  subscribeNetworkFailure,
  type ConnectivityState,
  type ConnectivityTone,
} from '@/lib/api/connectivity'
import { ApiError } from '@/lib/api/fetcher'

/**
 * Unit test untuk logika konektivitas global.
 *
 * Hanya logika MURNI + store runtime yang diuji (tanpa DOM): keputusan
 * "galat mana yang berarti jaringan" dan "copy mana yang tampil" adalah
 * kontrak yang harus terkunci di unit test. Perilaku DOM/React (banner
 * muncul/tidak, teks yang terbaca) diverifikasi lewat QA browser.
 */

const NETWORK_ERROR = new ApiError(
  'Tidak dapat terhubung ke server. Periksa koneksi Anda.',
  0,
  'NETWORK_ERROR',
)

const SERVER_ERROR = new ApiError('Terjadi gangguan pada server.', 500, 'HTTP_ERROR')

const VALID_TONES: readonly ConnectivityTone[] = ['warning', 'danger']

const VALID_STATES: readonly ConnectivityState[] = ['online', 'offline', 'unreachable']

describe('isOfflineError', () => {
  it('ApiError dengan status 0 (tanpa respons HTTP) terdeteksi sebagai galat jaringan', () => {
    expect(isOfflineError(NETWORK_ERROR)).toBe(true)
  })

  it('ApiError dengan code NETWORK_ERROR terdeteksi walau status-nya bukan 0', () => {
    expect(isOfflineError(new ApiError('jaringan putus', 0, 'NETWORK_ERROR'))).toBe(true)
    expect(isOfflineError({ status: 200, code: 'NETWORK_ERROR' })).toBe(true)
  })

  it('galat HTTP dari server BUKAN galat jaringan', () => {
    expect(isOfflineError(SERVER_ERROR)).toBe(false)
    expect(isOfflineError(new ApiError('sesi berakhir', 401, 'HTTP_ERROR'))).toBe(false)
    expect(isOfflineError(new ApiError('tidak ditemukan', 404, 'HTTP_ERROR'))).toBe(false)
  })

  it('Error biasa tanpa status/code bukan galat jaringan', () => {
    expect(isOfflineError(new Error('Failed to fetch'))).toBe(false)
    expect(isOfflineError(new TypeError('Failed to fetch'))).toBe(false)
  })

  it('nilai non-objek ditolak tanpa melempar error', () => {
    expect(isOfflineError(null)).toBe(false)
    expect(isOfflineError(undefined)).toBe(false)
    expect(isOfflineError('NETWORK_ERROR')).toBe(false)
    expect(isOfflineError(0)).toBe(false)
  })
})

describe('resolveConnectivityState', () => {
  it('browser offline menghasilkan status offline', () => {
    expect(
      resolveConnectivityState({ browserOnline: false, serverUnreachable: false }),
    ).toBe('offline')
  })

  it('browser online + server tak terjangkau menghasilkan status unreachable', () => {
    expect(
      resolveConnectivityState({ browserOnline: true, serverUnreachable: true }),
    ).toBe('unreachable')
  })

  it('keduanya sehat menghasilkan status online', () => {
    expect(
      resolveConnectivityState({ browserOnline: true, serverUnreachable: false }),
    ).toBe('online')
  })

  it('browser offline MENANG atas server tak terjangkau (kondisi lebih spesifik)', () => {
    expect(
      resolveConnectivityState({ browserOnline: false, serverUnreachable: true }),
    ).toBe('offline')
  })
})

describe('describeConnectivity', () => {
  it('status online tidak punya copy — banner tidak dirender sama sekali', () => {
    expect(describeConnectivity('online')).toBeNull()
  })

  it('status offline memakai nada warning dengan judul & isi Bahasa Indonesia', () => {
    const copy = describeConnectivity('offline')
    expect(copy).not.toBeNull()
    expect(copy?.tone).toBe('warning')
    expect(copy?.title).toBe('Anda sedang offline')
    expect(copy?.body.length).toBeGreaterThan(0)
  })

  it('status unreachable memakai nada danger dengan judul & isi Bahasa Indonesia', () => {
    const copy = describeConnectivity('unreachable')
    expect(copy).not.toBeNull()
    expect(copy?.tone).toBe('danger')
    expect(copy?.title).toBe('Server tidak dapat dihubungi')
    expect(copy?.body.length).toBeGreaterThan(0)
  })

  it('kedua status punya judul berbeda agar pesan tidak tertukar', () => {
    const offline = describeConnectivity('offline')
    const unreachable = describeConnectivity('unreachable')
    expect(offline?.title).not.toBe(unreachable?.title)
    expect(offline?.body).not.toBe(unreachable?.body)
  })

  it('setiap statusCopy punya nada dari daftar nada yang diizinkan', () => {
    for (const state of VALID_STATES) {
      const copy = describeConnectivity(state)
      if (copy === null) {
        expect(state).toBe('online')
        continue
      }
      expect(VALID_TONES).toContain(copy.tone)
      expect(copy.title).not.toBe('')
      expect(copy.body).not.toBe('')
    }
  })
})

describe('store kegagalan jaringan', () => {
  beforeEach(() => {
    clearNetworkFailure()
  })

  it('galat jaringan mencatat server tak terjangkau dan memberi tahu subscriber', () => {
    let notified = 0
    const unsubscribe = subscribeNetworkFailure(() => {
      notified += 1
    })

    reportNetworkFailure(NETWORK_ERROR)

    expect(getNetworkFailureSnapshot()).toBe(true)
    expect(notified).toBe(1)

    unsubscribe()
  })

  it('galat HTTP TIDAK pernah menandai server tak terjangkau', () => {
    reportNetworkFailure(SERVER_ERROR)
    expect(getNetworkFailureSnapshot()).toBe(false)
  })

  it('pelaporan berulang tidak memunculkan notifikasi ganda', () => {
    let notified = 0
    const unsubscribe = subscribeNetworkFailure(() => {
      notified += 1
    })

    reportNetworkFailure(NETWORK_ERROR)
    reportNetworkFailure(NETWORK_ERROR)

    expect(notified).toBe(1)
    expect(getNetworkFailureSnapshot()).toBe(true)

    unsubscribe()
  })

  it('clearNetworkFailure mengembalikan status sehat dan memberi tahu subscriber', () => {
    let notified = 0
    const unsubscribe = subscribeNetworkFailure(() => {
      notified += 1
    })

    reportNetworkFailure(NETWORK_ERROR)
    clearNetworkFailure()

    expect(getNetworkFailureSnapshot()).toBe(false)
    expect(notified).toBe(2)

    unsubscribe()
  })

  it('clearNetworkFailure saat status sehat tidak memicu notifikasi', () => {
    let notified = 0
    const unsubscribe = subscribeNetworkFailure(() => {
      notified += 1
    })

    clearNetworkFailure()

    expect(notified).toBe(0)

    unsubscribe()
  })

  it('subscriber yang berhenti berlangganan tidak lagi diberi tahu', () => {
    let notified = 0
    const unsubscribe = subscribeNetworkFailure(() => {
      notified += 1
    })

    unsubscribe()
    reportNetworkFailure(NETWORK_ERROR)

    expect(notified).toBe(0)
    expect(getNetworkFailureSnapshot()).toBe(true)
  })
})
