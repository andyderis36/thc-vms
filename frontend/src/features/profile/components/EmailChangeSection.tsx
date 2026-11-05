'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { PasswordInput } from '@/components/ui/PasswordInput'
import { ApiError } from '@/lib/api/fetcher'
import { useRequestEmailChangeMutation } from '@/lib/api/hooks'
import { EMAIL_MAX_LENGTH, PASSWORD_MAX_BYTES, isValidEmail } from '@/lib/limits'

const emailChangeSchema = z
  .object({
    new_email: z
      .string()
      .trim()
      .min(1, 'Email baru wajib diisi')
      .max(EMAIL_MAX_LENGTH, `Email maksimal ${EMAIL_MAX_LENGTH} karakter`)
      .refine(isValidEmail, 'Format email tidak valid'),
    confirm_new_email: z
      .string()
      .trim()
      .min(1, 'Konfirmasi email baru wajib diisi'),
    current_password: z.string().min(1, 'Kata sandi saat ini wajib diisi'),
  })
  .refine((values) => values.confirm_new_email === values.new_email, {
    message: 'Konfirmasi email tidak sama.',
    path: ['confirm_new_email'],
  })

type EmailChangeFormValues = z.infer<typeof emailChangeSchema>

/** Jeda ulang-kirim UI (detik) setelah tautan berhasil dikirim. */
const RESEND_COOLDOWN_SECONDS = 60

type Step = 'form' | 'review' | 'sent'

function apiErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') {
    return error.message
  }
  return 'Terjadi kesalahan. Silakan coba lagi.'
}

/**
 * "Ganti email" — seksi swalayan di `/profile` untuk SEMUA peran, dipasang
 * tepat di bawah seksi ganti kata sandi.
 *
 * Alur bertahap: (1) form `new_email` + `confirm_new_email` + kata sandi
 * saat ini, divalidasi zod dengan refine "harus sama"; (2) layar "cek
 * kembali" yang menampilkan alamat BARU secara UTUH (tanpa dipotong) +
 * tombol [Kirim tautan]/[Ubah]; (3) status terkirim dengan tombol kirim
 * ulang ber-cooldown 60 detik. Galat 429 rate limiter backend selalu
 * diteruskan sebagai toast berbahasa Indonesia.
 */
export function EmailChangeSection() {
  const [step, setStep] = useState<Step>('form')
  const [pending, setPending] = useState<{ newEmail: string; password: string } | null>(null)
  const [cooldownLeft, setCooldownLeft] = useState(0)
  const cooling = cooldownLeft > 0
  const requestEmailChange = useRequestEmailChangeMutation()

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<EmailChangeFormValues>({
    resolver: zodResolver(emailChangeSchema),
    defaultValues: { new_email: '', confirm_new_email: '', current_password: '' },
  })

  // Satu interval per jeda aktif: berhenti sendiri begitu hitungan menyentuh 0
  // (efek bergantung pada boolean `cooling`, bukan tiap tick).
  useEffect(() => {
    if (!cooling) {
      return undefined
    }
    const id = window.setInterval(() => {
      setCooldownLeft((previous) => (previous > 0 ? previous - 1 : 0))
    }, 1000)
    return () => window.clearInterval(id)
  }, [cooling])

  function handleFormSubmit(values: EmailChangeFormValues): void {
    setPending({ newEmail: values.new_email, password: values.current_password })
    setStep('review')
  }

  function handleBackToForm(): void {
    if (pending !== null) {
      reset({
        new_email: pending.newEmail,
        confirm_new_email: pending.newEmail,
        current_password: pending.password,
      })
    }
    setStep('form')
  }

  async function handleSend(): Promise<void> {
    if (pending === null || requestEmailChange.isPending) {
      return
    }
    try {
      await requestEmailChange.mutateAsync({
        new_email: pending.newEmail,
        current_password: pending.password,
      })
      setCooldownLeft(RESEND_COOLDOWN_SECONDS)
      setStep('sent')
      toast.success('Tautan verifikasi telah dikirim ke email baru Anda.')
    } catch (error) {
      // Rate limiter backend membalas pesan tetap berbahasa Indonesia.
      if (error instanceof ApiError && error.status === 429) {
        toast.error('Terlalu banyak percobaan. Silakan coba lagi nanti.')
        return
      }
      toast.error(apiErrorMessage(error))
    }
  }

  return (
    <section className="card flex flex-col gap-4 p-4 sm:p-6" aria-label="Ganti email">
      <div>
        <h2 className="text-base font-semibold text-ink">Ganti email</h2>
        <p className="mt-1 text-sm text-ink-secondary">
          Masukkan email baru dan kata sandi saat ini. Tautan verifikasi akan
          dikirim ke alamat baru tersebut.
        </p>
      </div>

      {step === 'form' ? (
        <form
          onSubmit={handleSubmit(handleFormSubmit)}
          noValidate
          className="flex flex-col gap-4"
        >
          <Input
            {...register('new_email')}
            label="Email baru"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="cth. nama@thc.net.id"
            required
            maxLength={EMAIL_MAX_LENGTH}
            className="min-h-touch"
            error={errors.new_email?.message}
          />
          <Input
            {...register('confirm_new_email')}
            label="Konfirmasi email baru"
            type="email"
            inputMode="email"
            autoComplete="off"
            placeholder="Ulangi email baru"
            required
            maxLength={EMAIL_MAX_LENGTH}
            className="min-h-touch"
            error={errors.confirm_new_email?.message}
          />
          <PasswordInput
            {...register('current_password')}
            label="Kata sandi saat ini"
            placeholder="Kata sandi yang sedang dipakai"
            autoComplete="current-password"
            required
            maxLength={PASSWORD_MAX_BYTES}
            className="min-h-touch"
            error={errors.current_password?.message}
          />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="submit"
              className="min-h-touch-lg focus-visible:outline-brand-contrast"
            >
              Lanjutkan
            </Button>
          </div>
        </form>
      ) : null}

      {step === 'review' && pending !== null ? (
        <div className="flex flex-col gap-4" data-testid="email-change-review">
          {/* Permukaan tint lembut (jokoui): alamat baru ditampilkan UTUH
              sebelum dikirim, agar salah ketik tertangkap di sini. */}
          <div className="rounded-control border border-brand/20 bg-brand/10 p-4">
            <p className="text-xs font-medium text-ink-secondary">Email baru</p>
            <p
              className="mt-1 break-all text-sm font-semibold text-ink"
              data-testid="new-email-full"
            >
              {pending.newEmail}
            </p>
          </div>
          <p className="text-sm text-ink-secondary">
            Pastikan alamat di atas sudah benar. Tautan verifikasi hanya dikirim
            ke alamat tersebut.
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="secondary"
              className="min-h-touch"
              onClick={handleBackToForm}
            >
              Ubah
            </Button>
            <Button
              className="min-h-touch-lg focus-visible:outline-brand-contrast"
              loading={requestEmailChange.isPending}
              onClick={() => void handleSend()}
            >
              Kirim tautan
            </Button>
          </div>
        </div>
      ) : null}

      {step === 'sent' && pending !== null ? (
        <div className="flex flex-col gap-4" data-testid="email-change-sent">
          <div className="rounded-control bg-success-bg p-4">
            <p className="text-sm font-semibold text-success-text">
              Tautan verifikasi dikirim
            </p>
            <p
              className="mt-1 break-all text-sm text-ink"
              data-testid="new-email-full"
            >
              {pending.newEmail}
            </p>
          </div>
          <p className="text-sm text-ink-secondary">
            Buka kotak masuk alamat di atas lalu klik tautan untuk menyelesaikan
            perubahan email. Tautan kedaluwarsa dalam 60 menit.
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="secondary"
              className="min-h-touch"
              onClick={handleBackToForm}
            >
              Ubah
            </Button>
            <Button
              className="min-h-touch-lg focus-visible:outline-brand-contrast"
              disabled={cooling}
              loading={requestEmailChange.isPending}
              onClick={() => void handleSend()}
            >
              {cooling ? `Kirim ulang (${cooldownLeft}s)` : 'Kirim ulang'}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
