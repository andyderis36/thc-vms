import type { Page, Response } from '@playwright/test'

/**
 * Kebijakan navigasi tunggal untuk seluruh spec E2E.
 *
 * `page.goto` Playwright menunggu event `load` secara default, artinya seluruh
 * subresource (`_next/static/chunks/*.js`, `*.woff2`, `/_next/image?…`) harus
 * selesai lebih dulu. Trace run live 2026-10-28 menunjukkan dokumen HTML siap
 * dalam 2,3–20,3 s sementara satu chunk ±4 KB butuh 2,9–47 s dan sebagian tidak
 * pernah selesai — sehingga `goto` gagal pada batas 30 s meski halaman sudah
 * ter-render (mis. APPR-03: shell tampil, `goto` timeout, chunk baru selesai
 * ±50 s setelah navigasi).
 *
 * Kesiapan halaman selalu dinyatakan oleh assertion web-first sesudahnya
 * (`expect(...).toBeVisible()`), jadi menunggu `load` tidak menambah cakupan
 * uji; yang benar-benar perlu ditunggu hanyalah dokumennya. Pola ini sudah
 * dipakai lebih dulu di `specs/gate-scanner.spec.ts` (detail kunjungan vendor).
 */
export const NAV_WAIT_UNTIL = 'domcontentloaded' as const

/** Navigasi ke rute aplikasi tanpa menunggu seluruh subresource. */
export async function gotoApp(page: Page, path: string): Promise<Response | null> {
  return page.goto(path, { waitUntil: NAV_WAIT_UNTIL })
}
