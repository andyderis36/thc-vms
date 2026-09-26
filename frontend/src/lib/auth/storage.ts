/**
 * Penyimpanan token JWT THC VMS — satu-satunya sumber kebenaran kunci token.
 *
 * Kunci `thc_vms_token` sama dengan yang dipakai `src/lib/api/fetcher.ts`
 * (`getStoredToken` / `storeToken` / `clearToken`). File ini adalah wajah
 * going-forward untuk lapisan auth; `fetcher.ts` sengaja tidak diubah.
 *
 * Semua akses `localStorage` dibungkus `try/catch` dan gagal diam-diam:
 * Safari private mode atau storage yang dimatikan melempar, dan komponen
 * guard tidak boleh meruntuhkan aplikasi hanya karena storage.
 */

/** Kunci JWT di `localStorage`. Harus sama dengan `TOKEN_KEY` di `fetcher.ts`. */
const TOKEN_KEY = 'thc_vms_token';

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

/** Baca JWT tersimpan. SSR-safe: kembalikan `null` di server atau saat gagal. */
export function getToken(): string | null {
  if (!isBrowser()) {
    return null;
  }
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Simpan JWT. Diam-diam no-op di server atau saat storage gagal. */
export function setToken(token: string): void {
  if (!isBrowser()) {
    return;
  }
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Abaikan: mode privat Safari / storage dimatikan tidak boleh crash app.
  }
}

/** Hapus JWT. Diam-diam no-op di server atau saat storage gagal. */
export function clearToken(): void {
  if (!isBrowser()) {
    return;
  }
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Abaikan: lihat `setToken`.
  }
}
