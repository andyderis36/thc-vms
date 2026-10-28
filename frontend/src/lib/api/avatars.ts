/**
 * Klien penyaji avatar pengguna — endpoint `GET /api/v1/avatars/:id`.
 *
 * Mengapa bukan URL storage: `user.avatar_url` hanya membawa PATH relatif
 * (`/api/v1/avatars/<uuid>?v=<hex>`) yang host-agnostik. Berkas aslinya
 * dilayani backend dengan header `Authorization`, sehingga `<img src>` biasa
 * TIDAK bisa memakainya (browser tidak mengirim token pada tag gambar).
 * Karena itu isi avatar diambil sebagai blob lalu dirender lewat object URL.
 */
import { ApiError, getStoredToken, resolveApiBase } from '@/lib/api/fetcher';

/** Prefiks path API yang dipakai backend pada `avatar_url`. */
const API_PATH_PREFIX = '/api/v1';

/**
 * Pesan galat HTTP berbahasa Indonesia untuk respons non-OK. Endpoint avatar
 * mengembalikan byte gambar, bukan amplop JSON, jadi status-lah satu-satunya
 * sumber pesan.
 */
function httpErrorMessage(status: number): string {
  if (status === 401) {
    return 'Sesi Anda telah berakhir. Silakan masuk kembali.';
  }
  if (status === 403) {
    return 'Anda tidak memiliki akses untuk melihat foto profil ini.';
  }
  if (status === 404) {
    return 'Foto profil tidak tersedia.';
  }
  if (status >= 500) {
    return 'Terjadi gangguan pada server. Silakan coba beberapa saat lagi.';
  }
  return 'Gagal memuat foto profil. Silakan coba lagi.';
}

/**
 * Petakan `avatar_url` dari API menjadi URL request yang siap di-`fetch`.
 *
 * - Path API (`/api/v1/avatars/...`) → ditempel ke `resolveApiBase()` supaya
 *   tetap satu origin dengan aplikasi (dev: `http://localhost:8080`,
 *   produksi: path relatif). Query `?v=` dipertahankan apa adanya.
 * - Nilai lain (mis. URL absolut lama) dipakai apa adanya — defensif agar
 *   data lama tidak langsung rusak.
 */
function resolveAvatarRequestUrl(avatarUrl: string): string {
  if (avatarUrl.startsWith(`${API_PATH_PREFIX}/`)) {
    return `${resolveApiBase()}${avatarUrl.slice(API_PATH_PREFIX.length)}`;
  }
  return avatarUrl;
}

/**
 * Ambil isi avatar sebagai `Blob` gambar.
 *
 * - Mengirim `Authorization: Bearer <token>` bila sesi tersimpan.
 * - Respons non-OK → `ApiError` dengan pesan Indonesia (401/403/404/5xx/other).
 * - Kegagalan jaringan → `ApiError` `NETWORK_ERROR` (status 0), bukan
 *   `TypeError` mentah "Failed to fetch".
 * - Body bukan gambar → `ApiError` `INVALID_RESPONSE`.
 *
 * @throws {ApiError} Respons gagal, jaringan gagal, atau body bukan gambar.
 */
export async function fetchAvatarBlob(avatarUrl: string): Promise<Blob> {
  const headers = new Headers();
  const token = getStoredToken();
  if (token !== null) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  let response: Response;
  try {
    response = await fetch(resolveAvatarRequestUrl(avatarUrl), { headers });
  } catch {
    throw new ApiError(
      'Gagal terhubung ke server. Periksa koneksi internet Anda.',
      0,
      'NETWORK_ERROR',
    );
  }

  if (!response.ok) {
    throw new ApiError(httpErrorMessage(response.status), response.status, 'HTTP_ERROR');
  }

  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) {
    throw new ApiError('Respons avatar tidak valid.', 200, 'INVALID_RESPONSE');
  }
  return blob;
}
