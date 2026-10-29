'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { getLoginRedirect } from '@/lib/auth/capabilities'
import { SessionNetworkError, useSession } from '@/lib/auth/session'

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

function LoginScreen() {
  const router = useRouter()
  const { user, status, signIn } = useSession()
  const expiredHandled = useRef(false)

  const {
    register,
    handleSubmit,
    setError,
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

  const onSubmit = async (values: LoginFormValues): Promise<void> => {
    try {
      const signedIn = await signIn(values.email, values.password)
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
              error={errors.email?.message}
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

            <Button type="submit" size="lg" fullWidth loading={isSubmitting}>
              Masuk
            </Button>
          </form>

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
