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

  timeout: 90_000,
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
    navigationTimeout: 30_000,
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
