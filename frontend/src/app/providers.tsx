'use client'

/**
 * Provider global aplikasi: satu `QueryClient` per sesi browser + Toaster.
 *
 * Cache TIDAK dikongsi antar-request server — `getQueryClient` membuat instance
 * baru ketika `window` tidak ada, sehingga tidak mungkin ada kebocoran data
 * kunjungan antar cabang.
 */

import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { Toaster } from 'sonner'

import { clearNetworkFailure, reportNetworkFailure } from '@/lib/api/connectivity'

/** Batas atas jeda retry eksponensial (ms) — jeda tidak tumbuh tanpa batas. */
const MAX_RETRY_DELAY_MS = 30_000

/**
 * Backoff eksponensial 1 dtk → 2 → 4 → 8 … dibatasi `MAX_RETRY_DELAY_MS`.
 * Nilainya identik dengan default TanStack Query, ditulis eksplisit agar
 * kontrak ketahanan jaringan buruk (S5) jelas dan teruji.
 */
function exponentialRetryDelay(retryAttempt: number): number {
  return Math.min(1000 * 2 ** retryAttempt, MAX_RETRY_DELAY_MS)
}

/**
 * Default opsi cache (diet data S5 + ketahanan jaringan buruk):
 * - `staleTime: Infinity` — master data (lokasi/purposes/vendor) tak pernah
 *   dianggap basi; query operasional menyetor `staleTime` 30 detik sendiri
 *   di `hooks.ts`, dan `me` memakai 0.
 * - `gcTime: 24 jam` — cache dipertahankan sehari penuh supaya pindah menu
 *   tidak memicu permintaan ulang.
 * - `refetchOnWindowFocus: false` — kembali fokus tidak lagi memicu refetch
 *   (reaksi fokus dihapus dari lapisan global & opsi detail/QR).
 * - `refetchOnReconnect: true` — pemulihan jaringan tetap menyegarkan data.
 * - `retry: 2` + `retryDelay` eksponensial (cap 30 detik) — koneksi seluler
 *   putus-putus diberi dua kesempatan ulang dengan jeda membesar sebelum
 *   menyerah. `hooks.ts` menyelaraskan kebijakan per-query (galat definitif
 *   401/403/404 tidak diulang).
 * - `retry: 0` (mutasi) — POST TIDAK pernah diulang otomatis (mencegah
 *   duplikasi check-in/approve); nilai ini sudah benar dan dipertahankan.
 * - `networkMode: 'online'` — dieksplisitkan: request menunggu jaringan
 *   kembali daring, bukan dipaksa jalan saat offline.
 *
 * Persistensi cache (`query-persist-client`) SENGAJA DITUNDA: paket resmi
 * `@tanstack/react-query-persist-client` belum terpasang di `package.json`,
 * jadi kita tidak menambah dependensi baru dan tidak memasang persist untuk
 * master query (locations/purposes). Bila paket itu kelak terpasang, persist
 * master 24 jam + `buster=APP_VERSION` boleh diaktifkan.
 *
 * `queryCache`/`mutationCache` global mendeteksi kegagalan JARINGAN (request
 * tak pernah sampai ke server) dan meneruskannya ke store konektivitas
 * (`lib/api/connectivity`) yang dibaca banner global. Ini TIDAK mengubah
 * semantik retry: `networkMode: 'online'` tetap menjeda query saat offline
 * (jadi tidak pernah ada "server tidak dapat dihubungi" palsu), dan retry
 * query/mutasi tetap seperti di bawah. Galat HTTP 401/403/404/500 TIDAK
 * pernah menyentuh store — hanya `NETWORK_ERROR`/`status: 0`.
 */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error: unknown) => {
        reportNetworkFailure(error)
      },
      onSuccess: () => {
        clearNetworkFailure()
      },
    }),
    mutationCache: new MutationCache({
      onError: (error: unknown) => {
        reportNetworkFailure(error)
      },
      onSuccess: () => {
        clearNetworkFailure()
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: Number.POSITIVE_INFINITY,
        gcTime: 24 * 60 * 60 * 1000,
        retry: 2,
        retryDelay: exponentialRetryDelay,
        networkMode: 'online',
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
      },
      mutations: {
        retry: 0,
        networkMode: 'online',
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

/**
 * Menyegarkan seluruh cache query saat riwayat browser dilintasi
 * (tombol Back/Forward).
 *
 * Seluruh layar memakai `useQuery` dengan `staleTime: Infinity`, dan navigasi
 * Back/Forward memulihkan DOM dari Router Cache tanpa remount — jadi
 * refetch-saat-mount tidak pernah menyala dan antrean terlihat basi sampai
 * reload manual. Dua pemicu dirangkum karena App Router selalu navigasi
 * same-document (diukur E2E 2026-11-03: klik + Back menambah NOL `pageshow`
 * dan tepat satu `popstate`):
 * - `popstate` — traversal Back/Forward antar rute SPA; inilah jalur yang
 *   benar-benar dipakai aplikasi ini.
 * - `pageshow` dengan `persisted: true` — HANYA pemulihan bfcache sejati
 *   (mis. kembali dari halaman muat-penuh eksternal); muat awal
 *   (`persisted: false`) tidak double-fetch.
 * Invalidasi tanpa filter kunci: katalog master yang ikut ter-refetch hanya
 * 4 query mungil, jadi pengecualian tidak sepadan.
 */
function useBfcacheRefresh(queryClient: QueryClient): void {
  useEffect(() => {
    const refresh = (): void => {
      void queryClient.invalidateQueries()
    }
    const onPageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) {
        refresh()
      }
    }
    window.addEventListener('popstate', refresh)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      window.removeEventListener('popstate', refresh)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [queryClient])
}

export function Providers({ children }: { children: ReactNode }) {
  const queryClient = getQueryClient()
  const position = useToastPosition()
  useBfcacheRefresh(queryClient)

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
