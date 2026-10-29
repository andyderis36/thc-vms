import { defineConfig } from '@playwright/test'

/**
 * Konfigurasi E2E Playwright untuk THC VMS.
 *
 * Catatan penting:
 * - Backend (http://localhost:8080) dan frontend (http://localhost:3210) harus
 *   SUDAH BERJALAN; `e2e/global.setup.ts` yang memeriksa konektivitas keduanya.
 * - `--headed` dideteksi dari argv CLI (bukan env inline) agar portabel di
 *   PowerShell: `npm run e2e:headed`.
 */
const isCI = !!process.env.CI

// Deteksi mode headed dari argumen CLI; env inline (`VAR=x cmd`) tidak portabel
// di PowerShell, jadi jangan bergantung pada itu.
const headed = process.argv.includes('--headed')

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',

  // Satu worker, tanpa paralelisme: suite ini menyentuh state bersama di DB.
  fullyParallel: false,
  workers: 1,

  retries: isCI ? 1 : 0,
  forbidOnly: isCI,

  // Anggaran 180 dtk: gate login live memasang jarak 13 dtk dan kuota 4 login
  // per 60 dtk, sehingga satu test yang login berkali-kali (@AUTH-01b: 6 peran)
  // bisa menunggu >90 dtk hanya untuk pacing. `expect.timeout` tetap 10 dtk,
  // jadi assertion yang benar-benar menggantung tetap gagal cepat.
  timeout: 180_000,
  expect: { timeout: 10_000 },

  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],

  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3210',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    // Batas ini HANYA plafon untuk dokumen, bukan waktu tunggu normal: spec
    // menavigasi lewat `gotoApp()` (`e2e/helpers/nav.ts`) yang berhenti di
    // `domcontentloaded`, jadi subresource tidak ikut dihitung. Trace run live
    // 2026-10-28 mencatat pengiriman dokumen 2,3–20,3 s (terlama: `/profile`
    // 14,7 s, `/qr` 20,3 s), dan `click()` yang memicu navigasi juga memakai
    // batas ini (login UI terukur 2,5–12,4 s). 60 s memberi margin >3x terhadap
    // kasus terburuk yang terukur tanpa menyamarkan navigasi yang benar-benar
    // menggantung (masih jauh di bawah anggaran test di atas).
    navigationTimeout: 60_000,
    // `headless` sengaja TIDAK dipaksa di sini: flag `--headed` yang menentukan.
    launchOptions: {
      slowMo: headed ? Number(process.env.E2E_SLOWMO ?? 250) : 0,
    },
  },

  // Preflight konektivitas backend+frontend sebelum seluruh suite berjalan.
  globalSetup: require.resolve('./e2e/global.setup.ts'),

  projects: [
    // Project `setup` menyiapkan storageState per peran; tidak memakai
    // storageState apa pun karena ia yang menghasilkannya.
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    // Seluruh spec membangun context sendiri lewat harness (`h.openAs(...)`)
    // dan tidak memakai fixture `page`, jadi satu project cukup: project
    // per-peran hanya akan menjalankan berkas spec yang sama berulang kali.
    {
      name: 'e2e',
      dependencies: ['setup'],
      testIgnore: /auth\.setup\.ts/,
    },
  ],
})
