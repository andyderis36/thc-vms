'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { getLoginRedirect } from '@/lib/auth/capabilities'
import { useSession } from '@/lib/auth/session'
import { ApiError } from '@/lib/api/fetcher'
import { useRequestPasswordResetMutation } from '@/lib/api/hooks'
import { EMAIL_MAX_LENGTH, isValidEmail } from '@/lib/limits'

/**
 * Kartu sukses SELALU memakai teks generik yang sama — keberadaan email
 * tidak pernah terbongkar, termasuk saat server membalas 404/kosong
 * (kontrak backend: 202 generik untuk email yang tidak terdaftar).
 */
const GENERIC_SUCCESS = 'Jika email terdaftar, tautan reset kata sandi telah dikirim.'

const forgotPasswordSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Email wajib diisi')
    .max(EMAIL_MAX_LENGTH, `Email maksimal ${EMAIL_MAX_LENGTH} karakter`)
    .refine(isValidEmail, 'Format email tidak valid'),
})

type ForgotPasswordFormValues = z.infer<typeof forgotPasswordSchema>

function ForgotPasswordScreen() {
  const router = useRouter()
  const { user, status } = useSession()
  const requestPasswordReset = useRequestPasswordResetMutation()
  const [done, setDone] = useState(false)

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordFormValues>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '' },
  })

  // Sudah masuk (token valid saat membuka /forgot-password) -> ganti ke
  // tujuan perannya, pola identik dengan halaman login.
  useEffect(() => {
    if (status === 'authenticated' && user !== null) {
      router.replace(getLoginRedirect(user.role))
    }
  }, [status, user, router])

  const onSubmit = async (values: ForgotPasswordFormValues): Promise<void> => {
    try {
      await requestPasswordReset.mutateAsync({ email: values.email.trim() })
      setDone(true)
    } catch (err: unknown) {
      // 400/422 = bentuk email salah; pesan validasi aman ditampilkan inline.
      if (err instanceof ApiError && (err.status === 422 || err.status === 400)) {
        setError('email', {
          type: 'server',
          message: err.message !== '' ? err.message : 'Format email tidak valid',
        })
        return
      }
      // Rate limiter backend membalas pesan tetap berbahasa Indonesia.
      if (err instanceof ApiError && err.status === 429) {
        toast.error('Terlalu banyak percobaan. Silakan coba lagi nanti.')
        return
      }
      // Koneksi gagal sebelum request sampai -> pesan jaringan generik,
      // bukan tuduhan server rusak.
      if (err instanceof ApiError && err.status === 0) {
        setError('root', { type: 'network', message: err.message })
        return
      }
      // Status lain (403 akun pending/nonaktif, 404, 500, body kosong):
      // tetap kartu generik yang sama agar keberadaan email tidak pernah
      // bisa dibedakan penyerang dari balik layar.
      setDone(true)
    }
  }

  if (status === 'authenticated') {
    return null
  }

  if (done) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-page px-4 py-10">
        <div className="card w-full max-w-[420px] rounded-modal p-6 text-center lg:p-8">
          <h1 className="text-xl font-bold text-ink">Tautan reset dikirim</h1>
          <p role="status" className="mt-3 text-sm leading-relaxed text-ink-secondary">
            {GENERIC_SUCCESS}
          </p>
          <p className="mt-2 text-sm leading-relaxed text-ink-secondary">
            Periksa kotak masuk dan folder spam Anda. Tautan hanya berlaku
            selama waktu terbatas.
          </p>
          <p className="mt-2 text-sm text-ink-secondary">Butuh bantuan? Hubungi admin cabang Anda.</p>
          <Link href="/login" className="mt-6 block">
            <Button variant="secondary" size="lg" fullWidth className="min-h-touch">
              Kembali ke halaman masuk
            </Button>
          </Link>
        </div>
      </main>
    )
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-page px-4 py-10">
      <div className="card w-full max-w-[420px] rounded-modal p-6 lg:p-8">
        <header className="mb-5">
          <h1 className="text-xl font-bold text-ink">Lupa kata sandi</h1>
          <p className="mt-1 text-sm text-ink-secondary">
            Masukkan email akun Anda. Kami akan mengirimkan tautan untuk
            mengatur ulang kata sandi.
          </p>
        </header>

        <form
          onSubmit={handleSubmit(onSubmit)}
          noValidate
          className="flex flex-col gap-4"
        >
          <Input
            {...register('email')}
            label="Email"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="cth. nama@thc.net.id"
            fieldSize="gate"
            required
            maxLength={EMAIL_MAX_LENGTH}
            error={errors.email?.message}
          />

          {errors.root?.message !== undefined ? (
            <p role="alert" className="text-sm font-medium text-danger-text">
              {errors.root.message}
            </p>
          ) : null}

          <Button type="submit" size="lg" fullWidth loading={isSubmitting}>
            Kirim tautan reset
          </Button>
        </form>

        <p className="mt-4 text-center text-sm text-ink-secondary">
          Ingat kata sandi Anda?{' '}
          <Link
            href="/login"
            className="font-semibold text-brand underline-offset-4 hover:underline"
          >
            Masuk di sini
          </Link>
        </p>
      </div>
    </main>
  )
}

export default function ForgotPasswordPage() {
  return <ForgotPasswordScreen />
}
