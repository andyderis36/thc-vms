/**
 * E2E profil mandiri (`/profile`) — UI + kontrak `PATCH /auth/me`.
 *
 * Cakupan (tag judul = ID skenario):
 * - @PROF-01 telepon dapat diubah semua peran lalu bertahan setelah reload.
 * - @PROF-02 vendor mengunggah PNG lewat file chooser nyata; avatar presigned.
 * - @PROF-03 foto yang ada dapat dihapus dan `avatar_url` kembali null.
 * - @PROF-04 nama tidak dirender & ditolak 403 untuk non-super_admin.
 * - @PROF-05 super_admin mengganti namanya sendiri lewat UI.
 * - @PROF-06 field terkunci (email/role/nik/location_id) ditolak 400.
 * - @PROF-07 body kosong ditolak 400 VALIDATION_ERROR.
 * - @PROF-08 pintu masuk `/profile` tersedia di keempat shell.
 * - @PROF-09 logout/login UI NYATA: foto admin & super_admin tetap tampil di
 *   avatar sidebar (dibuktikan `naturalWidth > 0`, bukan sekadar `src` ada).
 * - @PROF-10 unggah foto lewat UI memperbarui avatar sidebar TANPA reload.
 * - @PROF-11 foto tampil di tiga permukaan baru: kartu identitas vendor,
 *   navbar kios `lg+`, dan pita ponsel 320px; label "Gate Access Control" hilang.
 * - @PROF-12 nama pengawas + pill shift sebaris di pita kios ponsel (shift
 *   tak terpotong truncation nama), chip lokasi rata KANAN di bawahnya,
 *   dan pita membuka `/profile`.
 * - @PROF-13 `/profile` security memakai tautan kembali ringkas ke `/gate`
 *   tanpa tab gerbang maupun bottom bar kios.
 * - @PROF-14 `/profile` vendor TANPA back link: nol tautan kembali di badan
 *   halaman (`<main>`) maupun di navbar, dan tetap tanpa scroll horizontal
 *   di 375x800 & 320x800; bottom-nav "Kunjungan Saya" tetap berfungsi.
 * - @PROF-15 chip profil vendor SHELL-04: ikon saja di desktop & ponsel,
 *   nama penuh tampil di tablet.
 *
 * KESELAMATAN DATA: setiap test yang memutasi profil membaca `GET /auth/me`
 * lebih dulu, lalu mengembalikan `name`/`phone`/`avatar_url` asli di `finally`.
 * `name` hanya ikut dikirim bila peran memang boleh mengubahnya (super_admin);
 * mengirimnya untuk peran lain akan ditolak 403 dan membuat cleanup gagal.
 *
 * ANGGARAN LOGIN UI: `@PROF-09` memakai TEPAT 3 login UI nyata (admin, admin
 * setelah logout, super_admin) — backend membatasi `/auth/login` 5/menit/IP
 * dan helper API memakai cache token proses, jadi tidak ada login tambahan.
 */

import type { BrowserContext, Locator, Page, Response } from '@playwright/test'
import { expect, test, type Harness } from '../fixtures'
import {
  ACCOUNTS,
  API_BASE,
  FRONTEND_BASE,
  LOCATIONS,
  apiFetchRaw,
  uploadFileViaApi,
  type ApiEnvelope,
  type Role,
} from '../helpers/api'
import { pngBuffer } from '../helpers/assets'

/** Bentuk `User` dari openapi yang dipakai spec ini. */
interface ProfileUser {
  id: string
  name: string
  email: string
  phone: string
  role: string
  location_id: string | null
  location_name: string | null
  vendor_name: string | null
  avatar_url?: string | null
  editable_fields?: string[]
}

interface ProfileSnapshot {
  role: Role
  name: string
  phone: string
  avatarUrl: string | null
  /** `true` hanya untuk super_admin; menentukan apakah `name` ikut direstore. */
  nameEditable: boolean
}

let phoneSequence = 0

/** Nomor HP valid & unik: `08` + 9 digit (pola `0[0-9]{8,13}`). */
function uniquePhone(): string {
  phoneSequence += 1
  const suffix = `${String(Date.now()).slice(-7)}${String(phoneSequence).padStart(2, '0')}`
  return `08${suffix}`
}

/** Inisial maksimal 2 huruf — cermin placeholder avatar di `ProfileForm`. */
function initialsOf(name: string): string {
  const initials = name
    .split(/\s+/)
    .filter((part) => part !== '')
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('')
  return initials === '' ? '?' : initials
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function expectSuccess<T>(body: ApiEnvelope<T>, context: string): T {
  if (!body.success) {
    throw new Error(
      `[e2e-profile] ${context} gagal: ${body.error.code} - ${body.error.message}`,
    )
  }
  return body.data
}

/** `GET /auth/me` — sumber kebenaran sesi (termasuk avatar presigned). */
async function readMe(h: Harness, role: Role): Promise<ProfileUser> {
  const token = await h.tokenAs(role)
  const result = await apiFetchRaw<ApiEnvelope<ProfileUser>>(token, 'GET', '/auth/me')
  if (result.status !== 200) {
    throw new Error(
      `[e2e-profile] GET /auth/me (${role}) -> HTTP ${result.status}: ${JSON.stringify(result.body)}`,
    )
  }
  return expectSuccess(result.body, `GET /auth/me (${role})`)
}

async function snapshotProfile(h: Harness, role: Role): Promise<ProfileSnapshot> {
  const me = await readMe(h, role)
  return {
    role,
    name: me.name,
    phone: me.phone,
    avatarUrl: me.avatar_url ?? null,
    // Fallback untuk binary lama yang belum mengirim `editable_fields`.
    nameEditable: me.editable_fields?.includes('name') ?? role === 'super',
  }
}

async function patchMe(
  h: Harness,
  role: Role,
  body: Record<string, unknown>,
): Promise<{ status: number; body: ApiEnvelope<ProfileUser> }> {
  const token = await h.tokenAs(role)
  return apiFetchRaw<ApiEnvelope<ProfileUser>>(token, 'PATCH', '/auth/me', body)
}

/**
 * Kembalikan snapshot asli. Kegagalan cleanup dicatat, bukan dilempar, agar
 * kegagalan asersi utama tidak tertutup oleh error restore.
 */
async function restoreProfile(h: Harness, snapshot: ProfileSnapshot): Promise<void> {
  try {
    const body: Record<string, unknown> = {
      phone: snapshot.phone,
      avatar_url: snapshot.avatarUrl,
    }
    if (snapshot.nameEditable) {
      body.name = snapshot.name
    }
    const result = await patchMe(h, snapshot.role, body)
    console.log(
      `[e2e-profile] restore ${snapshot.role} -> HTTP ${result.status}${result.status === 200 ? '' : ` ${JSON.stringify(result.body)}`}`,
    )
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.log(`[e2e-profile] restore ${snapshot.role} gagal: ${reason}`)
  }
}

function isProfilePatch(response: Response): boolean {
  if (response.request().method() !== 'PATCH') return false
  return new URL(response.url()).pathname.endsWith('/auth/me')
}

function isUpload(response: Response): boolean {
  if (response.request().method() !== 'POST') return false
  return new URL(response.url()).pathname.endsWith('/uploads')
}

/** Klik "Simpan Perubahan" lalu kembalikan status respons PATCH. */
async function clickSave(page: Page): Promise<number> {
  const patched = page.waitForResponse(isProfilePatch)
  await page.getByRole('button', { name: 'Simpan Perubahan', exact: true }).click()
  return (await patched).status()
}

async function expectToast(page: Page, text: string): Promise<void> {
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: text }).first(),
  ).toBeVisible()
}

async function openProfilePage(page: Page): Promise<void> {
  await page.goto('/profile')
  await expect(
    page.getByRole('heading', { name: 'Profil Saya', exact: true }),
  ).toBeVisible()
}

/**
 * Pemicu `ProfileMenu` milik shell sidebar. `NotificationsMenu` juga memakai
 * `aria-haspopup="menu"`, jadi filter `span[role="img"]` (avatar) memastikan
 * yang terpilih adalah menu akun, bukan lonceng notifikasi.
 */
function sidebarTrigger(page: Page): Locator {
  return page
    .locator('button[aria-haspopup="menu"]')
    .filter({ has: page.locator('span[role="img"]') })
    .first()
}

/** Avatar di dalam pemicu menu akun (`<img>` hanya ada bila avatarUrl terisi). */
function sidebarAvatarImg(page: Page): Locator {
  return page.locator('button[aria-haspopup="menu"] span[role="img"] img').first()
}

/**
 * `src` presigned yang ada tapi gagal diambil (403/kedaluwarsa) tidak boleh
 * lulus — `naturalWidth` 0 membuktikan gambar benar-benar termuat.
 */
async function expectSidebarAvatarLoaded(page: Page): Promise<void> {
  const avatar = sidebarAvatarImg(page)
  await expect(avatar).toBeVisible()
  const src = await avatar.getAttribute('src')
  expect(src, 'avatar sidebar harus punya src').not.toBeNull()
  expect(src ?? '').toMatch(/^https?:\/\//)
  await expect
    .poll(() => avatar.evaluate((el) => (el instanceof HTMLImageElement ? el.naturalWidth : 0)))
    .toBeGreaterThan(0)
}

async function uiLogin(page: Page, role: Role): Promise<void> {
  const account = ACCOUNTS[role]
  await page.goto('/login')
  await expect(page.getByRole('heading', { name: 'Masuk', exact: true })).toBeVisible()
  // `Input` menandai field `required` dengan bintang di dalam `<label>`, jadi
  // accessible name-nya "Email *"/"Kata Sandi *" dan `getByLabel(..., exact)`
  // tidak cocok. Pilih berdasarkan tipe input agar stabil.
  await page.locator('input[type="email"]').fill(account.email)
  await page.locator('input[type="password"]').fill(account.password)
  await page.getByRole('button', { name: 'Masuk', exact: true }).click()
  await page.waitForURL((url) => url.pathname === '/dashboard')
}

async function uiLogout(page: Page): Promise<void> {
  await sidebarTrigger(page).click()
  const logoutItem = page.getByRole('menuitem', { name: 'Keluar', exact: true })
  await expect(logoutItem).toBeVisible()
  await logoutItem.click()
  await page.waitForURL((url) => url.pathname === '/login')
}

async function ensureAvatar(
  h: Harness,
  role: Role,
  snapshot: ProfileSnapshot,
): Promise<void> {
  if (snapshot.avatarUrl !== null) {
    return
  }
  const token = await h.tokenAs(role)
  const uploaded = await uploadFileViaApi(token, 'profile_photo', {
    name: `profil-${h.unique(`PROFAVATAR-${role}`)}.png`,
    mimeType: 'image/png',
    buffer: pngBuffer(),
  })
  const seeded = await patchMe(h, role, { avatar_url: uploaded.fileUrl })
  expect(seeded.status, `seed avatar ${role}`).toBe(200)
}

/**
 * Buka `/profile` dari pintu masuk masing-masing shell. Untuk vendor di
 * 360x800 pintu masuknya adalah chip ikon; ukurannya wajib >= 40px agar
 * regresi `display:none` langsung gagal.
 */
async function assertShellEntry(
  h: Harness,
  role: Role,
  label: string,
  path: string,
  viewport?: { width: number; height: number },
): Promise<void> {
  const page = await h.openAs(role)
  if (viewport !== undefined) {
    await page.setViewportSize(viewport)
  }
  await page.goto(path)

  if (role === 'super' || role === 'admin') {
    const trigger = page
      .locator('button[aria-haspopup="menu"]')
      .filter({ hasText: label })
      .first()
    await expect(trigger).toBeVisible()
    await trigger.click()
    const item = page.getByRole('menuitem', { name: 'Profil', exact: true })
    await expect(item).toBeVisible()
    await item.click()
  } else {
    const entry = page.getByRole('link', { name: `Profil ${label}`, exact: true })
    await expect(entry).toBeVisible()
    if (role === 'vendor') {
      const box = await entry.boundingBox()
      expect(box, 'chip profil vendor harus punya kotak terukur').not.toBeNull()
      if (box !== null) {
        expect(box.width).toBeGreaterThanOrEqual(40)
        expect(box.height).toBeGreaterThanOrEqual(40)
      }
    }
    await entry.click()
  }

  await expect(page).toHaveURL(/\/profile$/)
  await expect(
    page.getByRole('heading', { name: 'Profil Saya', exact: true }),
  ).toBeVisible()
}

// ---------------------------------------------------------------------------
// Skenario
// ---------------------------------------------------------------------------

test('@PROF-01 nomor telepon diperbarui lewat UI dan bertahan setelah reload untuk super, admin, security, vendor', async ({
  h,
}) => {
  const roles: Role[] = ['super', 'admin', 'security', 'vendor']
  const snapshots: ProfileSnapshot[] = []

  try {
    for (const role of roles) {
      const snapshot = await snapshotProfile(h, role)
      snapshots.push(snapshot)
      const nextPhone = uniquePhone()
      expect(nextPhone).not.toBe(snapshot.phone)

      const page = await h.openAs(role)
      await openProfilePage(page)

      const phoneInput = page.getByLabel('No. Telepon')
      await expect(phoneInput).toBeVisible()
      await expect(phoneInput).toHaveValue(snapshot.phone)
      await phoneInput.fill(nextPhone)

      expect(await clickSave(page), `PATCH phone ${role}`).toBe(200)
      await expectToast(page, 'Profil berhasil diperbarui.')

      await page.reload()
      await expect(
        page.getByRole('heading', { name: 'Profil Saya', exact: true }),
      ).toBeVisible()
      await expect(page.getByLabel('No. Telepon')).toHaveValue(nextPhone)

      const me = await readMe(h, role)
      expect(me.phone).toBe(nextPhone)
      expect(me.editable_fields).toContain('phone')
    }
  } finally {
    for (const snapshot of [...snapshots].reverse()) {
      await restoreProfile(h, snapshot)
    }
  }
})

test('@PROF-02 vendor mengunggah foto profil PNG lewat file chooser dan avatar presigned tersimpan', async ({
  h,
}) => {
  const snapshot = await snapshotProfile(h, 'vendor')

  try {
    const page = await h.openAs('vendor')
    await openProfilePage(page)

    const chooserPromise = page.waitForEvent('filechooser')
    const uploadPromise = page.waitForResponse(isUpload)
    const patchPromise = page.waitForResponse(isProfilePatch)

    await page.getByRole('button', { name: 'Unggah foto', exact: true }).click()
    const chooser = await chooserPromise
    await chooser.setFiles({
      name: `profil-${h.unique('PROF02')}.png`,
      mimeType: 'image/png',
      buffer: pngBuffer(),
    })

    const [uploadResponse, patchResponse] = await Promise.all([
      uploadPromise,
      patchPromise,
    ])
    expect(uploadResponse.status()).toBe(201)
    expect(patchResponse.status()).toBe(200)

    const preview = page.getByRole('img', { name: `Foto profil ${snapshot.name}` })
    await expect(preview).toBeVisible()
    await expect(preview).toHaveAttribute('src', /\?/)
    await expect(page.getByRole('button', { name: 'Hapus foto' })).toBeVisible()
    await expectToast(page, 'Foto profil berhasil diperbarui.')

    const me = await readMe(h, 'vendor')
    const avatarUrl = me.avatar_url ?? null
    expect(avatarUrl).not.toBeNull()
    if (avatarUrl === null) {
      throw new Error('[e2e-profile] avatar_url vendor tetap null setelah unggah.')
    }
    expect(avatarUrl.length).toBeGreaterThan(0)
    expect(new URL(avatarUrl).search.length).toBeGreaterThan(0)
  } finally {
    await restoreProfile(h, snapshot)
  }
})

test('@PROF-03 foto profil yang ada dapat dihapus dan avatar_url kembali null', async ({
  h,
}) => {
  const snapshot = await snapshotProfile(h, 'vendor')

  try {
    const token = await h.tokenAs('vendor')
    if (snapshot.avatarUrl === null) {
      const uploaded = await uploadFileViaApi(token, 'profile_photo', {
        name: `profil-${h.unique('PROF03')}.png`,
        mimeType: 'image/png',
        buffer: pngBuffer(),
      })
      const seeded = await patchMe(h, 'vendor', { avatar_url: uploaded.fileUrl })
      expect(seeded.status, 'seed avatar untuk PROF-03').toBe(200)
    }

    const page = await h.openAs('vendor')
    await openProfilePage(page)

    await expect(
      page.getByRole('img', { name: `Foto profil ${snapshot.name}` }),
    ).toBeVisible()
    const removeButton = page.getByRole('button', { name: 'Hapus foto', exact: true })
    await expect(removeButton).toBeVisible()

    const patched = page.waitForResponse(isProfilePatch)
    await removeButton.click()
    expect((await patched).status()).toBe(200)

    await expect(
      page.getByRole('img', { name: `Foto profil ${snapshot.name}` }),
    ).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Hapus foto' })).toHaveCount(0)
    await expect(page.getByText(initialsOf(snapshot.name), { exact: true })).toBeVisible()
    await expectToast(page, 'Foto profil berhasil dihapus.')

    const me = await readMe(h, 'vendor')
    expect(me.avatar_url ?? null).toBeNull()
  } finally {
    await restoreProfile(h, snapshot)
  }
})

test('@PROF-04 nama tidak dapat diubah admin, security, dan vendor (UI & API 403)', async ({
  h,
}) => {
  const roles: Role[] = ['admin', 'security', 'vendor']
  const snapshots: ProfileSnapshot[] = []

  try {
    for (const role of roles) {
      const snapshot = await snapshotProfile(h, role)
      snapshots.push(snapshot)

      const page = await h.openAs(role)
      await openProfilePage(page)
      await expect(page.getByLabel('Nama Lengkap')).toHaveCount(0)

      const attempted = await patchMe(h, role, { name: `${snapshot.name} Diubah` })
      expect(attempted.status, `PATCH name ${role}`).toBe(403)
      if (attempted.body.success) {
        throw new Error(`[e2e-profile] ${role} berhasil mengubah name (harus 403).`)
      }
      expect(attempted.body.error.code).toBe('FORBIDDEN')

      const me = await readMe(h, role)
      expect(me.name).toBe(snapshot.name)
      expect(me.editable_fields).not.toContain('name')
    }
  } finally {
    for (const snapshot of [...snapshots].reverse()) {
      await restoreProfile(h, snapshot)
    }
  }
})

test('@PROF-05 super_admin mengganti namanya sendiri lewat UI dan GET /auth/me mencerminkannya', async ({
  h,
}) => {
  const snapshot = await snapshotProfile(h, 'super')
  const nextName = `${h.unique('PROF05')} Superadmin`

  try {
    const page = await h.openAs('super')
    await openProfilePage(page)

    const nameInput = page.getByLabel('Nama Lengkap')
    await expect(nameInput).toBeVisible()
    await expect(nameInput).toHaveValue(snapshot.name)
    await nameInput.fill(nextName)

    expect(await clickSave(page), 'PATCH name super_admin').toBe(200)
    await expectToast(page, 'Profil berhasil diperbarui.')

    const me = await readMe(h, 'super')
    expect(me.name).toBe(nextName)
    expect(me.editable_fields).toContain('name')
  } finally {
    await restoreProfile(h, snapshot)
  }
})

test('@PROF-06 field email, role, nik, dan location_id ditolak 400 VALIDATION_ERROR', async ({
  h,
}) => {
  const snapshot = await snapshotProfile(h, 'vendor')
  const lockedFields: Array<{ field: string; body: Record<string, unknown> }> = [
    { field: 'email', body: { email: 'locked-profile@example.com' } },
    { field: 'role', body: { role: 'admin' } },
    { field: 'nik', body: { nik: '1234567890123456' } },
    { field: 'location_id', body: { location_id: LOCATIONS.hq } },
  ]

  try {
    for (const locked of lockedFields) {
      const result = await patchMe(h, 'vendor', locked.body)
      expect(result.status, `PATCH field terkunci ${locked.field}`).toBe(400)
      if (result.body.success) {
        throw new Error(`[e2e-profile] field ${locked.field} diterima (harus 400).`)
      }
      expect(result.body.error.code).toBe('VALIDATION_ERROR')
    }

    const page = await h.openAs('vendor')
    await openProfilePage(page)
    await expect(page.getByLabel('Email')).toHaveCount(0)
    await expect(page.getByLabel('Peran')).toHaveCount(0)
    await expect(page.getByLabel('Kata Sandi')).toHaveCount(0)
    await expect(page.locator('input[type="password"]')).toHaveCount(0)
    await expect(page.locator('input[type="email"]')).toHaveCount(0)
    await expect(page.locator('select')).toHaveCount(0)
  } finally {
    await restoreProfile(h, snapshot)
  }
})

test('@PROF-07 body kosong PATCH /auth/me ditolak 400 VALIDATION_ERROR', async ({ h }) => {
  const snapshot = await snapshotProfile(h, 'vendor')

  try {
    const api = await h.apiAs('vendor')
    const response = await api.patch(`${API_BASE}/auth/me`, { data: {} })
    expect(response.status()).toBe(400)

    const body: unknown = await response.json()
    if (!isRecord(body) || body.success !== false) {
      throw new Error(
        `[e2e-profile] PATCH /auth/me {} tidak mengembalikan amplop gagal: ${JSON.stringify(body)}`,
      )
    }
    if (!isRecord(body.error)) {
      throw new Error('[e2e-profile] amplop gagal tanpa objek error yang valid.')
    }
    expect(body.error.code).toBe('VALIDATION_ERROR')
  } finally {
    await restoreProfile(h, snapshot)
  }
})

test('@PROF-08 /profile terjangkau dari keempat shell dan chip profil vendor di 360x800 minimal 40px', async ({
  h,
}) => {
  const superProfile = await readMe(h, 'super')
  const adminProfile = await readMe(h, 'admin')
  const securityProfile = await readMe(h, 'security')
  const vendorProfile = await readMe(h, 'vendor')
  const vendorLabel = vendorProfile.vendor_name
  expect(vendorLabel).not.toBeNull()
  if (vendorLabel === null) {
    throw new Error('[e2e-profile] vendor_name seed kosong; nama aksesibel chip tak dapat diprediksi.')
  }

  await assertShellEntry(h, 'super', superProfile.name, '/dashboard')
  await assertShellEntry(h, 'admin', adminProfile.name, '/dashboard')
  await assertShellEntry(h, 'security', securityProfile.name, '/gate')
  await assertShellEntry(h, 'vendor', vendorLabel, '/dashboard', {
    width: 360,
    height: 800,
  })
})

test('@PROF-09 foto profil bertahan setelah logout/login UI nyata untuk admin dan super_admin', async ({
  h,
  page,
}) => {
  // ANGGARAN LOGIN UI: tepat 3 login nyata (admin, admin setelah logout,
  // super_admin) — backend membatasi /auth/login 5/menit/IP.
  const adminSnapshot = await snapshotProfile(h, 'admin')
  const superSnapshot = await snapshotProfile(h, 'super')

  const browser = page.context().browser()
  expect(browser, 'browser harus tersedia dari context fixture').not.toBeNull()
  if (browser === null) {
    throw new Error('[e2e-profile] browser tidak tersedia untuk context bersih.')
  }

  let cleanContext: BrowserContext | null = null

  try {
    await ensureAvatar(h, 'admin', adminSnapshot)
    await ensureAvatar(h, 'super', superSnapshot)

    // Context bersih TANPA storageState: satu-satunya jalan masuk adalah UI.
    cleanContext = await browser.newContext({ baseURL: FRONTEND_BASE })
    const uiPage = await cleanContext.newPage()

    await uiLogin(uiPage, 'admin')
    await expectSidebarAvatarLoaded(uiPage)

    // Regresi yang dilaporkan: logout lalu login lagi menghilangkan foto.
    await uiLogout(uiPage)
    await uiLogin(uiPage, 'admin')
    await expectSidebarAvatarLoaded(uiPage)

    await uiPage.goto('/profile')
    await expect(
      uiPage.getByRole('img', { name: `Foto profil ${adminSnapshot.name}` }),
    ).toBeVisible()

    // Logout bukan login; login UI #3 baru milik super_admin.
    await uiLogout(uiPage)
    await uiLogin(uiPage, 'super')
    await expectSidebarAvatarLoaded(uiPage)
  } finally {
    if (cleanContext !== null) {
      await cleanContext.close()
    }
    await restoreProfile(h, superSnapshot)
    await restoreProfile(h, adminSnapshot)
  }
})

test('@PROF-10 unggah foto profil lewat UI memperbarui avatar sidebar tanpa reload', async ({
  h,
}) => {
  const snapshot = await snapshotProfile(h, 'admin')

  try {
    // Avatar wajib ada sebelum unggah agar asersi "src berubah" bermakna.
    await ensureAvatar(h, 'admin', snapshot)

    const page = await h.openAs('admin')
    await openProfilePage(page)

    const avatar = sidebarAvatarImg(page)
    await expect(avatar).toBeVisible()
    await expect
      .poll(() => avatar.evaluate((el) => (el instanceof HTMLImageElement ? el.naturalWidth : 0)))
      .toBeGreaterThan(0)
    const srcBefore = await avatar.getAttribute('src')
    expect(srcBefore, 'avatar sidebar harus punya src sebelum unggah').not.toBeNull()

    const chooserPromise = page.waitForEvent('filechooser')
    const uploadPromise = page.waitForResponse(isUpload)
    const patchPromise = page.waitForResponse(isProfilePatch)

    await page.getByRole('button', { name: 'Unggah foto', exact: true }).click()
    const chooser = await chooserPromise
    await chooser.setFiles({
      name: `profil-${h.unique('PROF10')}.png`,
      mimeType: 'image/png',
      buffer: pngBuffer(),
    })

    const [uploadResponse, patchResponse] = await Promise.all([
      uploadPromise,
      patchPromise,
    ])
    expect(uploadResponse.status()).toBe(201)
    expect(patchResponse.status()).toBe(200)

    // Tanpa page.reload(): sesi di-refresh oleh useUpdateProfileMutation.
    await expect.poll(() => avatar.getAttribute('src')).not.toBe(srcBefore)
    await expect
      .poll(() => avatar.evaluate((el) => (el instanceof HTMLImageElement ? el.naturalWidth : 0)))
      .toBeGreaterThan(0)

    const srcAfter = await avatar.getAttribute('src')
    expect(srcAfter ?? '').toMatch(/^https?:\/\//)
    await expectToast(page, 'Foto profil berhasil diperbarui.')
  } finally {
    await restoreProfile(h, snapshot)
  }
})


test('@PROF-11 avatar vendor di kartu dashboard + avatar pengawas di navbar dan pita ponsel', async ({
  h,
}) => {
  const vendorSnapshot = await snapshotProfile(h, 'vendor')
  const securitySnapshot = await snapshotProfile(h, 'security')

  try {
    await ensureAvatar(h, 'vendor', vendorSnapshot)
    await ensureAvatar(h, 'security', securitySnapshot)

    // ---- A. Vendor desktop 1280x800: kartu identitas menampilkan foto -----
    const vendor = await h.openAs('vendor')
    await vendor.setViewportSize({ width: 1280, height: 800 })
    await vendor.goto('/dashboard')

    const card = vendor.locator('section[aria-label="Identitas Vendor/Mitra"]')
    await expect(card).toBeVisible()
    const vendorAvatar = card.locator('[data-avatar-state="image"] img')
    await expect(vendorAvatar).toBeVisible()
    const vendorSrc = await vendorAvatar.getAttribute('src')
    expect(vendorSrc ?? '').toMatch(/^https?:\/\//)
    await expect
      .poll(() =>
        vendorAvatar.evaluate((el) =>
          el instanceof HTMLImageElement ? el.naturalWidth : 0,
        ),
      )
      .toBeGreaterThan(0)
    await expect(card.getByText(vendorSnapshot.name, { exact: true })).toBeVisible()

    // ---- B. Vendor ponsel 320x800: kartu tetap utuh tanpa scroll samping --
    await vendor.setViewportSize({ width: 320, height: 800 })
    await vendor.goto('/dashboard')

    const mobileCard = vendor.locator('section[aria-label="Identitas Vendor/Mitra"]')
    await expect(mobileCard).toBeVisible()
    const mobileVendorAvatar = mobileCard.locator('[data-avatar-state="image"] img')
    await expect(mobileVendorAvatar).toBeVisible()
    await expect
      .poll(() =>
        mobileVendorAvatar.evaluate((el) =>
          el instanceof HTMLImageElement ? el.naturalWidth : 0,
        ),
      )
      .toBeGreaterThan(0)
    expect(
      await vendor.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      'dashboard vendor 320px tidak boleh overflow horizontal',
    ).toBe(true)

    // ---- C. Security desktop 1280x800: avatar tepat di kiri nama navbar --
    const security = await h.openAs('security')
    await security.setViewportSize({ width: 1280, height: 800 })
    await security.goto('/gate')

    const header = security.locator('header').first()
    const headerAvatar = security.locator('header [data-avatar-state="image"] img').first()
    await expect(headerAvatar).toBeVisible()
    await expect
      .poll(() =>
        headerAvatar.evaluate((el) =>
          el instanceof HTMLImageElement ? el.naturalWidth : 0,
        ),
      )
      .toBeGreaterThan(0)

    const nameLink = security.locator('header a[aria-label^="Profil "]')
    await expect(nameLink).toBeVisible()
    await expect(nameLink).toHaveAccessibleName(`Profil ${securitySnapshot.name}`)

    const desktopAvatarBox = await headerAvatar.boundingBox()
    const desktopNameBox = await nameLink.boundingBox()
    expect(desktopAvatarBox, 'avatar navbar harus punya kotak terukur').not.toBeNull()
    expect(desktopNameBox, 'nama pengawas harus punya kotak terukur').not.toBeNull()
    if (desktopAvatarBox !== null && desktopNameBox !== null) {
      expect(desktopAvatarBox.x).toBeLessThan(desktopNameBox.x)
    }

    expect((await header.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(68)
    await expect(
      security.getByText('Gate Access Control', { exact: true }),
    ).toHaveCount(0)

    // ---- D. Security ponsel 320x800: pita body memuat avatar + nama jaga ---
    await security.setViewportSize({ width: 320, height: 800 })
    await security.goto('/gate')

    const strip = security.locator('[data-testid="kiosk-status-strip"]')
    await expect(strip).toBeVisible()
    const stripAvatar = strip.locator('[data-avatar-state="image"] img')
    await expect(stripAvatar).toBeVisible()
    await expect
      .poll(() =>
        stripAvatar.evaluate((el) =>
          el instanceof HTMLImageElement ? el.naturalWidth : 0,
        ),
      )
      .toBeGreaterThan(0)

    const guardName = strip.locator('p').first()
    await expect(guardName).toBeVisible()
    const stripAvatarBox = await stripAvatar.boundingBox()
    const guardNameBox = await guardName.boundingBox()
    expect(stripAvatarBox, 'avatar pita ponsel harus punya kotak terukur').not.toBeNull()
    expect(guardNameBox, 'nama pengawas di pita harus punya kotak terukur').not.toBeNull()
    if (stripAvatarBox !== null && guardNameBox !== null) {
      expect(stripAvatarBox.x).toBeLessThan(guardNameBox.x)
    }

    expect((await security.locator('header').first().boundingBox())?.height ?? 0).toBeLessThan(
      60,
    )
    expect(
      await security.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      'gate security 320px tidak boleh overflow horizontal',
    ).toBe(true)
  } finally {
    await restoreProfile(h, securitySnapshot)
    await restoreProfile(h, vendorSnapshot)
  }
})

test('@PROF-12 nama + pill shift sebaris di pita kios, chip lokasi rata kanan, dan pita membuka /profile', async ({
  h,
}) => {
  const page = await h.openAs('security')
  await page.setViewportSize({ width: 375, height: 800 })
  await page.goto('/gate')

  const strip = page.locator('[data-testid="kiosk-status-strip"]')
  await expect(strip).toBeVisible()
  await expect(strip).toHaveAttribute('href', '/profile')
  await expect(strip).toHaveAccessibleName(/^Buka profil /)

  const name = strip.locator('[data-testid="kiosk-guard-name"]')
  const shift = strip.locator('[data-testid="kiosk-shift"]')
  const location = strip.locator('[data-testid="kiosk-location"]')
  await expect(name).toBeVisible()
  await expect(shift).toBeVisible()
  await expect(location).not.toBeEmpty()

  // Nama dibaca langsung dari testid — bukan di-split dari "nama · shift".
  const guardName = ((await name.textContent()) ?? '').trim()
  expect(guardName, 'nama pengawas harus terbaca dari pita').not.toBe('')
  await expect(shift).toHaveText(/\S/)
  await expect(strip).toHaveAccessibleName(`Buka profil ${guardName}`)

  const layout = await page.evaluate(() => {
    const rectOf = (el: Element | null) => {
      if (el === null) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right }
    }
    const nameEl = document.querySelector('[data-testid="kiosk-guard-name"]')
    const shiftEl = document.querySelector('[data-testid="kiosk-shift"]')
    const locationEl = document.querySelector('[data-testid="kiosk-location"]')
    // Tepi kanan chip = tepi kanan pembungkus Badge (induk teks lokasi),
    // karena teksnya sendiri di dalam padding `px-1.5` chip.
    const locationChip = locationEl?.parentElement ?? null
    // Kolom identitas = induk baris-1 (nama/pill) = induk chip lokasi.
    const column = nameEl?.parentElement?.parentElement ?? null
    return {
      name: rectOf(nameEl),
      shift: rectOf(shiftEl),
      shiftClipped: shiftEl !== null && shiftEl.scrollWidth > shiftEl.clientWidth + 1,
      locationChip: rectOf(locationChip),
      column: rectOf(column),
    }
  })
  console.log(`[e2e-profile] @PROF-12 ${JSON.stringify({ guardName, ...layout })}`)

  expect(layout.name, 'nama pengawas harus punya kotak terukur').not.toBeNull()
  expect(layout.shift, 'pill shift harus punya kotak terukur').not.toBeNull()
  expect(layout.locationChip, 'chip lokasi harus punya kotak terukur').not.toBeNull()
  expect(layout.column, 'kolom identitas harus punya kotak terukur').not.toBeNull()
  if (
    layout.name !== null &&
    layout.shift !== null &&
    layout.locationChip !== null &&
    layout.column !== null
  ) {
    // Pill shift tampil penuh — truncation nama tidak boleh memotongnya.
    expect(layout.shiftClipped, 'pill shift harus tampil penuh (tanpa klip)').toBe(false)
    // Nama (truncatable) di kiri, pill shift `shrink-0` di kanan — bersaudara.
    expect(layout.name.x + layout.name.width).toBeLessThanOrEqual(layout.shift.x + 1)
    // Chip lokasi `self-end`: tepi kanannya menempel tepi kanan kolom identitas.
    expect(Math.abs(layout.locationChip.right - layout.column.right)).toBeLessThanOrEqual(1.5)
  }

  await strip.click()
  await expect(page).toHaveURL(/\/profile$/)
  await expect(
    page.getByRole('heading', { name: 'Profil Saya', exact: true }),
  ).toBeVisible()
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    'profil security 375px tidak boleh overflow horizontal',
  ).toBe(true)
})

test('@PROF-13 security /profile memakai tautan kembali ringkas ke /gate tanpa tab gerbang', async ({
  h,
}) => {
  const page = await h.openAs('security')
  await page.setViewportSize({ width: 375, height: 800 })
  await page.goto('/profile')

  const back = page.getByRole('link', { name: 'Gate Check-in', exact: true })
  await expect(back).toBeVisible()
  await expect(back).toHaveAttribute('href', '/gate')
  const heading = page.getByRole('heading', { name: 'Profil Saya', exact: true })
  await expect(heading).toBeVisible()

  const backBox = await back.boundingBox()
  const headingBox = await heading.boundingBox()
  const backChrome = await back.evaluate((el) => {
    const style = getComputedStyle(el)
    return { borderWidth: style.borderTopWidth, background: style.backgroundColor }
  })
  console.log(
    `[e2e-profile] @PROF-13 ${JSON.stringify({ backBox, headingBox, backChrome })}`,
  )

  expect(backBox?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect(backBox, 'tautan kembali harus punya kotak terukur').not.toBeNull()
  expect(headingBox, 'judul profil harus punya kotak terukur').not.toBeNull()
  if (backBox !== null && headingBox !== null) {
    expect(Math.abs(backBox.x - headingBox.x)).toBeLessThanOrEqual(2)
  }

  // R2: tautan kembali menyatu dengan halaman — tanpa border/background kartu.
  expect(backChrome.borderWidth, 'tautan kembali tidak boleh berbingkai').toBe('0px')
  expect(
    ['rgba(0, 0, 0, 0)', 'transparent'],
    'tautan kembali tidak boleh punya latar kartu',
  ).toContain(backChrome.background)

  await expect(page.getByRole('tab')).toHaveCount(0)
  await expect(page.locator('nav[aria-label="Navigasi utama"]')).toHaveCount(0)
  await expect(
    page.getByRole('link', { name: 'Kembali ke Pos Check-in' }),
  ).toHaveCount(0)

  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    'profil security 375px tidak boleh overflow horizontal',
  ).toBe(true)

  await back.click()
  await expect(page).toHaveURL(/\/gate$/)
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    'gate security 375px tidak boleh overflow horizontal',
  ).toBe(true)

  await page.setViewportSize({ width: 320, height: 800 })
  await page.goto('/profile')
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    'profil security 320px tidak boleh overflow horizontal',
  ).toBe(true)
  await page.goto('/gate')
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    'gate security 320px tidak boleh overflow horizontal',
  ).toBe(true)
})

test('@PROF-14 vendor /profile tanpa back link di badan halaman maupun navbar', async ({
  h,
}) => {
  const page = await h.openAs('vendor')
  await page.setViewportSize({ width: 375, height: 800 })
  await page.goto('/profile')

  const heading = page.getByRole('heading', { name: 'Profil Saya', exact: true })
  await expect(heading).toBeVisible()

  // Bottom-nav juga memakai nama "Kunjungan Saya"; scope ke `<main>` agar
  // yang diukur benar-benar tautan kembali di badan halaman profil.
  const mainBackLinks = page.locator('main').getByRole('link', {
    name: /kunjungan saya|kembali/i,
  })
  const mainBackLinkCount = await mainBackLinks.count()
  console.log(`[e2e-profile] @PROF-14 mainBackLinkCount=${mainBackLinkCount}`)
  expect(mainBackLinkCount, 'badan /profile vendor tidak boleh punya back link').toBe(0)
  await expect(page.locator('main a[aria-label^="Kembali"]')).toHaveCount(0)

  await expect(
    page.locator('header, nav').getByRole('link', { name: /kembali/i }),
  ).toHaveCount(0)
  await expect(
    page.locator('header, nav').getByRole('button', { name: /kembali/i }),
  ).toHaveCount(0)
  await expect(
    page.locator('a[aria-label^="Kembali"], button[aria-label^="Kembali"]'),
  ).toHaveCount(0)

  // Bottom-nav tetap berfungsi: tautan "Kunjungan Saya" -> /dashboard.
  const bottomNavHome = page.getByRole('link', {
    name: 'Kunjungan Saya',
    exact: true,
  })
  await expect(bottomNavHome, 'bottom-nav harus menyediakan pintu kembali').toHaveCount(1)
  await expect(bottomNavHome).toHaveAttribute('href', '/dashboard')

  const headingBox = await heading.boundingBox()
  console.log(`[e2e-profile] @PROF-14 ${JSON.stringify({ mainBackLinkCount, headingBox })}`)
  expect(headingBox, 'judul profil harus punya kotak terukur').not.toBeNull()

  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    'profil vendor 375px tidak boleh overflow horizontal',
  ).toBe(true)

  await page.setViewportSize({ width: 320, height: 800 })
  await page.goto('/profile')
  await expect(
    page.getByRole('heading', { name: 'Profil Saya', exact: true }),
  ).toBeVisible()
  await expect(
    page.locator('main').getByRole('link', { name: /kunjungan saya|kembali/i }),
  ).toHaveCount(0)
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    'profil vendor 320px tidak boleh overflow horizontal',
  ).toBe(true)
})

test('@PROF-15 chip profil vendor memakai ikon saja pada desktop dan nama pada tablet', async ({
  h,
}) => {
  const page = await h.openAs('vendor')

  // ---- Desktop 1280x800: chip ikon 44px (w-11) -----------------------------
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/dashboard')

  const chip = page.locator('header a[aria-label^="Profil "]').first()
  await expect(chip).toBeVisible()
  await expect(chip).toHaveAccessibleName(/^Profil /)
  const chipLabel = (await chip.getAttribute('aria-label')) ?? ''
  const vendorName = chipLabel.startsWith('Profil ')
    ? chipLabel.slice('Profil '.length)
    : ''
  expect(vendorName, 'nama vendor harus terbaca dari aria-label chip').not.toBe('')

  const desktopBox = await chip.boundingBox()
  console.log(
    `[e2e-profile] @PROF-15 desktop ${JSON.stringify({ chipLabel, desktopBox })}`,
  )
  expect(desktopBox?.width ?? 0).toBeGreaterThanOrEqual(40)
  expect(desktopBox?.width ?? 0).toBeLessThanOrEqual(48)
  expect(desktopBox?.height ?? 0).toBeGreaterThanOrEqual(44)
  await expect(chip.locator('svg').first()).toBeVisible()
  await expect(chip.locator('span').filter({ hasText: vendorName }).first()).toBeHidden()
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    'dashboard vendor 1280px tidak boleh overflow horizontal',
  ).toBe(true)

  await chip.click()
  await expect(page).toHaveURL(/\/profile$/)

  // ---- Tablet 768x800: nama penuh, ikon disembunyikan ----------------------
  await page.setViewportSize({ width: 768, height: 800 })
  await page.goto('/dashboard')

  const tabletChip = page.locator('header a[aria-label^="Profil "]').first()
  await expect(tabletChip).toBeVisible()
  const tabletBox = await tabletChip.boundingBox()
  console.log(`[e2e-profile] @PROF-15 tablet ${JSON.stringify({ tabletBox })}`)
  expect(tabletBox?.width ?? 0).toBeGreaterThan(48)
  expect(tabletBox?.height ?? 0).toBeGreaterThanOrEqual(44)
  await expect(
    tabletChip.locator('span').filter({ hasText: vendorName }).first(),
  ).toBeVisible()
  await expect(tabletChip.locator('svg').first()).toBeHidden()
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    'dashboard vendor 768px tidak boleh overflow horizontal',
  ).toBe(true)

  // ---- Ponsel 375x800: kembali ke chip ikon 44px ---------------------------
  await page.setViewportSize({ width: 375, height: 800 })
  await page.goto('/dashboard')

  const phoneChip = page.locator('header a[aria-label^="Profil "]').first()
  await expect(phoneChip).toBeVisible()
  const phoneBox = await phoneChip.boundingBox()
  console.log(`[e2e-profile] @PROF-15 phone ${JSON.stringify({ phoneBox })}`)
  expect(phoneBox?.width ?? 0).toBeGreaterThanOrEqual(40)
  expect(phoneBox?.width ?? 0).toBeLessThanOrEqual(48)
  expect(phoneBox?.height ?? 0).toBeGreaterThanOrEqual(44)
  await expect(phoneChip.locator('svg').first()).toBeVisible()
  await expect(phoneChip.locator('span').filter({ hasText: vendorName }).first()).toBeHidden()
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    'dashboard vendor 375px tidak boleh overflow horizontal',
  ).toBe(true)
})
