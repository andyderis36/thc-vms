'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { getMe, login, logout } from '@/lib/api/client';
import { ApiError } from '@/lib/api/fetcher';
import { clearToken, getToken } from '@/lib/auth/storage';
import type { User } from '@/lib/api/types';

/** Status sesi client-side. `loading` hanya saat hidrasi awal berjalan. */
export type SessionStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface SessionValue {
  user: User | null;
  status: SessionStatus;
  /** Masuk dan hidrasi user. Melempar `Error` pesan Indonesia saat gagal. */
  signIn: (email: string, password: string) => Promise<User>;
  /** Keluar. Selalu mengakhiri sesi lokal walau logout jaringan gagal. */
  signOut: () => Promise<void>;
  /** Hidrasi ulang user dari token tersimpan. Tidak melempar. */
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

/**
 * Kunci flag sekali-pakai "sesi kedaluwarsa" di `sessionStorage`.
 * Dipasang SEBELUM `clearToken()` saat `getMe()` gagal padahal token sempat
 * ada (token basi / 401), lalu dikonsumsi guard menjadi `?expired=1`.
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

  const refresh = useCallback(async (): Promise<void> => {
    const token = getToken();
    if (token === null) {
      setUser(null);
      setStatus('unauthenticated');
      return;
    }
    try {
      // Pakai dedupe bersama agar refresh + mount effect tidak dobel-hit.
      const me = await fetchMeDeduped();
      setUser(me);
      setStatus('authenticated');
    } catch {
      // Token sempat ada tapi getMe gagal (basi/401/jaringan): tandai sesi
      // berakhir SEBELUM clearToken agar guard bisa redirect `?expired=1`.
      // Navigasi + toast tetap tugas guard + layar login, bukan provider ini.
      markSessionExpired();
      clearToken();
      setUser(null);
      setStatus('unauthenticated');
    }
  }, []);

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
      try {
        // Dedupe bersama: mount StrictMode ganda hanya menembak 1 request.
        const me = await fetchMeDeduped();
        if (!cancelled) {
          setUser(me);
          setStatus('authenticated');
        }
      } catch {
        // Token sempat ada tapi getMe gagal: tandai expired sebelum clear.
        markSessionExpired();
        clearToken();
        if (!cancelled) {
          setUser(null);
          setStatus('unauthenticated');
        }
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string): Promise<User> => {
    try {
      const result = await login({ email, password });
      setUser(result.user);
      setStatus('authenticated');
      return result.user;
    } catch (err: unknown) {
      // Jangan lempar ApiError mentah ke UI; bungkus jadi Error biasa.
      throw new Error(toDisplayMessage(err));
    }
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    try {
      await logout();
    } finally {
      // `logout()` sudah menghapus token via fetcher; panggil lagi via
      // storage agar satu kunci kebenaran tetap ditegakkan di lapisan auth.
      // `finally` menjamin sesi lokal berakhir walau jaringan gagal.
      clearToken();
      setUser(null);
      setStatus('unauthenticated');
    }
  }, []);

  const value = useMemo<SessionValue>(
    () => ({ user, status, signIn, signOut, refresh }),
    [user, status, signIn, signOut, refresh],
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
