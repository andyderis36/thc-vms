/**
 * Klien REST THC VMS — satu fungsi bertipe per endpoint MVP.
 *
 * Transport murni: tanpa React, tanpa TanStack Query. Lapisan hook terpisah
 * di folder features yang akan memakai fungsi-fungsi ini.
 */

import { apiFetch, clearToken, storeToken, uploadFile } from '@/lib/api/fetcher';
import type {
  ApproveRequest,
  CancelRequest,
  CheckInRequest,
  CreateSecurityUserRequest,
  CreateVisitRequest,
  Location,
  LoginRequest,
  LoginResult,
  Purpose,
  QrPayload,
  RejectRequest,
  RescheduleRequest,
  UpdateUserStatusRequest,
  User,
  VisitDetail,
  VisitListParams,
  VisitListResult,
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

export async function logout(): Promise<void> {
  try {
    await apiFetch<void>('/auth/logout', { method: 'POST' });
  } finally {
    clearToken();
  }
}

// ---------------------------------------------------------------------------
// Master Data
// ---------------------------------------------------------------------------

export function listLocations(): Promise<Location[]> {
  return apiFetch<Location[]>('/locations');
}

export function listPurposes(): Promise<Purpose[]> {
  return apiFetch<Purpose[]>('/purposes');
}

// ---------------------------------------------------------------------------
// Visits
// ---------------------------------------------------------------------------

export function listVisits(params: VisitListParams = {}): Promise<VisitListResult> {
  const query = new URLSearchParams();
  if (params.status !== undefined) query.set('status', params.status);
  if (params.location_id !== undefined) query.set('location_id', params.location_id);
  if (params.search !== undefined) query.set('search', params.search);
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
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
