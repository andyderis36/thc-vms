/**
 * Ganti email mandiri — `POST /auth/email-change/request` (202) +
 * `POST /auth/email-change/confirm` (200) beserta negatifnya.
 *
 * Sumber kebenaran yang dibaca sebelum menulis spec ini (bukan asumsi):
 * - `docs/4. openapi.yaml` §`/auth/email-change/*`: request butuh auth +
 *   `{ new_email, current_password }` -> 202 generik (salah kata sandi 401
 *   `INVALID_CREDENTIALS`); confirm butuh auth + `{ token }` -> 200 `User`,
 *   token basi 400 `INVALID_TOKEN` generik, rate-limit 429 `RATE_LIMITED`.
 * - `backend/internal/delivery/http/handlers/auth_email_change_handler.go`:
 *   strict-body dulu (tanpa `current_password` -> 400 `VALIDATION_ERROR`,
 *   TANPA memakan kuota limiter), limiter sesudahnya; confirm malformed pun
 *   400 generik yang sama agar tak jadi oracle akun.
 * - `backend/internal/delivery/http/router.go:210-211`: KEDUA endpoint di
 *   bawah `authed` — tanpa token -> 401 (dibuktikan @ECHG-01).
 * - `backend/internal/usecase/auth/email_change.go:177-185`: tautan konfirmasi
 *   `.../verify-email?token=<token>` dikirim ke inbox BARU; confirm mengikat
 *   token ke pemanggil + old_email sehingga replay setelah flip gagal generik.
 * - Alur akun temp mengikuti `e2e/provision-live-users.ts`: register publik
 *   `POST /auth/register` (201) -> aktivasi superadmin
 *   `PATCH /users/{id}/status {"status":"active"}` -> hapus
 *   `DELETE /users/{id}` + verifikasi 404.
 * - Domain `@example.com` = Mailpit-only (tidak pernah domain asli), mengikuti
 *   `backend/internal/infrastructure/mailer/mail_e2e_test.go`.
 *
 * KESELAMATAN LIVE: test yang memutasi email akun dilewati saat live kecuali
 * akun e2e provisioned tersedia (`E2E_LIVE_PROVISION=1`, cermin gating
 * `provision-live-users.ts`). Mengubah email akun seed/prod dilarang.
 * @ECHG-03 (rate-limit) SELALU lokal: bucket limiter berbasis IP bersama
 * dengan pengguna nyata di live.
 *
 * ISOLASI RATE-LIMIT (baca sebelum menyentuh file ini):
 * - Dimensi bucket (`middleware/emailchange_ratelimit.go`): request 3/jam
 *   per-user + 10/jam per-IP + 3/jam per-target-email; confirm 10/jam
 *   komposit per-user+IP. `AllowRequest` berkonsultasi ke KETIGA bucket pada
 *   SETIAP panggilan — upaya yang ditolak pun tetap membakar dimensi lain.
 * - Semua test berjalan dari satu IP (127.0.0.1), jadi `req:ip` 10/jam
 *   dipakai BERSAMA antar-test dan antar-run dalam sejam yang sama.
 * - Bakar per-run file ini: ECHG-03 4x (3x202 + 1x429, user+target fresh
 *   miliknya sendiri) + ECHG-01 2x (no-password DAN wrong-password: decode
 *   strict-body hanya menolak unknown-field/body rusak SEBELUM limiter —
 *   key yang HILANG lolos decode lalu 400 dari validasi usecase SETELAH
 *   limiter, jadi ikut membakar 1 hit; 401 tanpa-token tidak mencapai
 *   limiter karena `IdentityFrom` gugur lebih dulu) + ECHG-02 1x (request
 *   sukses) = 7 hit IP. Bucket per-user/per-target selalu
 *   fresh (vendor temp baru + `h.unique()` tiap test dan tiap run); bucket
 *   confirm komposit per-user+IP juga fresh (maks 2 hit/test).
 * - Dua run beruntun = 14 hit > 10: run kedua KEHABISAN budget IP bersama.
 *   Karena itu @ECHG-03 ditaruh PERTAMA (membakar bukti 429-nya saat jendela
 *   masih paling segar; 429 terminalnya SELALU dari bucket user-nya sendiri
 *   yang menolak panggilan ke-4, apa pun kondisi IP) dan SEMUA panggilan ke
 *   kedua endpoint email-change pada test NON-rate-limit dibungkus skip-lunak
 *   (request DAN confirm): 429 TAK TERDUGA berarti budget localhost habis
 *   (environmental), bukan bug — skip dengan alasan, JANGAN fail. Hanya 429
 *   terminal @ECHG-03 yang strict.
 */

import { expect, test, type Harness } from '../fixtures'
import {
  ACCOUNTS,
  DEFAULT_PASSWORD,
  apiFetchRaw,
  isLiveRun,
  loginViaApi,
  loginViaApiCached,
  type ApiEnvelope,
} from '../helpers/api'

// Mutasi email akun dilarang di live kecuali harness provisioned tersedia.
test.skip(
  isLiveRun() && process.env.E2E_LIVE_PROVISION !== '1',
  'email-change memutasi email akun: live run wajib E2E_LIVE_PROVISION=1',
)

/** Alasan skip lunak saat budget IP bersama habis (environmental, bukan bug). */
const SHARED_BUDGET_SKIP = 'shared localhost IP budget exhausted — rerun after an hour'

const MAILPIT_BASE = (process.env.E2E_MAILPIT_BASE_URL ?? 'http://localhost:8025').replace(
  /\/$/,
  '',
)
const VERIFY_LINK_PATTERN = /verify-email\?token=([^"'\s<>`]+)/

function makeNik(): string {
  const time = String(Date.now()).slice(-9).padStart(9, '0')
  const rand = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')
  return `9${time}${rand}`
}

/** Email Mailpit-only: unik per test DAN per run, tidak pernah domain asli. */
function makeExampleEmail(h: Harness, label: string): string {
  return `${h.unique(label).toLowerCase()}@example.com`
}

/** Register + aktivasi vendor temp; id dicatat untuk cleanup `finally`. */
async function registerTempVendor(
  h: Harness,
  trackedIds: string[],
  label: string,
): Promise<{ id: string; email: string }> {
  const email = makeExampleEmail(h, label)
  const created = await apiFetchRaw<ApiEnvelope<{ id: string }>>('', 'POST', '/auth/register', {
    name: `E2E Emailchg ${label}`,
    email,
    password: DEFAULT_PASSWORD,
    nik: makeNik(),
    phone: `0812${String(Date.now()).slice(-8)}`,
  })
  expect(created.status, `POST /auth/register ${email} -> HTTP ${created.status}`).toBe(201)
  if (created.body.success !== true) {
    throw new Error(`register ${email} gagal: ${JSON.stringify(created.body)}`)
  }
  const id = (created.body.data as { id: string }).id
  trackedIds.push(id)

  const superToken = (await loginViaApiCached(ACCOUNTS.super.email, ACCOUNTS.super.password)).token
  const activated = await apiFetchRaw(superToken, 'PATCH', `/users/${encodeURIComponent(id)}/status`, {
    status: 'active',
  })
  expect(activated.status, `aktivasi ${email} -> HTTP ${activated.status}`).toBe(200)
  return { id, email }
}

/** Login sebagai vendor temp (akun unik, tanpa cache proses). */
async function loginTempVendor(email: string): Promise<string> {
  return (await loginViaApi(email, DEFAULT_PASSWORD)).token
}

/** Hapus akun temp; DELETE ulang harus 404 (bukti bersih). */
async function deleteTempVendor(id: string): Promise<void> {
  const superToken = (await loginViaApiCached(ACCOUNTS.super.email, ACCOUNTS.super.password)).token
  const first = await apiFetchRaw(superToken, 'DELETE', `/users/${encodeURIComponent(id)}`)
  expect(first.status, `DELETE /users/${id} -> HTTP ${first.status}`).toBe(204)
  const second = await apiFetchRaw(superToken, 'DELETE', `/users/${encodeURIComponent(id)}`)
  expect(second.status, `DELETE ulang /users/${id} harus 404, dapat ${second.status}`).toBe(404)
}

/** Cari token `verify-email` terbaru untuk inbox di Mailpit; null bila tak ada. */
async function mailpitTokenFor(recipient: string): Promise<string | null> {
  let listResponse: Response
  try {
    listResponse = await fetch(`${MAILPIT_BASE}/api/v1/messages?limit=100`)
  } catch {
    return null
  }
  if (!listResponse.ok) {
    return null
  }
  const listBody = (await listResponse.json()) as {
    messages?: Array<{
      ID?: string
      Subject?: string
      To?: Array<{ Address?: string }>
    }>
  }
  const messages = listBody.messages ?? []
  const want = recipient.toLowerCase()
  for (const summary of messages) {
    const recipients = (summary.To ?? []).map((entry) => (entry.Address ?? '').toLowerCase())
    if (!recipients.includes(want)) {
      continue
    }
    if (summary.Subject !== '[THC-VMS] Verifikasi Alamat Email Baru' || summary.ID === undefined) {
      continue
    }
    const fullResponse = await fetch(`${MAILPIT_BASE}/api/v1/message/${summary.ID}`)
    if (!fullResponse.ok) {
      continue
    }
    const full = (await fullResponse.json()) as { Text?: string; HTML?: string }
    const match = `${full.Text ?? ''}\n${full.HTML ?? ''}`.match(VERIFY_LINK_PATTERN)
    if (match?.[1] !== undefined) {
      return match[1]
    }
  }
  return null
}

function readError(result: { status: number; body: unknown }, expectedStatus: number): {
  code: string
  message: string
} {
  expect(result.status, `HTTP harus ${expectedStatus}`).toBe(expectedStatus)
  const body = result.body
  if (
    typeof body !== 'object' ||
    body === null ||
    (body as { success?: unknown }).success !== false ||
    typeof (body as { error?: unknown }).error !== 'object'
  ) {
    throw new Error(`Amplop galat tidak valid: ${JSON.stringify(body)}`)
  }
  const { code, message } = (body as { error: { code?: unknown; message?: unknown } }).error
  if (typeof code !== 'string' || typeof message !== 'string') {
    throw new Error(`Amplop galat tanpa code/message: ${JSON.stringify(body)}`)
  }
  return { code, message }
}

/**
 * `POST /auth/email-change/request` mentah dengan skip-lunak budget IP:
 * 429 di sini berarti jendela 10/jam `req:ip` bersama sudah habis oleh run
 * sebelumnya (environmental) — lewati test, jangan fail. Status lain
 * diteruskan ke pemanggil untuk asersi strict biasa. Body diwariskan utuh
 * agar bentuk negatif (mis. key hilang) tetap teruji apa adanya.
 */
async function requestRawOrSkip(
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const result = await apiFetchRaw(token, 'POST', '/auth/email-change/request', body)
  if (result.status === 429) {
    test.skip(true, SHARED_BUDGET_SKIP)
  }
  return result
}

/**
 * `POST /auth/email-change/confirm` mentah dengan skip-lunak yang sama.
 * Bucket confirm komposit per-user+IP praktisnya selalu fresh (vendor temp
 * baru, maks 2 hit/test), tetapi penjagaan ini menutup celah akumulasi
 * lintas-run sesuai aturan "NEVER assert-fail on 429".
 */
async function confirmRawOrSkip(
  token: string,
  emailToken: string,
): Promise<{ status: number; body: unknown }> {
  const result = await apiFetchRaw(token, 'POST', '/auth/email-change/confirm', {
    token: emailToken,
  })
  if (result.status === 429) {
    test.skip(true, SHARED_BUDGET_SKIP)
  }
  return result
}

// @ECHG-03 ditaruh PERTAMA dengan sengaja: ia butuh 3x202 + 1x429 dari budget
// IP bersama, jadi ia berjalan saat jendela sejam masih paling segar. 429
// terminalnya dijamin bucket per-user miliknya sendiri (3/jam, user fresh ->
// panggilan ke-4 selalu ditolak) sehingga asersi strict-nya tidak bergantung
// pada sisa budget IP.
test('@ECHG-03 rate-limit: request ke-4 dalam sejam ditolak 429 generik (lokal saja)', async ({
  h,
}) => {
  // Bucket limiter berbasis IP dibagi dengan pengguna nyata di live.
  test.skip(isLiveRun(), 'rate-limit menembak bucket IP bersama: hanya aman di lokal')

  const trackedIds: string[] = []
  try {
    const temp = await registerTempVendor(h, trackedIds, 'echg03')
    const token = await loginTempVendor(temp.email)
    // Target fresh milik test ini: bucket per-target 3/jam ikut menolak
    // panggilan ke-4 bersama bucket per-user — keduanya 429 yang sama.
    const newEmail = makeExampleEmail(h, 'echg03-baru')

    // Kuota per-user 3/jam: tiga request pertama lolos 202 ...
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const raw = await requestRawOrSkip(token, {
        new_email: newEmail,
        current_password: DEFAULT_PASSWORD,
      })
      expect(raw.status, `request ke-${attempt} harus 202`).toBe(202)
      const body = raw.body as { success?: unknown; data?: { message?: unknown } }
      expect(body.success).toBe(true)
      expect(body.data?.message).toBe('Tautan verifikasi telah dikirim ke email baru Anda.')
    }

    // ... request ke-4 menabrak limiter -> 429 RATE_LIMITED generik. Strict:
    // tidak boleh skip di sini; bucket user fresh menjamin 429 apa pun sisa
    // budget IP (429 dari dimensi mana pun berpayload identik).
    const throttled = await apiFetchRaw(token, 'POST', '/auth/email-change/request', {
      new_email: newEmail,
      current_password: DEFAULT_PASSWORD,
    })
    const refusal = readError(throttled, 429)
    expect(refusal.code).toBe('RATE_LIMITED')
  } finally {
    for (const id of trackedIds) {
      await deleteTempVendor(id)
    }
  }
})

test('@ECHG-01 endpoint menolak tanpa token, tanpa kata sandi, kata sandi salah, dan token basi', async ({
  h,
}) => {
  const trackedIds: string[] = []
  try {
    const temp = await registerTempVendor(h, trackedIds, 'echg01')
    const token = await loginTempVendor(temp.email)
    const freshAddress = makeExampleEmail(h, 'echg01-baru')

    // Tanpa token: kedua endpoint di bawah `authed` -> 401 UNAUTHORIZED.
    for (const path of ['/auth/email-change/request', '/auth/email-change/confirm']) {
      const denied = await apiFetchRaw('', 'POST', path, { token: 'apa-pun' })
      const refusal = readError(denied, 401)
      expect(refusal.code).toBe('UNAUTHORIZED')
    }

    // Tanpa `current_password`: key hilang lolos decode strict-body (hanya
    // unknown-field yang ditolak pre-limiter) lalu 400 dari validasi usecase
    // SETELAH limiter — ikut membakar 1 hit budget IP, jadi skip-lunak juga.
    const noPassword = await requestRawOrSkip(token, { new_email: freshAddress })
    expect(readError(noPassword, 400).code).toBe('VALIDATION_ERROR')

    // Kata sandi salah -> 401 INVALID_CREDENTIALS ("Password saat ini salah.").
    // Butuh 1 hit budget IP bersama -> skip lunak bila jendela habis.
    const wrongPassword = await requestRawOrSkip(token, {
      new_email: freshAddress,
      current_password: 'SalahPassword123!',
    })
    const wrongRefusal = readError(wrongPassword, 401)
    expect(wrongRefusal.code).toBe('INVALID_CREDENTIALS')

    // Token basi -> 400 INVALID_TOKEN generik (skip-lunak bila budget habis).
    const stale = await confirmRawOrSkip(token, 'token-basi-yang-tidak-pernah-diterbitkan')
    const staleRefusal = readError(stale, 400)
    expect(staleRefusal.code).toBe('INVALID_TOKEN')
    expect(staleRefusal.message).toBe('Tautan tidak valid atau kedaluwarsa.')
  } finally {
    for (const id of trackedIds) {
      await deleteTempVendor(id)
    }
  }
})

test('@ECHG-02 alur penuh: request link -> Mailpit -> confirm membalik identitas, replay gagal generik', async ({
  h,
}) => {
  const trackedIds: string[] = []
  try {
    const temp = await registerTempVendor(h, trackedIds, 'echg02')
    const token = await loginTempVendor(temp.email)
    const newEmail = makeExampleEmail(h, 'echg02-baru')

    // Butuh 1 hit budget IP bersama -> skip lunak bila jendela habis.
    const requested = await requestRawOrSkip(token, {
      new_email: newEmail,
      current_password: DEFAULT_PASSWORD,
    })
    expect(requested.status, 'request harus 202').toBe(202)
    const requestedBody = requested.body as { success?: unknown; data?: { message?: unknown } }
    expect(requestedBody.success).toBe(true)
    expect(requestedBody.data?.message).toBe('Tautan verifikasi telah dikirim ke email baru Anda.')

    const emailToken = await mailpitTokenFor(newEmail)
    if (emailToken === null) {
      test.skip(true, 'Mailpit :8025 tidak reachable / SMTP_DRY_RUN: token tak bisa diekstrak')
      return
    }

    const confirmed = await confirmRawOrSkip(token, emailToken)
    expect(confirmed.status, 'confirm harus 200').toBe(200)
    const confirmedBody = confirmed.body as { success?: unknown; data?: { email?: unknown } }
    expect(confirmedBody.success).toBe(true)
    expect(confirmedBody.data?.email).toBe(newEmail)

    // Identitas lama mati: login email lama -> 401; email baru hidup.
    const oldLogin = await apiFetchRaw<ApiEnvelope<unknown>>('', 'POST', '/auth/login', {
      email: temp.email,
      password: DEFAULT_PASSWORD,
    })
    expect(oldLogin.status, 'login email lama harus mati').toBe(401)

    const fresh = await loginViaApi(newEmail, DEFAULT_PASSWORD)
    expect(fresh.user.email).toBe(newEmail)

    // Replay token yang sama (dengan sesi baru) -> 400 INVALID_TOKEN generik.
    const replay = await confirmRawOrSkip(fresh.token, emailToken)
    const replayRefusal = readError(replay, 400)
    expect(replayRefusal.code).toBe('INVALID_TOKEN')
    expect(replayRefusal.message).toBe('Tautan tidak valid atau kedaluwarsa.')
  } finally {
    for (const id of trackedIds) {
      await deleteTempVendor(id)
    }
  }
})
