'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { getLoginRedirect } from '@/lib/auth/capabilities'
import { useSession } from '@/lib/auth/session'

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
    .email('Format email tidak valid'),
  password: z
    .string()
    .min(1, 'Kata sandi wajib diisi')
    .min(6, 'Kata sandi minimal 6 karakter'),
})

type LoginFormValues = z.infer<typeof loginSchema>

/** Kata sandi semua akun demo sama — sumbernya seed (`mocks/seed.ts`). */
const DEMO_PASSWORD = 'Password123!'

interface DemoAccount {
  label: string
  email: string
}

const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  { label: 'Superadmin', email: 'superadmin@thc.net.id' },
  { label: 'Admin Cabang', email: 'admin.sby@thc.net.id' },
  { label: 'Security', email: 'satpam.sby@thc.net.id' },
  { label: 'PIC Vendor', email: 'vendor.splicing@mitra-fo.com' },
]

function LoginScreen() {
  const router = useRouter()
  const { user, status, signIn } = useSession()
  const [selectedDemo, setSelectedDemo] = useState<string | null>(null)
  const expiredHandled = useRef(false)

  const {
    register,
    handleSubmit,
    setValue,
    setError,
    clearErrors,
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

  /** Isi kolom dari akun demo. Hanya `setValue` — tidak pernah auto-submit. */
  const applyDemo = (account: DemoAccount): void => {
    clearErrors()
    setValue('email', account.email, { shouldValidate: true })
    setValue('password', DEMO_PASSWORD, { shouldValidate: true })
    setSelectedDemo(account.label)
  }

  const onSubmit = async (values: LoginFormValues): Promise<void> => {
    try {
      const signedIn = await signIn(values.email, values.password)
      router.replace(getLoginRedirect(signedIn.role))
    } catch (err: unknown) {
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
      {/* Panel kiri (desktop >=1024px): gradien gelap -> merah THC */}
      <section className="hidden bg-sidebar-dark bg-linear-to-br from-sidebar-dark via-sidebar-dark-active to-brand px-12 py-16 lg:flex lg:w-3/5 lg:flex-col lg:items-center lg:justify-center lg:gap-7">
        <div className="flex h-20 w-20 items-center justify-center rounded-modal bg-brand-contrast shadow-modal">
          <span className="text-2xl font-extrabold tracking-widest text-brand">
            THC
          </span>
        </div>
        <div className="max-w-md text-center">
          <p className="text-3xl font-bold text-brand-contrast">
            THC Visitor Management System
          </p>
          <p className="mt-4 text-base text-ink-muted">
            Sistem Pengelolaan Kunjungan Kantor Cabang, POP &amp; miniPOP THC
          </p>
        </div>
      </section>

      {/* Panel kanan (desktop 40%) / kolom tunggal (ponsel): kartu masuk */}
      <section className="flex flex-1 flex-col items-center justify-center px-4 py-8 lg:w-2/5 lg:px-8">
        <div className="card w-full max-w-[420px] rounded-modal p-5 lg:p-8">
          {/* Mark ringkas hanya di layar kecil (panel kiri tersembunyi) */}
          <div className="mb-6 flex items-center gap-3 lg:hidden">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-control bg-brand text-brand-contrast">
              <span className="text-sm font-extrabold tracking-wider">THC</span>
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold text-ink">
                THC Visitor Management System
              </p>
              <p className="text-xs text-ink-secondary">
                Kantor Cabang, POP &amp; miniPOP THC
              </p>
            </div>
          </div>

          <header className="mb-6">
            <h1 className="text-xl font-bold text-ink">Masuk</h1>
            <p className="mt-1 text-sm text-ink-secondary">
              Gunakan akun resmi Anda untuk mengakses sistem.
            </p>
          </header>

          <form
            onSubmit={handleSubmit(onSubmit)}
            noValidate
            className="flex flex-col gap-4"
          >
            <Input
              label="Email"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="cth. nama@thc.net.id"
              fieldSize="gate"
              required
              error={errors.email?.message}
              {...register('email')}
            />
            <Input
              label="Kata Sandi"
              type="password"
              autoComplete="current-password"
              placeholder="Minimal 6 karakter"
              fieldSize="gate"
              required
              error={errors.password?.message}
              {...register('password')}
            />

            <div>
              <p className="text-label font-semibold text-ink-secondary">
                Akun demo (uji coba)
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {DEMO_ACCOUNTS.map((account) => (
                  <button
                    key={account.label}
                    type="button"
                    aria-pressed={selectedDemo === account.label}
                    onClick={() => applyDemo(account)}
                    className={`flex min-h-touch cursor-pointer items-center justify-center rounded-control border px-3 py-2 text-xs font-semibold transition duration-150 ${
                      selectedDemo === account.label
                        ? 'border-brand bg-brand text-brand-contrast'
                        : 'border-border-mid bg-surface text-ink-secondary hover:bg-neutral-bg'
                    }`}
                  >
                    {account.label}
                  </button>
                ))}
              </div>
            </div>

            <Button type="submit" size="lg" fullWidth loading={isSubmitting}>
              Masuk
            </Button>
          </form>

          <p className="mt-6 text-center text-xs leading-relaxed text-ink-muted">
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
