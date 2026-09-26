/**
 * Handler MSW v2 (dev-only) yang mereproduksi kontrak OpenAPI THC VMS.
 *
 * v2 only: `http` + `HttpResponse` + `delay`. Titik isolasi multi-cabang
 * (AGENTS.md §6.1) ditegakkan di sini agar pelanggaran terlihat saat dev.
 */

import { delay, http, HttpResponse } from 'msw';
import type { RequestHandler } from 'msw';
import { db, DEMO_PASSWORD } from './seed';
import {
  getCheckinBlockReason,
  isWithinCheckinWindow,
} from '@/lib/visits/tolerance';
import type {
  LoginResult,
  QrPayload,
  UploadFileResult,
  User,
  VisitDetail,
  VisitListResult,
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
// Scoping multi-cabang (AGENTS.md §6.1)
// ---------------------------------------------------------------------------

/** Filter daftar kunjungan sesuai peran pemanggil. */
function scopeVisits(
  user: User,
  locationQuery: string | null,
): VisitDetail[] {
  if (user.role === 'super_admin') {
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
  // PIC hanya melihat kunjungan miliknya sendiri.
  return db.visits.filter((visit) => visit.pic_user.id === user.id);
}

/** `true` bila satu kunjungan boleh dilihat/diaksi pemanggil. */
function isVisitInScope(user: User, visit: VisitDetail): boolean {
  if (user.role === 'super_admin') {
    return true;
  }
  if (user.role === 'admin' || user.role === 'security') {
    return (
      user.location_id !== null && visit.location.id === user.location_id
    );
  }
  return visit.pic_user.id === user.id;
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
    return ok(auth);
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
          visit.pic_user.name.toLowerCase().includes(searchParam),
      );
    }
    const total = items.length;
    const paged = items.slice((page - 1) * limit, page * limit);
    const result: VisitListResult = { items: paged, total, page, limit };
    return ok(result);
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
    const isNdaAccepted = body['is_nda_accepted'];

    const location = db.locations.find((loc) => loc.id === locationId);
    if (location === undefined) {
      return fail('BAD_REQUEST', 'Lokasi wajib dipilih.', 400);
    }
    if (!Array.isArray(purposeIds) || purposeIds.length === 0) {
      return fail('BAD_REQUEST', 'Tujuan kunjungan wajib dipilih.', 400);
    }
    const unknownPurpose = purposeIds.some(
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

    const matchedPurposes = purposeIds.flatMap((id) => {
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
      pic_user: auth,
      vendor_name: auth.vendor_name ?? 'Internal THC',
      start_date: new Date(startMs).toISOString(),
      end_date: new Date(endMs).toISOString(),
      assignment_letter_url: stringField(body, 'assignment_letter_url') ?? null,
      notes: stringField(body, 'notes') ?? null,
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
        return [{ name, id_number: idNumber, phone, id_card_photo_url: photo }];
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
    if (auth.role !== 'super_admin' && auth.role !== 'admin') {
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
    if (auth.role !== 'super_admin' && auth.role !== 'admin') {
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
    if (visit.status !== 'requested' && visit.status !== 'rescheduled') {
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
      if (auth.role === 'pic' && visit.pic_user.id !== auth.id) {
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
    if (auth.role === 'pic' && visit.pic_user.id !== auth.id) {
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
    if (auth.role === 'pic') {
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
    if (auth.role === 'pic') {
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
    if (auth.role === 'security' || auth.role === 'pic') {
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
    if (auth.role === 'security' || auth.role === 'pic') {
      return fail(
        'FORBIDDEN',
        'Anda tidak memiliki izin untuk menambah petugas.',
        403,
      );
    }
    const body = await readJsonBody(request);
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
      role: 'security',
      location_id: location.id,
      location_name: location.name,
      status: 'active',
      type: 'internal',
      vendor_name: null,
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
      if (auth.role === 'security' || auth.role === 'pic') {
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
];
