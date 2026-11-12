/**
 * PR — Self-service password reset lewat UI (publik, tanpa login).
 *
 * Cakupan SENGAJA hanya permukaan UI + kontrak generik: request memakai
 * email TAK TERDAFTAR (tidak menulis baris/token apa pun di DB), confirm
 * memakai token sampah (selalu 401 generik), sisanya validasi client-side.
 * Jalur bahagia konfirmasi token valid sudah dikunci test backend + bukti
 * curl manual (lihat QA AUTH-12..18); e2e TIDAK boleh mengubah kata sandi
 * akun seed mana pun supaya tidak merusak run berikutnya.
 */

import type { Browser, Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import { FRONTEND_BASE } from '../helpers/api'
import { gotoApp } from '../helpers/nav'

const GENERIC_SUCCESS = 'Jika email terdaftar, tautan reset kata sandi telah dikirim.'
const GENERIC_INVALID = 'Tautan tidak valid atau kedaluwarsa.'
const UNKNOWN_EMAIL = `tidak-ada-e2e-${Date.now()}@invalid-thc-test.example`

/** Context bersih: halaman reset publik, tanpa token sesi apa pun. */
async function withCleanPage(
  browser: Browser,
  run: (page: Page) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext({
    baseURL: FRONTEND_BASE,
    storageState: { cookies: [], origins: [] },
  })
  const page = await context.newPage()
  try {
    await run(page)
  } finally {
    await context.close()
  }
}

test('@PR-01 halaman lupa kata sandi untuk email tak terdaftar tetap menampilkan kartu sukses generik', async ({
  browser,
}) => {
  await withCleanPage(browser, async (page) => {
    await gotoApp(page, '/forgot-password')
    await expect(
      page.getByRole('heading', { name: 'Lupa kata sandi', exact: true }),
    ).toBeVisible()

    await page.getByLabel('Email').fill(UNKNOWN_EMAIL)
    await page.getByRole('button', { name: 'Kirim tautan reset', exact: true }).click()

    // Generik: tidak membedakan email terdaftar vs tidak.
    await expect(page.getByText(GENERIC_SUCCESS)).toBeVisible()
    await expect(
      page.getByText('Butuh bantuan? Hubungi admin cabang Anda.'),
    ).toBeVisible()
  })
})

test('@PR-02 email format salah ditolak inline tanpa request', async ({
  browser,
}) => {
  await withCleanPage(browser, async (page) => {
    await gotoApp(page, '/forgot-password')
    await page.getByLabel('Email').fill('bukan-email')
    await page.getByRole('button', { name: 'Kirim tautan reset', exact: true }).click()

    await expect(page.getByText('Format email tidak valid')).toBeVisible()
    await expect(page.getByText(GENERIC_SUCCESS)).toHaveCount(0)
  })
})

test('@PR-03 token sampah menampilkan kartu tautan tidak valid setelah submit', async ({
  browser,
}) => {
  await withCleanPage(browser, async (page) => {
    await gotoApp(page, '/reset-password?token=sampah-token-e2e-123')
    await expect(
      page.getByRole('heading', { name: 'Atur ulang kata sandi', exact: true }),
    ).toBeVisible()

    await page.getByRole('textbox', { name: 'Kata sandi baru *', exact: true }).fill('Baru12345!')
    await page.getByRole('textbox', { name: 'Konfirmasi kata sandi baru *', exact: true }).fill('Baru12345!')
    await page.getByRole('button', { name: 'Simpan kata sandi baru', exact: true }).click()

    // 401 generik dari backend; pesan server tidak diteruskan.
    await expect(page.getByText(GENERIC_INVALID)).toBeVisible()
  })
})

test('@PR-04 tanpa token langsung menampilkan kartu tautan tidak valid tanpa form', async ({
  browser,
}) => {
  await withCleanPage(browser, async (page) => {
    await gotoApp(page, '/reset-password')

    await expect(page.getByText(GENERIC_INVALID)).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Simpan kata sandi baru', exact: true }),
    ).toHaveCount(0)
  })
})

test('@PR-05 konfirmasi tidak sama ditolak client-side tanpa request', async ({
  browser,
}) => {
  await withCleanPage(browser, async (page) => {
    await gotoApp(page, '/reset-password?token=sampah-token-e2e-123')
    await page.getByRole('textbox', { name: 'Kata sandi baru *', exact: true }).fill('Baru12345!')
    await page.getByRole('textbox', { name: 'Konfirmasi kata sandi baru *', exact: true }).fill('Beda12345!')
    await page.getByRole('button', { name: 'Simpan kata sandi baru', exact: true }).click()

    await expect(page.getByText('Konfirmasi kata sandi tidak sama.')).toBeVisible()
    await expect(page.getByText(GENERIC_INVALID)).toHaveCount(0)
  })
})
