// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  formatTanggalWaktu,
  gateDetail,
  Timeline,
} from '@/features/visits/detail/Timeline'
import type { VisitStatus } from '@/lib/api/types'

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

function renderTimeline(status: VisitStatus, statusNote?: string | null) {
  return render(
    createElement(Timeline, {
      status,
      createdAt: CREATED,
      startDate: START,
      endDate: END,
      checkInAt: CHECK_IN,
      checkOutAt: CHECK_OUT,
      statusNote,
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
