'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from '@/lib/auth/session'
import { getLoginRedirect } from '@/lib/auth/capabilities'
import { SessionRecoveryPlaceholder } from '@/lib/auth/guards'
import { Spinner } from '@/components/ui/Spinner'

/**
 * Rute akar - hanya pengalih sesuai peran.
 *
 *   security          -> /gate      (SCR-05, kios pos jaga)
 *   super_admin/admin -> /dashboard (SCR-02)
 *   vendor             -> /dashboard (SCR-02, portal vendor)
 *   belum login       -> /login     (SCR-01)
 *
 * `getLoginRedirect` adalah satu-satunya sumber kebenaran pemetaan ini, sama
 * dengan yang dipakai `RequireRole` dan proses logout - supaya tidak ada dua
 * tempat yang bisa berbeda pendapat soal tujuan home sebuah peran.
 */
export default function HomePage() {
  const router = useRouter()
  const { user, status, refresh } = useSession()

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.replace('/login')
      return
    }
    if (status === 'authenticated' && user !== null) {
      router.replace(getLoginRedirect(user.role))
    }
  }, [status, user, router])

  // Hidrasi sesi gagal karena gangguan sementara: token masih ada, jadi
  // tawarkan coba lagi alih-alih spinner abadi atau lempar ke /login.
  if (status === 'error') {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <SessionRecoveryPlaceholder onRetry={() => void refresh()} />
      </main>
    )
  }

  // Selama status belum selesai, jangan pernah menampilkan tautan ke halaman
  // yang belum siap - hanya spinner yang jujur.
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="flex flex-col items-center gap-3">
        <Spinner size="lg" label="Menyiapkan sesi" />
        <p className="text-sm text-ink-secondary">THC Visitor Management System</p>
      </div>
    </main>
  )
}
