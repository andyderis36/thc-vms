/**
 * Klien penyaji berkas kunjungan — endpoint berkas backend
 * `GET /visits/{id}/file?kind=...[&visitor_id=...]`.
 *
 * Mengapa bukan presigned MinIO/S3: URL presigned menempel pada host storage
 * (mis. endpoint S3 lokal dev) sehingga rusak saat dibuka lewat tunnel/LAN/beda
 * domain. Endpoint berkas selalu lewat `API_BASE` (origin yang sama dengan
 * aplikasi), mengembalikan isi berkas (blob) — tautan/blob object tidak pernah
 * membawa host storage maupun parameter `X-Amz-*` presigned.
 */
import { ApiError, getStoredToken, resolveApiBase } from '@/lib/api/fetcher';

/** Jenis berkas yang didukung endpoint `GET /visits/{id}/file`. */
export type VisitFileKind = 'assignment_letter' | 'id_card' | 'selfie';

const API_BASE = resolveApiBase();

/** Daftar kind yang dikenal backend — kind di luar daftar → galat validasi. */
const SUPPORTED_KINDS: ReadonlySet<VisitFileKind> = new Set<VisitFileKind>([
  'assignment_letter',
  'id_card',
  'selfie',
]);

/** Kind per-teknisi yang WAJIB menyertakan `visitor_id`. */
const VISITOR_REQUIRED_KINDS: ReadonlySet<VisitFileKind> = new Set<VisitFileKind>([
  'id_card',
  'selfie',
]);

/**
 * Pesan galat HTTP berbahasa Indonesia ketika respons gagal tidak membawa
 * amplop `{ success: false, error: { message } }` (mis. XML dari storage).
 */
function httpErrorMessage(status: number): string {
  if (status === 401) {
    return 'Sesi Anda telah berakhir. Silakan masuk kembali.';
  }
  if (status === 403) {
    return 'Anda tidak memiliki akses untuk melihat berkas ini.';
  }
  if (status === 404) {
    return 'Berkas tidak tersedia.';
  }
  if (status >= 500) {
    return 'Terjadi gangguan pada server. Silakan coba beberapa saat lagi.';
  }
  return 'Gagal memuat berkas. Silakan coba lagi.';
}

/**
 * Baca pesan galat dari amplop standar `{ success: false, error: { message } }`
 * bila tersedia; selain itu jatuh ke `httpErrorMessage(status)`.
 */
async function failureMessage(response: Response): Promise<string> {
  try {
    const payload: unknown = await response.json();
    if (
      typeof payload === 'object' &&
      payload !== null &&
      (payload as { success?: unknown }).success === false
    ) {
      const error: unknown = (payload as { error?: unknown }).error;
      const message: unknown =
        typeof error === 'object' && error !== null
          ? (error as { message?: unknown }).message
          : undefined;
      if (typeof message === 'string' && message !== '') {
        return message;
      }
    }
  } catch {
    // Body bukan JSON — pakai pesan status di bawah.
  }
  return httpErrorMessage(response.status);
}

/**
 * Susun URL endpoint berkas kunjungan:
 * `${API_BASE}/visits/{visitId}/file?kind={kind}[&visitor_id={visitorId}]`.
 *
 * - `assignment_letter` (per-kunjungan): TANPA `visitor_id`.
 * - `id_card` / `selfie` (per-teknisi): `visitor_id` wajib — kosong/tidak ada
 *   → galat validasi berbahasa Indonesia.
 * - Kind di luar daftar → galat.
 *
 * @throws {Error} Kind tidak didukung, atau `visitor_id` wajib tapi tidak diisi.
 */
export function buildVisitFileUrl(
  visitId: string,
  kind: VisitFileKind,
  visitorId?: string,
): string {
  if (!SUPPORTED_KINDS.has(kind)) {
    throw new Error(`Jenis berkas tidak didukung: ${String(kind)}`);
  }

  const params = new URLSearchParams({ kind });
  if (VISITOR_REQUIRED_KINDS.has(kind)) {
    const id = visitorId?.trim() ?? '';
    if (id === '') {
      throw new Error(`Parameter visitor_id wajib diisi untuk berkas ${kind}.`);
    }
    params.set('visitor_id', id);
  }

  return `${API_BASE}/visits/${encodeURIComponent(visitId)}/file?${params.toString()}`;
}

/**
 * Ambil isi berkas kunjungan sebagai `Blob` untuk object URL lokal.
 *
 * - Mengirim `Authorization: Bearer <token>` bila sesi tersimpan — token JWT
 *   TIDAK pernah ditempel di URL.
 * - Respons gagal → `ApiError` dengan pesan Indonesia (amplop backend bila
 *   ada, selain itu `httpErrorMessage`).
 * - Kegagalan jaringan → `ApiError` `NETWORK_ERROR` (status 0) — tanpa
 *   `TypeError` mentah "Failed to fetch".
 */
export async function fetchVisitFileBlob(
  visitId: string,
  kind: VisitFileKind,
  visitorId?: string,
): Promise<Blob> {
  const url = buildVisitFileUrl(visitId, kind, visitorId);

  const headers = new Headers();
  const token = getStoredToken();
  if (token !== null) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  let response: Response;
  try {
    response = await fetch(url, { headers });
  } catch {
    throw new ApiError(
      'Gagal terhubung ke server. Periksa koneksi internet Anda.',
      0,
      'NETWORK_ERROR',
    );
  }

  if (!response.ok) {
    throw new ApiError(await failureMessage(response), response.status, 'HTTP_ERROR');
  }

  return response.blob();
}
