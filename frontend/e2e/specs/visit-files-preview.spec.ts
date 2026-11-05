/**
 * E2E pratinjau berkas kunjungan (SCR-04): berkas yang diunggah user
 * (SPK/KTP/selfie) harus bisa dibuka/dilihat di halaman detail.
 *
 * Tag judul:
 * - @VFP-01 tautan SPK "Lihat Dokumen" dan endpoint berkasnya 200 PDF.
 * - @VFP-02 foto selfie anggota ter-render penuh (bukan fallback).
 * - @VFP-03 foto KTP terbuka via penampil dan ter-render penuh.
 *
 * Latar belakang: objek MinIO yang hilang membuat UI menampilkan
 * "Berkas tidak tersedia." — spek ini mengunci perilaku sebaliknya:
 * unggah nyata -> pratinjau nyata. Kunjungan uji dibuat lewat harness
 * (SPK/KTP/selfie nyata lewat API) dan dibersihkan otomatis pada teardown.
 */

import { expect, test } from '../fixtures'
import { gotoApp } from '../helpers/nav'

/** Basis API backend (localhost default, override via env saat live). */
const API_BASE = process.env.E2E_API_BASE_URL ?? 'http://localhost:8080/api/v1'

/** URL endpoint berkas kunjungan (otorisasi Bearer, lihat VisitFilePhoto). */
function fileUrl(visitId: string, kind: string, visitorId?: string): string {
  // API_BASE sudah berakhiran /api/v1 — jangan tambah prefix itu lagi.
  const base = `/visits/${encodeURIComponent(visitId)}/file?kind=${kind}`
  const query = visitorId !== undefined && visitorId !== ''
    ? `${base}&visitor_id=${encodeURIComponent(visitorId)}`
    : base
  return `${API_BASE}${query}`
}

test('@VFP-01 tautan SPK tampil dan endpoint berkasnya 200 PDF', async ({ h }) => {
  const visit = await h.createVisit('filepreview-spk', { withFiles: true, approve: false })
  const page = await h.openAs('vendor')
  await gotoApp(page, `/visits/${visit.id}`)

  // Nama aksesibel = aria-label ("Lihat dokumen surat tugas VST-…"), bukan
  // teks "Lihat Dokumen" — regex case-insensitive agar cocok keduanya.
  const spkLink = page.getByRole('link', { name: /lihat dokumen/i })
  await expect(spkLink).toBeVisible()

  const token = await h.tokenAs('vendor')
  const response = await page.request.get(fileUrl(visit.id, 'assignment_letter'), {
    headers: { authorization: `Bearer ${token}` },
  })
  // assignment_letter tidak butuh visitor_id (berbeda dari selfie/KTP).
  expect(response.ok(), 'endpoint SPK harus 200').toBeTruthy()
  expect(response.headers()['content-type'] ?? '').toContain('pdf')
})

test('@VFP-02 foto selfie anggota ter-render penuh, bukan fallback', async ({ h }) => {
  const visit = await h.createVisit('filepreview-selfie', { withFiles: true, approve: false })
  const page = await h.openAs('vendor')
  await gotoApp(page, `/visits/${visit.id}`)

  await expect(page.getByText('Berkas tidak tersedia.')).toHaveCount(0)
  const selfie = page.getByRole('img', { name: /Foto selfie/i }).first()
  await expect(selfie).toBeVisible()
  const loaded = await selfie.evaluate(async (element) => {
    if (!(element instanceof HTMLImageElement)) return false
    if (!element.complete || element.naturalWidth === 0) {
      await new Promise<void>((resolve) => {
        element.addEventListener('load', () => resolve(), { once: true })
        element.addEventListener('error', () => resolve(), { once: true })
        setTimeout(() => resolve(), 5000)
      })
    }
    return element.complete && element.naturalWidth > 0
  })
  expect(loaded, 'selfie harus termuat penuh (naturalWidth > 0)').toBe(true)
})

test('@VFP-03 foto KTP terbuka via penampil dan ter-render penuh', async ({ h }) => {
  const visit = await h.createVisit('filepreview-ktp', { withFiles: true, approve: false })
  const page = await h.openAs('vendor')
  await gotoApp(page, `/visits/${visit.id}`)

  await expect(page.getByText('Berkas tidak tersedia.')).toHaveCount(0)
  // Nama aksesibel = "Lihat foto Foto KTP <nama> lebih besar" (kata "foto"
  // ganda) — cocokkan frasa "Foto KTP" saja, case-insensitive.
  await page.getByRole('button', { name: /foto ktp/i }).click()
  const viewer = page.getByRole('dialog')
  await expect(viewer).toBeVisible()
  const ktp = viewer.getByRole('img').first()
  const loaded = await ktp.evaluate(async (element) => {
    if (!(element instanceof HTMLImageElement)) return false
    if (!element.complete || element.naturalWidth === 0) {
      await new Promise<void>((resolve) => {
        element.addEventListener('load', () => resolve(), { once: true })
        element.addEventListener('error', () => resolve(), { once: true })
        setTimeout(() => resolve(), 5000)
      })
    }
    return element.complete && element.naturalWidth > 0
  })
  expect(loaded, 'KTP harus termuat penuh di penampil').toBe(true)
})
