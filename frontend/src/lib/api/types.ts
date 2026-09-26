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
export type Role = 'super_admin' | 'admin' | 'security' | 'pic';

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
}

export interface Purpose {
  id: string;
  name: string;
}

export interface VisitorItem {
  name: string;
  id_number: string;
  phone: string;
  id_card_photo_url: string | null;
}

/**
 * Semua tanggal pada respons API adalah string ISO 8601
 * (mis. `2026-09-26T08:00:00+07:00`).
 *
 * Catatan: kolom waktu check-in dan check-out tidak ada di spesifikasi,
 * sehingga keduanya sengaja tidak dideklarasikan di sini.
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
  visitors: VisitorItem[];
  created_at: string;
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

export interface CreateVisitRequest {
  location_id: string;
  purpose_ids: string[];
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
