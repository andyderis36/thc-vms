'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { useConfirmEmailChangeMutation } from '@/lib/api/hooks'
import { SessionRecoveryPlaceholder } from '@/lib/auth/guards'
import { useSession } from '@/lib/auth/session'

/**
 * Galat konfirmasi SELALU memakai teks generik yang sama — token
 * kedaluwarsa, salah format, maupun gangguan jaringan tidak boleh
 * membedakan penyebab di layar (kontrak backend INVALID_TOKEN).
 */
const GENERIC_FAILURE = 'Tautan tidak valid atau kedaluwarsa.'

function VerifyEmailScreen() {
  const token = useSearchParams().get('token')
  const { status, refresh } = useSession()
  const router = useRouter()
  const confirmEmailChange = useConfirmEmailChangeMutation()
  const [failed, setFailed] = useState(false)

  async function handleConfirm(): Promise<void> {
    if (token === null || token === '' || confirmEmailChange.isPending) {
      return
    }
    try {
      await confirmEmailChange.mutateAsync({ token })
      toast.success('Email berhasil diverifikasi.')
      await refresh()
      router.replace('/profile')
    } catch {
      // Tanpa meneruskan pesan server dan tanpa mencatat token ke mana pun.
      setFailed(true)
    }
  }

  if (status === 'loading') {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex min-h-[40vh] items-center justify-center text-sm text-neutral-500"
      >
        Memuat…
      </div>
    )
  }

  if (status === 'error') {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-page px-4 py-10">
        <div className="w-full max-w-lg">
          <SessionRecoveryPlaceholder onRetry={() => void refresh()} />
        </div>
      </main>
    )
  }

  // Belum masuk: ajakan masuk ala RequireAuth. Token TETAP berada di query
  // halaman ini (tidak ada redirect yang membuangnya) dan TIDAK ADA POST
  // sebelum sesi terautentikasi.
  if (status === 'unauthenticated') {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-page px-4 py-10">
        <div className="card w-full max-w-lg p-6">
          <h1 className="text-xl font-bold text-ink">Verifikasi email</h1>
          <p className="mt-2 text-sm text-ink-secondary">
            Masuk terlebih dahulu untuk melanjutkan verifikasi email baru Anda.
            Tautan verifikasi tetap tersimpan di alamat halaman ini.
          </p>
          <Link href="/login" className="mt-6 block">
            <Button size="lg" fullWidth className="min-h-touch-lg">
              Masuk
            </Button>
          </Link>
        </div>
      </main>
    )
  }

  const linkInvalid = failed || token === null || token === ''

  return (
    <main className="flex min-h-dvh items-center justify-center bg-page px-4 py-10">
      <div className="card w-full max-w-lg p-6">
        <h1 className="text-xl font-bold text-ink">Verifikasi email baru</h1>
        {linkInvalid ? (
          <>
            <p role="alert" className="mt-3 text-sm font-medium text-danger-text">
              {GENERIC_FAILURE}
            </p>
            <Link href="/profile" className="mt-6 block">
              <Button variant="secondary" size="lg" fullWidth className="min-h-touch">
                Kembali ke profil
              </Button>
            </Link>
          </>
        ) : (
          <>
            <p className="mt-2 text-sm text-ink-secondary">
              Selesaikan perubahan email Anda dengan menekan tombol di bawah ini.
              Tautan hanya berlaku satu kali.
            </p>
            <Button
              size="lg"
              fullWidth
              className="mt-6 min-h-touch-lg"
              loading={confirmEmailChange.isPending}
              onClick={() => void handleConfirm()}
            >
              Verifikasi email baru
            </Button>
          </>
        )}
      </div>
    </main>
  )
}

export default function VerifyEmailPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[40vh] items-center justify-center">
          <Spinner size="lg" label="Memuat halaman verifikasi…" />
        </div>
      }
    >
      <VerifyEmailScreen />
    </Suspense>
  )
}
