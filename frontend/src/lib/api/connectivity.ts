/**
 * Logika konektivitas global THC VMS.
 *
 * File ini sengaja dipecah jadi DUA bagian dengan batas yang tegas:
 *
 * 1. BAGIAN MURNI (atas) — `isOfflineError`, `resolveConnectivityState`,
 *    `describeConnectivity`. Tanpa DOM, tanpa efek samping, tanpa I/O.
 *    Seluruh keputusan "apakah banner tampil dan apa isinya" hidup di sini
 *    sehingga bisa diuji unit TANPA browser (lihat `tests/connectivity.test.ts`).
 *
 * 2. BAGIAN RUNTIME (bawah) — store "server tidak dapat dihubungi": satu
 *    boolean + daftar subscriber. Ini BUKAN event bus: tidak ada antrean,
 *    tidak ada buffer, tidak ada riwayat. Hanya satu fakta: "permintaan
 *    terakhir yang gagal karena jaringan".
 *
 * JALUR KERJA (satu arah):
 *
 *   `fetcher.ts`   → request tak pernah sampai ke server
 *                  → lempar `ApiError` { status: 0, code: 'NETWORK_ERROR' }
 *   `providers.tsx`→ `QueryCache`/`MutationCache` `onError`
 *                  → `reportNetworkFailure(error)` (hanya galat jaringan)
 *   store runtime  → `subscribeNetworkFailure()` memberi tahu banner global
 *   banner         → `useSyncExternalStore` membaca snapshot store
 *
 * Pemulihan: `onSuccess` pada cache yang sama memanggil
 * `clearNetworkFailure()` — begitu satu permintaan sukses, server bisa
 * dihubungi lagi dan banner menghilang tanpa perlu interaksi pengguna.
 */

/** Status konektivitas yang bisa ditampilkan banner global. */
export type ConnectivityState = 'online' | 'offline' | 'unreachable'

/**
 * Nada visual banner. Kelas Tailwind SENGAJA tidak disertakan di sini
 * (pola yang sama dengan `status-badge.ts` vs `Badge.tsx`): pemetaan
 * nada → kelas hidup di komponen `ConnectivityBanner` supaya file ini
 * tetap murni dan dapat diuji tanpa DOM.
 */
export type ConnectivityTone = 'warning' | 'danger'

/** Isi banner untuk sebuah status konektivitas. */
export interface ConnectivityCopy {
  tone: ConnectivityTone
  title: string
  body: string
}

/**
 * Kode galat yang dipakai `fetcher.ts` saat request TIDAK PERNAH sampai ke
 * server (koneksi ditolak / DNS gagal / perangkat offline). Dibedakan dari
 * `HTTP_ERROR` (401/500/dst.) karena yang satu berarti "server ada jawaban",
 * yang lain berarti "server tidak pernah menjawab".
 */
const NETWORK_ERROR_CODE = 'NETWORK_ERROR'

/**
 * True bila `error` menandakan kegagalan jaringan — request tidak pernah
 * sampai ke server — BUKAN respons HTTP dari server.
 *
 * Duck-typing (bukan `instanceof`) dipakai supaya objek error yang berasal
 * dari lapisan lain (mis. error yang diserialisasi melewati batas worker)
 * tetap dikenali, dan supaya fungsi ini tetap murni tanpa mengimpor
 * `ApiError` (yang menarik rantai `fetcher` → `compressImage`).
 */
export function isOfflineError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const candidate = error as { status?: unknown; code?: unknown }
  if (candidate.status === 0) {
    return true
  }
  return candidate.code === NETWORK_ERROR_CODE
}

/**
 * Sumber kebenaran status konektivitas.
 *
 * Prioritas: browser offline MENANG atas "server tidak dapat dihubungi",
 * karena "perangkat ini tidak punya jaringan" adalah fakta yang lebih
 * spesifik dan tidak bisa disangkal — server mungkin baik-baik saja.
 */
export function resolveConnectivityState(input: {
  browserOnline: boolean
  serverUnreachable: boolean
}): ConnectivityState {
  if (!input.browserOnline) {
    return 'offline'
  }
  if (input.serverUnreachable) {
    return 'unreachable'
  }
  return 'online'
}

/**
 * Copy banner per status konektivitas. `online` bernilai `null`: saat
 * koneksi sehat banner TIDAK dirender sama sekali (tanpa node DOM, tanpa
 * strip kosong, tanpa layout shift).
 */
const CONNECTIVITY_COPY: Record<ConnectivityState, ConnectivityCopy | null> = {
  online: null,
  offline: {
    tone: 'warning',
    title: 'Anda sedang offline',
    body: 'Koneksi internet terputus. Data yang ditampilkan mungkin sudah tidak terbaru dan akan disegarkan otomatis setelah koneksi kembali.',
  },
  unreachable: {
    tone: 'danger',
    title: 'Server tidak dapat dihubungi',
    body: 'Permintaan ke server gagal. Data yang ditampilkan mungkin sudah tidak terbaru dan akan disegarkan otomatis setelah server dapat diakses kembali.',
  },
}

/**
 * Pemetaan murni status konektivitas → copy banner.
 *
 * Nada yang dipilih sengaja "terang" (permukaan ber-tint lembut dengan teks
 * gelap) supaya banner tetap terbaca di atas permukaan terang (kartu putih)
 * maupun di atas sidebar gelap superadmin (#09090b).
 */
export function describeConnectivity(state: ConnectivityState): ConnectivityCopy | null {
  return CONNECTIVITY_COPY[state]
}

/* ===========================================================================
 * BAGIAN RUNTIME — store "server tidak dapat dihubungi"
 * =========================================================================== */

type ConnectivityListener = () => void

/** true = ada permintaan yang gagal karena jaringan (server tak terjangkau). */
let serverUnreachable = false

const listeners = new Set<ConnectivityListener>()

function notifyListeners(): void {
  for (const listener of listeners) {
    listener()
  }
}

/**
 * Catat kegagalan jaringan terakhir.
 *
 * Hanya galat JARINGAN yang dihitung: HTTP 401/403/404/500 adalah jawaban
 * server yang bermasalah, bukan masalah koneksi, dan TIDAK boleh memunculkan
 * banner "server tidak dapat dihubungi".
 */
export function reportNetworkFailure(error: unknown): void {
  if (!isOfflineError(error) || serverUnreachable) {
    return
  }
  serverUnreachable = true
  notifyListeners()
}

/**
 * Tandai server bisa dihubungi lagi — dipanggil saat satu permintaan
 * sukses (cache `onSuccess`) sehingga banner hilang sendiri begitu
 * layanan pulih, tanpa interaksi pengguna.
 */
export function clearNetworkFailure(): void {
  if (!serverUnreachable) {
    return
  }
  serverUnreachable = false
  notifyListeners()
}

/** Snapshot untuk `useSyncExternalStore` — nilai boolean, stabil antar render. */
export function getNetworkFailureSnapshot(): boolean {
  return serverUnreachable
}

/** Berlangganan perubahan status kegagalan jaringan. Mengembalikan unsubscribe. */
export function subscribeNetworkFailure(listener: ConnectivityListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
