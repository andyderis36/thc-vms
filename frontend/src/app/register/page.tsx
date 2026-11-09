'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { Clock } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { PasswordInput } from '@/components/ui/PasswordInput'
import { getLoginRedirect } from '@/lib/auth/capabilities'
import { SessionNetworkError, useSession } from '@/lib/auth/session'
import { registerVendor } from '@/lib/api/client'
import { ApiError } from '@/lib/api/fetcher'
import type { RegisterVendorRequest } from '@/lib/api/types'
import { usePublicVendorsQuery } from '@/lib/api/hooks'
import {
  EMAIL_MAX_LENGTH,
  isValidEmail,
  isValidPhone,
  NAME_MAX_LENGTH,
  normalizePhone,
  PASSWORD_MAX_BYTES,
  passwordByteLength,
  PHONE_DIGIT_MESSAGE,
  PHONE_MAX_LENGTH,
  PHONE_MIN_LENGTH,
} from '@/lib/limits'
import { isValidNik, NIK_LENGTH } from '@/lib/users/nik'
import {
  resolveVendorInput,
  VENDOR_NAME_MAX_LENGTH,
} from '@/lib/visits/vendor-input'

const registerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Nama wajib diisi')
    .max(NAME_MAX_LENGTH, `Nama maksimal ${NAME_MAX_LENGTH} karakter`),
  email: z
    .string()
    .trim()
    .min(1, 'Email wajib diisi')
    .max(EMAIL_MAX_LENGTH, `Email maksimal ${EMAIL_MAX_LENGTH} karakter`)
    .refine(isValidEmail, 'Format email tidak valid'),
  password: z
    .string()
    .min(1, 'Kata sandi wajib diisi')
    .min(8, 'Kata sandi minimal 8 karakter')
    .refine(
      (value) => passwordByteLength(value) <= PASSWORD_MAX_BYTES,
      `Kata sandi maksimal ${PASSWORD_MAX_BYTES} byte`,
    ),
  phone: z
    .string()
    .trim()
    .refine(
      (value) => {
        if (value === '') return true
        const digits = value.replace(/[^0-9]/g, '')
        if (digits.length < PHONE_MIN_LENGTH || digits.length > PHONE_MAX_LENGTH) {
          // only treat as digit-count error when prefix is valid (mirrors BE PhoneLengthViolation)
          const normalized = digits.startsWith('62')
            ? `0${digits.slice(2)}`
            : digits
          if (
            !/[A-Za-z]/.test(value) &&
            normalized.startsWith('0')
          ) {
            return false
          }
        }
        return true
      },
      PHONE_DIGIT_MESSAGE,
    )
    .refine(
      (value) => value === '' || isValidPhone(value),
      'Format nomor telepon tidak valid',
    ),
  nik: z
    .string()
    .trim()
    .min(1, 'NIK wajib diisi (16 digit angka)')
    .refine(isValidNik, 'NIK harus terdiri dari tepat 16 digit angka'),
  vendorText: z
    .string()
    .trim()
    .max(VENDOR_NAME_MAX_LENGTH, `Nama perusahaan maksimal ${VENDOR_NAME_MAX_LENGTH} karakter`),
})

type RegisterFormValues = z.infer<typeof registerSchema>

function RegisterScreen() {
  const router = useRouter()
  const { user, status } = useSession()
  const [done, setDone] = useState(false)
  // Tanpa sesi: katalog vendor WAJIB dari endpoint publik (`/public/vendors`);
  // `/vendors` terautentikasi akan 401 di layar ini.
  const vendorsQuery = usePublicVendorsQuery()

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterFormValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: { name: '', email: '', password: '', phone: '', nik: '', vendorText: '' },
  })

  if (status === 'authenticated' && user !== null) {
    router.replace(getLoginRedirect(user.role))
  }

  const onSubmit = async (values: RegisterFormValues): Promise<void> => {
    try {
      const resolved = resolveVendorInput(values.vendorText, vendorsQuery.data ?? [])
      const body: RegisterVendorRequest = {
        name: values.name.trim(),
        email: values.email.trim(),
        password: values.password,
        nik: values.nik.trim(),
        ...(values.phone.trim() !== '' ? { phone: normalizePhone(values.phone) } : {}),
        ...resolved,
      }
      await registerVendor(body)
      setDone(true)
    } catch (err: unknown) {
      if (err instanceof SessionNetworkError) {
        setError('root', { type: 'network', message: err.message })
        return
      }
      if (err instanceof ApiError && err.status === 409) {
        setError('email', {
          type: 'server',
          message: 'Email sudah terdaftar. Gunakan email lain atau hubungi admin.',
        })
        return
      }
      const message =
        err instanceof Error && err.message !== ''
          ? err.message
          : 'Terjadi kesalahan. Silakan coba lagi.'
      setError('root', { type: 'server', message })
    }
  }

  if (status === 'authenticated') {
    return null
  }

  if (done) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center bg-page px-4 py-10 lg:flex-row">
        <div className="card w-full max-w-[480px] rounded-modal p-6 text-center lg:p-8">
          <p aria-hidden="true" className="mx-auto flex size-14 items-center justify-center rounded-badge bg-warning-bg text-warning-text">
            <Clock aria-hidden="true" className="size-7" />
          </p>
          <h1 className="mt-4 text-xl font-bold text-ink">Pendaftaran diterima</h1>
          <p className="mt-2">
            <Badge tone="warning">Menunggu persetujuan</Badge>
          </p>
          <p className="mt-2 text-sm leading-relaxed text-ink-secondary">
            Akun Vendor/Mitra Anda <strong>menunggu persetujuan superadmin</strong>.
            Anda akan dapat masuk setelah akun diaktifkan. Tidak ada tindakan
            lebih lanjut yang diperlukan saat ini.
          </p>
          <Link href="/login" className="mt-6 inline-block">
            <Button size="lg" className="min-h-touch">
              Kembali ke halaman masuk
            </Button>
          </Link>
        </div>
      </main>
    )
  }

  return (
    <main className="flex min-h-dvh flex-col bg-page lg:flex-row">
      <section className="relative isolate hidden overflow-hidden bg-sidebar-dark px-12 py-16 lg:flex lg:w-3/5 lg:flex-col lg:items-center lg:justify-center lg:gap-7">
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10 bg-[url('/login-hero.webp')] bg-cover bg-center"
        />
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10 bg-linear-to-br from-sidebar-dark/90 via-sidebar-dark/70 to-brand/60"
        />
        <Image
          src="/thcw.png"
          alt="THC"
          width={500}
          height={235}
          priority
          unoptimized
          className="relative z-10 h-auto w-52"
        />
        <div className="relative z-10 max-w-md text-center">
          <p className="text-3xl font-bold text-brand-contrast">
            Visitor Management System
          </p>
          <p className="mt-4 text-base text-brand-contrast/85">
            Pendaftaran akun Vendor/Mitra — akses fasilitas THC.
          </p>
        </div>
      </section>

      <section className="flex flex-1 flex-col items-center justify-start px-4 py-5 lg:w-2/5 lg:justify-center lg:px-8 lg:py-8">
        <div className="card w-full max-w-[480px] rounded-modal p-4 lg:p-8">
          <header className="mb-4 lg:mb-6">
            <h1 className="text-xl font-bold text-ink">Daftar sebagai Vendor/Mitra</h1>
            <p className="mt-1 text-sm text-ink-secondary">
              Isi data akun Anda. Akun baru menunggu persetujuan superadmin
              sebelum dapat digunakan untuk masuk.
            </p>
          </header>

          <form
            onSubmit={handleSubmit(onSubmit)}
            noValidate
            className="flex flex-col gap-3 lg:gap-4"
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:gap-4">
              <Input
                {...register('name')}
                label="Nama Lengkap"
                autoComplete="name"
                placeholder="cth. Dimas Prasetyo"
                fieldSize="gate"
                required
                maxLength={NAME_MAX_LENGTH}
                error={errors.name?.message}
              />
              <Input
                {...register('email')}
                label="Email"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="cth. nama@vendor.co.id"
                fieldSize="gate"
                required
                maxLength={EMAIL_MAX_LENGTH}
                error={errors.email?.message}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:gap-4">
              <Input
                {...register('phone')}
                label="No. Telepon"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="08xxxxxxxxxx"
                fieldSize="gate"
                maxLength={PHONE_MAX_LENGTH}
                error={errors.phone?.message}
              />
              <PasswordInput
                label="Kata Sandi"
                autoComplete="new-password"
                placeholder="Minimal 8 karakter"
                fieldSize="gate"
                required
                maxLength={PASSWORD_MAX_BYTES}
                hint="Minimal 8 karakter."
                error={errors.password?.message}
                {...register('password')}
              />
            </div>
            <Input
              {...register('nik')}
              label="NIK"
              inputMode="numeric"
              autoComplete="off"
              placeholder="16 digit Nomor Induk Kependudukan"
              fieldSize="gate"
              required
              maxLength={NIK_LENGTH}
              error={errors.nik?.message}
            />
            <Input
              {...register('vendorText')}
              label="Perusahaan Vendor/Mitra"
              placeholder={
                vendorsQuery.isPending
                  ? 'Memuat vendor…'
                  : 'Pilih dari daftar atau ketik manual'
              }
              hint="Pilih dari daftar atau ketik manual. Nama yang diketik manual tidak masuk daftar vendor."
              list="register-vendor-datalist"
              autoComplete="off"
              maxLength={VENDOR_NAME_MAX_LENGTH}
              error={errors.vendorText?.message}
            />
            <datalist id="register-vendor-datalist">
              {(vendorsQuery.data ?? []).map((vendor) => (
                <option key={vendor.id} value={vendor.name} />
              ))}
            </datalist>

            {errors.root?.message !== undefined ? (
              <p role="alert" className="text-sm font-medium text-danger-text">
                {errors.root.message}
              </p>
            ) : null}

            <Button type="submit" size="lg" fullWidth loading={isSubmitting}>
              Daftar
            </Button>
          </form>

          <p className="mt-3 text-center text-sm text-ink-secondary">
            Sudah punya akun?{' '}
            <Link
              href="/login"
              className="font-semibold text-brand underline-offset-4 hover:underline"
            >
              Masuk di sini
            </Link>
          </p>
        </div>
      </section>
    </main>
  )
}

export default function RegisterPage() {
  return <RegisterScreen />
}
