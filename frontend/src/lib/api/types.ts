/**
 * Kontrak tipe REST API THC VMS.
 *
 * Ditranskripsi persis dari `docs/4. openapi.yaml` (OpenAPI 3.1.0).
 * Larangan: jangan menambah field yang tidak ada di spesifikasi.
 */

/** Amplop respons sukses: `{ "success": true, "data": ... }` */
export type ApiSuccess<T> = {
  success: true;
  data: T;
};

/** Amplop respons gagal: `{ "success": false, "error": { "code", "message" } }` */
export type ApiFailure = {
  success: false;
  error: { code: string; message: string };
};

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

/** Peran pengguna (RBAC multi-cabang). */
export type Role = 'super_admin' | 'admin' | 'security' | 'vendor';

/** Siklus hidup kunjungan. */
export type VisitStatus =
  | 'requested'
  | 'approved'
  | 'visiting'
  | 'completed'
  | 'not_visit'
  | 'rejected'
  | 'cancelled'
  | 'rescheduled';

export interface User {
  id: string;
  name: string;
  email: string;
  phone: string;
  /**
   * NIK KTP 16 digit (`users.nik TEXT NULL UNIQUE`).
   * Wajib terisi untuk `admin` & `vendor`; `null` untuk
   * `security` & `super_admin` (BE menolak NIK untuk keduanya).
   */
  nik: string | null;
  role: Role;
  location_id: string | null;
  location_name: string | null;
  status: 'active' | 'inactive' | 'blacklisted';
  type: 'internal' | 'external';
  vendor_name: string | null;
}

export interface Location {
  id: string;
  name: string;
  type: 'pusat' | 'cabang' | 'pop' | 'minipop';
  address: string;
  city: string;
  timezone: 'WIB' | 'WITA' | 'WIT';
  /**
   * Status aktif fasilitas (dikelola via `PATCH /locations/:id`).
   * Opsional agar payload lama/seed tanpa field ini tetap valid —
   * absen dimaknai aktif (lihat `isLocationActive` di layar fasilitas).
   */
  is_active?: boolean;
}

/** `POST /locations` — super_admin saja (kontrak §2). */
export interface CreateLocationRequest {
  name: string;
  type: Location['type'];
  address?: string;
  city?: string;
  timezone?: Location['timezone'];
}

/** `PATCH /locations/:id` — parsial + toggle `is_active` (kontrak §2). */
export interface UpdateLocationRequest {
  name?: string;
  type?: Location['type'];
  address?: string;
  city?: string;
  timezone?: Location['timezone'];
  is_active?: boolean;
}

/** Peran yang boleh dibuat via `POST /users` (kontrak §2). */
export type ManagedUserRole = 'admin' | 'vendor';

/** `GET /users?role&search&location_id` — super_admin saja (kontrak §2). */
export interface ManagedUserListParams {
  role?: string;
  search?: string;
  location_id?: string;
}

/** `POST /users` — super_admin saja (kontrak §2). */
export interface CreateManagedUserRequest {
  name: string;
  email: string;
  password: string;
  phone?: string;
  /**
   * NIK KTP 16 digit angka. Wajib iff `role` adalah `admin`/`vendor`
   * (BE: 400 bila absen atau format salah).
   */
  nik?: string;
  role: ManagedUserRole;
  location_id?: string;
  vendor_id?: string;
  /**
   * Nama vendor manual (≤120) — dikirim bila nama tidak berasal dari katalog.
   * Absen = tanpa vendor. (`vendor_id` menang bila keduanya ada.)
   */
  vendor_name?: string;
}

/**
 * `PATCH /users/:id` — super_admin saja. Semua member opsional (absen =
 * biarkan kolom); role/type/status/password tak punya member dan tak bisa
 * berubah di sini. `location_id`/`vendor_id` null = biarkan (pengosongan
 * tak didukung — sesuai aturan trigger per peran); phone kosong dibersihkan.
 */
export interface UpdateManagedUserRequest {
  name?: string;
  email?: string;
  phone?: string | null;
  /**
   * NIK KTP 16 digit angka. Wajib & tak boleh dikosongkan untuk target
   * `admin`/`vendor`; ditolak (400) bila target `security`/`super_admin`.
   * Absen = biarkan kolom.
   */
  nik?: string | null;
  location_id?: string | null;
  vendor_id?: string | null;
  /**
   * Nama vendor manual (≤120). String kosong = bersihkan vendor;
   * absen (field tak dikirim) = biarkan kolom apa adanya.
   */
  vendor_name?: string | null;
  password?: string;
  /** Bukti reset password akun sendiri (wajib bila password diisi untuk diri sendiri). */
  current_password?: string;
}

export interface Purpose {
  id: string;
  name: string;
}

/**
 * Vendor mitra (`GET /vendors` → `[{id, name}]`).
 * Dropdown relasi Vendor/Mitra pada modal create/edit `/users`.
 */
export interface Vendor {
  id: string;
  name: string;
}

export interface VisitorItem {
  /**
   * ID baris visitor (UUID) — diisi pada respons baca; absen (undefined) pada
   * echo create. Satu-satunya nilai sah untuk `visitor_id` pada endpoint
   * berkas; jangan pernah mengirim `id_number` ke sana (400).
   */
  id?: string;
  name: string;
  id_number: string;
  phone: string;
  /**
   * URL presigned MinIO/S3 (opaque, berumur pendek). Saat konteks kunjungan
   * (`visit_id`) tersedia, lebih disukai lewat endpoint berkas
   * `GET /visits/{id}/file?kind=id_card` (`src/lib/api/files.ts`) — tahan lintas host.
   */
  id_card_photo_url: string | null;
  /**
   * URL presigned MinIO/S3 (opaque, berumur pendek). Saat konteks kunjungan
   * (`visit_id`) tersedia, lebih disukai lewat endpoint berkas
   * `GET /visits/{id}/file?kind=selfie` (`src/lib/api/files.ts`) — tahan lintas host.
   */
  photo_url?: string | null;
  vendor_id?: string | null;
  vendor_name?: string | null;
}

/**
 * Semua tanggal pada respons API adalah string ISO 8601
 * (mis. `2026-09-26T08:00:00+07:00`).
 *
 * Waktu gerbang (`check_in_at` / `check_out_at` / `checked_in_by`) diisi
 * HANYA oleh GET /visits/{id} untuk kunjungan yang sudah melewati gerbang
 * (status visiting/completed); null (atau absen) untuk
 * requested/approved dan untuk setiap item daftar (daftar tidak di-enrich
 * agar tetap murah — lihat usecase/visit/detail.go).
 */
export interface VisitDetail {
  id: string;
  visit_id: string;
  status: VisitStatus;
  location: Location;
  purposes: Purpose[];
  vendor_user: User;
  /**
   * @deprecated Alias lama — hanya dipertahankan selama transisi Fase 1 dan
   * akan dihapus setelah semua klien membaca `vendor_user`.
   */
  pic_user?: User;
  vendor_name: string;
  start_date: string;
  end_date: string;
  /**
   * URL presigned MinIO/S3 (opaque, berumur pendek). Karena `id` kunjungan
   * tersedia di type ini, lebih disukai lewat endpoint berkas
   * `GET /visits/{id}/file?kind=assignment_letter` (`src/lib/api/files.ts`).
   */
  assignment_letter_url: string | null;
  notes: string | null;
  /** "Tujuan lain" (teks bebas ≤200) — null/kosong bila tak diisi. */
  purpose_note?: string | null;
  visitors: VisitorItem[];
  created_at: string;
  check_in_at?: string | null;
  check_out_at?: string | null;
  checked_in_by?: string | null;
}

export interface VisitListResult {
  items: VisitDetail[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Pasangan urutan `GET /visits` (openapi §/visits): `?sort_by=` & `?order=`.
 * Kosakata tertutup — nilai di luar daftar ditolak backend 400
 * VALIDATION_ERROR, jadi hanya boleh dikirim tepat salah satu nilai ini.
 */
export type VisitSortField = 'created_at' | 'start_date' | 'end_date'

/** Arah urutan `GET /visits` (`?order=`) — default backend `desc`. */
export type VisitOrder = 'asc' | 'desc'

/**
 * Query `GET /visits` — semua opsional sesuai kontrak openapi §/visits.
 *
 * Pemetaan ke query string (lihat `listVisits` pada `client.ts`):
 * - `q` — pencarian bebas ILIKE nama vendor atau Visit ID.
 * - `date_from` / `date_to` — jendela jadwal `start_date` (`YYYY-MM-DD`
 *   atau RFC3339; rentang terbalik ditolak backend 400).
 * - `page` / `limit` — default backend 1 / 10 (opsi 10/20/50/100).
 * - `sort_by` / `order` — default backend `created_at` desc.
 *
 * Seluruh objek params ikut menjadi kunci TanStack Query
 * (`queryKeys.visits.list`), sehingga setiap perubahan filter menghasilkan
 * kunci baru dan memicu refetch otomatis.
 */
export interface VisitListParams {
  status?: VisitStatus
  location_id?: string
  /** `?q=` — kosong/absen = tanpa filter pencarian. */
  q?: string
  /** `?date_from=` — batas bawah jadwal (inklusif). */
  date_from?: string
  /** `?date_to=` — batas atas jadwal (date-only inklusif sehari penuh). */
  date_to?: string
  page?: number
  limit?: number
  sort_by?: VisitSortField
  order?: VisitOrder
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResult {
  token: string;
  user: User;
}

export interface CreateSecurityUserRequest {
  name: string;
  email: string;
  phone?: string;
  password: string;
  location_id?: string;
}

export interface UpdateUserStatusRequest {
  status: 'active' | 'inactive';
}

/**
 * `PATCH /users/security/:id` — admin cabang terkunci + superadmin.
 * Parsial seperti managed; lokasi tak punya member (pindah cabang lewat
 * konsol superadmin).
 */
export interface UpdateSecurityUserRequest {
  name?: string;
  email?: string;
  phone?: string | null;
  password?: string;
}

export interface CreateVisitRequest {
  location_id: string;
  purpose_ids: string[];
  /** "Tujuan lain" (≤200) — boleh terisi walau `purpose_ids` kosong. */
  purpose_note?: string | null;
  start_date: string;
  end_date: string;
  is_multi_day?: boolean;
  assignment_letter_url?: string;
  is_nda_accepted: boolean;
  notes?: string;
  visitors: VisitorItem[];
}

export interface UploadFileResult {
  file_url: string;
  file_name: string;
  file_size: number;
  mime_type: string;
}

export type UploadCategory = 'assignment_letter' | 'id_card' | 'checkin_photo';

export interface QrPayload {
  visit_id: string;
  qr_code_payload: string;
}

export interface RescheduleRequest {
  start_date: string;
  end_date: string;
  reason: string;
}

export interface RejectRequest {
  reason: string;
}

export interface CancelRequest {
  reason?: string;
}

export interface ApproveRequest {
  notes?: string;
}

export interface CheckInRequest {
  photo_url?: string;
  badge_code?: string;
  notes?: string;
}

/**
 * `GET /audit-logs` — baris jejak audit lintas cabang (super_admin saja).
 * Kontrak mengikuti skema `AuditLog` pada `docs/4. openapi.yaml` §475.
 */
export interface AuditLog {
  id: string;
  /** Pelaku aksi; `null` untuk baris sistem (mis. login gagal tanpa sesi). */
  user_id: string | null;
  /** Kode aksi tertutup domain (`auth.login.success`, `user.create`, …). */
  action: string;
  entity: string;
  entity_id: string | null;
  timestamp: string;
  ip: string;
  user_agent: string;
  metadata: Record<string, string>;
}

export interface AuditLogListResult {
  items: AuditLog[];
  total: number;
  page: number;
  limit: number;
}

/** Query `GET /audit-logs`; semua opsional sesuai kontrak openapi. */
export interface AuditLogListParams {
  user_id?: string;
  entity?: string;
  action?: string;
  /** `YYYY-MM-DD` atau RFC3339; backend memakai batas atas +24h untuk date-only. */
  date_from?: string;
  date_to?: string;
  page?: number;
  limit?: number;
}

/**
 * `GET /notifications` — notifikasi per-pengguna (read/unread) untuk lonceng
 * header. Tersedia untuk semua peran termasuk vendor; data di-scope ke auth.ID
 * caller. `unread_count` = jumlah belum dibaca secara global untuk pengguna
 * (tidak terpengaruh filter `location_id`); `total` = baris setelah filter.
 */
export type NotificationType =
  | 'visit_requested'
  | 'visit_rescheduled'
  | 'visit_check_in'
  | 'visit_check_out'
  | 'visit_approved'
  | 'visit_rejected'
  | 'visit_reminder'
  | 'visit_auto_cancelled';

export interface NotificationItem {
  id: string;
  type: NotificationType;
  /** Kunjungan terkait — dipakai untuk deep-link ke `/visits/{id}`. */
  visit_request_id: string;
  /** Kode tiket manusiawi (mis. `VST-…`). */
  visit_id: string;
  location_id: string;
  location_name: string;
  /** Judul notifikasi (dari template domain). */
  title: string;
  /** Isi pesan notifikasi (dari template domain). */
  message: string;
  /** Tandai telah dibaca. */
  is_read: boolean;
  /** RFC3339 waktu peristiwa. */
  occurred_at: string;
}

export interface NotificationListResult {
  items: NotificationItem[];
  total: number;
  unread_count: number;
  page: number;
  limit: number;
}

/** Query `GET /notifications`; `location_id` hanya bermakna untuk super_admin. */
export interface NotificationListParams {
  page?: number;
  limit?: number;
  location_id?: string;
}
