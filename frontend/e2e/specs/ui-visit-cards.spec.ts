/**
 * E2E UI kartu mobile SCR-02 — alignment ikon SPK vs label "Lihat SPK".
 *
 * Tag judul:
 * - @VC-01 pada lebar 320/375/390px, glyph ikon FileText dan teks anchor
 *   "Lihat SPK" berbagi satu garis tengah (delta <= 1px), anchor tetap
 *   memegang target sentuh min-h-touch (>= 43.5px), dan dokumen tidak
 *   meluber horizontal.
 *
 * Latar belakang bug: pembungkus span baris SPK semula inline-level, sehingga
 * anchor `inline-flex min-h-touch` (44px) mem-baseline-kan dirinya pada line
 * box span — ikon 16px (items-center pada <p>) tidak lagi segaris optis dengan
 * label. Kontrak perbaikan dikunci unit test `VisitCards.test.tsx` (kelas
 * wrapper flex) dan di sini lewat geometri terukur nyata di 3 viewport ponsel.
 *
 * Kunjungan uji dibuat lewat harness (SPK PDF nyata lewat API) dan dibersihkan
 * otomatis pada teardown.
 */

import type { Locator } from '@playwright/test'
import { expect, test } from '../fixtures'
import { gotoApp } from '../helpers/nav'

/** Lebar viewport ponsel target (SOP ergonomi mobile AGENTS.md §6.5). */
const PHONE_WIDTHS = [320, 375, 390] as const

/** Toleransi alignment optis garis tengah ikon vs teks. */
const CENTER_DELTA_TOLERANCE_PX = 1

/** `min-h-touch` = 44px; izinkan sub-pixel rounding. */
const MIN_TOUCH_TARGET_PX = 43.5

interface AlignmentMetrics {
  iconCenterY: number
  textCenterY: number
  anchorHeight: number
  delta: number
}

/**
 * Ukur garis tengah glyph ikon leading dan garis tengah teks "Lihat SPK"
 * dalam koordinat viewport — keduanya dari `getBoundingClientRect`, sehingga
 * delta independen terhadap posisi scroll.
 */
async function measureAlignment(anchor: Locator): Promise<AlignmentMetrics> {
  const metrics = await anchor.evaluate(async (element) => {
    const row = element.closest('p')
    const icon = row?.querySelector('svg')
    if (!(element instanceof HTMLElement) || !(icon instanceof SVGElement)) {
      throw new Error('[@VC-01] anchor "Lihat SPK" atau ikon leading tidak ditemukan')
    }

    // Node anchor bisa diganti React tepat setelah URL SPK selesai diambil;
    // dua frame memastikan commit + paint selesai sebelum rect dibaca.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })

    // Kotak teks glyph: Range pada node teks pertama anchor ("Lihat SPK"),
    // bukan kotak anchor penuh (min-h-touch 44px) agar diukur optis.
    const textNode = Array.from(element.childNodes).find(
      (node): node is Text => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
    )
    if (textNode === undefined) {
      throw new Error('[@VC-01] anchor "Lihat SPK" tidak memuat node teks')
    }
    const range = document.createRange()
    range.selectNodeContents(textNode)
    const textBox = range.getBoundingClientRect()
    const iconBox = icon.getBoundingClientRect()

    const iconCenterY = iconBox.top + iconBox.height / 2
    const textCenterY = textBox.top + textBox.height / 2
    return {
      iconCenterY,
      textCenterY,
      anchorHeight: element.getBoundingClientRect().height,
      delta: Math.abs(iconCenterY - textCenterY),
    }
  })
  return metrics
}

test('@VC-01 ikon SPK dan label "Lihat SPK" segaris tengah di ponsel 320/375/390px', async ({
  h,
}) => {
  // `approve:false` agar status tetap `requested` dan tampil di Antrean
  // Approval; SPK PDF nyata tetap diunggah oleh harness.
  const created = await h.createVisit('vc01', { withFiles: true, approve: false })
  const page = await h.openAs('admin')

  // Daftarkan listener SEBELUM navigasi (pola @FILE-01): komponen
  // `SpkFileLink` mengambil berkas lewat endpoint backend setelah detail muat.
  const spkResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/visits/${created.id}/file`) &&
      response.url().includes('kind=assignment_letter'),
  )

  await page.setViewportSize({ width: 375, height: 812 })
  await gotoApp(page, '/approvals')

  // Cari per kode kunjungan (server-side q) agar kartu dijamin ada di halaman 1.
  await page.getByLabel('Cari permohonan').fill(created.code)

  const spkResponse = await spkResponsePromise
  console.log(
    `[@VC-01] UI GET ${spkResponse.url()} -> HTTP ${spkResponse.status()} ` +
      `content-type=${spkResponse.headers()['content-type'] ?? ''}`,
  )
  expect(spkResponse.status(), '@VC-01: endpoint berkas SPK dari UI').toBe(200)

  // Tumpukan kartu mobile (VisitCards) di bawah 1024px; scope ke <li> kartu
  // yang memuat kode kunjungan agar tidak menyentuh baris tabel tersembunyi.
  const card = page
    .locator('li')
    .filter({
      has: page.getByRole('link', {
        name: `Lihat detail kunjungan ${created.code}`,
        exact: true,
      }),
    })
    .first()
  await expect(card, '@VC-01: kartu mobile kunjungan uji harus tampil').toBeVisible()

  const anchor = card.locator('a[aria-label^="Lihat surat tugas SPK"]')
  await expect(anchor, '@VC-01: anchor SPK harus tampil di kartu mobile').toBeVisible()

  for (const width of PHONE_WIDTHS) {
    await page.setViewportSize({ width, height: 812 })
    await expect(anchor).toBeVisible()

    // Perpindahan viewport memicu reflow dan (pada suite paralel) refetch
    // react-query; saat itu node anchor bisa sesaat terlepas dari dokumen dan
    // `getBoundingClientRect()` mengembalikan 0. Tunggu geometri benar-benar
    // terpasang sebelum mengukur — ambang batas di bawah tetap ketat.
    await expect
      .poll(async () => (await measureAlignment(anchor)).anchorHeight, {
        message: `[@VC-01] geometri anchor di ${width}px harus terpasang`,
        timeout: 5000,
      })
      .toBeGreaterThan(0)

    const metrics = await measureAlignment(anchor)
    console.log(
      `[@VC-01] width=${width}px iconCenterY=${metrics.iconCenterY.toFixed(2)} ` +
        `textCenterY=${metrics.textCenterY.toFixed(2)} delta=${metrics.delta.toFixed(2)}px ` +
        `anchorHeight=${metrics.anchorHeight.toFixed(2)}px`,
    )

    expect(
      metrics.delta,
      `[@VC-01] delta garis tengah ikon vs teks di ${width}px harus <= ${CENTER_DELTA_TOLERANCE_PX}px`,
    ).toBeLessThanOrEqual(CENTER_DELTA_TOLERANCE_PX)
    expect(
      metrics.anchorHeight,
      `[@VC-01] anchor di ${width}px harus mempertahankan min-h-touch`,
    ).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX)

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    console.log(
      `[@VC-01] width=${width}px scrollWidth=${overflow.scrollWidth} clientWidth=${overflow.clientWidth}`,
    )
    expect(
      overflow.scrollWidth,
      `[@VC-01: dokumen tidak boleh meluber horizontal di ${width}px]`,
    ).toBeLessThanOrEqual(overflow.clientWidth)
  }
})
