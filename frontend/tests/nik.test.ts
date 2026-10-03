import { describe, expect, it } from 'vitest'

import {
  NIK_LENGTH,
  NIK_PATTERN,
  isValidNik,
  roleRequiresNik,
  validateNik,
} from '@/lib/users/nik'

describe('NIK_LENGTH / NIK_PATTERN', () => {
  it('tepat 16 digit sesuai kontrak BE', () => {
    expect(NIK_LENGTH).toBe(16)
    expect(NIK_PATTERN.test('3573010101010001')).toBe(true)
    expect(NIK_PATTERN.test('357301010101000')).toBe(false)
    expect(NIK_PATTERN.test('35730101010100012')).toBe(false)
    expect(NIK_PATTERN.test('357301010101000A')).toBe(false)
  })
})

describe('isValidNik', () => {
  it('menerima 16 digit angka (spasi tepi diabaikan)', () => {
    expect(isValidNik('3573010101010001')).toBe(true)
    expect(isValidNik('  3573010101010001  ')).toBe(true)
  })

  it('menolak kosong, pendek, panjang, dan non-digit', () => {
    expect(isValidNik('')).toBe(false)
    expect(isValidNik('12345')).toBe(false)
    expect(isValidNik('35730101010100012')).toBe(false)
    expect(isValidNik('3573-0101-0101-0001')).toBe(false)
    expect(isValidNik('357301010101000a')).toBe(false)
  })
})

describe('validateNik', () => {
  it('wajib diisi bila required (pesan jelas)', () => {
    expect(validateNik('', true)).toBe('NIK wajib diisi (16 digit angka).')
    expect(validateNik('   ', true)).toBe('NIK wajib diisi (16 digit angka).')
  })

  it('kosong lolos bila tidak required', () => {
    expect(validateNik('', false)).toBeNull()
  })

  it('format salah memberi pesan jelas', () => {
    expect(validateNik('123', true)).toBe(
      'NIK harus terdiri dari tepat 16 digit angka.',
    )
  })

  it('valid mengembalikan null', () => {
    expect(validateNik('3573010101010001', true)).toBeNull()
  })
})

describe('roleRequiresNik', () => {
  it('true iff admin/vendor (cermin aturan BE)', () => {
    expect(roleRequiresNik('admin')).toBe(true)
    expect(roleRequiresNik('vendor')).toBe(true)
    expect(roleRequiresNik('security')).toBe(false)
    expect(roleRequiresNik('super_admin')).toBe(false)
  })
})
