/**
 * Unit test untuk `e2e/provision-live-users.ts` (logika murni, tanpa HTTP).
 *
 * - Matriks gate: lanjut hanya bila base URL + salah satu flag provisi ada.
 * - Email-gen: unik per peran/run, pola alfanumerik-strip huruf kecil, dan
 *   COCOK dengan USER_MARKER `sweep.ts` (rekonstruksi di bawah menyalin
 *   algoritma `sweep.ts` baris 58-74: domain default + domain dari env
 *   `E2E_EMAIL_*`; bila pola sweep berubah, test ini wajib ikut berubah).
 * - Format ekspor: baris `KEY=VALUE` untuk injeksi `e2e.ps1`, tanpa rahasia
 *   (tanpa baris `E2E_PASSWORD=` — kata sandi operator dipakai bersama).
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  buildEmails,
  buildExportLines,
  collectTeardownTargets,
  emailDomain,
  evaluateGate,
  isHarnessEmail,
  isTeardownOnly,
  ledgerPathFor,
  makeNik,
  makeRunId,
  pacingMs,
  parseTeardownArgs,
  readLedgerFile,
  resolveProvisionLocationId,
  resolveSecondLocationId,
  sanitizeRunId,
  writeLedger,
} from '../e2e/provision-live-users'

/** Cermin USER_MARKER sweep.ts (lihat komentar berkas di atas). */
function sweepUserMarker(env: Record<string, string | undefined>): RegExp {
  const domains = new Set<string>(['transhybrid.net.id'])
  for (const key of [
    'E2E_EMAIL_SUPERADMIN',
    'E2E_EMAIL_ADMIN',
    'E2E_EMAIL_ADMIN2',
    'E2E_EMAIL_SECURITY',
    'E2E_EMAIL_SECURITY2',
    'E2E_EMAIL_VENDOR',
    'E2E_EMAIL_VENDOR2',
  ] as const) {
    const candidate = env[key]
    const domain = candidate?.includes('@') ? candidate.split('@')[1] : ''
    if (domain) domains.add(domain)
  }
  return new RegExp(
    `^(?:[a-z0-9]+\\.)?e2e-[a-z0-9][a-z0-9-]*@(?:${[...domains]
      .map((d) => d.replace(/\./g, '\\.'))
      .join('|')})$`,
    'i',
  )
}

describe('provision-live-users gate', () => {
  const cases: Array<{ name: string; env: Record<string, string | undefined>; proceed: boolean }> = [
    { name: 'tanpa env apa pun -> skipped', env: {}, proceed: false },
    {
      name: 'base URL saja tanpa flag -> skipped',
      env: { E2E_API_BASE_URL: 'http://localhost:8080/api/v1' },
      proceed: false,
    },
    {
      name: 'flag saja tanpa base URL -> skipped',
      env: { E2E_LOCAL_PROVISION: '1' },
      proceed: false,
    },
    {
      name: 'flag 0 eksplisit -> skipped',
      env: { E2E_API_BASE_URL: 'http://localhost:8080/api/v1', E2E_LOCAL_PROVISION: '0' },
      proceed: false,
    },
    {
      name: 'flag live -> proceed',
      env: { E2E_API_BASE_URL: 'https://thc.example.com/api/v1', E2E_LIVE_PROVISION: '1' },
      proceed: true,
    },
    {
      name: 'flag lokal -> proceed',
      env: { E2E_API_BASE_URL: 'http://localhost:8080/api/v1', E2E_LOCAL_PROVISION: '1' },
      proceed: true,
    },
    {
      name: 'base URL kosong -> skipped',
      env: { E2E_API_BASE_URL: '   ', E2E_LOCAL_PROVISION: '1' },
      proceed: false,
    },
  ]
  for (const { name, env, proceed } of cases) {
    it(name, () => {
      expect(evaluateGate(env).proceed).toBe(proceed)
    })
  }

  it('alasan skip menyebut syarat yang hilang', () => {
    expect(evaluateGate({}).reason).toMatch(/E2E_API_BASE_URL/)
    expect(
      evaluateGate({ E2E_API_BASE_URL: 'http://localhost:8080/api/v1' }).reason,
    ).toMatch(/E2E_LIVE_PROVISION/)
  })
})

describe('provision-live-users email-gen', () => {
  const env = { E2E_EMAIL_SUPERADMIN: 'superadmin@transhybrid.net.id' }
  const domain = emailDomain(env)

  it('domain diambil dari E2E_EMAIL_SUPERADMIN (default seed lokal)', () => {
    expect(domain).toBe('transhybrid.net.id')
    expect(emailDomain({})).toBe('transhybrid.net.id')
    expect(emailDomain({ E2E_EMAIL_SUPERADMIN: 'ops@thc.net.id' })).toBe('thc.net.id')
  })

  it('enam peran berbeda dan unik', () => {
    const emails = buildEmails('abc123', domain)
    const values = [emails.admin, emails.security, emails.vendor, emails.admin2, emails.security2, emails.vendor2]
    expect(new Set(values).size).toBe(6)
    expect(emails.admin).toBe('e2e-abc123-admin@transhybrid.net.id')
    expect(emails.security).toBe('e2e-abc123-security@transhybrid.net.id')
    expect(emails.vendor).toBe('e2e-abc123-vendor@transhybrid.net.id')
    expect(emails.admin2).toBe('e2e-abc123-admin2@transhybrid.net.id')
    expect(emails.security2).toBe('e2e-abc123-security2@transhybrid.net.id')
    expect(emails.vendor2).toBe('e2e-abc123-vendor2@transhybrid.net.id')
  })

  it('run-id berbeda -> email berbeda', () => {
    const a = buildEmails(makeRunId({ E2E_RUN_ID: 'run-satu' }), domain)
    const b = buildEmails(makeRunId({ E2E_RUN_ID: 'run-dua' }), domain)
    expect(a.vendor).not.toBe(b.vendor)
  })

  it('local-part huruf kecil alfanumerik-strip', () => {
    const emails = buildEmails('ABC Def__99', domain)
    for (const email of [emails.admin, emails.security, emails.vendor, emails.admin2, emails.security2, emails.vendor2]) {
      const local = email.split('@')[0] ?? ''
      expect(local).toMatch(/^e2e-[a-z0-9][a-z0-9-]*$/)
    }
  })

  it('setiap email cocok USER_MARKER sweep.ts (domain seed + domain kustom)', () => {
    for (const probe of [
      { E2E_EMAIL_SUPERADMIN: 'superadmin@transhybrid.net.id' },
      { E2E_EMAIL_SUPERADMIN: 'ops@thc.net.id' },
    ]) {
      const marker = sweepUserMarker(probe)
      const emails = buildEmails('run99', emailDomain(probe))
      expect(marker.test(emails.admin)).toBe(true)
      expect(marker.test(emails.security)).toBe(true)
      expect(marker.test(emails.vendor)).toBe(true)
      expect(marker.test(emails.admin2)).toBe(true)
      expect(marker.test(emails.security2)).toBe(true)
      expect(marker.test(emails.vendor2)).toBe(true)
    }
  })

  it('akun seed tidak cocok pola email harness', () => {
    const marker = sweepUserMarker(env)
    for (const seed of [
      'vendor1a@transhybrid.net.id',
      'security1a@transhybrid.net.id',
      'admin1@transhybrid.net.id',
      'superadmin@transhybrid.net.id',
    ]) {
      expect(marker.test(seed)).toBe(false)
    }
  })
})

describe('provision-live-users export', () => {
  const emails = buildEmails('run7', 'transhybrid.net.id')
  const lines = buildExportLines('run7', emails)

  it('baris KEY=VALUE tanpa spasi untuk injeksi e2e.ps1', () => {
    for (const line of lines) {
      expect(line).toMatch(/^E2E_[A-Z0-9_]+=\S+$/)
    }
  })

  it('memuat kunci wajib admin/security/vendor + admin2/security2/vendor2 + run-id, tanpa rahasia', () => {
    const keys = lines.map((line) => line.split('=')[0])
    expect(keys).toEqual([
      'E2E_RUN_ID',
      'E2E_EMAIL_ADMIN',
      'E2E_EMAIL_SECURITY',
      'E2E_EMAIL_VENDOR',
      'E2E_EMAIL_ADMIN2',
      'E2E_EMAIL_SECURITY2',
      'E2E_EMAIL_VENDOR2',
    ])
    expect(keys.includes('E2E_PASSWORD')).toBe(false)
  })
})

describe('provision-live-users pacing & sanitasi', () => {
  it('default pacing 13000; override valid; invalid -> default', () => {
    expect(pacingMs({})).toBe(13000)
    expect(pacingMs({ E2E_LOGIN_PACING_MS: '2000' })).toBe(2000)
    expect(pacingMs({ E2E_LOGIN_PACING_MS: 'sampah' })).toBe(13000)
    expect(pacingMs({ E2E_LOGIN_PACING_MS: '-5' })).toBe(13000)
  })

  it('sanitizeRunId menormalkan ke pola marker', () => {
    expect(sanitizeRunId('RUN 42_X!')).toBe('run-42-x')
    expect(sanitizeRunId('---a--b---')).toBe('a-b')
  })

  it('makeRunId memakai E2E_RUN_ID bila valid, generate bila kosong', () => {
    expect(makeRunId({ E2E_RUN_ID: 'Wave-0 Proof' })).toBe('wave-0-proof')
    expect(makeRunId({})).toMatch(/^[a-z0-9][a-z0-9-]*$/)
  })

  it('makeNik selalu 16 digit numerik dan unik', () => {
    const a = makeNik()
    const b = makeNik()
    expect(a).toMatch(/^\d{16}$/)
    expect(b).toMatch(/^\d{16}$/)
    expect(a).not.toBe(b)
  })
})

describe('provision-live-users teardown', () => {
  it('isTeardownOnly hanya true bila flag ada', () => {
    expect(isTeardownOnly(['--teardown-only'])).toBe(true)
    expect(isTeardownOnly([])).toBe(false)
    expect(isTeardownOnly(['--run-id', 'x'])).toBe(false)
  })

  it('parseTeardownArgs membaca run-id/email/ledger dua bentuk', () => {
    expect(parseTeardownArgs(['--run-id', 'Wave 1', '--email', 'A@x.id', '--ledger', 'p.json'])).toEqual({
      runId: 'wave-1',
      emails: ['A@x.id'],
      ledgerPath: 'p.json',
    })
    expect(parseTeardownArgs(['--run-id=Wave_2', '--email=B@x.id', '--email=C@x.id'])).toEqual({
      runId: 'wave-2',
      emails: ['B@x.id', 'C@x.id'],
      ledgerPath: '',
    })
  })

  it('isHarnessEmail menerima e2e- dan menolak seed', () => {
    expect(isHarnessEmail('e2e-abc-admin@transhybrid.net.id')).toBe(true)
    expect(isHarnessEmail('E2E-Abc-Security@thc.net.id')).toBe(true)
    for (const seed of [
      'vendor1a@transhybrid.net.id',
      'admin1@transhybrid.net.id',
      'superadmin@transhybrid.net.id',
      'not-an-email',
    ]) {
      expect(isHarnessEmail(seed)).toBe(false)
    }
  })

  it('ledger round-trip: tulis lalu kumpulkan via E2E_PROVISION_LEDGER_DIR', () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-ledger-test-'))
    const env = { E2E_PROVISION_LEDGER_DIR: dir } as Record<string, string | undefined>
    const emails = buildEmails('roundtrip1', 'transhybrid.net.id')
    const path = writeLedger('roundtrip1', emails, env)
    expect(path).toBe(ledgerPathFor('roundtrip1', env))
    expect(readLedgerFile(path).emails).toEqual([
      emails.admin,
      emails.security,
      emails.vendor,
      emails.admin2,
      emails.security2,
      emails.vendor2,
    ])
    const targets = collectTeardownTargets({ ...env, E2E_RUN_ID: 'roundtrip1' }, [])
    for (const email of [emails.admin, emails.security, emails.vendor, emails.admin2, emails.security2, emails.vendor2]) {
      expect(targets.emails).toContain(email)
    }
  })

  it('collectTeardownTargets: env + argv dedup huruf kecil + rekonstruksi run-id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-teardown-recon-'))
    const env = {
      E2E_RUN_ID: 'recon9',
      E2E_EMAIL_ADMIN: 'E2E-RECON9-ADMIN@transhybrid.net.id',
      E2E_EMAIL_ADMIN2: 'E2E-RECON9-ADMIN2@transhybrid.net.id',
      E2E_EMAIL_SECURITY2: 'e2e-recon9-security2@transhybrid.net.id',
      E2E_EMAIL_VENDOR2: 'e2e-recon9-vendor2@transhybrid.net.id',
      E2E_EMAIL_SUPERADMIN: 'superadmin@transhybrid.net.id',
      E2E_PROVISION_LEDGER_DIR: dir,
    } as Record<string, string | undefined>
    const targets = collectTeardownTargets(env, ['--email', 'e2e-recon9-admin@transhybrid.net.id'])
    expect(targets.runId).toBe('recon9')
    const rebuilt = buildEmails('recon9', 'transhybrid.net.id')
    for (const email of [rebuilt.admin, rebuilt.security, rebuilt.vendor, rebuilt.admin2, rebuilt.security2, rebuilt.vendor2]) {
      expect(targets.emails).toContain(email)
    }
    expect(targets.emails.filter((e) => e === rebuilt.admin)).toHaveLength(1)
  })

  it('ledger korup/hilang = target kosong parsial, bukan throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-ledger-bad-'))
    const scanDir = mkdtempSync(join(tmpdir(), 'e2e-ledger-scan-'))
    const bad = join(dir, 'rusak.json')
    writeFileSync(bad, '{bukan-json', 'utf8')
    expect(readLedgerFile(bad)).toEqual({ runId: '', emails: [] })
    expect(readLedgerFile(join(dir, 'hilang.json'))).toEqual({ runId: '', emails: [] })
    const targets = collectTeardownTargets({ E2E_PROVISION_LEDGER: bad, E2E_PROVISION_LEDGER_DIR: scanDir }, [])
    expect(targets.emails).toEqual([])
  })
})

describe('resolveProvisionLocationId', () => {
  it('pilih nama mengandung pusat (case-insensitive)', () => {
    expect(
      resolveProvisionLocationId([
        { id: 'b', name: 'SBS-01-SAMBAS' },
        { id: 'a', name: 'Kantor Pusat THC' },
      ]),
    ).toBe('a')
  })

  it('fallback abjad pertama bila tanpa pusat', () => {
    expect(
      resolveProvisionLocationId([
        { id: 'b', name: 'SKS-01' },
        { id: 'a', name: 'ARK-01' },
      ]),
    ).toBe('a')
  })

  it('kosong bila tidak ada lokasi', () => {
    expect(resolveProvisionLocationId([])).toBe('')
    expect(resolveProvisionLocationId([{ id: '', name: 'X' }])).toBe('')
  })
})

describe('resolveSecondLocationId', () => {
  it('prefer nama mengandung sambas di antara non-primer', () => {
    expect(
      resolveSecondLocationId(
        [
          { id: 'a', name: 'Kantor Pusat THC' },
          { id: 'b', name: 'ARK-01' },
          { id: 'c', name: 'SBS-01-SAMBAS' },
        ],
        'a',
      ),
    ).toBe('c')
  })

  it('fallback abjad pertama non-primer bila tanpa sambas', () => {
    expect(
      resolveSecondLocationId(
        [
          { id: 'a', name: 'Kantor Pusat THC' },
          { id: 'c', name: 'SKS-01' },
          { id: 'b', name: 'ARK-01' },
        ],
        'a',
      ),
    ).toBe('b')
  })

  it('fallback id primer bila hanya satu lokasi', () => {
    expect(resolveSecondLocationId([{ id: 'a', name: 'Kantor Pusat THC' }], 'a')).toBe('a')
    expect(resolveSecondLocationId([], 'a')).toBe('a')
  })
})
