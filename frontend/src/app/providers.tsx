'use client'

/**
 * Provider global aplikasi: satu `QueryClient` per sesi browser + Toaster.
 *
 * Cache TIDAK dikongsi antar-request server — `getQueryClient` membuat instance
 * baru ketika `window` tidak ada, sehingga tidak mungkin ada kebocoran data
 * kunjungan antar cabang.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { Toaster } from 'sonner'

/**
 * Default opsi cache yang mengikuti SLO produk: P95 respons API < 150 ms dan
 * ~1.000 req/detik. `staleTime` 30 detik untuk data operasional, sedangkan
 * master data memakai 5 menit (lihat `hooks.ts`) sehingga N petugas gerbang
 * tidak menuju API Go sekaligus. `retry: 1` menjaga kegagalan tetap terasa
 * cepat — bukan tersembunyi di balik tiga exponential backoff.
 *
 * `gcTime` (bukan `cacheTime` — istilah v4) menahan cache 10 menit supaya
 * pindah menu tidak memicu permintaan ulang.
 */
function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30 * 1000,
        gcTime: 10 * 60 * 1000,
        retry: 1,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
      },
      mutations: {
        retry: 0,
      },
    },
  })
}

let browserQueryClient: QueryClient | undefined

/**
 * Sengaja TIDAK `useState(() => makeQueryClient())`: React membuang state itu
 * bila render pertama suspense tanpa pembatas Suspense di atasnya, sehingga
 * cache bisa terputus dari provider. Pola di bawah memberi instance yang stabil
 * di browser dan instance baru di server.
 */
function getQueryClient(): QueryClient {
  if (typeof window === 'undefined') {
    return makeQueryClient()
  }
  browserQueryClient ??= makeQueryClient()
  return browserQueryClient
}

const MOBILE_MEDIA_QUERY = '(max-width: 767px)'

type ToastPosition = 'top-right' | 'top-center'

/**
 * Sonner tidak menyediakan posisi responsif bawaan, jadi posisinya kita
 * tentukan sendiri: kanan atas di desktop, tengah atas di layar ponsel/tablet
 * kios pos.
 */
function useToastPosition(): ToastPosition {
  const [position, setPosition] = useState<ToastPosition>('top-center')

  useEffect(() => {
    const media = window.matchMedia(MOBILE_MEDIA_QUERY)
    const sync = (): void => setPosition(media.matches ? 'top-center' : 'top-right')
    sync()
    media.addEventListener('change', sync)
    return () => {
      media.removeEventListener('change', sync)
    }
  }, [])

  return position
}

export function Providers({ children }: { children: ReactNode }) {
  const queryClient = getQueryClient()
  const position = useToastPosition()

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster
        position={position}
        richColors
        closeButton
        toastOptions={{
          duration: 4000,
          classNames: {
            toast: 'font-sans rounded-card',
          },
        }}
      />
    </QueryClientProvider>
  )
}
