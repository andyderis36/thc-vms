'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { PasswordInput } from '@/components/ui/PasswordInput'
import { getLoginRedirect } from '@/lib/auth/capabilities'
import { SessionNetworkError, useSession } from '@/lib/auth/session'
import { EMAIL_MAX_LENGTH, PASSWORD_MAX_BYTES } from '@/lib/limits'

/**
 * SCR-01 — Layar Masuk terpadu untuk keempat peran RBAC.
 *
 * Desktop (>=1024px): split 60/40 — panel gradien gelap-ke-merah di kiri,
 * kartu masuk putih terpusat di kanan. Ponsel (<768px): satu kolom tunggal
 * dengan kartu radius 16px dan seluruh kontrol berukuran target sentuh 44px+.
 *
 * Halaman ini SENGAJA tanpa SessionProvider/Providers sendiri: satu-satunya
 * SessionProvider adalah milik root layout, sehingga `signIn` menulis ke
 * konteks root dan `/gate` tidak blank pasca-login (satu hidrasi getMe).
 */
const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Email wajib diisi')
    // Akun dev boleh masuk cukup dengan username `dev-superadmin` (tanpa
    // format email); sisanya tetap wajib email valid. Pemetaan ke email
    // lengkap terjadi di onSubmit sebelum signIn.
    .refine(
      (value) =>
        value === DEV_LOGIN_USERNAME ||
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
      'Format email tidak valid',
    ),
  password: z
    .string()
    .min(1, 'Kata sandi wajib diisi')
    .min(8, 'Kata sandi minimal 8 karakter'),
})

type LoginFormValues = z.infer<typeof loginSchema>


// Username singkat akun dev (boleh diketik tanpa format email).
const DEV_LOGIN_USERNAME = 'dev-superadmin'

// Email lengkap pasangan username dev di atas.
const DEV_LOGIN_EMAIL = 'dev-superadmin@transhybrid.net.id'

// Akun dummy khusus pengembangan lokal. Hanya dipakai bila
// NEXT_PUBLIC_DEMO_ACC_LOGIN === 'true' (lihat render di bawah). Email
// berasal dari seed backend (docs/5. LOCAL_DEV.md 6.1); password seragam
// seed = "Password123!" (backend/seeds/seeddata/password.go DemoPassword).
const DEV_DUMMY_PASSWORD = 'Password123!'

const DEV_DUMMY_ACCOUNTS = [
  { label: 'Super Admin - superadmin@transhybrid.net.id', email: 'superadmin@transhybrid.net.id' },
  { label: 'Admin - admin1@transhybrid.net.id', email: 'admin1@transhybrid.net.id' },
  { label: 'Security - security1a@transhybrid.net.id', email: 'security1a@transhybrid.net.id' },
  { label: 'Vendor - vendor1a@transhybrid.net.id', email: 'vendor1a@transhybrid.net.id' },
  // Password dev lokal (khusus dev, bukan seed global) — hanya dipakai
  // mengisi form saat flag demo aktif, tidak pernah dikirim ke mana pun
  // selain endpoint login seperti password biasa.
  { label: 'Dev Superadmin - dev-superadmin', email: DEV_LOGIN_EMAIL, password: 'qwqw1234' },
] as const

function LoginScreen() {
  const router = useRouter()
  const { user, status, signIn } = useSession()
  const expiredHandled = useRef(false)

  // Gerbang dev-only: dropdown akun dummy hanya muncul bila env flag true.
  const isDevLoginEnabled =
    process.env.NEXT_PUBLIC_DEMO_ACC_LOGIN === 'true'

  const {
    register,
    handleSubmit,
    setError,
    setValue,
    // RHF 7.88 tidak menyediakan `isPending`; `isSubmitting` adalah flag
    // pending yang aktif selama `onSubmit` berjalan — dipakai `loading` tombol.
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  })

  // Sudah masuk (token valid saat membuka /login) -> ganti ke tujuan perannya.
  useEffect(() => {
    if (status === 'authenticated' && user !== null) {
      router.replace(getLoginRedirect(user.role))
    }
  }, [status, user, router])

  // Flag `?expired=1` dari guard: nyalakan tepat SATU toast lalu bersihkan URL.
  // Ref menjamin efek StrictMode/dev ganda tidak menggandakan toast.
  useEffect(() => {
    if (
      expiredHandled.current ||
      status === 'loading' ||
      status === 'authenticated'
    ) {
      return
    }
    const params = new URLSearchParams(window.location.search)
    if (params.get('expired') !== '1') {
      return
    }
    expiredHandled.current = true
    toast.error('Sesi berakhir, silakan masuk kembali.')
    router.replace('/login')
  }, [status, router])

  const handleDevAccountChange = (email: string): void => {
    if (email === '') {
      return
    }
    const account = DEV_DUMMY_ACCOUNTS.find((item) => item.email === email)
    setValue('email', email, { shouldValidate: true })
    setValue('password', account && 'password' in account ? account.password : DEV_DUMMY_PASSWORD, {
      shouldValidate: true,
    })
  }

  const onSubmit = async (values: LoginFormValues): Promise<void> => {
    try {
      const email =
        values.email.trim() === DEV_LOGIN_USERNAME ? DEV_LOGIN_EMAIL : values.email
      const signedIn = await signIn(email, values.password)
      router.replace(getLoginRedirect(signedIn.role))
    } catch (err: unknown) {
      // Permintaan tidak pernah sampai ke server -> pesan koneksi, BUKAN
      // klaim kesalahan server.
      if (err instanceof SessionNetworkError) {
        setError('password', { type: 'network', message: err.message })
        return
      }
      // 401 membalas "Kredensial tidak valid" (backend & mock) -> error inline.
      const message =
        err instanceof Error && err.message !== ''
          ? err.message
          : 'Terjadi kesalahan. Silakan coba lagi.'
      setError('password', { type: 'server', message })
    }
  }

  if (status === 'authenticated') {
    return null
  }

  return (
    <main className="flex min-h-dvh flex-col bg-page lg:flex-row">
      {/* Panel kiri (desktop >=1024px): foto rak data center THC sebagai latar,
          dengan scrim gelap agar teks tetap kontras (menggantikan gradasi lama). */}
      <section className="relative isolate hidden overflow-hidden bg-sidebar-dark px-12 py-16 lg:flex lg:w-3/5 lg:flex-col lg:items-center lg:justify-center lg:gap-7">
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10 bg-[url('/login-hero.webp')] bg-cover bg-center"
        />
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10 bg-linear-to-br from-sidebar-dark/90 via-sidebar-dark/70 to-brand/60"
        />
        {/* `unoptimized` WAJIB (dua pemakaian di berkas ini): `/_next/image`
            `?url=%2Fthcw.png&w=1080&q=75` dengan `Accept: image/avif`
            menggantung tanpa respons (>45 s, terukur 2026-10-28) dan ikut
            menahan permintaan Next lain di server yang sama. Aset ini hanya
            24 KB (500x235) - sajikan apa adanya. */}
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
            THC Kalbar Data Center &amp; PoP Access Governance Portal
          </p>
        </div>
      </section>

      {/* Panel kanan (desktop 40%) / kolom tunggal (ponsel). */}
      <section className="flex flex-1 flex-col items-center justify-start px-4 py-0 min-[400px]:py-5 max-[359px]:py-0 lg:w-2/5 lg:justify-center lg:px-8 lg:py-8">
        {/* Hero khusus ponsel: container TERPISAH dari kartu form (pola
            transhybrid.net.id) — full-bleed ke tepi atas/kiri/kanan dengan
            padding section dinegasikan, hanya sudut bawah yang membulat. */}
        <div className="relative isolate -mx-4 mt-0 mb-5 flex min-h-[184px] shrink-0 self-stretch flex-col items-center justify-center overflow-hidden rounded-b-hero bg-sidebar-dark px-4 py-6 max-[359px]:min-h-[150px] max-[359px]:py-4 min-[400px]:-mt-5 min-[400px]:py-7 text-center lg:hidden">
          <div
            aria-hidden="true"
            className="absolute inset-0 -z-10 bg-[url('/login-hero.webp')] bg-cover bg-center"
          />
          <div
            aria-hidden="true"
            className="absolute inset-0 -z-10 bg-linear-to-br from-sidebar-dark/85 via-sidebar-dark/65 to-brand/55"
          />
          <div className="relative z-10 flex w-full flex-col items-center px-2">
            <Image
              src="/thcw.png"
              alt="THC"
              width={500}
              height={235}
              priority
              unoptimized
              className="h-15 w-auto shrink-0"
            />
            <p className="mt-4 w-full text-center text-sm font-bold leading-snug text-brand-contrast">
              Visitor Management System
            </p>
            <p className="mt-1.5 w-full text-center text-xs leading-snug text-brand-contrast/85">
              THC Kalbar Data Center &amp; PoP Access Governance Portal
            </p>
          </div>
        </div>

        {/* Kartu form: container terpisah di bawah hero. */}
        <div className="card w-full max-w-[420px] rounded-modal p-4 max-[359px]:p-3 lg:p-8">
          <header className="mb-4 max-[399px]:mb-2 min-[380px]:mb-3 min-[400px]:mb-5 lg:mb-6">
            <h1 className="text-xl font-bold text-ink">Masuk</h1>
            <p className="mt-1 text-sm text-ink-secondary">
              Gunakan akun resmi Anda untuk mengakses sistem.
            </p>
          </header>

          <form
            onSubmit={handleSubmit(onSubmit)}
            noValidate
            className="flex flex-col gap-3 max-[399px]:gap-2 min-[380px]:gap-3 min-[400px]:gap-4"
          >
            {isDevLoginEnabled ? (
              <div className="flex flex-col gap-2">
                <label
                  htmlFor="dev-dummy-account"
                  className="text-label font-semibold text-ink"
                >
                  Akun dummy (dev)
                </label>
                <select
                  id="dev-dummy-account"
                  defaultValue=""
                    onChange={(e) => handleDevAccountChange(e.target.value)}
                  className="h-10 w-full rounded-control border border-border-mid bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:ring-4 focus:ring-brand/12 focus:outline-none"
                >
                  <option value="">Pilih akun dummy...</option>
                  {DEV_DUMMY_ACCOUNTS.map((account) => (
                    <option key={account.email} value={account.email}>
                      {account.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {/* Registrasi RHF disebar DULU, lalu props semantik eksplisit:
                field ini wajib tetap textbox email biasa (tanpa list /
                role=combobox / aria-haspopup yang dibaca sebagai combobox). */}
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
            <PasswordInput
              label="Kata Sandi"
              autoComplete="current-password"
              placeholder="Minimal 8 karakter"
              fieldSize="gate"
              required
              maxLength={PASSWORD_MAX_BYTES}
              error={errors.password?.message}
              {...register('password')}
            />

            <Button type="submit" size="lg" fullWidth loading={isSubmitting}>
              Masuk
            </Button>
          </form>

          <p className="mt-3 text-center text-sm text-ink-secondary">
            Vendor / mitra baru?{' '}
            <Link
              href="/register"
              className="font-semibold text-brand underline-offset-4 hover:underline"
            >
              Daftar sebagai Vendor/Mitra
            </Link>
          </p>

          <p className="mt-3 max-[399px]:mt-2 text-center text-xs leading-snug max-[399px]:leading-tight text-ink-muted">
            Dengan masuk, Anda menyetujui Syarat Layanan dan Kebijakan Privasi
            THC. Data kunjungan hanya digunakan untuk keperluan verifikasi akses
            fasilitas.
          </p>
        </div>
      </section>
    </main>
  )
}

export default function LoginPage() {
  // Tanpa provider ganda: pakai SessionProvider + Toaster milik root layout.
  return <LoginScreen />
}
