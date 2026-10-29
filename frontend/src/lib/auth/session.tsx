'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getMe, login, logout } from '@/lib/api/client';
import { ApiError } from '@/lib/api/fetcher';
import { clearToken, getToken } from '@/lib/auth/storage';
import type { User } from '@/lib/api/types';

/**
 * Status sesi client-side. `loading` hanya saat hidrasi awal berjalan.
 * `error` = hidrasi gagal karena gangguan sementara (jaringan/429/5xx):
 * token TETAP tersimpan dan guard menampilkan tombol coba lagi — bukan
 * pengalihan ke `/login`.
 */
export type SessionStatus = 'loading' | 'authenticated' | 'unauthenticated' | 'error';

/**
 * Permintaan tidak PERNAH sampai ke server (fetch melempar; tanpa respons
 * HTTP sama sekali — backend mati / koneksi putus / CORS gagal).
 * Kelas khusus (bukan `Error` biasa) agar UI membedakan "koneksi gagal"
 * dari "respons HTTP error" (401/500) yang pesannya wajib dipertahankan
 * verbatim dari backend. Membawa pesan koneksi dari `ApiError` `NETWORK_ERROR`
 * yang TIDAK mengklaim kesalahan server.
 */
export class SessionNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionNetworkError';
  }
}

export interface SessionValue {
  user: User | null;
  status: SessionStatus;
  /** Masuk dan hidrasi user. Melempar `Error` pesan Indonesia saat gagal. */
  signIn: (email: string, password: string) => Promise<User>;
  /** Keluar. Selalu mengakhiri sesi lokal walau logout jaringan gagal. */
  signOut: () => Promise<void>;
  /** Hidrasi ulang user dari token tersimpan. Tidak melempar. */
  refresh: () => Promise<void>;
  /**
   * Tulis user baru ke sesi secara SINKRON (mis. hasil `PATCH /auth/me`).
   * Menaikkan epoch sehingga respons `/auth/me` yang lebih lama tidak bisa
   * menimpanya dengan data basi.
   */
  applyUser: (user: User) => void;
}

const SessionContext = createContext<SessionValue | null>(null);

/**
 * Interval penyegaran senyap user selama sesi aktif. `avatar_url` adalah
 * presigned URL berumur 15 menit; 10 menit memberi margin satu tick penuh
 * sebelum tautan di UI kedaluwarsa.
 */
export const SESSION_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Kunci flag sekali-pakai "sesi kedaluwarsa" di `sessionStorage`.
 * Dipasang SEBELUM `clearToken()` hanya ketika `getMe()` menolak dengan 401
 * padahal token sempat ada (token basi / kedaluwarsa), lalu dikonsumsi guard
 * menjadi `?expired=1`. Gangguan jaringan/429/5xx tidak memasang flag ini.
 * Kunjungan pertama tanpa token TIDAK memasang flag -> `/login` polos.
 */
const EXPIRED_FLAG_KEY = 'thc_vms_expired';

/** Tandai sesi berakhir (sekali-pakai). No-op di server / storage mati. */
function markSessionExpired(): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.sessionStorage.setItem(EXPIRED_FLAG_KEY, '1');
  } catch {
    // Abaikan: storage dimatikan tidak boleh crash app.
  }
}

/**
 * Baca + hapus flag kedaluwarsa sekali-pakai. Dipakai guard untuk memilih
 * `/login?expired=1` (true) vs `/login` polos (false).
 */
export function consumeSessionExpiredFlag(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    const expired = window.sessionStorage.getItem(EXPIRED_FLAG_KEY) === '1';
    if (expired) {
      window.sessionStorage.removeItem(EXPIRED_FLAG_KEY);
    }
    return expired;
  } catch {
    return false;
  }
}

/**
 * Dedupe in-flight `GET /auth/me`: satu promise bersama modul-level supaya
 * mount StrictMode ganda + `refresh()` bersamaan tidak menembak API berkali-kali.
 * Direset via `finally` begitu settle. Bukan polling/interval.
 */
let inFlightMe: Promise<User> | null = null;

function fetchMeDeduped(): Promise<User> {
  if (inFlightMe === null) {
    inFlightMe = getMe().finally(() => {
      inFlightMe = null;
    });
  }
  return inFlightMe;
}

/**
 * Hanya HTTP 401 yang berarti token tidak berlaku. Galat jaringan (status 0),
 * 429, dan 5xx bersifat sementara — sesi TIDAK boleh diakhiri karenanya.
 */
function isSessionExpiredError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

/** Ubah error tak dikenal menjadi pesan Indonesia yang aman ditampilkan. */
function toDisplayMessage(err: unknown): string {
  if (err instanceof ApiError) {
    return err.message;
  }
  if (err instanceof Error && err.message !== '') {
    return err.message;
  }
  return 'Terjadi kesalahan. Silakan coba lagi.';
}

export function SessionProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<SessionStatus>('loading');
  // Cache React Query milik root Providers (di atas provider ini): WAJIB
  // dibersihkan tiap ganti akun, kalau tidak daftar kunjungan akun lama
  // menyala sesaat di dashboard akun baru sampai refetch selesai.
  const queryClient = useQueryClient();

  /**
   * Generasi tulis state user. Semua jalur async menangkap nilai ini SEBELUM
   * `await` dan hanya boleh commit bila nilainya belum berubah. Tanpa ini,
   * `GET /auth/me` yang dimulai sebelum `PATCH /auth/me` bisa selesai
   * belakangan dan menimpa avatar baru dengan data basi.
   */
  const writeEpochRef = useRef(0);

  /** Tulis user baru secara sinkron + batalkan semua commit async yang lebih tua. */
  const applyUser = useCallback((next: User): void => {
    writeEpochRef.current += 1;
    setUser(next);
    setStatus('authenticated');
  }, []);

  /**
   * Hidrasi ulang user TANPA efek samping destruktif: dipakai signIn dan
   * interval latar. Kegagalan transien (jaringan/5xx) diabaikan dan state
   * dibiarkan apa adanya — tidak menandai sesi kedaluwarsa, tidak clearToken.
   * Mengembalikan `null` bila hasilnya sudah basi (applyUser lebih baru).
   */
  const hydrateSilently = useCallback(async (): Promise<User | null> => {
    const epoch = writeEpochRef.current;
    try {
      const me = await fetchMeDeduped();
      if (epoch !== writeEpochRef.current) {
        return null;
      }
      setUser(me);
      setStatus('authenticated');
      return me;
    } catch {
      return null;
    }
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const token = getToken();
    if (token === null) {
      writeEpochRef.current += 1;
      setUser(null);
      setStatus('unauthenticated');
      return;
    }
    const epoch = writeEpochRef.current;
    try {
      // Pakai dedupe bersama agar refresh + mount effect tidak dobel-hit.
      const me = await fetchMeDeduped();
      if (epoch !== writeEpochRef.current) {
        return;
      }
      setUser(me);
      setStatus('authenticated');
    } catch (err: unknown) {
      // Hasil basi tidak boleh mengakhiri sesi yang baru saja ditulis
      // (mis. applyUser setelah PATCH profil berhasil).
      if (epoch !== writeEpochRef.current) {
        return;
      }
      // Gangguan sementara (jaringan/429/5xx): pertahankan token & sesi.
      // Bila hidrasi awal belum selesai, beri kesempatan coba lagi (`error`);
      // bila sudah punya user, biarkan sesi berjalan dengan data lama.
      if (!isSessionExpiredError(err)) {
        setStatus((current) => (current === 'loading' ? 'error' : current));
        return;
      }
      // 401: token sempat ada tapi getMe gagal: tandai sesi berakhir SEBELUM
      // clearToken agar guard bisa redirect `?expired=1`. Navigasi + toast
      // tetap tugas guard + layar login, bukan provider ini.
      // Cache ikut dibuang: akun berikutnya wajib mulai dari data kosong.
      writeEpochRef.current += 1;
      markSessionExpired();
      queryClient.clear();
      clearToken();
      setUser(null);
      setStatus('unauthenticated');
    }
  }, [queryClient]);

  useEffect(() => {
    let cancelled = false;
    (async (): Promise<void> => {
      const token = getToken();
      if (token === null) {
        if (!cancelled) {
          setUser(null);
          setStatus('unauthenticated');
        }
        return;
      }
      const epoch = writeEpochRef.current;
      try {
        // Dedupe bersama: mount StrictMode ganda hanya menembak 1 request.
        const me = await fetchMeDeduped();
        if (!cancelled && epoch === writeEpochRef.current) {
          setUser(me);
          setStatus('authenticated');
        }
      } catch (err: unknown) {
        if (cancelled || epoch !== writeEpochRef.current) {
          return;
        }
        // Gangguan sementara (jaringan/429/5xx) BUKAN sesi berakhir: token
        // dipertahankan dan guard menampilkan tombol coba lagi, bukan /login.
        if (!isSessionExpiredError(err)) {
          setStatus('error');
          return;
        }
        // 401: token sempat ada tapi getMe gagal -> tandai expired sebelum clear.
        writeEpochRef.current += 1;
        markSessionExpired();
        clearToken();
        setUser(null);
        setStatus('unauthenticated');
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (status !== 'authenticated') {
      return undefined;
    }
    const intervalId = window.setInterval(() => {
      // SENGAJA memakai hydrateSilently, BUKAN refresh(): tick latar tidak
      // boleh mengakhiri sesi hanya karena satu permintaan /auth/me gagal.
      void hydrateSilently();
    }, SESSION_REFRESH_INTERVAL_MS);
    return (): void => {
      window.clearInterval(intervalId);
    };
  }, [status, hydrateSilently]);

  const signIn = useCallback(async (email: string, password: string): Promise<User> => {
    try {
      const result = await login({ email, password });
      // Buang sisa cache akun sebelumnya SEBELUM sesi baru dipasang, supaya
      // layar pertama akun baru tidak pernah melukis data akun lama.
      queryClient.clear();
      // Sesi baru adalah penulis terbaru: naikkan epoch agar `/auth/me` yang
      // dimulai sebelum login ini tidak menimpa payload login.
      writeEpochRef.current += 1;
      // Fallback segera: payload login cukup untuk membuka sesi walau /auth/me
      // lambat/gagal. Nilainya lalu diganti hasil hidrasi yang kanonik.
      setUser(result.user);
      setStatus('authenticated');
      const hydrated = await hydrateSilently();
      return hydrated ?? result.user;
    } catch (err: unknown) {
      // Jangan lempar ApiError mentah ke UI; bungkus jadi Error biasa.
      // Kegagalan jaringan (tanpa respons HTTP) dibungkus ke kelas khusus
      // agar layar masuk TIDAK pernah menampilkan klaim "kesalahan server".
      if (err instanceof ApiError && err.code === 'NETWORK_ERROR') {
        throw new SessionNetworkError(err.message);
      }
      throw new Error(toDisplayMessage(err));
    }
  }, [queryClient, hydrateSilently]);

  const signOut = useCallback(async (): Promise<void> => {
    try {
      await logout();
    } finally {
      // `logout()` sudah menghapus token via fetcher; panggil lagi via
      // storage agar satu kunci kebenaran tetap ditegakkan di lapisan auth.
      // Batalkan fetch yang masih jalan lalu buang cache: tanpa ini, login
      // berikutnya membaca daftar basi akun lama sampai refetch selesai.
      // `finally` menjamin sesi lokal berakhir walau jaringan gagal.
      // Naikkan epoch SEBELUM membuang state + sesudah await, agar hidrasi
      // `/auth/me` yang masih jalan tidak menghidupkan sesi yang sudah keluar.
      writeEpochRef.current += 1;
      await queryClient.cancelQueries();
      queryClient.clear();
      clearToken();
      setUser(null);
      setStatus('unauthenticated');
    }
  }, [queryClient]);

  const value = useMemo<SessionValue>(
    () => ({ user, status, signIn, signOut, refresh, applyUser }),
    [user, status, signIn, signOut, refresh, applyUser],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** Akses sesi. Melempar jelas bila dipakai di luar `<SessionProvider>`. */
export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (ctx === null) {
    throw new Error('useSession harus digunakan di dalam <SessionProvider>.');
  }
  return ctx;
}
