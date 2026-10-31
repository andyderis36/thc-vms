/**
 * Handler MSW v2 (dev-only) yang mereproduksi kontrak OpenAPI THC VMS.
 *
 * v2 only: `http` + `HttpResponse` + `delay`. Titik isolasi multi-cabang
 * (AGENTS.md §6.1) ditegakkan di sini agar pelanggaran terlihat saat dev.
 */

import { delay, http, HttpResponse } from 'msw';
import type { RequestHandler } from 'msw';
import { db, DEMO_PASSWORD } from './seed';
import { isSuperAdminRole } from '@/lib/auth/capabilities';
import {
  PHONE_DIGIT_MESSAGE,
  PHONE_MAX_LENGTH,
  PHONE_MIN_LENGTH,
} from '@/lib/limits';
import {
  getCheckinBlockReason,
  isWithinCheckinWindow,
} from '@/lib/visits/tolerance';
import type {
  Location,
  LoginResult,
  NotificationItem,
  NotificationType,
  QrPayload,
  UploadFileResult,
  User,
  Vendor,
  VisitDetail,
  VisitListResult,
  VisitStatus,
} from '@/lib/api/types';

const API_BASE: string =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8080/api/v1';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const ALLOWED_UPLOAD_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
]);

// ---------------------------------------------------------------------------
// Util kecil
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

function ok(data: unknown, status = 200): Response {
  return HttpResponse.json({ success: true, data }, { status });
}

function fail(code: string, message: string, status: number): Response {
  return HttpResponse.json(
    { success: false, error: { code, message } },
    { status },
  );
}

async function readJsonBody(
  request: Request,
): Promise<Record<string, unknown>> {
  try {
    const payload: unknown = await request.json();
    return isRecord(payload) ? payload : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Token mock (JWT-like, stateless: sub = id user)
// ---------------------------------------------------------------------------

function toBase64Url(input: string): string {
  return btoa(input)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');
}

function fromBase64Url(input: string): string {
  const restored = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (restored.length % 4)) % 4;
  return atob(restored + '='.repeat(padLength));
}

function createMockToken(user: User): string {
  const header = toBase64Url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = toBase64Url(
    JSON.stringify({ sub: user.id, email: user.email, iat: Date.now() }),
  );
  const signature = toBase64Url(`${user.id}.${Date.now()}.${Math.random()}`);
  return `${header}.${payload}.${signature}`;
}

function getAuthUser(request: Request): User | null {
  const header = request.headers.get('Authorization');
  if (header === null || !header.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice('Bearer '.length).trim();
  const segments = token.split('.');
  const payloadSegment = segments[1];
  if (payloadSegment === undefined) {
    return null;
  }
  try {
    const payload: unknown = JSON.parse(fromBase64Url(payloadSegment));
    if (!isRecord(payload)) {
      return null;
    }
    const sub = payload['sub'];
    if (typeof sub !== 'string') {
      return null;
    }
    return db.users.find((user) => user.id === sub) ?? null;
  } catch {
    return null;
  }
}

function unauthorized(): Response {
  return fail(
    'UNAUTHORIZED',
    'Sesi Anda telah berakhir. Silakan masuk kembali.',
    401,
  );
}

// ---------------------------------------------------------------------------
// Profil mandiri (PATCH /auth/me)
// ---------------------------------------------------------------------------

/** Field yang boleh diubah sendiri lewat `PATCH /auth/me` (openapi). */
const PROFILE_EDITABLE_FIELDS = new Set(['name', 'phone', 'avatar_url']);

/** Nomor telepon kanonik: hanya digit, awalan `62` diganti `0` (cermin BE). */
const PHONE_PATTERN = /^(?:62|0)[0-9]{9,15}$/;

/** Daftar field yang boleh diubah sendiri, dihitung dari peran pemanggil. */
function editableFieldsFor(role: User['role']): string[] {
  return isSuperAdminRole(role)
    ? ['name', 'phone', 'avatar_url']
    : ['phone', 'avatar_url'];
}

/**
 * Amplop `GET`/`PATCH /auth/me`: profil + `editable_fields` peran. Menyalin
 * objek agar `editable_fields` tidak ikut tersimpan pada `db.users` (field ini
 * hanya dijamin pada respons `/auth/me`, bukan pada user tertanam kunjungan).
 */
function meResponse(user: User): User {
  return { ...user, editable_fields: editableFieldsFor(user.role) };
}

// ---------------------------------------------------------------------------
// Scoping multi-cabang (AGENTS.md §6.1)
// ---------------------------------------------------------------------------

/** Filter daftar kunjungan sesuai peran pemanggil. */
function scopeVisits(
  user: User,
  locationQuery: string | null,
): VisitDetail[] {
  if (isSuperAdminRole(user.role)) {
    if (locationQuery !== null && locationQuery !== '') {
      return db.visits.filter(
        (visit) => visit.location.id === locationQuery,
      );
    }
    return [...db.visits];
  }
  if (user.role === 'admin' || user.role === 'security') {
    // Abaikan query lintas cabang: paksa ke lokasi milik user.
    return db.visits.filter(
      (visit) => visit.location.id === user.location_id,
    );
  }
  // Vendor/Mitra hanya melihat kunjungan miliknya sendiri.
  return db.visits.filter((visit) => visit.vendor_user.id === user.id);
}

/** Peta status kunjungan → jenis peristiwa notifikasi; status tanpa peristiwa = null. */
function notificationTypeFor(status: VisitStatus): NotificationType | null {
  switch (status) {
    case 'requested':
      return 'visit_requested';
    case 'rescheduled':
      return 'visit_rescheduled';
    case 'visiting':
      return 'visit_check_in';
    case 'completed':
      return 'visit_check_out';
    default:
      return null;
  }
}

/**
 * Judul + pesan notifikasi per jenis (cermin template domain backend).
 * `Record<NotificationType, …>` menjaga mock tetap sinkron dengan enum kontrak.
 */
const NOTIFICATION_TEMPLATES: Record<
  NotificationType,
  { title: string; message: (visitCode: string) => string }
> = {
  visit_requested: {
    title: 'Permintaan kunjungan baru',
    message: (code) => `Permintaan ${code} menunggu persetujuan.`,
  },
  visit_rescheduled: {
    title: 'Jadwal kunjungan diperbarui',
    message: (code) => `Permintaan ${code} dijadwalkan ulang.`,
  },
  visit_check_in: {
    title: 'Check-in tamu',
    message: (code) => `Tamu ${code} telah check-in.`,
  },
  visit_check_out: {
    title: 'Check-out tamu',
    message: (code) => `Tamu ${code} telah check-out.`,
  },
  visit_approved: {
    title: 'Kunjungan disetujui',
    message: (code) => `Permintaan ${code} telah disetujui.`,
  },
  visit_rejected: {
    title: 'Kunjungan ditolak',
    message: (code) => `Permintaan ${code} ditolak.`,
  },
  visit_reminder: {
    title: 'Pengingat kunjungan',
    message: (code) => `Kunjungan ${code} akan dimulai sebentar lagi.`,
  },
  visit_auto_cancelled: {
    title: 'Kunjungan dibatalkan otomatis',
    message: (code) => `Permintaan ${code} batal otomatis.`,
  },
};

/**
 * Status "sudah dibaca" per notifikasi — mock in-memory (dev-only); backend
 * menyimpannya di kolom `notification.is_read`.
 */
const readNotificationIds = new Set<string>();

/**
 * Bangun feed notifikasi milik pemanggil dari kunjungan ter-scope-nya.
 * Padanan mock dari tabel `notification` backend: newest-first, satu baris per
 * (kunjungan, jenis), dengan `is_read` dibaca dari `readNotificationIds`.
 */
function notificationsFor(
  user: User,
  locationQuery: string | null,
): NotificationItem[] {
  const items: NotificationItem[] = [];
  for (const visit of scopeVisits(user, locationQuery)) {
    const type = notificationTypeFor(visit.status);
    if (type === null) {
      continue;
    }
    const id = `${visit.id}:${type}`;
    const template = NOTIFICATION_TEMPLATES[type];
    items.push({
      id,
      type,
      visit_request_id: visit.id,
      visit_id: visit.visit_id,
      location_id: visit.location.id,
      location_name: visit.location.name,
      title: template.title,
      message: template.message(visit.visit_id),
      is_read: readNotificationIds.has(id),
      occurred_at: visit.created_at,
    });
  }
  items.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
  return items;
}

/** `true` bila satu kunjungan boleh dilihat/diaksi pemanggil. */
function isVisitInScope(user: User, visit: VisitDetail): boolean {
  if (isSuperAdminRole(user.role)) {
    return true;
  }
  if (user.role === 'admin' || user.role === 'security') {
    return (
      user.location_id !== null && visit.location.id === user.location_id
    );
  }
  return visit.vendor_user.id === user.id;
}

/** Cari kunjungan by UUID maupun kode `visit_id`. */
function findVisit(id: string): VisitDetail | undefined {
  return db.visits.find(
    (visit) => visit.id === id || visit.visit_id === id,
  );
}

/** Payload QR stabil per kunjungan; sengaja BUKAN visit_id mentah. */
function qrPayloadFor(visit: VisitDetail): string {
  const raw = `${visit.id}:${visit.visit_id}:thc-vms-gate`;
  let hashA = 0x811c9dc5;
  let hashB = 0x01000193;
  for (let index = 0; index < raw.length; index += 1) {
    const charCode = raw.charCodeAt(index);
    hashA = Math.imul(hashA ^ charCode, 0x01000193) >>> 0;
    hashB = Math.imul(hashB + charCode, 0x811c9dc5) >>> 0;
  }
  const hexA = hashA.toString(16).padStart(8, '0').toUpperCase();
  const hexB = hashB.toString(16).padStart(8, '0').toUpperCase();
  return `THC1-${hexA}-${hexB}`;
}

function generateVisitCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let suffix = '';
    const rand = new Uint32Array(10);
    crypto.getRandomValues(rand);
    for (const n of rand) {
      suffix += chars.charAt(n % chars.length);
    }
    const code = `VST-${suffix}`;
    const taken = db.visits.some((visit) => visit.visit_id === code);
    if (!taken) {
      return code;
    }
  }
}

const INVALID_TRANSITION_MESSAGE =
  'Kunjungan tidak dapat diproses pada status saat ini.';

const LOCATION_TYPES = new Set(['pusat', 'cabang', 'pop', 'minipop']);
const LOCATION_TIMEZONES = new Set(['WIB', 'WITA', 'WIT']);
const MANAGED_ROLES = new Set(['admin', 'vendor']);

/**
 * Cermin kontrak BE `users.nik TEXT NULL UNIQUE` (16 digit):
 * wajib + format + unik untuk admin/vendor.
 */
const NIK_PATTERN = /^\d{16}$/;

function invalidNikFormat(): Response {
  return fail(
    'BAD_REQUEST',
    'NIK harus terdiri dari tepat 16 digit angka.',
    400,
  );
}

function takenNik(): Response {
  return fail('CONFLICT', 'NIK sudah terdaftar.', 409);
}

/** NIK pada body create managed user (admin/vendor: wajib). Kembalikan error atau NIK bersih. */
function parseRequiredNik(body: Record<string, unknown>): { nik: string } | { error: Response } {
  const raw = body['nik'];
  const nik = typeof raw === 'string' ? raw.trim() : '';
  if (nik === '') {
    return {
      error: fail(
        'BAD_REQUEST',
        'NIK wajib diisi untuk peran admin dan Vendor/Mitra.',
        400,
      ),
    };
  }
  if (!NIK_PATTERN.test(nik)) {
    return { error: invalidNikFormat() };
  }
  if (db.users.some((user) => user.nik === nik)) {
    return { error: takenNik() };
  }
  return { nik };
}

/** NIK ditolak BE untuk security/super_admin — cermin 400 di endpoint security. */
function rejectSecurityNik(body: Record<string, unknown>): Response | null {
  const raw = body['nik'];
  if (typeof raw === 'string' && raw.trim() !== '') {
    return fail('BAD_REQUEST', 'NIK tidak berlaku untuk akun security.', 400);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const handlers: RequestHandler[] = [
  // -- Auth ---------------------------------------------------------------
  http.post(`${API_BASE}/auth/login`, async ({ request }) => {
    const body = await readJsonBody(request);
    const email = stringField(body, 'email')?.trim().toLowerCase() ?? '';
    const password = stringField(body, 'password') ?? '';
    const user = db.users.find(
      (candidate) => candidate.email.toLowerCase() === email,
    );
    if (
      user === undefined ||
      password !== DEMO_PASSWORD ||
      user.status === 'inactive'
    ) {
      return fail('UNAUTHORIZED', 'Kredensial tidak valid', 401);
    }
    const result: LoginResult = { token: createMockToken(user), user };
    return ok(result);
  }),

  http.get(`${API_BASE}/auth/me`, ({ request }) => {
    const auth = getAuthUser(request);
    if (auth === null) {
      return unauthorized();
    }
    return ok(meResponse(auth));
  }),

  http.patch(`${API_BASE}/auth/me`, async ({ request }) => {
    const auth = getAuthUser(request);
    if (auth === null) {
      return unauthorized();
    }
    const body = await readJsonBody(request);
    const keys = Object.keys(body);
    const unknownField = keys.find(
      (key) => !PROFILE_EDITABLE_FIELDS.has(key),
    );
    if (unknownField !== undefined) {
      return fail(
        'VALIDATION_ERROR',
        `Field "${unknownField}" tidak dapat diubah pada profil sendiri.`,
        400,
      );
    }
    if (keys.length === 0) {
      return fail(
        'VALIDATION_ERROR',
        'Tidak ada perubahan yang diberikan.',
        400,
      );
    }
    const next: Partial<Pick<User, 'name' | 'phone' | 'avatar_url'>> = {};
    if ('name' in body) {
      if (!isSuperAdminRole(auth.role)) {
        return fail(
          'FORBIDDEN',
          'Hanya Superadmin yang dapat mengubah nama sendiri.',
          403,
        );
      }
      const name = stringField(body, 'name')?.trim() ?? '';
      if (name === '' || name.length > 100) {
        return fail(
          'VALIDATION_ERROR',
          'Nama wajib diisi dan maksimal 100 karakter.',
          400,
        );
      }
      next.name = name;
    }
    if ('phone' in body) {
      const raw = stringField(body, 'phone') ?? '';
      const canonical = raw.startsWith('62') ? `0${raw.slice(2)}` : raw;
      const normalizedDigits = raw.replace(/[^0-9]/g, '');
      const normalized = normalizedDigits.startsWith('62')
        ? `0${normalizedDigits.slice(2)}`
        : normalizedDigits;
      let hasLetter = false;
      for (const ch of raw.trim()) {
        if (/[A-Za-z]/.test(ch)) {
          hasLetter = true;
          break;
        }
      }
      if (
        raw.trim() !== '' &&
        !hasLetter &&
        normalized.startsWith('0') &&
        (normalized.length < PHONE_MIN_LENGTH ||
          normalized.length > PHONE_MAX_LENGTH)
      ) {
        return fail(
          'VALIDATION_ERROR',
          PHONE_DIGIT_MESSAGE,
          400,
        );
      }
      if (!PHONE_PATTERN.test(canonical)) {
        return fail(
          'VALIDATION_ERROR',
          'Nomor telepon harus berupa digit dengan awalan 0 atau 62.',
          400,
        );
      }
      next.phone = canonical;
    }
    if ('avatar_url' in body) {
      const avatar = body['avatar_url'];
      if (avatar === null) {
        next.avatar_url = null;
      } else if (typeof avatar === 'string' && avatar.length <= 2048) {
        next.avatar_url = avatar;
      } else {
        return fail(
          'VALIDATION_ERROR',
          'URL avatar tidak valid.',
          400,
        );
      }
    }
    Object.assign(auth, next);
    return ok(meResponse(auth));
  }),

  http.post(`${API_BASE}/auth/logout`, () => ok(null)),

  // -- Master data ----------------------------------------------------------
  http.get(`${API_BASE}/locations`, async () => {
    await delay(150);
    return ok(db.locations);
  }),

  http.get(`${API_BASE}/purposes`, async () => {
    await delay(150);
    return ok(db.purposes);
  }),

  http.get(`${API_BASE}/vendors`, async () => {
    await delay(150);
    const vendors: Vendor[] = db.vendors;
    return ok(vendors);
  }),

  // Saran jabatan (distinct, A-Z, maks 50) — mock statis: cukup untuk
  // mengisi <datalist> pada form pengajuan.
  http.get(`${API_BASE}/jabatan`, async () => {
    await delay(150);
    return ok(['Mandor', 'Supervisor', 'Teknisi']);
  }),

  // -- Visits: list ---------------------------------------------------------
  http.get(`${API_BASE}/visits`, async ({ request }) => {
    const auth = getAuthUser(request);
    if (auth === null) {
      return unauthorized();
    }
    await delay(150);
    const url = new URL(request.url);
    const statusParam = url.searchParams.get('status');
    const locationParam = url.searchParams.get('location_id');
    const searchParam = url.searchParams.get('search')?.trim().toLowerCase();
    const pageRaw = Number.parseInt(
      url.searchParams.get('page') ?? '1',
      10,
    );
    const limitRaw = Number.parseInt(
      url.searchParams.get('limit') ?? '20',
      10,
    );
    const page = Number.isNaN(pageRaw) || pageRaw < 1 ? 1 : pageRaw;
    const limit = Number.isNaN(limitRaw) || limitRaw < 1 ? 20 : limitRaw;

    let items = scopeVisits(auth, locationParam);
    if (statusParam !== null && statusParam !== '') {
      items = items.filter((visit) => visit.status === statusParam);
    }
    if (searchParam !== null && searchParam !== undefined && searchParam !== '') {
      items = items.filter(
        (visit) =>
          visit.visit_id.toLowerCase().includes(searchParam) ||
          visit.vendor_user.name.toLowerCase().includes(searchParam),
      );
    }
    const total = items.length;
    const paged = items.slice((page - 1) * limit, page * limit);
    const result: VisitListResult = { items: paged, total, page, limit };
    return ok(result);
  }),

  // -- Notifikasi (feed read-only untuk lonceng header) ----------------------
  http.get(`${API_BASE}/notifications`, async ({ request }) => {
    const auth = getAuthUser(request);
    if (auth === null) {
      return unauthorized();
    }
    await delay(150);
    const url = new URL(request.url);
    const locationParam = url.searchParams.get('location_id');
    const pageRaw = Number.parseInt(
      url.searchParams.get('page') ?? '1',
      10,
    );
    const limitRaw = Number.parseInt(
      url.searchParams.get('limit') ?? '20',
      10,
    );
    const page = Number.isNaN(pageRaw) || pageRaw < 1 ? 1 : pageRaw;
    const limit = Number.isNaN(limitRaw) || limitRaw < 1 ? 20 : limitRaw;

    const all = notificationsFor(auth, locationParam);
    const total = all.length;
    const unreadCount = all.filter((item) => !item.is_read).length;
    const paged = all.slice((page - 1) * limit, page * limit);
    return ok({ items: paged, total, unread_count: unreadCount, page, limit });
  }),

  http.patch(`${API_BASE}/notifications/:id`, async ({ request, params }) => {
    const auth = getAuthUser(request);
    if (auth === null) {
      return unauthorized();
    }
    const id = String(params['id'] ?? '');
    const owned = notificationsFor(auth, null).find((item) => item.id === id);
    if (owned === undefined) {
      return fail(
        'NOT_FOUND',
        'Notifikasi tidak ditemukan.',
        404,
      );
    }
    readNotificationIds.add(id);
    return ok({ id, is_read: true });
  }),

  http.post(`${API_BASE}/notifications/read-all`, async ({ request }) => {
    const auth = getAuthUser(request);
    if (auth === null) {
      return unauthorized();
    }
    const owned = notificationsFor(auth, null).filter((item) => !item.is_read);
    for (const item of owned) {
      readNotificationIds.add(item.id);
    }
    return ok({ updated: owned.length });
  }),

  // -- Visits: create ---------------------------------------------------------
  http.post(`${API_BASE}/visits`, async ({ request }) => {
    const auth = getAuthUser(request);
    if (auth === null) {
      return unauthorized();
    }
    const body = await readJsonBody(request);
    const locationId = stringField(body, 'location_id') ?? '';
    const startDate = stringField(body, 'start_date') ?? '';
    const endDate = stringField(body, 'end_date') ?? '';
    const visitors = body['visitors'];
    const purposeIds = body['purpose_ids'];
    // "Tujuan lain" (kontrak baru): teks manual ≤200; `purpose_ids` boleh
    // kosong selama field ini terisi (cermin BE).
    const purposeNoteRaw = stringField(body, 'purpose_note');
    const purposeNote =
      purposeNoteRaw === undefined || purposeNoteRaw.trim() === ''
        ? null
        : purposeNoteRaw.trim();
    const isNdaAccepted = body['is_nda_accepted'];

    const location = db.locations.find((loc) => loc.id === locationId);
    if (location === undefined) {
      return fail('BAD_REQUEST', 'Lokasi wajib dipilih.', 400);
    }
    if (purposeNote !== null && purposeNote.length > 200) {
      return fail('BAD_REQUEST', 'Tujuan lain maksimal 200 karakter.', 400);
    }
    const purposeIdList: unknown[] = Array.isArray(purposeIds)
      ? purposeIds
      : [];
    if (purposeIdList.length === 0 && purposeNote === null) {
      return fail(
        'BAD_REQUEST',
        'Pilih minimal satu tujuan kunjungan atau isi tujuan lain.',
        400,
      );
    }
    const unknownPurpose = purposeIdList.some(
      (id) =>
        typeof id !== 'string' ||
        db.purposes.every((purpose) => purpose.id !== id),
    );
    if (unknownPurpose) {
      return fail('BAD_REQUEST', 'Tujuan kunjungan tidak valid.', 400);
    }
    if (startDate === '' || endDate === '') {
      return fail('BAD_REQUEST', 'Tanggal mulai dan selesai wajib diisi.', 400);
    }
    const startMs = new Date(startDate).getTime();
    const endMs = new Date(endDate).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
      return fail('BAD_REQUEST', 'Format tanggal tidak valid.', 400);
    }
    if (startMs >= endMs) {
      return fail(
        'BAD_REQUEST',
        'Tanggal mulai harus sebelum tanggal selesai.',
        400,
      );
    }
    if (!Array.isArray(visitors) || visitors.length === 0) {
      return fail('BAD_REQUEST', 'Data teknisi wajib diisi (minimal 1 orang).', 400);
    }
    if (visitors.length > 10) {
      return fail('BAD_REQUEST', 'Jumlah teknisi maksimal 10 orang.', 400);
    }
    if (isNdaAccepted !== true) {
      return fail(
        'BAD_REQUEST',
        'Anda harus menyetujui NDA sebelum mengajukan kunjungan.',
        400,
      );
    }

    const matchedPurposes = purposeIdList.flatMap((id) => {
      if (typeof id !== 'string') {
        return [];
      }
      const found = db.purposes.find((purpose) => purpose.id === id);
      return found === undefined ? [] : [found];
    });
    const visit: VisitDetail = {
      id: crypto.randomUUID(),
      visit_id: generateVisitCode(),
      status: 'requested',
      location,
      purposes: matchedPurposes,
      vendor_user: auth,
      // Fase 1: backend masih dual-emit `pic_user` (nilai sama) — jangan dihapus.
      pic_user: auth,
      vendor_name: auth.vendor_name ?? 'Internal THC',
      start_date: new Date(startMs).toISOString(),
      end_date: new Date(endMs).toISOString(),
      assignment_letter_url: stringField(body, 'assignment_letter_url') ?? null,
      notes: stringField(body, 'notes') ?? null,
      purpose_note: purposeNote,
      visitors: visitors.flatMap((item) => {
        if (!isRecord(item)) {
          return [];
        }
        const name = typeof item['name'] === 'string' ? item['name'] : '';
        const idNumber =
          typeof item['id_number'] === 'string' ? item['id_number'] : '';
        const phone = typeof item['phone'] === 'string' ? item['phone'] : '';
        if (name === '' || idNumber === '' || phone === '') {
          return [];
        }
        const photo =
          typeof item['id_card_photo_url'] === 'string'
            ? item['id_card_photo_url']
            : null;
        const selfie =
          typeof item['photo_url'] === 'string' ? item['photo_url'] : null;
        const rawVendorId =
          typeof item['vendor_id'] === 'string' ? item['vendor_id'] : '';
        const vendor =
          rawVendorId !== ''
            ? db.vendors.find((entry) => entry.id === rawVendorId)
            : undefined;
        // vendor_id menang; selain itu teks manual `vendor_name` (≤120).
        const manualVendor =
          typeof item['vendor_name'] === 'string'
            ? item['vendor_name'].trim()
            : '';
        return [
          {
            name,
            id_number: idNumber,
            phone,
            id_card_photo_url: photo,
            photo_url: selfie,
            vendor_id: rawVendorId !== '' ? rawVendorId : null,
            vendor_name:
              vendor !== undefined
                ? vendor.name
                : manualVendor !== '' && manualVendor.length <= 120
                  ? manualVendor
                  : null,
          },
        ];
      }),
      created_at: new Date().toISOString(),
    };
    db.visits.unshift(visit);
    return ok(visit, 201);
  }),

  // -- Visits: detail ---------------------------------------------------------
  http.get(`${API_BASE}/visits/:id`, ({ request, params }) => {
    const auth = getAuthUser(request);
    if (auth === null) {
      return unauthorized();
    }
    const id = params['id'];
    if (typeof id !== 'string') {
      return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
    }
    const visit = findVisit(id);
    if (visit === undefined || !isVisitInScope(auth, visit)) {
      return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
    }
    return ok(visit);
  }),

  // -- Visits: approve ----------------------------------------------------------
  http.post(`${API_BASE}/visits/:id/approve`, async ({ request, params }) => {
    const auth = getAuthUser(request);
    if (auth === null) {
      return unauthorized();
    }
    if (!isSuperAdminRole(auth.role) && auth.role !== 'admin') {
      return fail(
        'FORBIDDEN',
        'Anda tidak memiliki izin untuk menyetujui kunjungan',
        403,
      );
    }
    const id = params['id'];
    if (typeof id !== 'string') {
      return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
    }
    const visit = findVisit(id);
    if (visit === undefined || !isVisitInScope(auth, visit)) {
      return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
    }
    if (visit.status !== 'requested' && visit.status !== 'rescheduled') {
      return fail('CONFLICT', INVALID_TRANSITION_MESSAGE, 409);
    }
    const body = await readJsonBody(request);
    const notes = stringField(body, 'notes');
    visit.status = 'approved';
    if (notes !== undefined && notes.trim() !== '') {
      visit.notes = notes;
    }
    return ok(null);
  }),

  // -- Visits: reject -----------------------------------------------------------
  http.post(`${API_BASE}/visits/:id/reject`, async ({ request, params }) => {
    const auth = getAuthUser(request);
    if (auth === null) {
      return unauthorized();
    }
    if (!isSuperAdminRole(auth.role) && auth.role !== 'admin') {
      return fail(
        'FORBIDDEN',
        'Anda tidak memiliki izin untuk menolak kunjungan',
        403,
      );
    }
    const id = params['id'];
    if (typeof id !== 'string') {
      return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
    }
    const visit = findVisit(id);
    if (visit === undefined || !isVisitInScope(auth, visit)) {
      return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
    }
    const body = await readJsonBody(request);
    const reason = stringField(body, 'reason')?.trim() ?? '';
    if (reason.length < 5) {
      return fail(
        'BAD_REQUEST',
        'Alasan penolakan wajib diisi (minimal 5 karakter).',
        400,
      );
    }
    if (visit.status !== 'requested') {
      return fail('CONFLICT', INVALID_TRANSITION_MESSAGE, 409);
    }
    visit.status = 'rejected';
    visit.notes = reason;
    return ok(null);
  }),

  // -- Visits: reschedule ---------------------------------------------------------
  http.post(
    `${API_BASE}/visits/:id/reschedule`,
    async ({ request, params }) => {
      const auth = getAuthUser(request);
      if (auth === null) {
        return unauthorized();
      }
      if (auth.role === 'security') {
        return fail(
          'FORBIDDEN',
          'Anda tidak memiliki izin untuk menjadwalkan ulang kunjungan.',
          403,
        );
      }
      const id = params['id'];
      if (typeof id !== 'string') {
        return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
      }
      const visit = findVisit(id);
      if (visit === undefined) {
        return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
      }
      if (auth.role === 'vendor' && visit.vendor_user.id !== auth.id) {
        return fail(
          'FORBIDDEN',
          'Anda hanya dapat menjadwalkan ulang kunjungan milik Anda.',
          403,
        );
      }
      if (!isVisitInScope(auth, visit)) {
        return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
      }
      const body = await readJsonBody(request);
      const startDate = stringField(body, 'start_date') ?? '';
      const endDate = stringField(body, 'end_date') ?? '';
      const reason = stringField(body, 'reason')?.trim() ?? '';
      if (startDate === '' || endDate === '' || reason === '') {
        return fail(
          'BAD_REQUEST',
          'Tanggal mulai, tanggal selesai, dan alasan wajib diisi.',
          400,
        );
      }
      const startMs = new Date(startDate).getTime();
      const endMs = new Date(endDate).getTime();
      if (
        Number.isNaN(startMs) ||
        Number.isNaN(endMs) ||
        startMs >= endMs
      ) {
        return fail(
          'BAD_REQUEST',
          'Tanggal mulai harus sebelum tanggal selesai.',
          400,
        );
      }
      if (
        visit.status !== 'requested' &&
        visit.status !== 'approved' &&
        visit.status !== 'rescheduled'
      ) {
        return fail('CONFLICT', INVALID_TRANSITION_MESSAGE, 409);
      }
      visit.status = 'rescheduled';
      visit.start_date = new Date(startMs).toISOString();
      visit.end_date = new Date(endMs).toISOString();
      visit.notes = reason;
      return ok(null);
    },
  ),

  // -- Visits: cancel ---------------------------------------------------------------
  http.post(`${API_BASE}/visits/:id/cancel`, async ({ request, params }) => {
    const auth = getAuthUser(request);
    if (auth === null) {
      return unauthorized();
    }
    if (auth.role === 'security') {
      return fail(
        'FORBIDDEN',
        'Anda tidak memiliki izin untuk membatalkan kunjungan.',
        403,
      );
    }
    const id = params['id'];
    if (typeof id !== 'string') {
      return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
    }
    const visit = findVisit(id);
    if (visit === undefined) {
      return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
    }
    if (auth.role === 'vendor' && visit.vendor_user.id !== auth.id) {
      return fail(
        'FORBIDDEN',
        'Anda hanya dapat membatalkan kunjungan milik Anda.',
        403,
      );
    }
    if (!isVisitInScope(auth, visit)) {
      return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
    }
    const body = await readJsonBody(request);
    const reason = stringField(body, 'reason');
    if (
      visit.status !== 'requested' &&
      visit.status !== 'approved' &&
      visit.status !== 'rescheduled'
    ) {
      return fail('CONFLICT', INVALID_TRANSITION_MESSAGE, 409);
    }
    visit.status = 'cancelled';
    if (reason !== undefined && reason.trim() !== '') {
      visit.notes = reason;
    }
    return ok(null);
  }),

  // -- Visits: QR ---------------------------------------------------------------------
  http.get(`${API_BASE}/visits/:id/qr`, ({ request, params }) => {
    const auth = getAuthUser(request);
    if (auth === null) {
      return unauthorized();
    }
    const id = params['id'];
    if (typeof id !== 'string') {
      return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
    }
    const visit = findVisit(id);
    if (visit === undefined || !isVisitInScope(auth, visit)) {
      return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
    }
    if (visit.status !== 'approved') {
      return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
    }
    const payload: QrPayload = {
      visit_id: visit.visit_id,
      qr_code_payload: qrPayloadFor(visit),
    };
    return ok(payload);
  }),

  // -- Visits: check-in (gerbang toleransi ±2 jam) ---------------------------------------
  http.post(`${API_BASE}/visits/:id/checkin`, async ({ request, params }) => {
    const auth = getAuthUser(request);
    if (auth === null) {
      return unauthorized();
    }
    const id = params['id'];
    if (typeof id !== 'string') {
      return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
    }
    const visit = findVisit(id);
    if (visit === undefined) {
      return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
    }
    if (auth.role === 'vendor') {
      return fail(
        'FORBIDDEN',
        'Anda tidak memiliki izin untuk melakukan check-in.',
        403,
      );
    }
    if (
      (auth.role === 'admin' || auth.role === 'security') &&
      visit.location.id !== auth.location_id
    ) {
      return fail(
        'FORBIDDEN',
        'Kunjungan ini ditujukan untuk lokasi lain',
        403,
      );
    }
    if (visit.status !== 'approved') {
      return fail('CONFLICT', INVALID_TRANSITION_MESSAGE, 409);
    }
    const now = Date.now();
    if (!isWithinCheckinWindow(now, visit.start_date, visit.end_date)) {
      const reason =
        getCheckinBlockReason(now, visit.start_date, visit.end_date) ??
        'Check-in di luar jendela toleransi kunjungan.';
      return fail('OUT_OF_WINDOW', reason, 400);
    }
    visit.status = 'visiting';
    return ok(null);
  }),

  // -- Visits: check-out -------------------------------------------------------------------
  http.post(`${API_BASE}/visits/:id/checkout`, ({ request, params }) => {
    const auth = getAuthUser(request);
    if (auth === null) {
      return unauthorized();
    }
    const id = params['id'];
    if (typeof id !== 'string') {
      return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
    }
    const visit = findVisit(id);
    if (visit === undefined) {
      return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
    }
    if (auth.role === 'vendor') {
      return fail(
        'FORBIDDEN',
        'Anda tidak memiliki izin untuk melakukan check-out.',
        403,
      );
    }
    if (
      (auth.role === 'admin' || auth.role === 'security') &&
      visit.location.id !== auth.location_id
    ) {
      return fail(
        'FORBIDDEN',
        'Kunjungan ini ditujukan untuk lokasi lain',
        403,
      );
    }
    if (visit.status !== 'visiting') {
      return fail('CONFLICT', INVALID_TRANSITION_MESSAGE, 409);
    }
    visit.status = 'completed';
    return ok(null);
  }),

  // -- Uploads -------------------------------------------------------------------------------
  http.post(`${API_BASE}/uploads`, async ({ request }) => {
    const auth = getAuthUser(request);
    if (auth === null) {
      return unauthorized();
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return fail('BAD_REQUEST', 'Berkas wajib dilampirkan.', 400);
    }
    const part = form.get('file');
    if (!(part instanceof File)) {
      return fail('BAD_REQUEST', 'Berkas wajib dilampirkan.', 400);
    }
    if (!ALLOWED_UPLOAD_MIME.has(part.type)) {
      return fail(
        'UNSUPPORTED_MEDIA',
        'Format berkas tidak didukung. Gunakan PDF, JPG, atau PNG.',
        400,
      );
    }
    if (part.size > MAX_UPLOAD_BYTES) {
      return fail('PAYLOAD_TOO_LARGE', 'Ukuran berkas maksimal 5 MB', 413);
    }
    const safeName = encodeURIComponent(part.name);
    const result: UploadFileResult = {
      file_url: `http://localhost:9000/thc-vms-bucket/uploads/${Date.now()}-${safeName}`,
      file_name: part.name,
      file_size: part.size,
      mime_type: part.type,
    };
    return ok(result, 201);
  }),

  // -- Security users ----------------------------------------------------------------------------
  http.get(`${API_BASE}/users/security`, async ({ request }) => {
    const auth = getAuthUser(request);
    if (auth === null) {
      return unauthorized();
    }
    if (auth.role === 'security' || auth.role === 'vendor') {
      return fail(
        'FORBIDDEN',
        'Anda tidak memiliki izin untuk melihat data petugas.',
        403,
      );
    }
    await delay(150);
    const url = new URL(request.url);
    const locationParam = url.searchParams.get('location_id');
    let items = db.users.filter((user) => user.role === 'security');
    if (auth.role === 'admin') {
      items = items.filter(
        (user) => user.location_id === auth.location_id,
      );
    } else if (locationParam !== null && locationParam !== '') {
      items = items.filter((user) => user.location_id === locationParam);
    }
    return ok(items);
  }),

  http.post(`${API_BASE}/users/security`, async ({ request }) => {
    const auth = getAuthUser(request);
    if (auth === null) {
      return unauthorized();
    }
    if (auth.role === 'security' || auth.role === 'vendor') {
      return fail(
        'FORBIDDEN',
        'Anda tidak memiliki izin untuk menambah petugas.',
        403,
      );
    }
    const body = await readJsonBody(request);
    const nikRejected = rejectSecurityNik(body);
    if (nikRejected !== null) {
      return nikRejected;
    }
    const name = stringField(body, 'name')?.trim() ?? '';
    const email = stringField(body, 'email')?.trim() ?? '';
    const password = stringField(body, 'password') ?? '';
    if (name === '' || email === '' || password === '') {
      return fail(
        'BAD_REQUEST',
        'Nama, email, dan password wajib diisi.',
        400,
      );
    }
    let locationId: string;
    if (auth.role === 'admin') {
      // Lokasi dipaksa ke cabang milik admin; abaikan nilai body.
      if (auth.location_id === null) {
        return fail('BAD_REQUEST', 'Lokasi admin tidak valid.', 400);
      }
      locationId = auth.location_id;
    } else {
      locationId = stringField(body, 'location_id') ?? '';
      if (locationId === '') {
        return fail('BAD_REQUEST', 'Lokasi wajib dipilih.', 400);
      }
    }
    const location = db.locations.find((loc) => loc.id === locationId);
    if (location === undefined) {
      return fail('BAD_REQUEST', 'Lokasi tidak valid.', 400);
    }
    const emailTaken = db.users.some(
      (user) => user.email.toLowerCase() === email.toLowerCase(),
    );
    if (emailTaken) {
      return fail('CONFLICT', 'Email sudah terdaftar.', 409);
    }
    const phone = stringField(body, 'phone') ?? '-';
    const created: User = {
      id: crypto.randomUUID(),
      name,
      email,
      phone,
      nik: null,
      role: 'security',
      location_id: location.id,
      location_name: location.name,
      status: 'active',
      type: 'internal',
      vendor_name: null,
      avatar_url: null,
    };
    db.users.push(created);
    return ok(created, 201);
  }),

  http.patch(
    `${API_BASE}/users/security/:id/status`,
    async ({ request, params }) => {
      const auth = getAuthUser(request);
      if (auth === null) {
        return unauthorized();
      }
      if (auth.role === 'security' || auth.role === 'vendor') {
        return fail(
          'FORBIDDEN',
          'Anda tidak memiliki izin untuk mengubah status petugas.',
          403,
        );
      }
      const id = params['id'];
      if (typeof id !== 'string') {
        return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
      }
      const target = db.users.find(
        (user) => user.id === id && user.role === 'security',
      );
      if (target === undefined) {
        return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
      }
      if (
        auth.role === 'admin' &&
        target.location_id !== auth.location_id
      ) {
        return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
      }
      const body = await readJsonBody(request);
      const status = stringField(body, 'status');
      if (status !== 'active' && status !== 'inactive') {
        return fail(
          'BAD_REQUEST',
          'Status harus "active" atau "inactive".',
          400,
        );
      }
      target.status = status;
      return ok(target);
    },
  ),

  // -- Security users: delete (super_admin semua cabang; admin terkunci cabangnya) --
  http.delete(`${API_BASE}/users/security/:id`, ({ request, params }) => {
    const auth = getAuthUser(request);
    if (auth === null) {
      return unauthorized();
    }
    if (auth.role === 'security' || auth.role === 'vendor') {
      return fail(
        'FORBIDDEN',
        'Anda tidak memiliki izin untuk menghapus petugas.',
        403,
      );
    }
    const id = params['id'];
    if (typeof id !== 'string') {
      return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
    }
    const index = db.users.findIndex(
      (user) => user.id === id && user.role === 'security',
    );
    if (index === -1) {
      return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
    }
    const target = db.users[index] as User;
    if (
      auth.role === 'admin' &&
      (auth.location_id === null || target.location_id !== auth.location_id)
    ) {
      return fail(
        'FORBIDDEN',
        'Anda tidak memiliki izin untuk menghapus petugas di luar cabang Anda.',
        403,
      );
    }
    const referenced =
      db.visits.some((visit) => visit.vendor_user.id === target.id) ||
      db.visits.some((visit) => visit.checked_in_by === target.id);
    if (referenced) {
      return fail(
        'CONFLICT',
        'Petugas masih memiliki kunjungan terkait dan tidak dapat dihapus.',
        409,
      );
    }
    db.users.splice(index, 1);
    return new HttpResponse(null, { status: 204 });
  }),

  // -- Superadmin: fasilitas & cabang (kontrak §2) --------------------------------
  http.post(`${API_BASE}/locations`, async ({ request }) => {
    const auth = getAuthUser(request);
    if (auth === null) {
      return unauthorized();
    }
    if (!isSuperAdminRole(auth.role)) {
      return fail(
        'FORBIDDEN',
        'Anda tidak memiliki izin untuk mengelola fasilitas.',
        403,
      );
    }
    const body = await readJsonBody(request);
    const name = stringField(body, 'name')?.trim() ?? '';
    const type = stringField(body, 'type') ?? '';
    if (name === '' || type === '') {
      return fail('BAD_REQUEST', 'Nama dan tipe fasilitas wajib diisi.', 400);
    }
    if (!LOCATION_TYPES.has(type)) {
      return fail(
        'BAD_REQUEST',
        'Tipe fasilitas harus pusat, cabang, pop, atau minipop.',
        400,
      );
    }
    const timezone = stringField(body, 'timezone') ?? 'WIB';
    if (!LOCATION_TIMEZONES.has(timezone)) {
      return fail(
        'BAD_REQUEST',
        'Zona waktu harus WIB, WITA, atau WIT.',
        400,
      );
    }
    const created: Location = {
      id: crypto.randomUUID(),
      name,
      type: type as Location['type'],
      address: stringField(body, 'address') ?? '',
      city: stringField(body, 'city') ?? '',
      timezone: timezone as Location['timezone'],
      is_active: true,
    };
    db.locations.push(created);
    return ok(created, 201);
  }),

  http.patch(`${API_BASE}/locations/:id`, async ({ request, params }) => {
    const auth = getAuthUser(request);
    if (auth === null) {
      return unauthorized();
    }
    if (!isSuperAdminRole(auth.role)) {
      return fail(
        'FORBIDDEN',
        'Anda tidak memiliki izin untuk mengelola fasilitas.',
        403,
      );
    }
    const id = params['id'];
    if (typeof id !== 'string') {
      return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
    }
    const target = db.locations.find((loc) => loc.id === id);
    if (target === undefined) {
      return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
    }
    const body = await readJsonBody(request);
    if ('name' in body) {
      const name = stringField(body, 'name')?.trim() ?? '';
      if (name === '') {
        return fail('BAD_REQUEST', 'Nama fasilitas tidak boleh kosong.', 400);
      }
      target.name = name;
    }
    if ('type' in body) {
      const type = stringField(body, 'type') ?? '';
      if (!LOCATION_TYPES.has(type)) {
        return fail(
          'BAD_REQUEST',
          'Tipe fasilitas harus pusat, cabang, pop, atau minipop.',
          400,
        );
      }
      target.type = type as Location['type'];
    }
    if ('address' in body) {
      target.address = stringField(body, 'address') ?? '';
    }
    if ('city' in body) {
      target.city = stringField(body, 'city') ?? '';
    }
    if ('timezone' in body) {
      const timezone = stringField(body, 'timezone') ?? '';
      if (!LOCATION_TIMEZONES.has(timezone)) {
        return fail('BAD_REQUEST', 'Zona waktu harus WIB, WITA, atau WIT.', 400);
      }
      target.timezone = timezone as Location['timezone'];
    }
    if ('is_active' in body) {
      const flag = body['is_active'];
      if (typeof flag !== 'boolean') {
        return fail('BAD_REQUEST', 'Status aktif harus true atau false.', 400);
      }
      target.is_active = flag;
    }
    return ok(target);
  }),

  // -- Superadmin: manajemen user & vendor (kontrak §2) ---------------------------
  http.get(`${API_BASE}/users`, async ({ request }) => {
    const auth = getAuthUser(request);
    if (auth === null) {
      return unauthorized();
    }
    if (!isSuperAdminRole(auth.role)) {
      return fail(
        'FORBIDDEN',
        'Anda tidak memiliki izin untuk melihat data pengguna.',
        403,
      );
    }
    await delay(150);
    const url = new URL(request.url);
    const roleParam = url.searchParams.get('role');
    const locationParam = url.searchParams.get('location_id');
    const searchParam = url.searchParams.get('search')?.trim().toLowerCase();
    let items = [...db.users];
    if (roleParam !== null && roleParam !== '') {
      items = items.filter((user) => user.role === roleParam);
    }
    if (locationParam !== null && locationParam !== '') {
      items = items.filter((user) => user.location_id === locationParam);
    }
    if (searchParam !== null && searchParam !== undefined && searchParam !== '') {
      items = items.filter(
        (user) =>
          user.name.toLowerCase().includes(searchParam) ||
          user.email.toLowerCase().includes(searchParam),
      );
    }
    return ok(items);
  }),

  http.post(`${API_BASE}/users`, async ({ request }) => {
    const auth = getAuthUser(request);
    if (auth === null) {
      return unauthorized();
    }
    if (!isSuperAdminRole(auth.role)) {
      return fail(
        'FORBIDDEN',
        'Anda tidak memiliki izin untuk menambah pengguna.',
        403,
      );
    }
    const body = await readJsonBody(request);
    const name = stringField(body, 'name')?.trim() ?? '';
    const email = stringField(body, 'email')?.trim() ?? '';
    const password = stringField(body, 'password') ?? '';
    const role = stringField(body, 'role') ?? '';
    if (name === '' || email === '' || password === '') {
      return fail(
        'BAD_REQUEST',
        'Nama, email, dan password wajib diisi.',
        400,
      );
    }
    if (!MANAGED_ROLES.has(role)) {
      return fail(
        'BAD_REQUEST',
        'Peran harus admin atau vendor.',
        400,
      );
    }
    const emailTaken = db.users.some(
      (user) => user.email.toLowerCase() === email.toLowerCase(),
    );
    if (emailTaken) {
      return fail('CONFLICT', 'Email sudah terdaftar.', 409);
    }
    // NIK wajib + 16 digit + unik untuk admin/vendor (cermin BE).
    const parsedNik = parseRequiredNik(body);
    if ('error' in parsedNik) {
      return parsedNik.error;
    }
    let locationId: string | null = null;
    let locationName: string | null = null;
    let vendorName: string | null = null;
    if (role === 'admin') {
      const requested = stringField(body, 'location_id') ?? '';
      if (requested === '') {
        return fail('BAD_REQUEST', 'Admin wajib memiliki cabang penugasan.', 400);
      }
      const location = db.locations.find((loc) => loc.id === requested);
      if (location === undefined) {
        return fail('BAD_REQUEST', 'Lokasi tidak valid.', 400);
      }
      locationId = location.id;
      locationName = location.name;
      const vendorId = stringField(body, 'vendor_id') ?? '';
      const vendorNameManual = stringField(body, 'vendor_name') ?? '';
      if (vendorId !== '' || vendorNameManual !== '') {
        return fail('BAD_REQUEST', 'vendor_id hanya untuk role vendor.', 400);
      }
    } else {
      // role vendor: vendor_id opsional — resolve ke nama vendor katalog;
      // selain itu `vendor_name` manual dari isian bebas-teks (≤120).
      const vendorId = stringField(body, 'vendor_id') ?? '';
      const vendorNameManual = stringField(body, 'vendor_name') ?? '';
      if (vendorId !== '') {
        const vendor = db.vendors.find((item) => item.id === vendorId);
        if (vendor === undefined) {
          return fail('BAD_REQUEST', 'Vendor tidak valid.', 400);
        }
        vendorName = vendor.name;
      } else if (vendorNameManual.trim() !== '' && vendorNameManual.trim().length <= 120) {
        vendorName = vendorNameManual.trim();
      }
    }
    const phone = stringField(body, 'phone') ?? '-';
    const created: User = {
      id: crypto.randomUUID(),
      name,
      email,
      phone,
      nik: parsedNik.nik,
      role: role as User['role'],
      location_id: locationId,
      location_name: locationName,
      status: 'active',
      type: role === 'admin' ? 'internal' : 'external',
      vendor_name: vendorName,
      avatar_url: null,
    };
    db.users.push(created);
    return ok(created, 201);
  }),

  http.patch(`${API_BASE}/users/:id/status`, async ({ request, params }) => {
    const auth = getAuthUser(request);
    if (auth === null) {
      return unauthorized();
    }
    if (!isSuperAdminRole(auth.role)) {
      return fail(
        'FORBIDDEN',
        'Anda tidak memiliki izin untuk mengubah status pengguna.',
        403,
      );
    }
    const id = params['id'];
    if (typeof id !== 'string') {
      return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
    }
    const target = db.users.find((user) => user.id === id);
    if (target === undefined) {
      return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
    }
    if (target.id === auth.id) {
      return fail(
        'FORBIDDEN',
        'Tidak dapat mengubah status akun sendiri.',
        403,
      );
    }
    if (isSuperAdminRole(target.role)) {
      return fail(
        'FORBIDDEN',
        'Tidak dapat mengubah status akun super_admin.',
        403,
      );
    }
    const body = await readJsonBody(request);
    const status = stringField(body, 'status');
    if (status !== 'active' && status !== 'inactive') {
      return fail(
        'BAD_REQUEST',
        'Status harus "active" atau "inactive".',
        400,
      );
    }
    target.status = status;
    return ok(target);
  }),

  // -- Superadmin: ubah user (parsial; tanpa role/status) ------------------------
  // vendor_id di-resolve ke vendor_name katalog agar dropdown Vendor/Mitra terasa;
  // NIK cermin BE (wajib/format/unik untuk admin/vendor, ditolak lainnya).
  http.patch(`${API_BASE}/users/:id`, async ({ request, params }) => {
    const auth = getAuthUser(request);
    if (auth === null) {
      return unauthorized();
    }
    if (!isSuperAdminRole(auth.role)) {
      return fail(
        'FORBIDDEN',
        'Anda tidak memiliki izin untuk mengubah pengguna.',
        403,
      );
    }
    const id = params['id'];
    if (typeof id !== 'string') {
      return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
    }
    const target = db.users.find((user) => user.id === id);
    if (target === undefined) {
      return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
    }
    const body = await readJsonBody(request);
    const name = stringField(body, 'name');
    const email = stringField(body, 'email');
    const phone = stringField(body, 'phone');
    const locationId = stringField(body, 'location_id');
    const vendorId = stringField(body, 'vendor_id');
    // vendor_name: string = set manual ('' = bersihkan kolom); absen = biarkan.
    const vendorNameField =
      typeof body['vendor_name'] === 'string' ? body['vendor_name'] : undefined;
    const nikProvided = 'nik' in body;
    // Kata sandi hanya divalidasi (mock tak menyimpan hash — BE acuan).
    const password = stringField(body, 'password');
    if (
      name === undefined &&
      email === undefined &&
      phone === undefined &&
      locationId === undefined &&
      vendorId === undefined &&
      vendorNameField === undefined &&
      password === undefined &&
      !nikProvided
    ) {
      return fail('BAD_REQUEST', 'Tidak ada perubahan yang diberikan.', 400);
    }
    if (name !== undefined && name.trim() === '') {
      return fail('BAD_REQUEST', 'Nama tidak boleh kosong.', 400);
    }
    if (email !== undefined && email.trim() === '') {
      return fail('BAD_REQUEST', 'Email tidak boleh kosong.', 400);
    }
    if (password !== undefined && password === '') {
      return fail('BAD_REQUEST', 'Password baru tidak boleh kosong.', 400);
    }
    if (
      target.role === 'admin' &&
      (vendorId !== undefined || vendorNameField !== undefined)
    ) {
      return fail('BAD_REQUEST', 'vendor_id hanya untuk role vendor.', 400);
    }
    if (target.role === 'vendor' && locationId !== undefined) {
      return fail('BAD_REQUEST', 'Role vendor tidak memakai location_id.', 400);
    }
    // NIK cermin BE: ditolak untuk security/super_admin; untuk admin/vendor
    // wajib 16 digit, tak boleh dikosongkan, dan unik.
    let nextNik: string | undefined;
    if (nikProvided) {
      if (target.role !== 'admin' && target.role !== 'vendor') {
        return fail(
          'BAD_REQUEST',
          'NIK hanya berlaku untuk peran admin dan Vendor/Mitra.',
          400,
        );
      }
      const raw = body['nik'];
      const nik = typeof raw === 'string' ? raw.trim() : '';
      if (nik === '') {
        return fail('BAD_REQUEST', 'NIK tidak boleh dikosongkan.', 400);
      }
      if (!NIK_PATTERN.test(nik)) {
        return invalidNikFormat();
      }
      if (db.users.some((user) => user.id !== id && user.nik === nik)) {
        return takenNik();
      }
      nextNik = nik;
    }
    // Anti-pengambilalihan (cermin BE): super_admin lain tak tersentuh;
    // reset diri sendiri wajib buktikan password saat ini (mock: DEMO_PASSWORD).
    if (password !== undefined) {
      if (isSuperAdminRole(target.role) && target.id !== auth.id) {
        return fail('FORBIDDEN', 'Tidak dapat me-reset password super_admin lain.', 403);
      }
      if (target.id === auth.id) {
        const currentPassword = stringField(body, 'current_password');
        if (currentPassword === undefined || currentPassword === '') {
          return fail('BAD_REQUEST', 'Password saat ini wajib diisi untuk mengubah password sendiri.', 400);
        }
        if (currentPassword !== DEMO_PASSWORD) {
          return fail('INVALID_CREDENTIALS', 'Password saat ini salah.', 401);
        }
      }
    }
    if (email !== undefined && db.users.some((user) => user.id !== id && user.email === email)) {
      return fail('CONFLICT', 'Email sudah dipakai akun lain.', 409);
    }
    if (name !== undefined) target.name = name;
    if (email !== undefined) target.email = email;
    if (phone !== undefined) target.phone = phone;
    if (locationId !== undefined) target.location_id = locationId;
    if (nextNik !== undefined) target.nik = nextNik;
    if (target.role === 'vendor') {
      if (vendorId !== undefined) {
        // vendor_id menang bila keduanya ada — resolve ke nama katalog.
        const vendor = db.vendors.find((item) => item.id === vendorId);
        if (vendor === undefined) {
          return fail('BAD_REQUEST', 'Vendor tidak valid.', 400);
        }
        target.vendor_name = vendor.name;
      } else if (vendorNameField !== undefined) {
        const trimmed = vendorNameField.trim();
        if (trimmed.length > 120) {
          return fail('BAD_REQUEST', 'Nama vendor maksimal 120 karakter.', 400);
        }
        // String kosong = bersihkan override; selain itu teks manual.
        target.vendor_name = trimmed === '' ? null : trimmed;
      }
    }
    return ok(target);
  }),

  // -- Security users: ubah pengawas (admin cabang terkunci; super_admin bebas) ----
  http.patch(`${API_BASE}/users/security/:id`, async ({ request, params }) => {
    const auth = getAuthUser(request);
    if (auth === null) {
      return unauthorized();
    }
    if (!isSuperAdminRole(auth.role) && auth.role !== 'admin') {
      return fail(
        'FORBIDDEN',
        'Anda tidak memiliki izin untuk mengubah pengawas.',
        403,
      );
    }
    const id = params['id'];
    if (typeof id !== 'string') {
      return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
    }
    const target = db.users.find((user) => user.id === id);
    if (target === undefined || target.role !== 'security') {
      return fail('NOT_FOUND', 'Akun security tidak ditemukan.', 404);
    }
    if (!isSuperAdminRole(auth.role) && target.location_id !== auth.location_id) {
      return fail(
        'FORBIDDEN_BRANCH',
        'Tidak berhak mengubah akun security dari cabang lain.',
        403,
      );
    }
    const body = await readJsonBody(request);
    const nikRejected = rejectSecurityNik(body);
    if (nikRejected !== null) {
      return nikRejected;
    }
    const name = stringField(body, 'name');
    const email = stringField(body, 'email');
    const phone = stringField(body, 'phone');
    const password = stringField(body, 'password');
    if (
      name === undefined &&
      email === undefined &&
      phone === undefined &&
      password === undefined
    ) {
      return fail('BAD_REQUEST', 'Tidak ada perubahan yang diberikan.', 400);
    }
    if (name !== undefined && name.trim() === '') {
      return fail('BAD_REQUEST', 'Nama tidak boleh kosong.', 400);
    }
    if (email !== undefined && email.trim() === '') {
      return fail('BAD_REQUEST', 'Email tidak boleh kosong.', 400);
    }
    if (password !== undefined && password === '') {
      return fail('BAD_REQUEST', 'Password baru tidak boleh kosong.', 400);
    }
    if (
      email !== undefined &&
      db.users.some((user) => user.id !== id && user.email === email)
    ) {
      return fail('CONFLICT', 'Email sudah dipakai akun lain.', 409);
    }
    if (name !== undefined) target.name = name;
    if (email !== undefined) target.email = email;
    if (phone !== undefined) target.phone = phone;
    return ok(target);
  }),

  // -- Visits: delete (super_admin saja) ---------------------------------------
  http.delete(`${API_BASE}/visits/:id`, ({ request, params }) => {
    const auth = getAuthUser(request);
    if (auth === null) {
      return unauthorized();
    }
    if (!isSuperAdminRole(auth.role)) {
      return fail(
        'FORBIDDEN',
        'Anda tidak memiliki izin untuk menghapus kunjungan.',
        403,
      );
    }
    const id = params['id'];
    if (typeof id !== 'string') {
      return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
    }
    const index = db.visits.findIndex(
      (visit) => visit.id === id || visit.visit_id === id,
    );
    if (index === -1) {
      return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
    }
    db.visits.splice(index, 1);
    return new HttpResponse(null, { status: 204 });
  }),

  // -- Superadmin: hapus user (larangan: diri sendiri & super_admin; 409 bila direferensikan) --
  http.delete(`${API_BASE}/users/:id`, ({ request, params }) => {
    const auth = getAuthUser(request);
    if (auth === null) {
      return unauthorized();
    }
    if (!isSuperAdminRole(auth.role)) {
      return fail(
        'FORBIDDEN',
        'Anda tidak memiliki izin untuk menghapus pengguna.',
        403,
      );
    }
    const id = params['id'];
    if (typeof id !== 'string') {
      return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
    }
    const index = db.users.findIndex((user) => user.id === id);
    if (index === -1) {
      return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
    }
    const target = db.users[index] as User;
    if (target.id === auth.id) {
      return fail(
        'FORBIDDEN',
        'Tidak dapat menghapus akun sendiri.',
        403,
      );
    }
    if (isSuperAdminRole(target.role)) {
      return fail(
        'FORBIDDEN',
        'Tidak dapat menghapus akun super_admin.',
        403,
      );
    }
    const referenced = db.visits.some((visit) => visit.vendor_user.id === target.id);
    if (referenced) {
      return fail(
        'CONFLICT',
        'Pengguna masih memiliki kunjungan terkait dan tidak dapat dihapus.',
        409,
      );
    }
    db.users.splice(index, 1);
    return new HttpResponse(null, { status: 204 });
  }),

  // -- Superadmin: hapus fasilitas (409 bila masih direferensikan) --------------
  http.delete(`${API_BASE}/locations/:id`, ({ request, params }) => {
    const auth = getAuthUser(request);
    if (auth === null) {
      return unauthorized();
    }
    if (!isSuperAdminRole(auth.role)) {
      return fail(
        'FORBIDDEN',
        'Anda tidak memiliki izin untuk menghapus fasilitas.',
        403,
      );
    }
    const id = params['id'];
    if (typeof id !== 'string') {
      return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
    }
    const index = db.locations.findIndex((loc) => loc.id === id);
    if (index === -1) {
      return fail('NOT_FOUND', 'Data yang diminta tidak ditemukan.', 404);
    }
    const usedByVisit = db.visits.some((visit) => visit.location.id === id);
    const usedByUser = db.users.some((user) => user.location_id === id);
    if (usedByVisit || usedByUser) {
      return fail(
        'CONFLICT',
        'Fasilitas masih digunakan oleh kunjungan atau pengguna dan tidak dapat dihapus.',
        409,
      );
    }
    db.locations.splice(index, 1);
    return new HttpResponse(null, { status: 204 });
  }),
];
