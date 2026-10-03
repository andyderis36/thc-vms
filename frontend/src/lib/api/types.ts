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
  name: string;
  id_number: string;
  phone: string;
  id_card_photo_url: string | null;
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
  pic_user: User;
  vendor_name: string;
  start_date: string;
  end_date: string;
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

export interface VisitListParams {
  status?: VisitStatus;
  location_id?: string;
  search?: string;
  page?: number;
  limit?: number;
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
