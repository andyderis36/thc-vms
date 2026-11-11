// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  formatTanggalWaktu,
  gateDetail,
  historyDetail,
  Timeline,
} from '@/features/visits/detail/Timeline'
import type { VisitHistoryEntry, VisitStatus } from '@/lib/api/types'

const START = '2026-09-26T09:00:00+07:00'
const END = '2026-09-26T17:00:00+07:00'
const CHECK_IN = '2026-09-26T14:30:00+07:00'
const CHECK_OUT = '2026-09-26T16:45:00+07:00'

describe('gateDetail', () => {
  it('memakai stempel aktual saat check-in sudah terjadi', () => {
    expect(gateDetail('Masuk', CHECK_IN, START)).toBe(`Masuk ${formatTanggalWaktu(CHECK_IN)}`)
  })

  it('memakai stempel aktual saat check-out sudah terjadi', () => {
    expect(gateDetail('Keluar', CHECK_OUT, END)).toBe(`Keluar ${formatTanggalWaktu(CHECK_OUT)}`)
  })

  it('mundur ke teks jadwal saat belum check-in (null/undefined/kosong)', () => {
    for (const empty of [null, undefined, ''] as const) {
      expect(gateDetail('Masuk', empty, START)).toBe(`Jadwal mulai ${formatTanggalWaktu(START)}`)
      expect(gateDetail('Keluar', empty, END)).toBe(`Jadwal selesai ${formatTanggalWaktu(END)}`)
    }
  })

  it('tidak pernah menghasilkan Invalid Date untuk stempel rusak', () => {
    expect(gateDetail('Masuk', 'bukan-tanggal', START)).toBe('Masuk bukan-tanggal')
  })
})

type RenderedState = 'done' | 'current' | 'future'

const CREATED = '2026-09-20T08:00:00+07:00'

function dotOf(li: Element): Element {
  const dot = li.querySelector('span[aria-hidden="true"]')
  if (dot === null) {
    throw new Error('node timeline tanpa titik status')
  }
  return dot
}

function stateOf(dot: Element): RenderedState {
  const classes = dot.className.split(/\s+/)
  if (classes.includes('bg-success-bg')) return 'done'
  if (classes.includes('bg-brand')) return 'current'
  if (classes.includes('bg-border-mid')) return 'future'
  throw new Error(`kelas titik status tak dikenal: ${dot.className}`)
}

const REASON = 'Vendor tidak membawa surat tugas yang sah untuk kunjungan ini.'

function renderTimeline(
  status: VisitStatus,
  statusNote?: string | null,
  history?: VisitHistoryEntry[],
) {
  return render(
    createElement(Timeline, {
      status,
      createdAt: CREATED,
      startDate: START,
      endDate: END,
      checkInAt: CHECK_IN,
      checkOutAt: CHECK_OUT,
      statusNote,
      history,
    }),
  )
}

function stepNodes(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll('ol > li')).filter(
    (li) => !(li.textContent ?? '').includes('Status akhir'),
  )
}

describe('Timeline node status', () => {
  afterEach(cleanup)

  it('completed: 4/4 node done (hijau + Check), tanpa current/future, tanpa footer', () => {
    const { container } = renderTimeline('completed')

    expect(screen.queryByText('Status akhir')).not.toBeInTheDocument()
    expect(container.querySelectorAll('ol > li')).toHaveLength(4)

    const nodes = stepNodes(container)
    expect(nodes).toHaveLength(4)
    for (const node of nodes) {
      const dot = dotOf(node)
      expect(stateOf(dot)).toBe('done')
      expect(dot.querySelector('svg')).not.toBeNull()
    }

    expect(container.querySelector('[aria-current="step"]')).toBeNull()
    expect(screen.getByText('Selesai')).toBeInTheDocument()
  })

  it.each(['rejected', 'cancelled', 'not_visit'] as const)(
    '%s: byte-identik — 1 node done + footer X (alasan hanya di footer)',
    (status) => {
      const { container } = renderTimeline(status, REASON)

      const nodes = stepNodes(container)
      expect(nodes).toHaveLength(1)
      const dot = dotOf(nodes[0]!)
      expect(stateOf(dot)).toBe('done')
      expect(dot.querySelector('svg')).not.toBeNull()

      const footer = screen.getByText('Status akhir').closest('li')
      expect(footer).not.toBeNull()
      const footerDot = dotOf(footer!)
      expect(footerDot.className.split(/\s+/)).toContain('bg-neutral-bg')
      expect(footerDot.querySelector('svg')).not.toBeNull()

      expect(within(footer!).getByText(REASON)).toBeInTheDocument()
      expect(screen.getAllByText(REASON)).toHaveLength(1)

      expect(container.querySelectorAll('ol > li')).toHaveLength(2)
      expect(container.querySelector('[aria-current="step"]')).toBeNull()
    },
  )

  it.each(['rejected', 'cancelled', 'not_visit'] as const)(
    '%s: footer Status akhir memuat alasan lengkap di bawah badge',
    (status) => {
      const { container } = renderTimeline(status, REASON)

      const footer = screen.getByText('Status akhir').closest('li')
      expect(footer).not.toBeNull()

      const badge = footer!.querySelector('.status-badge')
      expect(badge).not.toBeNull()

      const reason = within(footer!).getByText(REASON)
      expect(reason).toBeInTheDocument()
      expect(
        badge!.compareDocumentPosition(reason) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()

      const classes = reason.className.split(/\s+/)
      expect(classes).toContain('break-words')
      expect(classes).toContain('text-ink-secondary')

      expect(screen.getAllByText(REASON)).toHaveLength(1)
      expect(container.querySelectorAll('ol > li')).toHaveLength(2)
    },
  )

  it.each([null, undefined, '', '   '] as const)(
    'footer tidak menambah node alasan saat statusNote=%s',
    (statusNote) => {
      const { container } = renderTimeline('rejected', statusNote)

      const footer = screen.getByText('Status akhir').closest('li')
      expect(footer).not.toBeNull()
      expect(footer!.querySelector('.status-badge')).not.toBeNull()
      expect(footer!.querySelectorAll('p')).toHaveLength(1)
      expect(container.querySelectorAll('ol > li')).toHaveLength(2)
    },
  )

  const PATTERNS = {
    requested: ['current', 'future', 'future', 'future'],
    approved: ['done', 'current', 'future', 'future'],
    visiting: ['done', 'done', 'current', 'future'],
    rescheduled: ['current', 'future', 'future', 'future'],
  } satisfies Partial<Record<VisitStatus, RenderedState[]>>

  it.each(Object.keys(PATTERNS) as (keyof typeof PATTERNS)[])(
    '%s: posisi node tidak berubah',
    (status) => {
      const { container } = renderTimeline(status)

      expect(screen.queryByText('Status akhir')).not.toBeInTheDocument()
      const nodes = stepNodes(container)
      expect(nodes).toHaveLength(4)
      expect(nodes.map((node) => stateOf(dotOf(node)))).toEqual(PATTERNS[status])
    },
  )
})

const APPROVED_AT = '2026-09-21T09:30:00+07:00'

const TRAIL: VisitHistoryEntry[] = [
  { status: 'requested', at: CREATED, actor_name: 'Wulan Sari', actor_role_label: 'Vendor/Mitra' },
  {
    status: 'approved',
    at: APPROVED_AT,
    actor_name: 'Siti Rahayu',
    actor_role_label: 'Admin Cabang',
  },
  { status: 'visiting', at: CHECK_IN, actor_name: 'Bagus Prakoso', actor_role_label: 'Petugas Keamanan' },
  // Transisi sistem (changed_by NULL): pelaku wajib null.
  { status: 'completed', at: CHECK_OUT, actor_name: null, actor_role_label: null },
]

describe('historyDetail', () => {
  it('baris berpelaku: "oleh <nama> (<peran>) · <stempel>"', () => {
    expect(historyDetail(TRAIL[1]!)).toBe(
      `oleh Siti Rahayu (Admin Cabang) · ${formatTanggalWaktu(APPROVED_AT)}`,
    )
  })

  it('tanpa label peran: klause oleh tetap tanpa tanda kurung', () => {
    const entry: VisitHistoryEntry = {
      status: 'approved',
      at: APPROVED_AT,
      actor_name: 'Siti Rahayu',
      actor_role_label: null,
    }
    expect(historyDetail(entry)).toBe(`oleh Siti Rahayu · ${formatTanggalWaktu(APPROVED_AT)}`)
  })

  it('transisi sistem: hanya stempel, tanpa klause "oleh"', () => {
    expect(historyDetail(TRAIL[3]!)).toBe(formatTanggalWaktu(CHECK_OUT))
    expect(historyDetail(TRAIL[3]!)).not.toContain('oleh')
  })
})

describe('Timeline jejak status (history)', () => {
  afterEach(cleanup)

  it('merender baris riwayat tertua -> terbaru dengan pelaku, bukan langkah turunan', () => {
    const { container } = renderTimeline('completed', undefined, TRAIL)

    const nodes = stepNodes(container)
    expect(nodes).toHaveLength(4)
    expect(nodes.map((node) => stateOf(dotOf(node)))).toEqual([
      'done',
      'done',
      'done',
      'done',
    ])

    expect(nodes[0]!.textContent).toContain('Diminta')
    expect(nodes[0]!.textContent).toContain(
      `oleh Wulan Sari (Vendor/Mitra) · ${formatTanggalWaktu(CREATED)}`,
    )
    expect(nodes[1]!.textContent).toContain('Disetujui')
    expect(nodes[1]!.textContent).toContain(
      `oleh Siti Rahayu (Admin Cabang) · ${formatTanggalWaktu(APPROVED_AT)}`,
    )
    expect(nodes[3]!.textContent).toContain('Selesai')

    // Transisi sistem: baris = label + stempel SAJA (textContent tanpa "oleh").
    expect(nodes[3]!.textContent).toBe(`Selesai${formatTanggalWaktu(CHECK_OUT)}`)
    expect(screen.getByText(formatTanggalWaktu(CHECK_OUT))).toBeInTheDocument()

    expect(screen.queryByText('Persetujuan')).not.toBeInTheDocument()
    expect(screen.queryByText('Kedatangan di Lokasi')).not.toBeInTheDocument()
    expect(screen.queryByText('Disetujui oleh admin')).not.toBeInTheDocument()
    expect(screen.queryByText(`Masuk ${formatTanggalWaktu(CHECK_IN)}`)).not.toBeInTheDocument()
    expect(screen.queryByText(/Diajukan 20 Sep/)).not.toBeInTheDocument()
    expect(container.querySelector('[aria-current="step"]')).toBeNull()
  })

  it('history kosong ([]) tetap memakai langkah turunan', () => {
    const { container } = renderTimeline('completed', undefined, [])

    const nodes = stepNodes(container)
    expect(nodes).toHaveLength(4)
    expect(screen.getByText('Persetujuan')).toBeInTheDocument()
    expect(screen.getByText(`Diajukan ${formatTanggalWaktu(CREATED)}`)).toBeInTheDocument()
    expect(screen.getByText(`Masuk ${formatTanggalWaktu(CHECK_IN)}`)).toBeInTheDocument()
    expect(screen.queryByText(/oleh Siti Rahayu/)).not.toBeInTheDocument()
  })

  it('status terminal + history: baris riwayat dirender DAN footer alasan tetap ada', () => {
    const { container } = renderTimeline('rejected', REASON, [
      {
        status: 'rejected',
        at: APPROVED_AT,
        actor_name: 'Siti Rahayu',
        actor_role_label: 'Admin Cabang',
      },
    ])

    expect(screen.getByText('Status akhir')).toBeInTheDocument()
    expect(within(screen.getByText('Status akhir').closest('li')!).getByText(REASON)).toBeInTheDocument()
    expect(container.querySelectorAll('ol > li')).toHaveLength(3)

    const nodes = stepNodes(container)
    expect(nodes).toHaveLength(2)
    expect(nodes[0]!.textContent).toContain('Pengajuan')
    expect(nodes[1]!.textContent).toContain('Ditolak')
    expect(nodes[1]!.textContent).toContain(
      `oleh Siti Rahayu (Admin Cabang) · ${formatTanggalWaktu(APPROVED_AT)}`,
    )
  })
})
