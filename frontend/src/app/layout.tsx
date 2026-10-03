import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import MswProvider from './msw-provider'
import { Providers } from './providers'
import { SessionProvider } from '@/lib/auth/session'

/**
 * Inter is the mandated typeface (docs/stitch-ui/02-design-system.md §3).
 * next/font self-hosts the subset at build time — no external font request
 * at runtime and no layout shift.
 */
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
})

export const metadata: Metadata = {
  title: {
    default: 'THC Visitor Management System',
    template: '%s | THC VMS',
  },
  description:
    'Sistem manajemen izin akses & kunjungan fasilitas Kantor Cabang, POP, dan miniPOP THC.',
  robots: { index: false, follow: false },
}

/**
 * Token warna brand — nilai TS dari `--color-brand` di `./globals.css`
 * (SSOT design system, docs/stitch-ui/02-design-system.md §2).
 * Metadata Next.js dibangun statis sehingga tidak bisa membaca CSS variable;
 * hex dicerminkan sekali di sini dan dipakai `viewport.themeColor` di bawah.
 */
const BRAND_TOKEN = '#422ad5'

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  themeColor: BRAND_TOKEN,
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="id" className={inter.variable}>
      <body className="min-h-dvh bg-page text-ink antialiased">
        {/*
          Urutan provider itu mengikat, bukan sembaran:
          1. MswProvider paling luar - ia menahan render sampai service worker
             mock benar-benar mengendalikan halaman. Kalau dia di dalam,
             `getMe()` milik SessionProvider akan menembak API sebelum mock siap.
          2. Providers - satu QueryClient per sesi browser.
          3. SessionProvider - hidrasi user dari token yang tersimpan.
        */}
        <MswProvider>
          <Providers>
            <SessionProvider>{children}</SessionProvider>
          </Providers>
        </MswProvider>
      </body>
    </html>
  )
}
