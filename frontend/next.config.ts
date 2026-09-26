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
}

export default nextConfig
