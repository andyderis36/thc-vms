'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useState } from 'react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'
import { Button } from '@/components/ui/Button'
import { PasswordInput } from '@/components/ui/PasswordInput'
import { Spinner } from '@/components/ui/Spinner'
import { ApiError } from '@/lib/api/fetcher'
import { useConfirmPasswordResetMutation } from '@/lib/api/hooks'
import {
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  passwordByteLength,
} from '@/lib/limits'

/**
 * Galat konfirmasi SELALU memakai teks generik yang sama — token
 * kedaluwarsa, terpakai, maupun rusak tidak boleh membedakan penyebab di
 * layar (kontrak backend: 401 byte-identical untuk semua kegagalan token).
 */
const GENERIC_FAILURE = 'Tautan tidak valid atau kedaluwarsa.'

const resetPasswordSchema = z
  .object({
    new_password: z
      .string()
      .min(1, 'Kata sandi baru wajib diisi')
      .min(PASSWORD_MIN_LENGTH, `Kata sandi minimal ${PASSWORD_MIN_LENGTH} karakter`)
      .refine(
        (value) => passwordByteLength(value) <= PASSWORD_MAX_BYTES,
        `Kata sandi maksimal ${PASSWORD_MAX_BYTES} byte`,
      ),
    confirm_password: z.string().min(1, 'Konfirmasi kata sandi wajib diisi'),
  })
  .refine((values) => values.confirm_password === values.new_password, {
    message: 'Konfirmasi kata sandi tidak sama.',
    path: ['confirm_password'],
  })

type ResetPasswordFormValues = z.infer<typeof resetPasswordSchema>

function ResetPasswordScreen() {
  const token = useSearchParams().get('token')
  const confirmPasswordReset = useConfirmPasswordResetMutation()
  const [failed, setFailed] = useState(false)
  const [done, setDone] = useState(false)

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ResetPasswordFormValues>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { new_password: '', confirm_password: '' },
  })

  const onSubmit = async (values: ResetPasswordFormValues): Promise<void> => {
    if (token === null || token.trim() === '') {
      setFailed(true)
      return
    }
    try {
      await confirmPasswordReset.mutateAsync({
        token,
        new_password: values.new_password,
      })
      setDone(true)
    } catch (err: unknown) {
      // Rate limiter backend membalas pesan tetap berbahasa Indonesia.
      if (err instanceof ApiError && err.status === 429) {
        toast.error('Terlalu banyak percobaan. Silakan coba lagi nanti.')
        return
      }
      // 400 = kata sandi lemah; pesan validasi aman ditampilkan inline.
      if (err instanceof ApiError && err.status === 400) {
        setError('new_password', {
          type: 'server',
          message: err.message !== '' ? err.message : 'Kata sandi tidak valid.',
        })
        return
      }
      // 401 dan galat tak terduga lain (jaringan, 5xx): teks generik yang
      // sama tanpa meneruskan pesan server apa pun untuk kegagalan token.
      setFailed(true)
    }
  }

  if (done) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-page px-4 py-10">
        <div className="card w-full max-w-[420px] rounded-modal p-6 text-center lg:p-8">
          <h1 className="text-xl font-bold text-ink">Kata sandi berhasil diubah</h1>
          <p role="status" className="mt-3 text-sm leading-relaxed text-ink-secondary">
            Silakan masuk dengan kata sandi baru Anda.
          </p>
          <Link href="/login" className="mt-6 block">
            <Button size="lg" fullWidth className="min-h-touch">
              Masuk
            </Button>
          </Link>
        </div>
      </main>
    )
  }

  const linkInvalid = failed || token === null || token.trim() === ''

  return (
    <main className="flex min-h-dvh items-center justify-center bg-page px-4 py-10">
      <div className="card w-full max-w-[420px] rounded-modal p-6 lg:p-8">
        <header className="mb-5">
          <h1 className="text-xl font-bold text-ink">Atur ulang kata sandi</h1>
          {linkInvalid ? null : (
            <p className="mt-1 text-sm text-ink-secondary">
              Pilih kata sandi baru untuk akun Anda. Tautan hanya berlaku
              satu kali.
            </p>
          )}
        </header>

        {linkInvalid ? (
          <>
            <p role="alert" className="text-sm font-medium text-danger-text">
              {GENERIC_FAILURE}
            </p>
            <Link href="/login" className="mt-6 block">
              <Button variant="secondary" size="lg" fullWidth className="min-h-touch">
                Kembali ke halaman masuk
              </Button>
            </Link>
          </>
        ) : (
          <form
            onSubmit={handleSubmit(onSubmit)}
            noValidate
            className="flex flex-col gap-4"
          >
            <PasswordInput
              label="Kata sandi baru"
              autoComplete="new-password"
              placeholder="Minimal 8 karakter"
              fieldSize="gate"
              required
              maxLength={PASSWORD_MAX_BYTES}
              hint={`Minimal ${PASSWORD_MIN_LENGTH} karakter.`}
              error={errors.new_password?.message}
              {...register('new_password')}
            />
            <PasswordInput
              label="Konfirmasi kata sandi baru"
              autoComplete="new-password"
              placeholder="Ulangi kata sandi baru"
              fieldSize="gate"
              required
              maxLength={PASSWORD_MAX_BYTES}
              error={errors.confirm_password?.message}
              {...register('confirm_password')}
            />

            <Button type="submit" size="lg" fullWidth loading={isSubmitting}>
              Simpan kata sandi baru
            </Button>
          </form>
        )}
      </div>
    </main>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[40vh] items-center justify-center">
          <Spinner size="lg" label="Memuat halaman reset kata sandi…" />
        </div>
      }
    >
      <ResetPasswordScreen />
    </Suspense>
  )
}
