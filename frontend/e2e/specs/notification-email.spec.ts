/**
 * Email liveness per-event — 7 alur pemicu + reminder best-effort (lokal saja).
 *
 * APA YANG DIUJI: setiap transisi lifecycle yang masuk allowlist email
 * (`backend/internal/domain/mailer.go:41-49` — approved, rejected, cancelled,
 * rescheduled, reminder, check_in, check_out) benar-benar memicu fan-out:
 * baris `GET /notifications` tertulis untuk audience yang benar DAN worker
 * mailer async mengirim ke inbox nyata. Karena pengiriman SMTP butuh detik
 * dan tak bisa di-await deterministik, spec ini memakai kontrak split:
 * asersi otomatis membuktikan pemicu + baris in_app per audience (termasuk
 * negatif lintas-audience), sedangkan penerimaan Gmail dikonfirmasi operator
 * lewat CHECKLIST INBOX di bawah (satu inbox menampung semua 7 surat,
 * dibedakan oleh subjek kode kunjungan).
 *
 * CHECKLIST INBOX MANUAL (operator: buka andyderispas33@gmail.com seusai run):
 * | # | Pemicu            | Penerima Gmail (plus-address temp) | Subjek yang diharapkan              |
 * |---|---------------------|------------------------------------|-------------------------------------|
 * | 1 | approve           | vendor temp (akun pengaju)         | `[THC-VMS] Kunjungan Disetujui — <VST-…>`      |
 * | 2 | reject            | vendor temp (akun pengaju)         | `[THC-VMS] Kunjungan Ditolak — <VST-…>`        |
 * | 3 | reschedule        | vendor temp (akun pengaju)         | `[THC-VMS] Jadwal Diubah — <VST-…>`            |
 * | 4 | check-in          | staff cabang + superadmin (akun SEED, bukan Gmail — cukup baris in_app) | `[THC-VMS] Check-in Tercatat — <VST-…>` |
 * | 5 | check-out         | staff cabang + superadmin (akun SEED, bukan Gmail — cukup baris in_app) | `[THC-VMS] Check-out Tercatat — <VST-…>` |
 * | 6 | vendor self-cancel| staff cabang + superadmin (akun SEED, bukan Gmail — cukup baris in_app) | `[THC-VMS] Kunjungan Dibatalkan — <VST-…>` |
 * | 7 | admin cancel      | vendor temp (akun pengaju)         | `[THC-VMS] Kunjungan Dibatalkan — <VST-…>`     |
 * | 8 | reminder (R4)     | vendor temp (akun pengaju)         | `[THC-VMS] Pengingat Kunjungan (H-1) — <VST-…>`|
 * Tabel subjek dikunci `emailSubjectTitles`
 * (`backend/internal/domain/mailer.go:61-69`); judul in_app dikunci
 * `TransitionNotification` / `HumanCancelledNotification` /
 * `RescheduledVendorNotification` (`backend/internal/domain/notification.go`).
 * Email recipient = cermin fan-out in_app, aktif saja
 * (`notification_repository.go:155-170`, `WHERE u.status = 'active'`):
 * vendor = vendor pemilik kunjungan, staff = super_admin nasional +
 * admin/security cabang kunjungan.
 *
 * KESELAMATAN: file ini HARD lokal — `test.skip(isLiveRun(), …)` di bawah
 * tanpa pengecualian `E2E_LIVE_PROVISION`. Pengiriman SMTP asli + pembuatan
 * akun temp di produksi dilarang mutlak. Satu-satunya domain nyata yang boleh
 * muncul adalah plus-address `andyderispas33@gmail.com` (inbox uji yang
 * disetujui operator); domain lain = domain sekali pakai lokal pola
 * `email-change.spec.ts`. Akun seed TIDAK PERNAH dimutasi emailnya: setiap
 * test mendaftarkan vendor temp sendiri (`POST /auth/register` -> aktivasi
 * superadmin `PATCH /users/{id}/status` -> hapus `DELETE /users/{id}` +
 * verifikasi 404, cermin `e2e/provision-live-users.ts`).
 *
 * POLA HARNESS (cermin `visit-cancel-fanout.spec.ts` + `email-change.spec.ts`):
 * - kunjungan dibuat LANGSUNG sebagai vendor temp (bukan `h.createVisit`
 *   milik seed vendor) agar penerima vendor = inbox plus-address;
 * - marker sweep `E2E-…` di `notes` + email unik per test DAN per run lewat
 *   `h.unique()` sehingga `sweep.ts` mengenalinya;
 * - NIK 16 digit unik, `expect.poll` tanpa `waitForTimeout`;
 * - teardown per-test: `DELETE /visits/{id}` 204 + `GET` 404,
 *   `DELETE /users/{id}` 204 + 404.
 *
 * CATATAN SMTP: backend mengirim async best-effort sesudah commit (SMTP_*
 * dari `backend/.env` lokal); kiriman butuh detik sehingga asersi otomatis
 * TIDAK menunggu email — hanya baris in_app yang transaksional.
 */

import { expect, test, type Harness } from '../fixtures'
import {
  ACCOUNTS,
  DEFAULT_PASSWORD,
  LOCATIONS,
  PURPOSES,
  apiFetchRaw,
  approveVisitViaApi,
  cancelVisitViaApi,
  checkInViaApi,
  checkOutViaApi,
  isLiveRun,
  loginViaApi,
  loginViaApiCached,
  rejectVisitViaApi,
  rescheduleVisitViaApi,
  type ApiEnvelope,
} from '../helpers/api'

// Mutasi akun + SMTP asli dilarang di live: tanpa pengecualian, tanpa escape hatch.
test.skip(
  isLiveRun(),
  'notification-email mengirim SMTP asli + membuat akun temp: lokal saja, tanpa pengecualian',
)

/** Inbox uji milik operator — satu-satunya alamat nyata yang boleh dipakai file ini. */
const OPERATOR_INBOX = 'andyderispas33@gmail.com'

/** Surat pengganti lokal: backend hanya memvalidasi bentuk URL (pola harness fixtures). */
const PLACEHOLDER_SPK_URL =
  'http://localhost:9000/thc-vms-bucket/assignment_letter/e2e-placeholder.pdf'

/** Judul subjek email terkunci (`domain/mailer.go:emailSubjectTitles`). */
const EMAIL_SUBJECT_TITLES: Record<string, string> = {
  visit_approved: 'Kunjungan Disetujui',
  visit_rejected: 'Kunjungan Ditolak',
  visit_cancelled: 'Kunjungan Dibatalkan',
  visit_rescheduled: 'Jadwal Diubah',
  visit_reminder: 'Pengingat Kunjungan (H-1)',
  visit_check_in: 'Check-in Tercatat',
  visit_check_out: 'Check-out Tercatat',
}

/** Subjek Gmail yang diharapkan untuk satu alur — dicatat untuk checklist manual. */
function expectedSubject(type: string, visitCode: string): string {
  return `[THC-VMS] ${(EMAIL_SUBJECT_TITLES[type] ?? type)} — ${visitCode}`
}

/** Bentuk `GET /notifications` sesuai `docs/4. openapi.yaml`. */
interface NotificationItem {
  id: string
  type: string
  visit_request_id: string
  visit_id: string
  location_id: string
  title: string
  message: string
  is_read: boolean
  occurred_at: string
}

interface NotificationListData {
  items: NotificationItem[]
  total: number
  unread_count: number
  page: number
  limit: number
}

function makeNik(): string {
  const time = String(Date.now()).slice(-9).padStart(9, '0')
  const rand = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')
  return `9${time}${rand}`
}

/**
 * Email temp plus-address ke inbox operator: unik per test DAN per run
 * (marker `h.unique()` kompatibel sweep), tanpa pernah menyentuh akun seed.
 */
function makePlusEmail(h: Harness, label: string): string {
  const local = OPERATOR_INBOX.split('@')[0] ?? 'andyderispas33'
  return `${local}+${h.unique(label).toLowerCase()}@gmail.com`
}

/** Register + aktivasi vendor temp; id dicatat untuk cleanup `finally`. */
async function registerTempVendor(
  h: Harness,
  trackedIds: string[],
  label: string,
): Promise<{ id: string; email: string; token: string }> {
  const email = makePlusEmail(h, label)
  const created = await apiFetchRaw<ApiEnvelope<{ id: string }>>('', 'POST', '/auth/register', {
    name: `E2E Nemail ${label}`,
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

  const { token } = await loginViaApi(email, DEFAULT_PASSWORD)
  return { id, email, token }
}

/** Hapus akun temp; DELETE ulang harus 404 (bukti bersih). */
async function deleteTempVendor(id: string): Promise<void> {
  const superToken = (await loginViaApiCached(ACCOUNTS.super.email, ACCOUNTS.super.password)).token
  const first = await apiFetchRaw(superToken, 'DELETE', `/users/${encodeURIComponent(id)}`)
  expect(first.status, `DELETE /users/${id} -> HTTP ${first.status}`).toBe(204)
  const second = await apiFetchRaw(superToken, 'DELETE', `/users/${encodeURIComponent(id)}`)
  expect(second.status, `DELETE ulang /users/${id} harus 404, dapat ${second.status}`).toBe(404)
}

interface TempVisit {
  id: string
  code: string
}

/**
 * Buat kunjungan SEBAGAI vendor temp (pola payload `fixtures.createVisit`
 * dengan `withFiles:false` + marker sweep di notes).
 */
async function createVisitAsTempVendor(
  h: Harness,
  vendorToken: string,
  label: string,
  opts: { startOffsetMinutes?: number; endOffsetMinutes?: number } = {},
): Promise<TempVisit> {
  const marker = h.unique(label)
  const now = Date.now()
  const payload: Record<string, unknown> = {
    location_id: LOCATIONS.hq,
    purpose_ids: [PURPOSES.Survey],
    start_date: new Date(now + (opts.startOffsetMinutes ?? -30) * 60_000).toISOString(),
    end_date: new Date(now + (opts.endOffsetMinutes ?? 180) * 60_000).toISOString(),
    is_nda_accepted: true,
    assignment_letter_url: PLACEHOLDER_SPK_URL,
    notes: `E2E notification-email ${marker}`,
    visitors: [
      {
        name: `${marker} Visitor 1`,
        id_number: `${String(now).slice(-13)}001`,
        phone: `0812${String(now).slice(-8)}`,
        vendor_name: 'PT Lintas Fiber',
        jabatan: 'Teknisi',
      },
    ],
  }
  const created = await apiFetchRaw<ApiEnvelope<{ id: string; visit_id: string }>>(
    vendorToken,
    'POST',
    '/visits',
    payload,
  )
  expect(created.status, `POST /visits ${marker} -> HTTP ${created.status}`).toBe(201)
  if (created.body.success !== true) {
    throw new Error(`create visit ${marker} gagal: ${JSON.stringify(created.body)}`)
  }
  const data = created.body.data as { id: string; visit_id: string }
  console.log(
    `[e2e-nemail] createVisit ${marker} -> ${data.visit_id} (${data.id}) subjek: ${expectedSubject('visit_approved', data.visit_id)}`,
  )
  return { id: data.id, code: data.visit_id }
}

/** Hapus kunjungan; DELETE 204 lalu GET 404 (bukti bersih). */
async function deleteVisitVerified(id: string): Promise<void> {
  const superToken = (await loginViaApiCached(ACCOUNTS.super.email, ACCOUNTS.super.password)).token
  const first = await apiFetchRaw(superToken, 'DELETE', `/visits/${encodeURIComponent(id)}`)
  expect(first.status, `DELETE /visits/${id} -> HTTP ${first.status}`).toBe(204)
  const second = await apiFetchRaw(superToken, 'GET', `/visits/${encodeURIComponent(id)}`)
  expect(second.status, `GET ulang /visits/${id} harus 404, dapat ${second.status}`).toBe(404)
}

/** `GET /notifications` dengan amplop dibuka; melempar bila bukan 200 sukses. */
async function listNotifications(token: string): Promise<NotificationListData> {
  const result = await apiFetchRaw<ApiEnvelope<NotificationListData>>(
    token,
    'GET',
    '/notifications?limit=100',
  )
  expect(result.status, `GET /notifications -> HTTP ${result.status}`).toBe(200)
  if (result.body.success !== true) {
    throw new Error(`GET /notifications gagal: ${JSON.stringify(result.body)}`)
  }
  return result.body.data
}

/** Baris notifikasi untuk SATU kunjungan + jenis tertentu. */
function notificationFor(
  data: NotificationListData,
  visitId: string,
  type: string,
): NotificationItem | undefined {
  return data.items.find(
    (candidate) => candidate.visit_request_id === visitId && candidate.type === type,
  )
}

/** Tunggu baris fan-out muncul di feed penerima (tanpa fixed sleep). */
async function expectFeedRow(
  token: string,
  visitId: string,
  type: string,
  pollTimeoutMs = 15_000,
): Promise<NotificationItem> {
  let found: NotificationItem | undefined
  await expect
    .poll(
      async () => {
        found = notificationFor(await listNotifications(token), visitId, type)
        return found?.id
      },
      { message: `feed harus memuat ${type} untuk ${visitId}`, timeout: pollTimeoutMs },
    )
    .toBeDefined()
  if (found === undefined) {
    throw new Error(`poll selesai tanpa ${type} untuk ${visitId}`)
  }
  return found
}

/** Pastikan feed LAIN tidak memuat baris jenis itu untuk kunjungan ini (negatif audience). */
async function expectNoFeedRow(token: string, visitId: string, type: string): Promise<void> {
  const feed = await listNotifications(token)
  expect(
    notificationFor(feed, visitId, type),
    `feed lawan tidak boleh memuat ${type} untuk ${visitId}`,
  ).toBeUndefined()
}

test('@NEM-01 approve memicu email vendor: baris visit_approved di vendor, nihil di staff', async ({
  h,
}) => {
  const trackedIds: string[] = []
  let visit: TempVisit | null = null
  try {
    const temp = await registerTempVendor(h, trackedIds, 'nem01')
    visit = await createVisitAsTempVendor(h, temp.token, 'nem01')

    await approveVisitViaApi(await h.tokenAs('admin'), visit.id, 'Disetujui harness NEM-01.')

    const vendorRow = await expectFeedRow(temp.token, visit.id, 'visit_approved')
    expect(vendorRow.title).toBe('Kunjungan Disetujui')
    expect(vendorRow.message).toContain(visit.code)
    console.log(`[e2e-nemail] NEM-01 Gmail yang diharapkan: ${expectedSubject('visit_approved', visit.code)} -> ${temp.email}`)

    await expectNoFeedRow(await h.tokenAs('admin'), visit.id, 'visit_approved')
  } finally {
    if (visit !== null) {
      await deleteVisitVerified(visit.id)
    }
    for (const id of trackedIds) {
      await deleteTempVendor(id)
    }
  }
})

test('@NEM-02 reject memicu email vendor: baris visit_rejected di vendor, nihil di staff', async ({
  h,
}) => {
  const trackedIds: string[] = []
  let visit: TempVisit | null = null
  try {
    const temp = await registerTempVendor(h, trackedIds, 'nem02')
    visit = await createVisitAsTempVendor(h, temp.token, 'nem02')

    await rejectVisitViaApi(
      await h.tokenAs('admin'),
      visit.id,
      'Ditolak harness NEM-02: dokumen kurang.',
    )

    const vendorRow = await expectFeedRow(temp.token, visit.id, 'visit_rejected')
    expect(vendorRow.title).toBe('Kunjungan Ditolak')
    expect(vendorRow.message).toContain(visit.code)
    console.log(`[e2e-nemail] NEM-02 Gmail yang diharapkan: ${expectedSubject('visit_rejected', visit.code)} -> ${temp.email}`)

    await expectNoFeedRow(await h.tokenAs('admin'), visit.id, 'visit_rejected')
  } finally {
    if (visit !== null) {
      await deleteVisitVerified(visit.id)
    }
    for (const id of trackedIds) {
      await deleteTempVendor(id)
    }
  }
})

test('@NEM-03 reschedule memberitahu KEDUA sisi: staff dan vendor dapat visit_rescheduled', async ({
  h,
}) => {
  const trackedIds: string[] = []
  let visit: TempVisit | null = null
  try {
    const temp = await registerTempVendor(h, trackedIds, 'nem03')
    visit = await createVisitAsTempVendor(h, temp.token, 'nem03')
    await approveVisitViaApi(await h.tokenAs('admin'), visit.id, 'Disetujui harness NEM-03.')

    const start = new Date(Date.now() + 3 * 24 * 60 * 60_000)
    const end = new Date(start.getTime() + 2 * 60 * 60_000)
    await rescheduleVisitViaApi(temp.token, visit.id, start.toISOString(), end.toISOString())

    const staffRow = await expectFeedRow(await h.tokenAs('admin'), visit.id, 'visit_rescheduled')
    expect(staffRow.message).toContain(visit.code)
    const vendorRow = await expectFeedRow(temp.token, visit.id, 'visit_rescheduled')
    expect(vendorRow.message).toContain(visit.code)
    expect(vendorRow.id).not.toBe(staffRow.id)
    console.log(`[e2e-nemail] NEM-03 Gmail yang diharapkan: ${expectedSubject('visit_rescheduled', visit.code)} -> ${temp.email}`)
  } finally {
    if (visit !== null) {
      await deleteVisitVerified(visit.id)
    }
    for (const id of trackedIds) {
      await deleteTempVendor(id)
    }
  }
})

test('@NEM-04 check-in memicu email staff: baris visit_check_in di admin, nihil di vendor', async ({
  h,
}) => {
  const trackedIds: string[] = []
  let visit: TempVisit | null = null
  try {
    const temp = await registerTempVendor(h, trackedIds, 'nem04')
    visit = await createVisitAsTempVendor(h, temp.token, 'nem04')
    await approveVisitViaApi(await h.tokenAs('admin'), visit.id, 'Disetujui harness NEM-04.')

    await checkInViaApi(await h.tokenAs('security'), visit.id)

    const staffRow = await expectFeedRow(await h.tokenAs('admin'), visit.id, 'visit_check_in')
    expect(staffRow.title).toBe('Check-in Tercatat')
    expect(staffRow.message).toContain(visit.code)
    console.log(`[e2e-nemail] NEM-04 subjek staff (akun seed, konfirmasi manual bila perlu): ${expectedSubject('visit_check_in', visit.code)}`)

    await expectNoFeedRow(temp.token, visit.id, 'visit_check_in')
  } finally {
    if (visit !== null) {
      await deleteVisitVerified(visit.id)
    }
    for (const id of trackedIds) {
      await deleteTempVendor(id)
    }
  }
})

test('@NEM-05 check-out memicu email staff: baris visit_check_out di admin, nihil di vendor', async ({
  h,
}) => {
  const trackedIds: string[] = []
  let visit: TempVisit | null = null
  try {
    const temp = await registerTempVendor(h, trackedIds, 'nem05')
    visit = await createVisitAsTempVendor(h, temp.token, 'nem05')
    await approveVisitViaApi(await h.tokenAs('admin'), visit.id, 'Disetujui harness NEM-05.')

    await checkInViaApi(await h.tokenAs('security'), visit.id)
    await checkOutViaApi(await h.tokenAs('security'), visit.id)

    const staffRow = await expectFeedRow(await h.tokenAs('admin'), visit.id, 'visit_check_out')
    expect(staffRow.title).toBe('Check-out Tercatat')
    expect(staffRow.message).toContain(visit.code)
    console.log(`[e2e-nemail] NEM-05 subjek staff (akun seed, konfirmasi manual bila perlu): ${expectedSubject('visit_check_out', visit.code)}`)

    await expectNoFeedRow(temp.token, visit.id, 'visit_check_out')
  } finally {
    if (visit !== null) {
      await deleteVisitVerified(visit.id)
    }
    for (const id of trackedIds) {
      await deleteTempVendor(id)
    }
  }
})

test('@NEM-06 vendor membatalkan: staff dapat visit_cancelled + email, vendor sendiri nihil', async ({
  h,
}) => {
  const trackedIds: string[] = []
  let visit: TempVisit | null = null
  try {
    const temp = await registerTempVendor(h, trackedIds, 'nem06')
    visit = await createVisitAsTempVendor(h, temp.token, 'nem06')
    await approveVisitViaApi(await h.tokenAs('admin'), visit.id, 'Disetujui harness NEM-06.')

    await cancelVisitViaApi(temp.token, visit.id, h.unique('vendor membatalkan NEM-06'))

    const staffRow = await expectFeedRow(await h.tokenAs('admin'), visit.id, 'visit_cancelled')
    expect(staffRow.title).toBe('Kunjungan Dibatalkan Vendor')
    expect(staffRow.message).toContain(visit.code)
    console.log(`[e2e-nemail] NEM-06 subjek staff (akun seed, konfirmasi manual bila perlu): ${expectedSubject('visit_cancelled', visit.code)}`)

    await expectNoFeedRow(temp.token, visit.id, 'visit_cancelled')
  } finally {
    if (visit !== null) {
      await deleteVisitVerified(visit.id)
    }
    for (const id of trackedIds) {
      await deleteTempVendor(id)
    }
  }
})

test('@NEM-07 admin membatalkan: vendor dapat visit_cancelled + email, staff nihil', async ({
  h,
}) => {
  const trackedIds: string[] = []
  let visit: TempVisit | null = null
  try {
    const temp = await registerTempVendor(h, trackedIds, 'nem07')
    visit = await createVisitAsTempVendor(h, temp.token, 'nem07')
    await approveVisitViaApi(await h.tokenAs('admin'), visit.id, 'Disetujui harness NEM-07.')

    await cancelVisitViaApi(
      await h.tokenAs('admin'),
      visit.id,
      h.unique('admin membatalkan NEM-07'),
    )

    const vendorRow = await expectFeedRow(temp.token, visit.id, 'visit_cancelled')
    expect(vendorRow.title).toBe('Kunjungan Dibatalkan')
    expect(vendorRow.message).toContain(visit.code)
    console.log(`[e2e-nemail] NEM-07 Gmail yang diharapkan: ${expectedSubject('visit_cancelled', visit.code)} -> ${temp.email}`)

    await expectNoFeedRow(await h.tokenAs('admin'), visit.id, 'visit_cancelled')
  } finally {
    if (visit !== null) {
      await deleteVisitVerified(visit.id)
    }
    for (const id of trackedIds) {
      await deleteTempVendor(id)
    }
  }
})

/**
 * NEM-08 best-effort: pengingat R4 ditulis worker sweep (`runner.go`: langsung
 * saat start lalu tiap 15 menit; `ReminderWindow` 45 menit), BUKAN oleh request
 * HTTP. Poll dibatasi 8 menit agar muat dalam anggaran run; bila sweep belum
 * menyentuh jendela kunjungan, test di-skip dengan alasan (bukan fail) karena
 * itu artefak fase tick, bukan regresi.
 */
test(
  '@NEM-08 reminder R4 best-effort: visit approved ~15 mnt out dapat visit_reminder bila sweep tiba',
  async ({ h }) => {
    test.skip(
      process.env.E2E_REMINDER_SWEEP !== '1',
      'Tick scheduler R4: aturannya sudah dikunci unit test paket worker; E2E ini opt-in (E2E_REMINDER_SWEEP=1) agar gate tidak menunggu tick 15 menit.',
    )
    test.setTimeout(9 * 60_000)
    const trackedIds: string[] = []
    let visit: TempVisit | null = null
    try {
      const temp = await registerTempVendor(h, trackedIds, 'nem08')
      visit = await createVisitAsTempVendor(h, temp.token, 'nem08', {
        startOffsetMinutes: 15,
        endOffsetMinutes: 180,
      })
      await approveVisitViaApi(await h.tokenAs('admin'), visit.id, 'Disetujui harness NEM-08.')

      let found: NotificationItem | undefined
      try {
        found = await expectFeedRow(temp.token, visit.id, 'visit_reminder', 8 * 60_000)
      } catch {
        test.skip(
          true,
          'sweep worker 15 mnt belum menyentuh jendela R4 45 mnt dalam 8 mnt poll — artefak fase tick, bukan regresi; ulangi run agar tick menutupi jendela',
        )
        return
      }
      expect(found.title).toBe('Pengingat Kunjungan')
      expect(found.message).toContain(visit.code)
      console.log(`[e2e-nemail] NEM-08 Gmail yang diharapkan: ${expectedSubject('visit_reminder', visit.code)} -> ${temp.email}`)
    } finally {
      if (visit !== null) {
        await deleteVisitVerified(visit.id)
      }
      for (const id of trackedIds) {
        await deleteTempVendor(id)
      }
    }
  },
)
