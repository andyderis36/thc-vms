/**
 * Generator berkas uji untuk harness E2E.
 *
 * Ukuran/MIME diverifikasi oleh backend `POST /uploads` (header part), jadi
 * buffer di sini cukup realistis: PDF berheader `%PDF-1.4`, JPEG baseline
 * solid-color yang benar-benar dapat didekode, PNG 1x1 valid, serta ZIP/EXE
 * palsu untuk menguji penolakan MIME.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Buffer } from 'node:buffer'
import type { TestInfo } from '@playwright/test'

/**
 * PDF minimal dengan header `%PDF-1.4`, satu halaman kosong, dan padding
 * komentar sampai mendekati `approxKb` kilobyte. Backend hanya memeriksa MIME
 * dan ukuran, bukan isi PDF.
 */
export function pdfBuffer(approxKb: number): Buffer {
  const head = [
    '%PDF-1.4',
    '1 0 obj',
    '<< /Type /Catalog /Pages 2 0 R >>',
    'endobj',
    '2 0 obj',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    'endobj',
    '3 0 obj',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
    'endobj',
    '',
  ].join('\n')
  const tail = ['trailer', '<< /Root 1 0 R /Size 4 >>', '%%EOF', ''].join('\n')
  const target = Math.max(1, Math.trunc(approxKb)) * 1024

  let padding = ''
  const room = target - Buffer.byteLength(head) - Buffer.byteLength(tail)
  if (room > 2) {
    // `%` di awal baris adalah komentar PDF yang sah sebagai padding.
    padding = `%${'x'.repeat(room - 2)}\n`
  }

  return Buffer.from(`${head}${padding}${tail}`, 'latin1')
}

/** Tulis satu byte hasil packing bit JPEG. */
function pushByte(out: number[], value: number): void {
  out.push(value & 0xff)
  // Byte stuffing entropy-coded JPEG: 0xFF diikuti 0x00.
  if ((value & 0xff) === 0xff) {
    out.push(0x00)
  }
}

/**
 * JPEG baseline grayscale solid (satu blok per 8x8 MCU) untuk dimensi apa pun.
 * Tabel Huffman kustom: DC kategori 0 = bit `0`, AC EOB = bit `0`, sehingga
 * setiap blok hanya 2 bit entropy. Hasilnya JPEG sah dengan magic `FF D8 FF`.
 */
export function jpegBuffer(width = 8, height = 8): Buffer {
  const w = Math.max(1, Math.trunc(width))
  const h = Math.max(1, Math.trunc(height))
  const blocksX = Math.ceil(w / 8)
  const blocksY = Math.ceil(h / 8)
  const blockCount = blocksX * blocksY

  const out: number[] = [
    0xff,
    0xd8, // SOI
    // APP0 JFIF 1.1
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    // DQT: satu tabel kuantisasi semua 1
    0xff,
    0xdb,
    0x00,
    0x43,
    0x00,
  ]
  for (let i = 0; i < 64; i += 1) {
    out.push(0x01)
  }
  // SOF0 baseline, 1 komponen grayscale
  out.push(
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    (h >> 8) & 0xff,
    h & 0xff,
    (w >> 8) & 0xff,
    w & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
  )
  // DHT DC: satu simbol kategori 0
  out.push(0xff, 0xc4, 0x00, 0x14, 0x00)
  out.push(0x01, ...Array.from({ length: 15 }, () => 0x00))
  out.push(0x00)
  // DHT AC: satu simbol EOB (0x00)
  out.push(0xff, 0xc4, 0x00, 0x14, 0x10)
  out.push(0x01, ...Array.from({ length: 15 }, () => 0x00))
  out.push(0x00)
  // SOS
  out.push(0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00)

  // Entropy: tiap blok = DC(0) + AC EOB(0) = 2 bit nol.
  let accumulator = 0
  let bitCount = 0
  for (let i = 0; i < blockCount; i += 1) {
    for (let bit = 0; bit < 2; bit += 1) {
      accumulator = (accumulator << 1) | 0
      bitCount += 1
      if (bitCount === 8) {
        pushByte(out, accumulator)
        accumulator = 0
        bitCount = 0
      }
    }
  }
  if (bitCount > 0) {
    // Padding JPEG: bit sisa diisi 1.
    accumulator = (accumulator << (8 - bitCount)) | ((1 << (8 - bitCount)) - 1)
    pushByte(out, accumulator)
  }

  out.push(0xff, 0xd9) // EOI
  return Buffer.from(out)
}

const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

/** PNG 1x1 valid. */
export function pngBuffer(): Buffer {
  return Buffer.from(PNG_1X1_BASE64, 'base64')
}

/** ZIP kosong yang valid (hanya End Of Central Directory). */
export function zipBuffer(): Buffer {
  return Buffer.from(`504b0506${'00'.repeat(18)}`, 'hex')
}

/** Berkas ber-magic `MZ` (bukan executable utuh) untuk uji penolakan MIME. */
export function exeBuffer(): Buffer {
  return Buffer.concat([Buffer.from('MZ', 'latin1'), Buffer.alloc(62, 0)])
}

/**
 * Tulis `data` ke `testInfo.outputPath(name)` dan kembalikan path absolut.
 * Direktori output dibuat bila belum ada.
 */
export async function writeAsset(
  testInfo: TestInfo,
  name: string,
  data: Buffer,
): Promise<string> {
  const filePath = testInfo.outputPath(name)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, data)
  return filePath
}
