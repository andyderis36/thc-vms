/**
 * E2E UI lintas-permukaan — GG2, K3, K6.
 *
 * Cakupan (tag judul = ID requirement):
 * - @GG2-01 Security kiosk: top bar desktop (>=1280) menampilkan avatar pengawas
 *   tepat di samping nama (di dalam cluster kontrol profil) dan benar-benar
 *   termuat (`naturalWidth > 0`); pada 375px pita identitas body menampilkan
 *   avatar yang sama lewat path `/api/v1/avatars/<uuid>` yang SAMA (dua fetch
 *   Bearer terpisah, blob URL berbeda), dan teks lama "Gate Access Control"
 *   tidak lagi dirender.
 * - @K3-01 Kartu identitas gerbang (pita identitas kios di `/gate`, K3)
 *   memakai geometri yang identik dengan kartu identitas vendor di
 *   `/dashboard`: border-radius, padding, gap, serta lebar/warna border
 *   dibandingkan per sisi dengan toleransi 0.5px.
 * - @K6-01 Detail `/visits/{id}` sebagai admin memakai judul "Anggota" (bukan
 *   "Tim Teknisi") dan setiap baris anggota menampilkan label "Jabatan"
 *   beserta nilainya.
 *
 * Interpretasi K3: kode dan unit test proyek menandai `KioskStatusStrip`
 * sebagai permukaan K3 ("root memakai permukaan & ritme kartu identitas vendor
 * (K3)"), jadi kartu gerbang yang diukur adalah pita identitas kios tersebut.
 *
 * KESELAMATAN DATA: satu-satunya mutasi adalah seed avatar security bila
 * kosong. Snapshot `GET /auth/me` dibaca lebih dulu; `avatar_url` hasil GET
 * adalah PATH TURUNAN (`/api/v1/avatars/...`) yang read-only, jadi restore
 * hanya mengirim `null` untuk kasus seed (snapshot kosong), lalu objek hasil
 * unggahan dibersihkan.
 * Kunjungan K6 dibuat lewat `h.createVisit` sehingga ikut dibersihkan
 * teardown harness.
 */

import type { Locator } from '@playwright/test'
import { expect, test, type Harness } from '../fixtures'
import {
  expectAvatarLoad,
  expectImageDecoded,
  trackAvatarLoads,
} from '../helpers/avatar'
import {
  apiFetchRaw,
  uploadFileViaApi,
  type ApiEnvelope,
  type Role,
} from '../helpers/api'
import { pngBuffer } from '../helpers/assets'
import { deleteUploadedFiles } from '../helpers/storage'
import { gotoApp } from '../helpers/nav'

interface MeUser {
  name: string
  avatar_url?: string | null
}

interface AvatarSnapshot {
  before: MeUser
  uploadedUrl: string | null
}

const SIDES = ['top', 'right', 'bottom', 'left'] as const

interface SideValues {
  top: string
  right: string
  bottom: string
  left: string
}

interface CardGeometry {
  radius: SideValues
  padding: SideValues
  borderWidth: SideValues
  borderColor: SideValues
  gap: { row: string; column: string }
}

/** `GET /auth/me` — sumber kebenaran sesi, termasuk path avatar backend. */
async function readMe(h: Harness, role: Role): Promise<MeUser> {
  const token = await h.tokenAs(role)
  const result = await apiFetchRaw<ApiEnvelope<MeUser>>(token, 'GET', '/auth/me')
  expect(result.status, `GET /auth/me (${role}) harus 200`).toBe(200)
  if (!result.body.success) {
    throw new Error(
      `[ui-avatar] GET /auth/me (${role}) gagal: ${result.body.error.code} - ${result.body.error.message}`,
    )
  }
  return result.body.data
}

async function patchAvatar(
  h: Harness,
  role: Role,
  avatarUrl: string | null,
): Promise<number> {
  const token = await h.tokenAs(role)
  const result = await apiFetchRaw<ApiEnvelope<MeUser>>(token, 'PATCH', '/auth/me', {
    avatar_url: avatarUrl,
  })
  return result.status
}

/**
 * Pastikan peran punya avatar. Bila seed masih kosong, unggah PNG nyata lalu
 * tautkan lewat `PATCH /auth/me`; snapshot awal dipakai untuk restore.
 */
async function ensureAvatar(h: Harness, role: Role): Promise<AvatarSnapshot> {
  const before = await readMe(h, role)
  if (
    before.avatar_url !== null &&
    before.avatar_url !== undefined &&
    before.avatar_url !== ''
  ) {
    return { before, uploadedUrl: null }
  }

  const token = await h.tokenAs(role)
  const uploaded = await uploadFileViaApi(token, 'profile_photo', {
    name: `avatar-${h.unique(`UI-AVATAR-${role}`)}.png`,
    mimeType: 'image/png',
    buffer: pngBuffer(),
  })
  expect(
    await patchAvatar(h, role, uploaded.fileUrl),
    `seed avatar ${role} harus 200`,
  ).toBe(200)
  return { before, uploadedUrl: uploaded.fileUrl }
}

async function restoreAvatar(
  h: Harness,
  role: Role,
  snapshot: AvatarSnapshot,
): Promise<void> {
  // `avatar_url` hasil GET adalah path turunan (`/api/v1/avatars/...`) yang
  // TIDAK bisa ditulis balik lewat PATCH; hanya `null` yang valid. Snapshot
  // yang sudah punya foto tidak pernah diubah test ini, jadi tidak perlu
  // direstore — dan path-nya tidak boleh dikirim (PATCH akan 400).
  if ((snapshot.before.avatar_url ?? null) === null) {
    expect(await patchAvatar(h, role, null), `restore avatar ${role} harus 200`).toBe(200)
  }

  if (snapshot.uploadedUrl !== null) {
    try {
      await deleteUploadedFiles([snapshot.uploadedUrl])
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      console.log(`[ui-avatar] cleanup objek avatar ${role} dilewati: ${reason}`)
    }
  }
}

function expectPxClose(actual: string, expected: string, label: string): void {
  const a = Number.parseFloat(actual)
  const e = Number.parseFloat(expected)
  expect(Number.isFinite(a), `${label}: "${actual}" bukan nilai px`).toBe(true)
  expect(Number.isFinite(e), `${label}: "${expected}" bukan nilai px`).toBe(true)
  expect(
    Math.abs(a - e),
    `${label}: ${actual} vs ${expected} harus sama (toleransi 0.5px)`,
  ).toBeLessThanOrEqual(0.5)
}

async function readCardGeometry(card: Locator): Promise<CardGeometry> {
  return card.evaluate((el): CardGeometry => {
    const style = getComputedStyle(el)
    return {
      radius: {
        top: style.borderTopLeftRadius,
        right: style.borderTopRightRadius,
        bottom: style.borderBottomRightRadius,
        left: style.borderBottomLeftRadius,
      },
      padding: {
        top: style.paddingTop,
        right: style.paddingRight,
        bottom: style.paddingBottom,
        left: style.paddingLeft,
      },
      borderWidth: {
        top: style.borderTopWidth,
        right: style.borderRightWidth,
        bottom: style.borderBottomWidth,
        left: style.borderLeftWidth,
      },
      borderColor: {
        top: style.borderTopColor,
        right: style.borderRightColor,
        bottom: style.borderBottomColor,
        left: style.borderLeftColor,
      },
      gap: { row: style.rowGap, column: style.columnGap },
    }
  })
}

function expectSameCardGeometry(gate: CardGeometry, vendor: CardGeometry): void {
  for (const side of SIDES) {
    expectPxClose(gate.radius[side], vendor.radius[side], `border-radius ${side}`)
    expectPxClose(gate.padding[side], vendor.padding[side], `padding ${side}`)
    expectPxClose(gate.borderWidth[side], vendor.borderWidth[side], `border-width ${side}`)
    expect(gate.borderColor[side], `border-color ${side} harus identik`).toBe(
      vendor.borderColor[side],
    )
  }
  expectPxClose(gate.gap.row, vendor.gap.row, 'row-gap')
  expectPxClose(gate.gap.column, vendor.gap.column, 'column-gap')
}

test('@GG2-01 avatar pengawas tampil di top bar desktop dan pita body ponsel dengan path /api/v1/avatars/ yang sama', async ({
  h,
}) => {
  const snapshot = await ensureAvatar(h, 'security')

  try {
    const page = await h.openAs('security')
    const avatarLoads = trackAvatarLoads(page)

    // ---- A. Desktop 1280x800: avatar tepat di samping nama pengawas --------
    await page.setViewportSize({ width: 1280, height: 800 })
    await gotoApp(page, '/gate')

    const header = page.locator('header').first()
    const headerAvatar = header.locator('[data-avatar-state="image"] img').first()
    const desktopLoad = await expectAvatarLoad(avatarLoads, 0, 'avatar top bar desktop')
    await expectImageDecoded(headerAvatar, 'avatar pengawas di top bar desktop')

    const profileLink = header.locator('a[aria-label^="Profil "]').first()
    await expect(profileLink, 'nama pengawas di top bar harus terlihat').toBeVisible()
    const guardName =
      (await profileLink.getAttribute('aria-label'))?.replace(/^Profil /, '') ?? ''
    expect(guardName, 'aria-label tautan profil harus memuat nama pengawas').not.toBe('')
    await expect(profileLink, 'teks tautan harus sama dengan nama pengawas').toHaveText(
      guardName,
    )

    // Avatar dan nama berada di cluster kontrol profil yang sama.
    const sameProfileControl = await headerAvatar.evaluate((el) => {
      const link = document.querySelector('header a[aria-label^="Profil "]')
      const cluster = el.closest('div')
      return link !== null && cluster !== null && cluster.contains(link)
    })
    expect(
      sameProfileControl,
      'avatar harus berada di dalam cluster kontrol profil yang sama dengan nama',
    ).toBe(true)

    const avatarBox = await headerAvatar.boundingBox()
    const nameBox = await profileLink.boundingBox()
    expect(avatarBox, 'avatar top bar harus punya kotak terukur').not.toBeNull()
    expect(nameBox, 'nama pengawas harus punya kotak terukur').not.toBeNull()
    if (avatarBox !== null && nameBox !== null) {
      expect(
        avatarBox.x + avatarBox.width,
        'avatar harus berada di kiri nama pengawas',
      ).toBeLessThanOrEqual(nameBox.x + 1)
      expect(
        avatarBox.y,
        'avatar dan nama harus berada pada baris yang sama',
      ).toBeLessThan(nameBox.y + nameBox.height)
      expect(
        nameBox.y,
        'avatar dan nama harus berada pada baris yang sama',
      ).toBeLessThan(avatarBox.y + avatarBox.height)
    }

    await expect(
      page.getByText('Gate Access Control', { exact: true }),
      'label "Gate Access Control" tidak boleh dirender di desktop',
    ).toHaveCount(0)

    // ---- B. Ponsel 375x800: pita identitas body memuat avatar yang sama ----
    const mobileMark = avatarLoads.length
    await page.setViewportSize({ width: 375, height: 800 })
    await gotoApp(page, '/gate')

    const strip = page.getByTestId('kiosk-status-strip')
    await expect(strip, 'pita identitas ponsel harus terlihat').toBeVisible()
    const stripAvatar = strip.locator('[data-avatar-state="image"] img').first()
    const stripLoad = await expectAvatarLoad(avatarLoads, mobileMark, 'avatar pita ponsel')
    await expectImageDecoded(stripAvatar, 'avatar pengawas di pita body ponsel')

    expect(
      stripLoad.path,
      'dua placement harus meminta path /api/v1/avatars/<uuid> yang sama',
    ).toBe(desktopLoad.path)

    await expect(
      page.getByText('Gate Access Control', { exact: true }),
      'label "Gate Access Control" tidak boleh dirender di ponsel',
    ).toHaveCount(0)
  } finally {
    await restoreAvatar(h, 'security', snapshot)
  }
})

test('@K3-01 kartu identitas gerbang memakai geometri yang identik dengan kartu identitas vendor', async ({
  h,
}) => {
  // ---- Kartu identitas vendor di /dashboard (peran vendor) ----------------
  const vendorPage = await h.openAs('vendor')
  await vendorPage.setViewportSize({ width: 1280, height: 800 })
  await vendorPage.goto('/dashboard')

  const vendorCard = vendorPage.getByRole('region', { name: 'Identitas Vendor/Mitra' })
  await expect(vendorCard, 'kartu identitas vendor harus terlihat').toBeVisible()
  const vendorGeometry = await readCardGeometry(vendorCard)

  // ---- Kartu identitas gerbang di /gate (pita kios, K3) -------------------
  const securityPage = await h.openAs('security')
  await securityPage.setViewportSize({ width: 375, height: 800 })
  await securityPage.goto('/gate')

  const gateCard = securityPage.getByRole('link', { name: /^Buka profil / })
  await expect(gateCard, 'kartu identitas gerbang harus terlihat').toBeVisible()
  const gateGeometry = await readCardGeometry(gateCard)

  console.log(
    `[ui-avatar] @K3-01 gate=${JSON.stringify(gateGeometry)} vendor=${JSON.stringify(vendorGeometry)}`,
  )

  expectSameCardGeometry(gateGeometry, vendorGeometry)
})

test('@K6-01 detail kunjungan admin memakai judul "Anggota" dan setiap baris menampilkan Jabatan', async ({
  h,
}) => {
  const visit = await h.createVisit('k6', { memberCount: 2, withFiles: false })
  expect(
    visit.status,
    'kunjungan harus approved agar admin cabang dapat membuka detail',
  ).toBe('approved')

  const page = await h.openAs('admin')
  await gotoApp(page, `/visits/${visit.id}`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText(visit.code)

  const heading = page.getByRole('heading', { name: 'Anggota', exact: true })
  await expect(
    heading,
    'judul daftar anggota harus tepat "Anggota"',
  ).toBeVisible()
  await expect(
    page.getByText('Tim Teknisi', { exact: true }),
    'judul lama "Tim Teknisi" tidak boleh dipakai',
  ).toHaveCount(0)

  const card = heading.locator(
    'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " card ")][1]',
  )
  const rows = card.locator('ul > li')
  await expect(
    rows,
    'jumlah baris anggota harus sama dengan memberCount',
  ).toHaveCount(2)

  const rowCount = await rows.count()
  for (let index = 0; index < rowCount; index += 1) {
    const row = rows.nth(index)
    const jabatan = row.locator('p').filter({ hasText: /^Jabatan: / })
    await expect(
      jabatan,
      `baris anggota ${index + 1} harus menampilkan label "Jabatan"`,
    ).toHaveCount(1)

    const text = ((await jabatan.textContent()) ?? '').trim()
    expect(
      text,
      `baris anggota ${index + 1} harus memuat nilai Jabatan yang tidak kosong`,
    ).toMatch(/^Jabatan: (?!—).+$/)
    expect(
      text,
      `baris anggota ${index + 1} harus memuat jabatan seed "Teknisi"`,
    ).toContain('Teknisi')
  }
})
