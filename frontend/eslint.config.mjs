import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'

/**
 * Next.js 16 removed the `next lint` command and the `eslint` key in
 * next.config. Lint is run directly with `npm run lint` using flat config.
 */
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // File E2E Playwright bukan komponen React/Next: matikan aturan React &
    // Next yang tidak relevan, tetapi aturan TypeScript tetap aktif.
    files: ['e2e/**/*.ts', 'playwright.config.ts'],
    rules: {
      '@next/next/no-html-link-for-pages': 'off',
      '@next/next/no-img-element': 'off',
      '@next/next/no-sync-scripts': 'off',
      '@next/next/no-page-custom-font': 'off',
      'react/display-name': 'off',
      'react/prop-types': 'off',
      'react/jsx-key': 'off',
      'react/jsx-no-target-blank': 'off',
      'react/no-unescaped-entities': 'off',
      'react-hooks/rules-of-hooks': 'off',
      'react-hooks/exhaustive-deps': 'off',
    },
  },
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    'public/mockServiceWorker.js',
    'test-results/**',
    'playwright-report/**',
    'blob-report/**',
  ]),
])

export default eslintConfig
