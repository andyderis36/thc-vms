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

/**
 * Peran pengguna (RBAC multi-cabang). `dev-superadmin` adalah peran tertinggi
 * yang tersembunyi: lolos semua gate `super_admin`, tetapi tak pernah
 * dirender sebagai opsi peran dan tak pernah muncul di daftar user.
 */
export type Role = 'super_admin' | 'dev-superadmin' | 'admin' | 'security' | 'vendor';

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
  /**
   * Daftar cabang/POP penugasan (1-to-many branch scoping, model hibrida,
   * accept-either/return-both dengan `location_id`); `location_id` tetap
   * primer selamanya sebagai display-default/elemen pertama.
   */
  location_ids?: string[];
  location_name: string | null;
  status: 'active' | 'inactive' | 'pending' | 'blacklisted';
  type: 'internal' | 'external';
  vendor_name: string | null;
  /**
   * URL presigned berumur pendek untuk foto profil (di-resolve ulang pada
   * setiap respons; URL bucket mentah tidak pernah diekspos). `null` bila
   * belum ada foto. Jangan disimpan di luar cache respons — selalu ambil dari
   * `/auth/me` (atau respons update) karena URL kedaluwarsa.
   */
  avatar_url: string | null;
  /**
   * Field yang boleh diubah sendiri oleh pemanggil, dihitung dari peran.
   * Hanya dijamin ada pada respons `/auth/me` (dan `PATCH /auth/me`), sehingga
   * opsional untuk payload user lain (mis. `vendor_user` kunjungan).
   */
  editable_fields?: string[];
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
  /**
   * Daftar cabang/POP penugasan (accept-either dengan `location_id`);
   * `location_id` tetap primer sebagai display-default/elemen pertama.
   */
  location_ids?: string[];
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
  /**
   * Daftar cabang/POP penugasan (accept-either dengan `location_id`,
   * absen = biarkan); `location_id` tetap primer sebagai
   * display-default/elemen pertama.
   */
  location_ids?: string[];
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
 * Dropdown relasi Vendor/Mitra pada modal create/edit akun terkelola.
 */
export interface Vendor {
  id: string;
  name: string;
}

/**
 * Akun vendor aktif pada `GET /users/vendors` — dipakai pemilih pemilik
 * kunjungan (admin/super_admin) pada SCR-03. `company` = nama perusahaan
 * akun (null bila belum diisi).
 */
export interface VendorAccount {
  id: string;
  name: string;
  email: string;
  company: string | null;
}

/**
 * `GET /jabatan` → daftar nilai `jabatan` yang PERNAH tersimpan pada baris
 * visitor (distinct, urut A-Z, maksimal 50 entri; bisa kosong `[]`).
 * HANYA saran untuk `<datalist>` — pengguna tetap bebas mengetik jabatan baru.
 */
export type JabatanList = string[];

/** Sumber nama pada saran identitas vendor; prioritas master > account > history. */
export type VendorSuggestionSource = 'master' | 'account' | 'history';

/**
 * `GET /vendors/suggestions` → satu nama vendor terdedupe.
 * `name` memakai casing sumber pemenang; `source` menandai asal nama itu.
 * Endpoint read-only: mengetik nama baru tidak pernah menulis data master.
 */
export interface VendorSuggestion {
  name: string;
  source: VendorSuggestionSource;
}

/**
 * `GET /visits/member-suggestions` → anggota roster lama untuk dipakai ulang,
 * distinct per (nama case-insensitive, telepon) dengan kunjungan terbaru
 * menang, maksimal 20 entri. SENGAJA tanpa URL foto; tautan foto hanya ada
 * pada `MemberSuggestionDetail`.
 */
export interface MemberSuggestion {
  /**
   * ID baris visitor pemenang dedupe — langsung dipakai untuk
   * `GET /visits/member-suggestions/{visitorId}` tanpa resolusi kunjungan.
   */
  visitor_id: string;
  name: string;
  id_number: string;
  phone: string;
  email: string | null;
  jabatan: string | null;
  /** RFC3339 - waktu mulai kunjungan terbaru anggota ini. */
  last_visit_at: string;
  source_visit_id: string;
}

/**
 * `GET /visits/member-suggestions/{visitorId}` → satu anggota pilihan dengan
 * tautan foto presigned berumur pendek untuk autofill. Visitor tidak dikenal
 * atau di luar cakupan dijawab 404.
 */
export interface MemberSuggestionDetail {
  name: string;
  id_number: string;
  phone: string;
  email: string | null;
  jabatan: string | null;
  /**
   * Perusahaan milik anggota sendiri (override > katalog), BUKAN Vendor
   * Pengaju kunjungan. Null/kosong = baris formulir tidak diubah.
   */
  vendor_name: string | null;
  id_card_photo_url: string | null;
  photo_url: string | null;
  source_visit_id: string;
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
  /**
   * Jabatan/peran pengunjung di lokasi (mis. Teknisi, Mandor, Supervisor) —
   * teks bebas ≤120 karakter. Absen/null = belum diisi. Saran isian berasal
   * dari `GET /jabatan`; nilainya TIDAK divalidasi terhadap daftar itu.
   */
  jabatan?: string | null;
  /**
   * Email kontak anggota (opsional, maks 254 karakter setelah trim) —
   * kontrak `VisitorItem.email` pada `docs/4. openapi.yaml`. Absen/null =
   * tidak ada; kosong diperlakukan sebagai absen (field tidak dikirim).
   */
  email?: string | null;
  /**
   * Penanda baris kontak anggota yang pernah diubah pembuat kunjungan via
   * `PATCH /visits/{id}/visitors/{visitorId}`. Absen = belum pernah diubah.
   */
  phone_edited?: boolean;
}

/**
 * `PATCH /visits/{id}/visitors/{visitorId}` — hanya nomor telepon yang dapat
 * dikoreksi pembuat sebelum persetujuan (requested/rescheduled).
 */
export interface UpdateVisitorContactRequest {
  phone: string;
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
  status_note?: string | null;
  visitors: VisitorItem[];
  created_at: string;
  check_in_at?: string | null;
  check_out_at?: string | null;
  checked_in_by?: string | null;
  /**
   * Nama tampilan pengaju kunjungan (`visit_request.created_by` JOIN users)
   * — baris "Diajukan oleh". Absen bila akun pengaju tidak dikenal atau
   * kunjungan ditulis sebelum kolom created_by ada.
   */
  created_by_name?: string | null;
  /** Label peran Bahasa Indonesia pengaju — hanya bersama `created_by_name`. */
  created_by_role_label?: string | null;
  /** Nama petugas pelaksana check-in (JOIN users); absen sebelum check-in. */
  checked_in_by_name?: string | null;
  /** Nama petugas pelaksana check-out (JOIN users); absen sebelum check-out. */
  checked_out_by_name?: string | null;
  /**
   * Jejak perubahan status dengan pelaku, urut tertua -> terbaru (maksimal
   * 50 baris terbaru) — kontrak `VisitDetail.history` pada
   * `docs/4. openapi.yaml`. Diisi HANYA oleh `GET /visits/{id}`; absen pada
   * item daftar, di mana timeline memakai langkah turunan sebagai fallback.
   */
  history?: VisitHistoryEntry[];
  /**
   * Bukti pengerjaan sebelum/sesudah (`visit_work_photo`) — kontrak
   * `VisitDetail.work_photos` pada `docs/4. openapi.yaml`. Diisi HANYA oleh
   * `GET /visits/{id}`; tiap slot `null` hingga dilampirkan via
   * `POST /visits/{id}/work-photos`. Absen pada item daftar dan echo create.
   */
  work_photos?: {
    before: WorkPhoto | null;
    after: WorkPhoto | null;
  };
}

/**
 * Satu baris `VisitDetail.history` — status_history dengan pelaku sudah
 * dinamai. `actor_name` / `actor_role_label` null untuk transisi sistem
 * (aturan otomatis worker), sehingga timeline menghilangkan klause "oleh".
 */
export interface VisitHistoryEntry {
  status: VisitStatus;
  /** RFC3339 waktu transisi (`status_history.changed_at`). */
  at: string;
  actor_name: string | null;
  actor_role_label: string | null;
}

/**
 * Satu slot bukti pengerjaan kunjungan (`before` = kondisi sebelum mulai,
 * `after` = kondisi sesudah selesai) — kontrak `WorkPhoto` pada
 * `docs/4. openapi.yaml`.
 */
export interface WorkPhoto {
  /** Slot bukti; hanya pada respons `POST /visits/{id}/work-photos`. */
  kind?: 'before' | 'after';
  /**
   * URL presigned berumur pendek (detail) atau URL tersimpan (echo lampir).
   * `null` bila tautan tidak tersedia — jangan disimpan di luar cache respons.
   */
  url: string | null;
  /** ID akun pengunggah; `null` bila akun sudah dihapus. */
  uploaded_by?: string | null;
  /** Nama tampilan pengunggah; `null` bila tidak dikenal. */
  uploaded_by_name?: string | null;
  /** RFC3339 waktu lampiran tersimpan (diperbarui setiap penggantian). */
  uploaded_at: string;
}

/**
 * `POST /visits/{id}/work-photos` — lampirkan satu bukti pengerjaan.
 * Lampiran pertama menjawab 201, lampiran ulang pada slot yang sama
 * MENGGANTIKAN baris (menjawab 200).
 */
export interface AttachWorkPhotoRequest {
  kind: 'before' | 'after';
  url: string;
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

/**
 * `POST /auth/register` — pendaftaran Vendor/Mitra mandiri (publik, tanpa
 * auth). Tanpa `role`/`location_id`: keduanya diturunkan server (vendor,
 * tanpa cabang). Akun baru selalu `inactive` dan menunggu persetujuan
 * superadmin; ikuti aturan vendor-wins yang sama (`vendor_id` menang bila
 * keduanya ada, nama manual tidak masuk katalog).
 */
export interface RegisterVendorRequest {
  name: string;
  email: string;
  password: string;
  phone?: string;
  /** NIK KTP tepat 16 digit angka (wajib untuk vendor). */
  nik: string;
  vendor_id?: string;
  /** Nama perusahaan vendor ketikan manual (≤120). */
  vendor_name?: string;
}

export interface CreateSecurityUserRequest {
  name: string;
  email: string;
  phone?: string;
  password: string;
  location_id?: string;
}

export interface UpdateUserStatusRequest {
  status: 'active' | 'inactive' | 'pending';
}

/**
 * `PATCH /users/security/:id` — admin cabang terkunci + superadmin.
 * Parsial seperti managed; `location_id` memindahkan akun ke cabang lain
 * (absen/null = biarkan cabang saat ini) dan HANYA superadmin yang boleh
 * mengirimnya — admin cabang yang mengirimnya mendapat 403.
 */
export interface UpdateSecurityUserRequest {
  name?: string;
  email?: string;
  phone?: string | null;
  password?: string;
  /**
   * Cabang penugasan baru (mutasi lokasi). Absen/null = biarkan cabang
   * saat ini; terisi = pindah ke cabang itu (superadmin saja).
   */
  location_id?: string | null;
}

/**
 * `PATCH /auth/me` — profil sendiri. `phone` & `avatar_url` untuk semua peran;
 * `name` hanya diterima untuk `super_admin` (peran lain dijawab 403 FORBIDDEN).
 * `new_password` bersama `current_password` memutar kata sandi sendiri untuk
 * semua peran (termasuk `super_admin` dan `dev-superadmin` lewat jalur yang
 * sama). Kunci `password` lama dan field lain ditolak backend 400
 * VALIDATION_ERROR.
 */
export interface UpdateSelfProfileRequest {
  name?: string;
  phone?: string;
  /** `null` menghapus avatar. */
  avatar_url?: string | null;
  /** Kata sandi baru pengganti milik sendiri; wajib disertai `current_password`. */
  new_password?: string;
  /** Bukti kata sandi saat ini (wajib bila `new_password` dikirim). */
  current_password?: string;
}

/**
 * `POST /auth/email-change/request` — minta tautan verifikasi ganti email
 * (publik, dibatasi rate limiter). Respons selalu generik 202 agar tidak
 * membocorkan apakah email sudah terdaftar.
 */
export interface EmailChangeRequest {
  new_email: string;
  current_password: string;
}

/** `POST /auth/email-change/request` → 202 generik `{ success, data: { message } }`. */
export interface EmailChangeRequestResult {
  message: string;
}

/**
 * `POST /auth/email-change/confirm` — tukar token verifikasi menjadi email
 * baru (wajib auth, respons `User`). Token tidak valid/kedaluwarsa dijawab
 * 400 INVALID_TOKEN "Tautan tidak valid atau kedaluwarsa.".
 */
export interface EmailChangeConfirmRequest {
  token: string;
}

export interface CreateVisitRequest {
  location_id: string;
  /**
   * ID akun vendor PEMILIK kunjungan (opsional). Hanya dihormati untuk
   * admin/superadmin; vendor hanya boleh mengirim akunnya sendiri (ID lain
   * ditolak 403). Akun target wajib vendor aktif. Absen = akun pemanggil.
   */
  vendor_user_id?: string;
  /**
   * Nama vendor/mitra per kunjungan yang diketik manual (≤120, maks trim).
   * Hanya bermakna untuk pengajuan admin/superadmin; vendor tetap memakai
   * nama perusahaan per anggota. Absen/kosong = tanpa perusahaan kunjungan.
   */
  vendor_name?: string;
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

export type UploadCategory = 'assignment_letter' | 'id_card' | 'checkin_photo' | 'profile_photo' | 'work_photos';

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
  /** Nilai filter efektif yang dipakai backend (setelah normalisasi/clamp). */
  offset?: number;
  q?: string;
  order?: 'asc' | 'desc';
}

/** Query `GET /audit-logs`; semua opsional sesuai kontrak openapi. */
export interface AuditLogListParams {
  user_id?: string;
  entity?: string;
  action?: string;
  /** `YYYY-MM-DD` atau RFC3339; backend memakai batas atas +24h untuk date-only. */
  date_from?: string;
  date_to?: string;
  /** Pencarian bebas atas aksi, entitas, ID entitas, IP, user-agent, dan pelaku. */
  q?: string;
  /** Arah urutan waktu; default server `desc`. */
  order?: 'asc' | 'desc';
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
  | 'visit_auto_cancelled'
  | 'visit_cancelled';

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

/**
 * `GET /notifications/pending-registrations` — antre pendaftaran vendor
 * menunggu persetujuan (superadmin saja; 403 untuk role lain). Bentuk dibekukan
 * pada `docs/4. openapi.yaml` (`PendingRegistrationItem` /
 * `PendingRegistrationListResponse`) — jangan diubah di sini.
 */
export type PendingRegistrationStatus = 'pending' | 'approved' | 'rejected';

export interface PendingRegistrationItem {
  vendor_user_id: string;
  name: string;
  email: string;
  phone: string;
  nik: string;
  vendor_name: string;
  /** RFC3339 waktu pendaftaran. */
  created_at: string;
  status: PendingRegistrationStatus;
}

export interface PendingRegistrationListResult {
  items: PendingRegistrationItem[];
  total: number;
  /** Jumlah belum diproses (agregat server) — sumber angka badge lonceng. */
  pending_count: number;
  page: number;
  limit: number;
}

/** Query `GET /notifications/pending-registrations`; hanya `page`/`limit`. */
export interface PendingRegistrationListParams {
  page?: number;
  limit?: number;
}
