'use client'

import { useSyncExternalStore } from 'react'
import { CloudOff, ServerCrash } from 'lucide-react'

import {
  describeConnectivity,
  getNetworkFailureSnapshot,
  resolveConnectivityState,
  subscribeNetworkFailure,
  type ConnectivityTone,
} from '@/lib/api/connectivity'

/**
 * Pemetaan nada -> kelas Tailwind hidup DI SINI (bukan di
 * `lib/api/connectivity.ts`), supaya file logika tetap murni dan dapat
 * diuji tanpa DOM — pola yang sama dengan `Badge.tsx` vs
 * `lib/visits/status-badge.ts`.
 *
 * Permukaan yang dipilih "terang" (tint lembut + teks gelap) supaya banner
 * terbaca di atas kartu putih halaman login maupun di atas sidebar gelap
 * superadmin (#09090b) yang menindih sisi kiri viewport.
 */
const TONE_CLASSES: Record<ConnectivityTone, string> = {
  warning: 'bg-warning-bg text-warning-text',
  danger: 'bg-danger-bg text-danger-text',
}

/**
 * Dengarkan status jaringan browser lewat event `online`/`offline`.
 *
 * `useSyncExternalStore` (bukan `useState` + `useEffect`) dipilih karena
 * tidak memaksa update state di dalam efek — aturan lint
 * `react-hooks/set-state-in-effect` tetap hijau tanpa perlu pengecualian.
 */
function subscribeToOnlineStatus(onStoreChange: () => void): () => void {
  window.addEventListener('online', onStoreChange)
  window.addEventListener('offline', onStoreChange)
  return () => {
    window.removeEventListener('online', onStoreChange)
    window.removeEventListener('offline', onStoreChange)
  }
}

/** Snapshot sisi browser — `navigator.onLine` adalah sumber kebenaran. */
function getOnlineSnapshot(): boolean {
  if (typeof navigator === 'undefined') {
    return true
  }
  return navigator.onLine
}

/** Snapshot SSR — server tidak punya jaringan, jadi diasumsikan online. */
function getServerOnlineSnapshot(): boolean {
  return true
}

/** Snapshot SSR untuk store kegagalan jaringan — belum ada yang gagal. */
function getServerFailureSnapshot(): boolean {
  return false
}

/**
 * Banner konektivitas global (satu-satunya di seluruh aplikasi).
 *
 * Dua sumber status:
 * 1. `navigator.onLine` + event `online`/`offline` — perangkat sedang
 *    kehilangan koneksi internet.
 * 2. Store "server tidak dapat dihubungi" — browser masih daring tetapi
 *    request terakhir gagal tanpa respons HTTP (backend mati / DNS gagal).
 *
 * Saat koneksi sehat komponen ini TIDAK merender apa pun: tidak ada node
 * DOM, tidak ada strip kosong, tidak ada layout shift.
 */
export function ConnectivityBanner() {
  const browserOnline = useSyncExternalStore(
    subscribeToOnlineStatus,
    getOnlineSnapshot,
    getServerOnlineSnapshot,
  )
  const serverUnreachable = useSyncExternalStore(
    subscribeNetworkFailure,
    getNetworkFailureSnapshot,
    getServerFailureSnapshot,
  )

  const copy = describeConnectivity(
    resolveConnectivityState({ browserOnline, serverUnreachable }),
  )

  if (copy === null) {
    return null
  }

  const Icon = browserOnline ? ServerCrash : CloudOff

  return (
    // Konteks pembungkus: ruang napas + perataan. Kartu banner diratakan
    // ke kanan di >= lg supaya TIDAK pernah tertutup sidebar tetap
    // (superadmin 260px / admin cabang 250px) yang menindih sisi kiri
    // viewport; di layar kecil kartu memakai lebar penuh.
    <div className="px-3 pt-3 lg:pr-4">
      <div
        role="status"
        aria-live="polite"
        data-testid="connectivity-banner"
        className={[
          'flex w-full items-start gap-2 rounded-card border border-black/5 px-3 py-2 shadow-card lg:ml-auto lg:max-w-md',
          TONE_CLASSES[copy.tone],
        ].join(' ')}
      >
        <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <p className="min-w-0 text-label leading-snug">
          {/* Spasi eksplisit (bukan margin) supaya judul & isi tetap satu
              rangkaian kalimat yang benar saat dibaca screen reader. */}
          <span className="font-semibold">{copy.title}</span>{' '}
          {copy.body}
        </p>
      </div>
    </div>
  )
}
