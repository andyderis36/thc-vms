import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MAX_TECHNICIANS } from '@/features/visits/form/visit-schema'
import {
  areTechnicianRowsBlank,
  clearTechnicianRoster,
  loadTechnicianRoster,
  saveTechnicianRoster,
  technicianRosterStorageKey,
} from '@/lib/visits/technician-autosave'

/** Storage in-memory berbentuk `Storage` asli — dipasang sebagai localStorage. */
function createMemoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length(): number {
      return map.size
    },
    clear(): void {
      map.clear()
    },
    getItem(key: string): string | null {
      return map.get(key) ?? null
    },
    key(index: number): string | null {
      return [...map.keys()][index] ?? null
    },
    removeItem(key: string): void {
      map.delete(key)
    },
    setItem(key: string, value: string): void {
      map.set(key, value)
    },
  }
}

/**
 * Baris INPUT form: memuat `id_number` (wajib saat submit) — field itu
 * sengaja TIDAK pernah dipersist oleh autosave.
 */
const baseRow = {
  name: 'Budi Santoso',
  id_number: '3273010501900001',
  phone: '081234567890',
  vendor_name: 'PT Lintas Fiber',
}

/** Baris HASIL load: hanya 3 field teks (nama, HP, vendor) — tanpa PII. */
const baseSaved = {
  name: 'Budi Santoso',
  phone: '081234567890',
  vendor_name: 'PT Lintas Fiber',
}

describe('technician-autosave', () => {
  let storage: Storage

  beforeEach(() => {
    storage = createMemoryStorage()
    vi.stubGlobal('localStorage', storage)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('round trip save → load', () => {
    it('mengembalikan baris yang sama TANPA id_number, teks di-trim, envelope berversi 2', () => {
      saveTechnicianRoster('usr_1', [
        { ...baseRow, name: '  Budi Santoso  ', phone: ' 081234567890 ' },
        { name: 'Siti Aminah', id_number: ' 327302 ', phone: '0899', vendor_name: '' },
      ])

      expect(loadTechnicianRoster('usr_1')).toEqual([
        baseSaved,
        { name: 'Siti Aminah', phone: '0899', vendor_name: '' },
      ])

      const raw = storage.getItem(technicianRosterStorageKey('usr_1')) ?? ''
      const envelope = JSON.parse(raw) as { version: number }
      expect(envelope.version).toBe(2)
    })

    it('id_number TIDAK PERNAH tersimpan: tidak ada kunci maupun nilainya di JSON mentah', () => {
      saveTechnicianRoster('usr_1', [baseRow])

      const raw = storage.getItem(technicianRosterStorageKey('usr_1')) ?? ''
      expect(raw).not.toContain('id_number')
      expect(raw).not.toContain(baseRow.id_number)

      const loaded = loadTechnicianRoster('usr_1')
      expect(loaded).toEqual([baseSaved])
      expect(loaded?.[0]).not.toHaveProperty('id_number')
    })

    it('vendor_name dihilangkan dari input → dimuat sebagai string kosong', () => {
      saveTechnicianRoster('usr_1', [
        { name: 'Andi', id_number: '1', phone: '0811' },
      ])
      expect(loadTechnicianRoster('usr_1')).toEqual([
        { name: 'Andi', phone: '0811', vendor_name: '' },
      ])
    })

    it('kunci belum pernah ada → null', () => {
      expect(loadTechnicianRoster('usr_kosong')).toBeNull()
    })

    it('userId kosong → save no-op dan load null', () => {
      expect(() => saveTechnicianRoster('', [baseRow])).not.toThrow()
      expect(loadTechnicianRoster('')).toBeNull()
    })
  })

  describe('isolasi per-akun', () => {
    it('data terpisah per userId; clear satu akun tidak menyentuh akun lain', () => {
      saveTechnicianRoster('usr_a', [{ ...baseRow, name: 'Teknisi A' }])
      saveTechnicianRoster('usr_b', [{ ...baseRow, name: 'Teknisi B' }])

      expect(loadTechnicianRoster('usr_a')?.[0]?.name).toBe('Teknisi A')
      expect(loadTechnicianRoster('usr_b')?.[0]?.name).toBe('Teknisi B')

      clearTechnicianRoster('usr_a')
      expect(loadTechnicianRoster('usr_a')).toBeNull()
      expect(loadTechnicianRoster('usr_b')?.[0]?.name).toBe('Teknisi B')
    })

    it('kunci storage benar-benar memuat userId', () => {
      saveTechnicianRoster('usr_spesifik', [baseRow])
      expect(storage.getItem('thc-vms:technicians:usr_spesifik')).not.toBeNull()
      expect(storage.getItem(technicianRosterStorageKey('usr_a'))).toBeNull()
    })
  })

  describe('data korup / versi lama dibuang diam-diam', () => {
    const key = technicianRosterStorageKey('usr_1')

    it('JSON tidak valid → null', () => {
      storage.setItem(key, '{bukan-json')
      expect(loadTechnicianRoster('usr_1')).toBeNull()
    })

    it('envelope versi 1 (lama, berisi id_number) → usang, null — PII tak dimigrasikan', () => {
      storage.setItem(
        key,
        JSON.stringify({ version: 1, rows: [baseRow] }),
      )
      expect(loadTechnicianRoster('usr_1')).toBeNull()
    })

    it('versi tidak dikenal → null', () => {
      storage.setItem(key, JSON.stringify({ version: 999, rows: [baseRow] }))
      expect(loadTechnicianRoster('usr_1')).toBeNull()
    })

    it('bentuk envelope salah (rows bukan array) → null', () => {
      storage.setItem(key, JSON.stringify({ version: 2, rows: 'rusak' }))
      expect(loadTechnicianRoster('usr_1')).toBeNull()
    })

    it('tipe field salah → baris dibuang; bila tak ada sisa → null', () => {
      storage.setItem(
        key,
        JSON.stringify({
          version: 2,
          rows: [{ name: 42, phone: '2' }, baseRow, { name: 'X' }],
        }),
      )
      const loaded = loadTechnicianRoster('usr_1')
      expect(loaded).toHaveLength(1)
      expect(loaded?.[0]?.name).toBe(baseRow.name)
    })

    it('baris envelope v2 yang masih memuat id_number → field asing di-strip, field tersisa tetap dimuat', () => {
      storage.setItem(
        key,
        JSON.stringify({
          version: 2,
          rows: [{ ...baseRow, selfie: { url: 'https://cdn.example/s.jpg', name: 's.jpg' } }],
        }),
      )

      const loaded = loadTechnicianRoster('usr_1')
      expect(loaded).toEqual([baseSaved])
      expect(loaded?.[0]).not.toHaveProperty('id_number')
      const raw = storage.getItem(key) ?? ''
      expect(raw).toContain(baseRow.id_number) // data lama masih di storage…
      // …tapi tidak pernah terbaca kembali ke state aplikasi.
      expect(JSON.stringify(loaded)).not.toContain(baseRow.id_number)
    })
  })

  describe('foto & nomor identitas tidak pernah dipersist', () => {
    it('properti foto terpotong saat save dan tidak ada di JSON mentah', () => {
      const rowsWithPhotos = [
        {
          ...baseRow,
          id_card_photo: { url: 'https://cdn.example/ktp.jpg', name: 'ktp.jpg' },
          selfie: { url: 'https://cdn.example/selfie.jpg', name: 'selfie.jpg' },
        },
      ]
      saveTechnicianRoster('usr_1', rowsWithPhotos)

      const raw = storage.getItem(technicianRosterStorageKey('usr_1')) ?? ''
      expect(raw).not.toContain('selfie')
      expect(raw).not.toContain('id_card_photo')
      expect(raw).not.toContain('https://')
      expect(raw).not.toContain('id_number')
      expect(raw).not.toContain(baseRow.id_number)

      const loaded = loadTechnicianRoster('usr_1')
      expect(loaded?.[0]).toEqual(baseSaved)
      expect(loaded?.[0]).not.toHaveProperty('selfie')
      expect(loaded?.[0]).not.toHaveProperty('id_card_photo')
      expect(loaded?.[0]).not.toHaveProperty('id_number')
    })

    it('entri tersimpan yang mengandung sisa foto/id_number di-strip saat load', () => {
      storage.setItem(
        technicianRosterStorageKey('usr_1'),
        JSON.stringify({
          version: 2,
          rows: [
            {
              ...baseRow,
              selfie: { url: 'https://cdn.example/s.jpg', name: 's.jpg' },
            },
          ],
        }),
      )
      const loaded = loadTechnicianRoster('usr_1')
      expect(loaded).toEqual([baseSaved])
    })
  })

  describe('baris kosong & batas jumlah', () => {
    it('baris kosong / hanya spasi dilewati', () => {
      saveTechnicianRoster('usr_1', [
        { name: '', id_number: '', phone: '', vendor_name: '' },
        { name: '   ', id_number: ' ', phone: '\t', vendor_name: '  ' },
        baseRow,
        { name: '', id_number: '', phone: '', vendor_name: '' },
      ])
      expect(loadTechnicianRoster('usr_1')).toEqual([baseSaved])
    })

    it('semua baris kosong → kunci dihapus, load null', () => {
      saveTechnicianRoster('usr_1', [
        { name: '', id_number: '', phone: '', vendor_name: '' },
        { name: '  ', id_number: '', phone: '', vendor_name: '' },
      ])
      expect(storage.getItem(technicianRosterStorageKey('usr_1'))).toBeNull()
      expect(loadTechnicianRoster('usr_1')).toBeNull()
    })

    it(`dibatasi MAX_TECHNICIANS (${MAX_TECHNICIANS}) saat save dan load`, () => {
      const many = Array.from({ length: MAX_TECHNICIANS + 4 }, (_, index) => ({
        name: `Teknisi ${index + 1}`,
        id_number: `${index + 1}`,
        phone: `0812345${index}`,
        vendor_name: '',
      }))
      saveTechnicianRoster('usr_1', many)
      expect(loadTechnicianRoster('usr_1')).toHaveLength(MAX_TECHNICIANS)
    })
  })

  describe('kegagalan storage tidak pernah melempar', () => {
    const row = { name: 'Budi', id_number: '1', phone: '0812', vendor_name: 'PT X' }

    it('setItem/getItem/removeItem melempar (kuota penuh) → no-op diam', () => {
      vi.stubGlobal('localStorage', {
        get length(): number {
          return 0
        },
        clear(): void {},
        getItem(): string | null {
          throw new Error('SecurityError')
        },
        key(): string | null {
          throw new Error('SecurityError')
        },
        removeItem(): void {
          throw new Error('SecurityError')
        },
        setItem(): void {
          throw new Error('QuotaExceededError')
        },
      } satisfies Storage)

      expect(() => saveTechnicianRoster('usr_1', [row])).not.toThrow()
      expect(loadTechnicianRoster('usr_1')).toBeNull()
      expect(() => clearTechnicianRoster('usr_1')).not.toThrow()
    })

    it('localStorage tidak tersedia (SSR/storage dimatikan) → no-op diam', () => {
      vi.stubGlobal('localStorage', undefined)
      expect(() => saveTechnicianRoster('usr_1', [row])).not.toThrow()
      expect(loadTechnicianRoster('usr_1')).toBeNull()
      expect(() => clearTechnicianRoster('usr_1')).not.toThrow()
    })

    it('getter localStorage melempar (mode privat) → no-op diam', () => {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get(): Storage {
          throw new Error('SecurityError: access denied')
        },
      })
      expect(() => saveTechnicianRoster('usr_1', [row])).not.toThrow()
      expect(loadTechnicianRoster('usr_1')).toBeNull()
      expect(() => clearTechnicianRoster('usr_1')).not.toThrow()
    })
  })

  describe('areTechnicianRowsBlank', () => {
    it('semua field kosong / spasi / daftar kosong → true', () => {
      expect(areTechnicianRowsBlank([])).toBe(true)
      expect(
        areTechnicianRowsBlank([
          { name: '', id_number: ' ', phone: '', vendor_name: undefined },
          { name: '  ', id_number: '', phone: '\t', vendor_name: '' },
        ]),
      ).toBe(true)
    })

    it('hanya id_number terisi (field tak dipersist) → tetap dianggap kosong', () => {
      expect(
        areTechnicianRowsBlank([
          { name: '', id_number: '3273010501900001', phone: '', vendor_name: '' },
        ]),
      ).toBe(true)
    })

    it('salah satu field terisi → false', () => {
      expect(
        areTechnicianRowsBlank([
          { name: '', id_number: '', phone: '', vendor_name: '' },
          { name: 'Budi', id_number: '', phone: '', vendor_name: '' },
        ]),
      ).toBe(false)
      expect(
        areTechnicianRowsBlank([
          { name: '', id_number: '', phone: '', vendor_name: 'PT X' },
        ]),
      ).toBe(false)
      expect(
        areTechnicianRowsBlank([
          { name: '', id_number: '', phone: '0812', vendor_name: '' },
        ]),
      ).toBe(false)
    })
  })
})
