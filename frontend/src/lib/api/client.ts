/**
 * Klien REST THC VMS — satu fungsi bertipe per endpoint MVP.
 *
 * Transport murni: tanpa React, tanpa TanStack Query. Lapisan hook terpisah
 * di folder features yang akan memakai fungsi-fungsi ini.
 */

import { apiFetch, clearToken, storeToken } from '@/lib/api/fetcher';
import type {
  ApproveRequest,
  AuditLogListParams,
  AuditLogListResult,
  CancelRequest,
  CheckInRequest,
  CreateLocationRequest,
  CreateManagedUserRequest,
  CreateSecurityUserRequest,
  CreateVisitRequest,
  EmailChangeConfirmRequest,
  EmailChangeRequest,
  EmailChangeRequestResult,
  JabatanList,
  Location,
  LoginRequest,
  LoginResult,
  ManagedUserListParams,
  MemberSuggestion,
  MemberSuggestionDetail,
  NotificationListParams,
  NotificationListResult,
  NotificationSettingsMatrix,
  NotificationToggle,
  PendingRegistrationListParams,
  PendingRegistrationListResult,
  Purpose,
  QrPayload,
  RegisterVendorRequest,
  RejectRequest,
  RescheduleRequest,
  UpdateLocationRequest,
  UpdateManagedUserRequest,
  UpdateSecurityUserRequest,
  UpdateSelfProfileRequest,
  UpdateUserStatusRequest,
  UpdateVisitorContactRequest,
  User,
  Vendor,
  VendorAccount,
  VendorSuggestion,
  VisitDetail,
  VisitListParams,
  VisitListResult,
  VisitorItem,
} from '@/lib/api/types';

/** `POST /uploads` — tetap di sini agar endpoint Storage punya satu penutup bertipe. */
export { uploadFile } from '@/lib/api/fetcher';

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function login(body: LoginRequest): Promise<LoginResult> {
  const result = await apiFetch<LoginResult>('/auth/login', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  storeToken(result.token);
  return result;
}

export function getMe(): Promise<User> {
  return apiFetch<User>('/auth/me');
}

/** `PATCH /auth/me` — perbarui profil sendiri; respons membawa `avatar_url` presigned terbaru. */
export function updateMe(body: UpdateSelfProfileRequest): Promise<User> {
  return apiFetch<User>('/auth/me', { method: 'PATCH', body: JSON.stringify(body) });
}

export async function logout(): Promise<void> {
  try {
    await apiFetch<void>('/auth/logout', { method: 'POST' });
  } finally {
    clearToken();
  }
}

/**
 * `POST /auth/register` — pendaftaran Vendor/Mitra mandiri (publik).
 * SENGAJA tanpa `storeToken`: akun baru berstatus inactive dan tidak
 * langsung masuk — layar sukses bersifat netral ("menunggu persetujuan").
 */
export function registerVendor(body: RegisterVendorRequest): Promise<User> {
  return apiFetch<User>('/auth/register', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * `POST /auth/email-change/request` — minta tautan verifikasi ganti email
 * mandiri. Wajib membawa `current_password` sebagai bukti anti-pengambilalihan;
 * respons selalu 202 generik `{ message }` agar tidak membocorkan apakah
 * email sudah terdaftar. Tautan dikirim ke alamat BARU.
 */
export function requestEmailChange(body: EmailChangeRequest): Promise<EmailChangeRequestResult> {
  return apiFetch<EmailChangeRequestResult>('/auth/email-change/request', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * `POST /auth/email-change/confirm` — tukar token verifikasi menjadi email
 * baru (wajib auth; respons `User`). Token tidak valid/kedaluwarsa dijawab
 * 400 INVALID_TOKEN dengan pesan generik — pemanggil wajib memperlakukan
 * semua galat secara generik.
 */
export function confirmEmailChange(body: EmailChangeConfirmRequest): Promise<User> {
  return apiFetch<User>('/auth/email-change/confirm', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Master Data
// ---------------------------------------------------------------------------

export function listLocations(activeOnly?: boolean): Promise<Location[]> {
  // Default/true → katalog aktif (kompatibel mundur untuk form pengajuan);
  // false eksplisit → semua baris untuk halaman admin (agar nonaktif bisa diaktifkan lagi).
  const search = activeOnly === false ? '?active_only=false' : '';
  return apiFetch<Location[]>(`/locations${search}`);
}

export function listPurposes(): Promise<Purpose[]> {
  return apiFetch<Purpose[]>('/purposes');
}

/**
 * `GET /vendors` → `[{id, name}]` — katalog vendor mitra untuk dropdown
 * relasi Vendor/Mitra (kontrak BE; master data seperti locations/purposes).
 */
export function listVendors(): Promise<Vendor[]> {
  return apiFetch<Vendor[]>('/vendors');
}

/**
 * `GET /public/vendors` → katalog vendor aktif TANPA auth — dipakai layar
 * pendaftaran mandiri (tanpa sesi, jadi `/vendors` akan 401).
 */
export function listPublicVendors(): Promise<Vendor[]> {
  return apiFetch<Vendor[]>('/public/vendors');
}

/**
 * `GET /users/vendors` → akun vendor AKTIF `{id, name, email, company}`
 * (admin/super_admin saja) untuk pemilih pemilik kunjungan.
 */
export function listVendorAccounts(): Promise<VendorAccount[]> {
  return apiFetch<VendorAccount[]>('/users/vendors');
}

/**
 * `GET /jabatan` → `["Mandor", "Teknisi"]` — nilai jabatan yang pernah
 * tersimpan pada baris visitor (distinct, A-Z, maks 50; bisa kosong `[]`).
 * HANYA saran isian: pengguna tetap bebas mengetik jabatan baru.
 */
export function listJabatan(): Promise<JabatanList> {
  return apiFetch<JabatanList>('/jabatan');
}

// ---------------------------------------------------------------------------
// Saran isian (feed read-only untuk <datalist> SCR-03)
// ---------------------------------------------------------------------------

/**
 * `GET /vendors/suggestions` → nama vendor terdedupe (master > account >
 * history, maks 50). `q` = filter prefix ≤80 karakter (dikirim apa adanya;
 * memanggil yang menclamp bertanggung jawab atas batas itu — lihat
 * `clampSuggestionQuery`). `q` kosong = seluruh feed. Role gate + scope cabang
 * hidup di backend (403 untuk vendor/security).
 */
export function listVendorSuggestions(q = ''): Promise<VendorSuggestion[]> {
  const query = new URLSearchParams();
  if (q !== '') query.set('q', q);
  const search = query.toString();
  return apiFetch<VendorSuggestion[]>(
    search === '' ? '/vendors/suggestions' : `/vendors/suggestions?${search}`,
  );
}

/**
 * `GET /visits/member-suggestions` → roster anggota lama untuk dipakai ulang
 * (maks 20, TANPA URL foto). `q` = filter nama ≤80 karakter; `vendor` = nama
 * tampilan untuk menyempitkan hasil (admin/super_admin; diabaikan backend
 * untuk peran vendor). Keduanya dikirim hanya bila terisi.
 */
export function listMemberSuggestions(
  params: { q?: string; vendor?: string } = {},
): Promise<MemberSuggestion[]> {
  const query = new URLSearchParams();
  if (params.q !== undefined && params.q !== '') query.set('q', params.q);
  if (params.vendor !== undefined && params.vendor !== '')
    query.set('vendor', params.vendor);
  const search = query.toString();
  return apiFetch<MemberSuggestion[]>(
    search === '' ? '/visits/member-suggestions' : `/visits/member-suggestions?${search}`,
  );
}

/**
 * `GET /visits/member-suggestions/{visitorId}` → satu anggota pilihan dengan
 * tautan foto presigned (404 untuk id tak dikenal/luar cakupan — tidak
 * pernah diretry oleh lapisan hook).
 */
export function getMemberSuggestion(visitorId: string): Promise<MemberSuggestionDetail> {
  return apiFetch<MemberSuggestionDetail>(
    `/visits/member-suggestions/${encodeURIComponent(visitorId)}`,
  );
}

// ---------------------------------------------------------------------------
// Visits
// ---------------------------------------------------------------------------

/**
 * `GET /visits` — seluruh query param kontrak (openapi §/visits) diteruskan
 * apa adanya; string kosong dibuang sehingga filter kosong tidak pernah
 * menghasilkan `?q=`/`?date_from=`/dst. yang ikut memecah kunci cache.
 */
export function listVisits(params: VisitListParams = {}): Promise<VisitListResult> {
  const query = new URLSearchParams();
  if (params.status !== undefined) query.set('status', params.status);
  if (params.location_id !== undefined && params.location_id !== '') query.set('location_id', params.location_id);
  if (params.q !== undefined && params.q !== '') query.set('q', params.q);
  if (params.date_from !== undefined && params.date_from !== '') query.set('date_from', params.date_from);
  if (params.date_to !== undefined && params.date_to !== '') query.set('date_to', params.date_to);
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.sort_by !== undefined) query.set('sort_by', params.sort_by);
  if (params.order !== undefined) query.set('order', params.order);
  const search = query.toString();
  return apiFetch<VisitListResult>(search === '' ? '/visits' : `/visits?${search}`);
}

export function getVisit(id: string): Promise<VisitDetail> {
  return apiFetch<VisitDetail>(`/visits/${id}`);
}

export function createVisit(body: CreateVisitRequest): Promise<VisitDetail> {
  return apiFetch<VisitDetail>('/visits', { method: 'POST', body: JSON.stringify(body) });
}

export function approveVisit(id: string, body?: ApproveRequest): Promise<void> {
  return apiFetch<void>(`/visits/${id}/approve`, {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
  });
}

export function rejectVisit(id: string, body: RejectRequest): Promise<void> {
  return apiFetch<void>(`/visits/${id}/reject`, { method: 'POST', body: JSON.stringify(body) });
}

export function rescheduleVisit(id: string, body: RescheduleRequest): Promise<void> {
  return apiFetch<void>(`/visits/${id}/reschedule`, { method: 'POST', body: JSON.stringify(body) });
}

export function cancelVisit(id: string, body?: CancelRequest): Promise<void> {
  return apiFetch<void>(`/visits/${id}/cancel`, {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
  });
}

export function getVisitQr(id: string): Promise<QrPayload> {
  return apiFetch<QrPayload>(`/visits/${id}/qr`);
}

/** `PATCH /visits/{id}/visitors/{visitorId}` — ubah parsial kontak anggota (pembuat saja). */
export function updateVisitorContact(
  visitId: string,
  visitorId: string,
  body: UpdateVisitorContactRequest,
): Promise<VisitorItem> {
  return apiFetch<VisitorItem>(`/visits/${visitId}/visitors/${visitorId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function checkInVisit(id: string, body?: CheckInRequest): Promise<void> {
  return apiFetch<void>(`/visits/${id}/checkin`, {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
  });
}

export function checkOutVisit(id: string): Promise<void> {
  return apiFetch<void>(`/visits/${id}/checkout`, { method: 'POST' });
}

// ---------------------------------------------------------------------------
// User Management (Security Cabang)
// ---------------------------------------------------------------------------

export function listSecurityUsers(
  params: { location_id?: string } = {},
): Promise<User[]> {
  const query = new URLSearchParams();
  if (params.location_id !== undefined) query.set('location_id', params.location_id);
  const search = query.toString();
  return apiFetch<User[]>(search === '' ? '/users/security' : `/users/security?${search}`);
}

export function createSecurityUser(body: CreateSecurityUserRequest): Promise<User> {
  return apiFetch<User>('/users/security', { method: 'POST', body: JSON.stringify(body) });
}

export function updateSecurityUserStatus(
  id: string,
  body: UpdateUserStatusRequest,
): Promise<User> {
  return apiFetch<User>(`/users/security/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

/** `DELETE /users/security/{id}` — 204 kosong; 403 lintas cabang; 409 bila direferensikan. */
export function deleteSecurityUser(id: string): Promise<void> {
  return apiFetch<void>(`/users/security/${id}`, { method: 'DELETE' });
}

/**
 * `PATCH /users/security/:id` — admin cabang terkunci + superadmin; parsial + reset password.
 * `location_id` ikut diteruskan apa adanya di body (mutasi cabang: superadmin
 * saja; absen/null berarti "biarkan cabang saat ini").
 */
export function updateSecurityUser(id: string, body: UpdateSecurityUserRequest): Promise<User> {
  return apiFetch<User>(`/users/security/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Superadmin: Fasilitas & Cabang + Manajemen User & Vendor (kontrak §2)
// ---------------------------------------------------------------------------

/** `GET /locations` sudah ada di atas; di bawah ini sisi tulis + manajemen user. */

export function createLocation(body: CreateLocationRequest): Promise<Location> {
  return apiFetch<Location>('/locations', { method: 'POST', body: JSON.stringify(body) });
}

export function updateLocation(id: string, body: UpdateLocationRequest): Promise<Location> {
  return apiFetch<Location>(`/locations/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function listManagedUsers(params: ManagedUserListParams = {}): Promise<User[]> {
  const query = new URLSearchParams();
  if (params.role !== undefined && params.role !== '') query.set('role', params.role);
  if (params.search !== undefined && params.search !== '') query.set('search', params.search);
  if (params.location_id !== undefined && params.location_id !== '')
    query.set('location_id', params.location_id);
  const search = query.toString();
  return apiFetch<User[]>(search === '' ? '/users' : `/users?${search}`);
}

export function createManagedUser(body: CreateManagedUserRequest): Promise<User> {
  return apiFetch<User>('/users', { method: 'POST', body: JSON.stringify(body) });
}

export function updateManagedUserStatus(
  id: string,
  body: UpdateUserStatusRequest,
): Promise<User> {
  return apiFetch<User>(`/users/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

/** `PATCH /users/:id` — super_admin saja; parsial, tanpa role/status (password = reset hash). */
export function updateManagedUser(id: string, body: UpdateManagedUserRequest): Promise<User> {
  return apiFetch<User>(`/users/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Hapus permanen (super_admin saja — kontrak DELETE §2)
// ---------------------------------------------------------------------------

/** `DELETE /visits/{id}` — 204 kosong. */
export function deleteVisit(id: string): Promise<void> {
  return apiFetch<void>(`/visits/${id}`, { method: 'DELETE' });
}

/** `DELETE /users/{id}` — 204 kosong; 403 diri sendiri/super_admin; 409 bila direferensikan. */
export function deleteManagedUser(id: string): Promise<void> {
  return apiFetch<void>(`/users/${id}`, { method: 'DELETE' });
}

/** `DELETE /locations/{id}` — 204 kosong; 409 bila masih direferensikan. */
export function deleteLocation(id: string): Promise<void> {
  return apiFetch<void>(`/locations/${id}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Audit (super_admin saja)
// ---------------------------------------------------------------------------

/** `GET /audit-logs` — daftar jejak audit berfilter; 403 untuk non-super_admin. */
export function listAuditLogs(params: AuditLogListParams = {}): Promise<AuditLogListResult> {
  const query = new URLSearchParams();
  if (params.user_id !== undefined && params.user_id !== '') query.set('user_id', params.user_id);
  if (params.entity !== undefined && params.entity !== '') query.set('entity', params.entity);
  if (params.action !== undefined && params.action !== '') query.set('action', params.action);
  if (params.date_from !== undefined && params.date_from !== '')
    query.set('date_from', params.date_from);
  if (params.date_to !== undefined && params.date_to !== '') query.set('date_to', params.date_to);
  if (params.q !== undefined && params.q !== '') query.set('q', params.q);
  if (params.order !== undefined) query.set('order', params.order);
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  const search = query.toString();
  return apiFetch<AuditLogListResult>(search === '' ? '/audit-logs' : `/audit-logs?${search}`);
}

// ---------------------------------------------------------------------------
// Notifikasi (feed lonceng header)
// ---------------------------------------------------------------------------

/**
 * `GET /notifications` — feed read-only untuk lonceng header. `location_id`
 * hanya dikirim bila terisi (bermakna untuk super_admin); admin/security
 * di-scope backend ke cabangnya sendiri dan vendor ditolak 403.
 */
export function listNotifications(params: NotificationListParams = {}): Promise<NotificationListResult> {
  const query = new URLSearchParams();
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.location_id !== undefined && params.location_id !== '')
    query.set('location_id', params.location_id);
  const search = query.toString();
  return apiFetch<NotificationListResult>(search === '' ? '/notifications' : `/notifications?${search}`);
}

/** `PATCH /notifications/{id}` — tandai satu notifikasi milik pemanggil sebagai dibaca. */
export function markNotificationRead(id: string): Promise<{ id: string; is_read: true }> {
  return apiFetch<{ id: string; is_read: true }>(`/notifications/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ is_read: true }),
  });
}

/** `POST /notifications/read-all` — tandai semua notifikasi milik pemanggil sebagai dibaca. */
export function markAllNotificationsRead(): Promise<{ updated: number }> {
  return apiFetch<{ updated: number }>('/notifications/read-all', { method: 'POST' });
}

// ---------------------------------------------------------------------------
// Pendaftaran vendor menunggu persetujuan (superadmin)
// ---------------------------------------------------------------------------

/**
 * `GET /notifications/pending-registrations` — antre pendaftaran vendor
 * beserta `pending_count` agregat. Hanya superadmin (403 untuk role lain);
 * dipakai lonceng untuk angka badge dan entri panel. Tidak ada endpoint
 * count terpisah — `pending_count` diambil dari respons daftar (probe
 * `limit: 1`, pola `useUnreadNotificationCount`).
 */
export function listPendingRegistrations(
  params: PendingRegistrationListParams = {},
): Promise<PendingRegistrationListResult> {
  const query = new URLSearchParams();
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  const search = query.toString();
  return apiFetch<PendingRegistrationListResult>(
    search === ''
      ? '/notifications/pending-registrations'
      : `/notifications/pending-registrations?${search}`,
  );
}

// ---------------------------------------------------------------------------
// Pengaturan notifikasi (matriks) - `/settings/notifications`
// ---------------------------------------------------------------------------

export function getNotificationSettings(): Promise<NotificationSettingsMatrix> {
  return apiFetch<NotificationSettingsMatrix>('/settings/notifications');
}

export function updateNotificationSettings(body: {
  toggles: NotificationToggle[];
  version: number;
}): Promise<NotificationSettingsMatrix> {
  return apiFetch<NotificationSettingsMatrix>('/settings/notifications', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

// Alias nama alternatif.
export const getNotificationMatrix = getNotificationSettings;
export const updateNotificationMatrix = updateNotificationSettings;
export const fetchNotificationSettings = getNotificationSettings;
export const saveNotificationSettings = updateNotificationSettings;
