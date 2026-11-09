import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  BADGE_CODE_MAX_LENGTH,
  CHECKIN_NOTES_MAX_LENGTH,
  EMAIL_MAX_LENGTH,
  FACILITY_ADDRESS_MAX_LENGTH,
  FACILITY_CITY_MAX_LENGTH,
  FACILITY_NAME_MAX_LENGTH,
  ID_NUMBER_MAX_LENGTH,
  ID_NUMBER_PATTERN,
  JABATAN_MAX_LENGTH,
  JSON_BODY_MAX_BYTES,
  NAME_MAX_LENGTH,
  NIK_LENGTH,
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  PHONE_MAX_LENGTH,
  PHONE_PATTERN,
  PURPOSE_NAME_MAX_LENGTH,
  PURPOSE_NOTE_MAX_LENGTH,
  REJECT_REASON_MIN_LENGTH,
  SEARCH_QUERY_MAX_LENGTH,
  SUGGESTION_QUERY_MAX_LENGTH,
  TECHNICIANS_MAX,
  TEXT_MAX_LENGTH,
  UPLOAD_INGEST_MAX_BYTES,
  UPLOAD_STORED_MAX_BYTES,
  VENDOR_NAME_MAX_LENGTH,
  VISIT_ID_INPUT_MAX_LENGTH,
} from '@/lib/limits'

/**
 * Drift guard: `x-limits:` pada `docs/4. openapi.yaml` adalah SSOT. Uji ini
 * membaca YAML mentah (tanpa dependensi yaml) dan memastikan setiap konstanta
 * `lib/limits.ts` sama persis. Path diresolusi dari lokasi berkas uji, bukan
 * `process.cwd()`, agar tetap benar baik dijalankan dari `frontend/` maupun root.
 */
const OPENAPI_PATH = fileURLToPath(
  new URL('../../docs/4. openapi.yaml', import.meta.url),
)

function readLimitsBlock(): Map<string, string> {
  const source = readFileSync(OPENAPI_PATH, 'utf8')
  const block = /^x-limits:\s*\r?\n([\s\S]*?)(?=^\S)/m.exec(source)
  if (block?.[1] === undefined) {
    throw new Error(`Blok x-limits tidak ditemukan di ${OPENAPI_PATH}`)
  }

  const entries = new Map<string, string>()
  for (const line of block[1].split(/\r?\n/)) {
    const match = /^\s{2}([a-z_]+):\s*(.+)$/.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined) {
      entries.set(
        match[1],
        match[2].trim().replace(/^"(.*)"$/, '$1'),
      )
    }
  }
  return entries
}

const limits = readLimitsBlock()

const numberContracts: ReadonlyArray<{
  constant: string
  actual: number
  key: string
}> = [
  { constant: 'NAME_MAX_LENGTH', actual: NAME_MAX_LENGTH, key: 'name_max_length' },
  {
    constant: 'ID_NUMBER_MAX_LENGTH',
    actual: ID_NUMBER_MAX_LENGTH,
    key: 'id_number_max_length',
  },
  {
    constant: 'PHONE_MAX_LENGTH',
    actual: PHONE_MAX_LENGTH,
    key: 'phone_max_length',
  },
  {
    constant: 'PHONE_MIN_LENGTH',
    actual: 10,
    key: 'phone_min_length',
  },
  {
    constant: 'PASSWORD_MIN_LENGTH',
    actual: PASSWORD_MIN_LENGTH,
    key: 'password_min_length',
  },
  {
    constant: 'PASSWORD_MAX_BYTES',
    actual: PASSWORD_MAX_BYTES,
    key: 'password_max_bytes',
  },
  {
    constant: 'EMAIL_MAX_LENGTH',
    actual: EMAIL_MAX_LENGTH,
    key: 'email_max_length',
  },
  { constant: 'TEXT_MAX_LENGTH', actual: TEXT_MAX_LENGTH, key: 'text_max_length' },
  {
    constant: 'REJECT_REASON_MIN_LENGTH',
    actual: REJECT_REASON_MIN_LENGTH,
    key: 'reject_reason_min_length',
  },
  {
    constant: 'FACILITY_NAME_MAX_LENGTH',
    actual: FACILITY_NAME_MAX_LENGTH,
    key: 'facility_name_max_length',
  },
  {
    constant: 'FACILITY_ADDRESS_MAX_LENGTH',
    actual: FACILITY_ADDRESS_MAX_LENGTH,
    key: 'facility_address_max_length',
  },
  {
    constant: 'FACILITY_CITY_MAX_LENGTH',
    actual: FACILITY_CITY_MAX_LENGTH,
    key: 'facility_city_max_length',
  },
  {
    constant: 'VISIT_ID_INPUT_MAX_LENGTH',
    actual: VISIT_ID_INPUT_MAX_LENGTH,
    key: 'visit_id_input_max_length',
  },
  {
    constant: 'BADGE_CODE_MAX_LENGTH',
    actual: BADGE_CODE_MAX_LENGTH,
    key: 'badge_code_max_length',
  },
  {
    constant: 'CHECKIN_NOTES_MAX_LENGTH',
    actual: CHECKIN_NOTES_MAX_LENGTH,
    key: 'checkin_notes_max_length',
  },
  {
    constant: 'SEARCH_QUERY_MAX_LENGTH',
    actual: SEARCH_QUERY_MAX_LENGTH,
    key: 'search_query_max_length',
  },
  {
    constant: 'SUGGESTION_QUERY_MAX_LENGTH',
    actual: SUGGESTION_QUERY_MAX_LENGTH,
    key: 'suggestion_query_max_length',
  },
  {
    constant: 'VENDOR_NAME_MAX_LENGTH',
    actual: VENDOR_NAME_MAX_LENGTH,
    key: 'vendor_name_max_length',
  },
  {
    constant: 'JABATAN_MAX_LENGTH',
    actual: JABATAN_MAX_LENGTH,
    key: 'jabatan_max_length',
  },
  {
    constant: 'PURPOSE_NAME_MAX_LENGTH',
    actual: PURPOSE_NAME_MAX_LENGTH,
    key: 'purpose_name_max_length',
  },
  {
    constant: 'PURPOSE_NOTE_MAX_LENGTH',
    actual: PURPOSE_NOTE_MAX_LENGTH,
    key: 'purpose_note_max_length',
  },
  { constant: 'NIK_LENGTH', actual: NIK_LENGTH, key: 'nik_length' },
  {
    constant: 'TECHNICIANS_MAX',
    actual: TECHNICIANS_MAX,
    key: 'technicians_max',
  },
  {
    constant: 'UPLOAD_STORED_MAX_BYTES',
    actual: UPLOAD_STORED_MAX_BYTES,
    key: 'upload_stored_max_bytes',
  },
  {
    constant: 'UPLOAD_INGEST_MAX_BYTES',
    actual: UPLOAD_INGEST_MAX_BYTES,
    key: 'upload_ingest_max_bytes',
  },
  {
    constant: 'JSON_BODY_MAX_BYTES',
    actual: JSON_BODY_MAX_BYTES,
    key: 'json_body_max_bytes',
  },
]

describe('limits-contract — lib/limits.ts vs docs/4. openapi.yaml', () => {
  it('menemukan blok x-limits beserta seluruh kunci kontrak', () => {
    for (const { key } of numberContracts) {
      expect(
        limits.has(key),
        `x-limits.${key} tidak ditemukan di ${OPENAPI_PATH}`,
      ).toBe(true)
    }
    expect(limits.has('id_number_pattern')).toBe(true)
    expect(limits.has('phone_pattern')).toBe(true)
  })

  it('jumlah kunci x-limits sama dengan jumlah kontrak', () => {
    expect(limits.size).toBe(28)
    expect(limits.size).toBe(numberContracts.length + 2)
  })

  it.each(numberContracts)(
    '$constant sama dengan x-limits.$key',
    ({ constant, actual, key }) => {
      const raw = limits.get(key)
      expect(
        raw,
        `x-limits.${key} tidak ditemukan (konstanta ${constant})`,
      ).toBeDefined()
      expect(
        actual,
        `limits.${constant} (${actual}) berbeda dari x-limits.${key} (${raw})`,
      ).toBe(Number(raw))
      expect(Number.isNaN(Number(raw))).toBe(false)
    },
  )

  it('ID_NUMBER_PATTERN identik dengan x-limits.id_number_pattern', () => {
    const raw = limits.get('id_number_pattern')
    expect(ID_NUMBER_PATTERN.flags).toBe('')
    expect(
      ID_NUMBER_PATTERN.source,
      `limits.ID_NUMBER_PATTERN berbeda dari x-limits.id_number_pattern (${raw})`,
    ).toBe(raw)
  })

  it('PHONE_PATTERN identik dengan x-limits.phone_pattern', () => {
    const raw = limits.get('phone_pattern')
    expect(PHONE_PATTERN.flags).toBe('')
    expect(
      PHONE_PATTERN.source,
      `limits.PHONE_PATTERN berbeda dari x-limits.phone_pattern (${raw})`,
    ).toBe(raw)
  })
})
