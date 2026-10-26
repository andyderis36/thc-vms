/**
 * Auth setup Playwright: membuat storageState per peran.
 *
 * Login dilakukan lewat API (`POST /api/v1/auth/login`), bukan UI, lalu token
 * ditulis manual ke `playwright/.auth/<peran>.json` dengan bentuk storageState
 * Playwright. Setelah menulis, token DIVERIFIKASI lewat `GET /api/v1/auth/me`:
 * status 200 dan `data.role` harus sama dengan peran yang diharapkan.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { test as setup, expect } from '@playwright/test'
import {
  ACCOUNTS,
  API_BASE,
  FRONTEND_BASE,
  TOKEN_STORAGE_KEY,
  type Role,
} from './helpers/api'

const ROLES: readonly Role[] = [
  'super',
  'admin',
  'admin-sambas',
  'security',
  'security-sambas',
  'vendor',
]

const AUTH_DIR = path.resolve(process.cwd(), 'playwright', '.auth')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

for (const role of ROLES) {
  setup(`autentikasi ${role}`, async ({ request }) => {
    const account = ACCOUNTS[role]

    const loginResponse = await request.post(`${API_BASE}/auth/login`, {
      data: { email: account.email, password: account.password },
      headers: { accept: 'application/json' },
    })
    const loginText = await loginResponse.text()
    expect(
      loginResponse.status(),
      `login ${role} gagal (HTTP ${loginResponse.status()}): ${loginText}`,
    ).toBe(200)

    const loginBody: unknown = JSON.parse(loginText)
    if (
      !isRecord(loginBody) ||
      loginBody.success !== true ||
      !isRecord(loginBody.data) ||
      typeof loginBody.data.token !== 'string'
    ) {
      throw new Error(`[auth.setup] respons login ${role} tidak sesuai kontrak: ${loginText}`)
    }
    const token = loginBody.data.token

    const storageState = {
      cookies: [],
      origins: [
        {
          origin: FRONTEND_BASE,
          localStorage: [{ name: TOKEN_STORAGE_KEY, value: token }],
        },
      ],
    }

    await fs.mkdir(AUTH_DIR, { recursive: true })
    const statePath = path.join(AUTH_DIR, `${role}.json`)
    await fs.writeFile(statePath, `${JSON.stringify(storageState, null, 2)}\n`, 'utf8')

    const meResponse = await request.get(`${API_BASE}/auth/me`, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
    })
    const meText = await meResponse.text()
    if (meResponse.status() !== 200) {
      throw new Error(
        `[auth.setup] token ${role} tidak hidup: GET /auth/me -> HTTP ${meResponse.status()} (${meText})`,
      )
    }

    const meBody: unknown = JSON.parse(meText)
    if (
      !isRecord(meBody) ||
      meBody.success !== true ||
      !isRecord(meBody.data) ||
      typeof meBody.data.role !== 'string'
    ) {
      throw new Error(`[auth.setup] respons /auth/me ${role} tidak sesuai kontrak: ${meText}`)
    }
    if (meBody.data.role !== account.role) {
      throw new Error(
        `[auth.setup] peran ${role} tidak cocok: diharapkan "${account.role}", didapat "${meBody.data.role}".`,
      )
    }
  })
}
