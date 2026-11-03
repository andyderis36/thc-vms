/**
 * T4 — Autentikasi lewat UI + guard peran (client-side).
 *
 * Semua skenario login murni memakai browser context BERSIH (tanpa token),
 * bukan `h.openAs()` yang sudah menyuntikkan token. Guard peran diuji dengan
 * token nyata per peran dari harness. Tidak ada `waitForTimeout` untuk
 * sinkronisasi: seluruh sinkronisasi memakai web-first assertion. Satu-satunya
 * jeda opsional adalah pacing rate-limit (`E2E_LOGIN_PACING_MS`).
 */

import type { Browser, Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import { FRONTEND_BASE, TOKEN_STORAGE_KEY, awaitLoginSlot, ACCOUNTS, DEFAULT_PASSWORD } from '../helpers/api'
import { gotoApp } from '../helpers/nav'

const DEMO_PASSWORD = DEFAULT_PASSWORD
const SECURITY_EMAIL = ACCOUNTS.security.email
const ADMIN_EMAIL = ACCOUNTS.admin.email

/** Semua rute yang diproteksi guard client-side pada skenario NAV-03. */
const PROTECTED_PATHS = [
  '/approvals',
  '/security',
  '/facilities',
  '/coordinators',
  '/vendor-registrations',
  '/audit',
] as const

async function gotoLogin(page: Page): Promise<void> {
  await gotoApp(page, '/login')
  await expect(
    page.getByRole('heading', { name: 'Masuk', exact: true }),
  ).toBeVisible()
}

async function fillAndSubmitLogin(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await awaitLoginSlot()
  await page.getByLabel('Email').fill(email)
  // Field password memakai PasswordInput (ada tombol show/hide dengan
  // aria-label "Tampilkan kata sandi"), jadi persempit ke role textbox agar
  // tidak menabrak tombol toggle.
  await page.getByRole('textbox', { name: 'Kata Sandi' }).fill(password)
  await page.getByRole('button', { name: 'Masuk', exact: true }).click()
}

/** Context bersih: tidak mewarisi storageState project maupun token harness. */
async function withCleanPage(
  browser: Browser,
  run: (page: Page) => Promise<void>,
): Promise<void> {
  // `browser.newContext()` di Playwright Test tetap mewarisi `use.storageState`
  // project; storageState kosong eksplisit wajib agar benar-benar tanpa token.
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

test('@AUTH-01 Login UI sukses sebagai security diarahkan ke /gate', async ({
  browser,
}) => {
  await withCleanPage(browser, async (page) => {
    await gotoLogin(page)
    await fillAndSubmitLogin(page, SECURITY_EMAIL, DEMO_PASSWORD)

    await expect(page).toHaveURL(/\/gate$/)
    await expect(
      page.getByRole('tab', { name: 'Kamera', exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole('tab', { name: 'Input Manual', exact: true }),
    ).toBeVisible()
  })
})

test('@AUTH-01 Login UI sukses sebagai admin diarahkan ke /dashboard', async ({
  browser,
}) => {
  await withCleanPage(browser, async (page) => {
    await gotoLogin(page)
    await fillAndSubmitLogin(page, ADMIN_EMAIL, DEMO_PASSWORD)

    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(
      page.getByRole('heading', { name: 'Dashboard Kunjungan', exact: true }),
    ).toBeVisible()
  })
})

test('@AUTH-02 Login gagal menampilkan error dan tidak menyimpan token', async ({
  browser,
}) => {
  await withCleanPage(browser, async (page) => {
    await gotoLogin(page)
    await fillAndSubmitLogin(page, ADMIN_EMAIL, 'SalahBanget123!')

    const alert = page.getByRole('alert').filter({ hasText: 'Kredensial tidak valid' })
    await expect(alert).toBeVisible()
    const errorText = (await alert.innerText()).trim()
    console.log(`[e2e] teks error login persis: "${errorText}"`)
    expect(errorText).toContain('Kredensial tidak valid')

    await expect(page).toHaveURL(/\/login$/)
    await expect
      .poll(() =>
        page.evaluate((key) => localStorage.getItem(key), TOKEN_STORAGE_KEY),
      )
      .toBeNull()
  })
})

test('@NAV-03 Vendor dipulangkan ke /dashboard dari seluruh rute terproteksi', async ({
  h,
}) => {
  const page = await h.openAs('vendor')

  for (const path of PROTECTED_PATHS) {
    await gotoApp(page, path)
    await expect(page, `vendor ${path} harus dipulangkan`).toHaveURL(
      /\/dashboard$/,
    )
    await expect(
      page.getByRole('heading', { name: 'Dashboard Kunjungan', exact: true }),
    ).toBeVisible()
  }
})

test('@NAV-03 Security dipulangkan ke /gate dari seluruh rute terproteksi', async ({
  h,
}) => {
  const page = await h.openAs('security')

  for (const path of PROTECTED_PATHS) {
    await gotoApp(page, path)
    await expect(page, `security ${path} harus dipulangkan`).toHaveURL(
      /\/gate$/,
    )
    await expect(
      page.getByRole('tab', { name: 'Kamera', exact: true }),
    ).toBeVisible()
  }
})

test('@LOGOUT Aksi Keluar pada menu profil menghapus token dan kembali ke /login', async ({
  h,
}) => {
  const page = await h.openAs('admin')
  await gotoApp(page, '/dashboard')
  await expect(
    page.getByRole('heading', { name: 'Dashboard Kunjungan', exact: true }),
  ).toBeVisible()

  // Pemicu ProfileMenu di sidebar desktop: tombol ber-aria-haspopup="menu".
  const profileTrigger = page
    .locator('aside[aria-label="Menu utama"] button[aria-haspopup="menu"]')
    .first()
  await expect(profileTrigger).toBeVisible()
  await profileTrigger.click()

  const logoutItem = page.getByRole('menuitem', { name: 'Keluar', exact: true })
  await expect(logoutItem).toBeVisible()
  await logoutItem.click()

  await expect(page).toHaveURL(/\/login$/)
  await expect
    .poll(() =>
      page.evaluate((key) => localStorage.getItem(key), TOKEN_STORAGE_KEY),
    )
    .toBeNull()
})
