import type { NextConfig } from 'next'

/**
 * THC-VMS Frontend — Next.js 16.3.6
 *
 * Turbopack is the DEFAULT bundler in Next 16. `next build` FAILS if a webpack
 * config key is detected here, so do not add `webpack()`.
 *
 * The frontend talks DIRECTLY to the Go backend at NEXT_PUBLIC_API_BASE_URL.
 * There is deliberately NO BFF / Route Handler proxy layer (PRD v3.1 §8).
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  // Production image (frontend/Dockerfile) memakai runner standalone:
  // WTO .next/standalone/server.js. Tanpa ini image prod tidak viable.
  output: 'standalone',
  // Demo via Cloudflare quick tunnel: izinkan origin *.trycloudflare.com
  // mengakses endpoint dev (HMR/RSC). Tanpa ini dev server memblokir
  // request cross-origin ("Blocked cross-origin request") dan halaman
  // via tunnel gagal hidrasi (putih polos). Dev-only, tidak ke build.
  allowedDevOrigins: ['*.trycloudflare.com'],
}

export default nextConfig
