import { describe, expect, it } from 'vitest'

import {
  EMAIL_MAX_LENGTH,
  ID_NUMBER_MAX_LENGTH,
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  PHONE_MAX_LENGTH,
  isValidEmail,
  isValidIdNumber,
  isValidPassword,
  isValidPhone,
  normalizePhone,
  passwordByteLength,
  sanitizePhoneInput,
} from '@/lib/limits'

describe('normalizePhone', () => {
  it('mengubah awalan +62 menjadi 0 dan membuang pemisah', () => {
    expect(normalizePhone('+62 812-3456-7890')).toBe('081234567890')
  })

  it('mempertahankan awalan 0 dan membuang spasi/tanda hubung', () => {
    expect(normalizePhone('0812 3456 7890')).toBe('081234567890')
    expect(normalizePhone('0812-3456-7890')).toBe('081234567890')
  })

  it('mengubah bentuk 62 tanpa plus', () => {
    expect(normalizePhone('6281234567890')).toBe('081234567890')
  })

  it('mengembalikan string kosong bila tidak ada digit', () => {
    expect(normalizePhone('abc')).toBe('')
    expect(normalizePhone('')).toBe('')
  })
})

describe('sanitizePhoneInput', () => {
  it('membuang semua non-digit saat mengetik/tempel', () => {
    expect(sanitizePhoneInput('+62 812-3456-7890')).toBe('6281234567890')
    expect(sanitizePhoneInput('0812 3456 7890')).toBe('081234567890')
    expect(sanitizePhoneInput('abc')).toBe('')
    expect(sanitizePhoneInput('')).toBe('')
  })

  it('memotong ke PHONE_MAX_LENGTH digit', () => {
    expect(sanitizePhoneInput('0'.repeat(30))).toHaveLength(PHONE_MAX_LENGTH)
    expect(sanitizePhoneInput('0'.repeat(30))).toBe('0'.repeat(PHONE_MAX_LENGTH))
  })

  it('tidak mengubah awalan seperti normalizePhone (beda kontrak)', () => {
    expect(sanitizePhoneInput('+62 812-3456-7890')).not.toBe(
      normalizePhone('+62 812-3456-7890'),
    )
    expect(isValidPhone(sanitizePhoneInput('+62 812-3456-7890'))).toBe(true)
  })
})

describe('isValidPhone', () => {
  it('menerima nomor Indonesia yang valid', () => {
    expect(isValidPhone('081234567890')).toBe(true)
    expect(isValidPhone('+62 812-3456-7890')).toBe(true)
    expect(isValidPhone('6281234567890')).toBe(true)
    expect(isValidPhone(' 0812345678 ')).toBe(true)
  })

  it('menolak kosong, terlalu pendek, tanpa awalan sah, dan non-digit', () => {
    expect(isValidPhone('')).toBe(false)
    expect(isValidPhone('12345')).toBe(false)
    expect(isValidPhone('81234567890')).toBe(false)
    expect(isValidPhone('0812')).toBe(false)
    expect(isValidPhone('abcdefghij')).toBe(false)
  })

  it('menolak nomor yang melebihi batas panjang/digit', () => {
    expect(isValidPhone('08123456789012345')).toBe(false)
    expect(isValidPhone('62' + '8'.repeat(15))).toBe(false)
    expect(PHONE_MAX_LENGTH).toBe(16)
  })

  it('batas digit baru: 9 digit ditolak, 10 dan 16 digit diterima, 17 digit ditolak', () => {
    expect(isValidPhone('081234567')).toBe(false)
    expect(isValidPhone('0812345678')).toBe(true)
    expect(isValidPhone('0812345678901234')).toBe(true)
    expect(isValidPhone('08123456789012345')).toBe(false)
  })
})

describe('isValidIdNumber', () => {
  it('menerima 8-20 huruf/angka (spasi tepi diabaikan)', () => {
    expect(isValidIdNumber('12345678')).toBe(true)
    expect(isValidIdNumber('A1B2C3D4')).toBe(true)
    expect(isValidIdNumber('1234567890123456')).toBe(true)
    expect(isValidIdNumber('12345678901234567890')).toBe(true)
    expect(isValidIdNumber(' 12345678 ')).toBe(true)
  })

  it('menolak di luar 8-20 karakter atau mengandung tanda baca', () => {
    expect(isValidIdNumber('1234')).toBe(false)
    expect(isValidIdNumber('1234567')).toBe(false)
    expect(isValidIdNumber('123456789012345678901')).toBe(false)
    expect(isValidIdNumber('1234-5678')).toBe(false)
    expect(isValidIdNumber('')).toBe(false)
  })

  it('batas maksimum selaras dengan kontrak', () => {
    expect(ID_NUMBER_MAX_LENGTH).toBe(20)
  })
})

describe('isValidEmail', () => {
  it('menerima alamat email satu-baris yang wajar', () => {
    expect(isValidEmail('teknisi@thc.co.id')).toBe(true)
    expect(isValidEmail('  user@example.com ')).toBe(true)
    expect(isValidEmail('a@b.c')).toBe(true)
  })

  it('menolak display-name, tanpa titik domain, dan @ ganda', () => {
    expect(isValidEmail('Nama <user@example.com>')).toBe(false)
    expect(isValidEmail('user@example')).toBe(false)
    expect(isValidEmail('user@@example.com')).toBe(false)
    expect(isValidEmail('@example.com')).toBe(false)
    expect(isValidEmail('user@.com')).toBe(false)
    expect(isValidEmail('')).toBe(false)
  })

  it('menolak email lebih panjang dari batas', () => {
    const tooLong = `${'a'.repeat(EMAIL_MAX_LENGTH)}@b.co`
    expect(tooLong.length).toBeGreaterThan(EMAIL_MAX_LENGTH)
    expect(isValidEmail(tooLong)).toBe(false)
    expect(EMAIL_MAX_LENGTH).toBe(254)
  })
})

describe('passwordByteLength', () => {
  it('menghitung byte UTF-8, bukan jumlah karakter', () => {
    expect(passwordByteLength('abc')).toBe(3)
    expect(passwordByteLength('é')).toBe(2)
    expect(passwordByteLength('🔐')).toBe(4)
  })
})

describe('isValidPassword', () => {
  it('menuntut minimal 8 karakter', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8)
    expect(isValidPassword('a'.repeat(PASSWORD_MIN_LENGTH - 1))).toBe(false)
    expect(isValidPassword('a'.repeat(PASSWORD_MIN_LENGTH))).toBe(true)
  })

  it('menolak string multibyte yang melewati batas byte', () => {
    expect(PASSWORD_MAX_BYTES).toBe(72)
    const seventyThreeBytes = 'é'.repeat(37) // 37 rune, 74 byte
    expect(passwordByteLength(seventyThreeBytes)).toBe(74)
    expect(isValidPassword(seventyThreeBytes)).toBe(false)
  })

  it('menerima 72 byte dan menolak 73 byte', () => {
    expect(isValidPassword('a'.repeat(PASSWORD_MAX_BYTES))).toBe(true)
    expect(isValidPassword('a'.repeat(PASSWORD_MAX_BYTES + 1))).toBe(false)
  })
})
