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
  images: {
    /*
     * Origin presigned MinIO dev — diambil PERSIS dari backend/.env.example:
     *   S3_ENDPOINT=localhost:9000
     *   S3_PUBLIC_BASE_URL=http://localhost:9000/thc-vms-bucket
     *   S3_USE_SSL=false
     * → satu origin: http://localhost:9000 (path-style /thc-vms-bucket/...).
     *
     * `search` sengaja DIHAPUS (wildcard `**` tersirat) karena URL presigned
     * membawa query `?X-Amz-Algorithm=...` — `search: ''` akan memblokirnya
     * dengan HTTP 400.
     *
     * SWAP HOST PRODUCTION: ganti blok di bawah dengan origin S3/R2 hasil
     * deploy (protocol 'https', hostname asli, port ''), selaras dengan
     * S3_ENDPOINT / S3_PUBLIC_BASE_URL backend produksi — mis. akun
     * Cloudflare R2 atau regional AWS S3. Jangan hardcode di tempat lain.
     *
     * `images.minimumCacheTTL` TIDAK di-set (default Next): berkas KTP/selfie
     * bisa diunggah ulang dan URL presigned berganti tiap 15 menit, jadi
     * tidak ada jaminan immutable untuk di-cache lama.
     */
    remotePatterns: [
      {
        protocol: 'http',
        hostname: 'localhost',
        port: '9000',
        pathname: '/**',
      },
    ],
  },
}

export default nextConfig
