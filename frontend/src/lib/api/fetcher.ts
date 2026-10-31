/**
 * Transport HTTP tipis untuk REST API THC VMS.
 *
 * Hanya `fetch` bawaan browser (tanpa pustaka HTTP pihak ketiga). Semua
 * lapisan di bawah ini berjalan di browser, sehingga akses `localStorage`
 * dijaga SSR-safe.
 */

import type { UploadCategory, UploadFileResult } from '@/lib/api/types';
import { prepareUpload, type PrepareUploadOptions } from '@/lib/uploads/compressImage';

/**
 * Basis URL API. Produksi menyajikan FE + BE di satu origin (reverse proxy
 * Caddy), jadi cukup PATH dari env (`/api/v1`) — pindah IP LAN <-> domain
 * tanpa build ulang. Dev lokal tetap URL absolut karena FE (:3210) dan BE
 * (:8080) berbeda origin.
 */
export function resolveApiBase(): string {
  const configured = process.env.NEXT_PUBLIC_API_BASE_URL ?? '';
  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    const isLocalDev = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (!isLocalDev) {
      try {
        const url = new URL(configured, window.location.origin);
        // Tunnel/demo lintas-origin: bila env menunjuk backend di host lain
        // (mis. tunnel BE terpisah), pakai URL absolut itu apa adanya.
        if (url.origin !== window.location.origin) {
          return configured;
        }
        const path = url.pathname.replace(/\/+$/, '');
        return path || '/api/v1';
      } catch {
        return '/api/v1';
      }
    }
  }
  return configured;
}

const API_BASE = resolveApiBase();

const TOKEN_KEY = 'thc_vms_token';

/** Error domain dari lapisan API: selalu punya `status` + `code` untuk ditampilkan. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function getStoredToken(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return window.localStorage.getItem(TOKEN_KEY);
}

export function storeToken(token: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.removeItem(TOKEN_KEY);
}

type SuccessEnvelope = { success: true; data: unknown };
type FailureEnvelope = { success: false; error: { code: string; message: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSuccessEnvelope(value: unknown): value is SuccessEnvelope {
  return isRecord(value) && value['success'] === true;
}

function isFailureEnvelope(value: unknown): value is FailureEnvelope {
  if (!isRecord(value)) {
    return false;
  }
  const error = value['error'];
  return (
    value['success'] === false &&
    isRecord(error) &&
    typeof error['code'] === 'string' &&
    typeof error['message'] === 'string'
  );
}

/** Body kosong (204 / 200 tanpa konten) dibaca sebagai `undefined`. */
async function readJsonBody(response: Response): Promise<unknown | undefined> {
  try {
    const payload: unknown = await response.json();
    return payload;
  } catch {
    return undefined;
  }
}

function fallbackMessage(status: number): string {
  if (status === 401) {
    return 'Sesi Anda telah berakhir. Silakan masuk kembali.';
  }
  if (status === 403) {
    return 'Anda tidak memiliki izin untuk melakukan tindakan ini.';
  }
  if (status === 404) {
    return 'Data yang diminta tidak ditemukan.';
  }
  if (status === 413) {
    return 'Ukuran berkas terlalu besar. Ukuran maksimal berkas adalah 5MB.';
  }
  if (status >= 500) {
    return 'Terjadi gangguan pada server. Silakan coba beberapa saat lagi.';
  }
  return 'Permintaan gagal diproses. Silakan coba lagi.';
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  // Jangan sentuh Content-Type untuk FormData — browser yang memasang boundary multipart.
  if (init?.body !== undefined && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  const token = getStoredToken();
  if (token !== null) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch {
    // Tidak ada respons HTTP sama sekali (koneksi ditolak / DNS / offline).
    // `status: 0` + `code: 'NETWORK_ERROR'` membawa pembeda ini ke pemanggil,
    // sehingga UI bisa menampilkan pesan koneksi — BUKAN tuduhan server rusak.
    // Pesan untuk respons HTTP (401/500/dst.) di bawah TIDAK diubah.
    throw new ApiError(
      'Tidak dapat terhubung ke server. Periksa koneksi Anda.',
      0,
      'NETWORK_ERROR',
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const payload = await readJsonBody(response);

  if (payload === undefined) {
    if (response.ok) {
      return undefined as T;
    }
    throw new ApiError(fallbackMessage(response.status), response.status, 'HTTP_ERROR');
  }

  if (isFailureEnvelope(payload)) {
    throw new ApiError(payload.error.message, response.status, payload.error.code);
  }

  if (isSuccessEnvelope(payload)) {
    return payload.data as T;
  }

  if (!response.ok) {
    throw new ApiError(fallbackMessage(response.status), response.status, 'HTTP_ERROR');
  }

  throw new ApiError('Respons server tidak valid.', response.status, 'INVALID_RESPONSE');
}

export async function uploadFile(
  file: File,
  category: UploadCategory,
  options?: PrepareUploadOptions,
): Promise<UploadFileResult> {
  // Dua langkah sebelum baris byte apa pun menyentuh jaringan: validasi ingest
  // 20 MB + MIME, kompresi foto (≤1600px, JPEG q0.82), lalu validasi stored
  // 5 MB pada hasil foto — plafon stored PDF ditangguhkan ke server. Pesan
  // penolakan tetap bahasa Indonesia. `options.compress === false` melewati
  // kompresi untuk berkas yang sudah dioptimalkan pemanggil.
  const prepared = await prepareUpload(file, options);
  if (!prepared.ok) {
    throw new ApiError(prepared.message, 400, 'VALIDATION_ERROR');
  }
  const form = new FormData();
  form.append('file', prepared.file);
  form.append('category', category);
  return apiFetch<UploadFileResult>('/uploads', { method: 'POST', body: form });
}
