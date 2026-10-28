// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApproveModal } from './ApproveModal'
import type { VisitDetail } from '@/lib/api/types'
import { TEXT_MAX_LENGTH } from '@/lib/limits'

interface ApproveVariables {
  visitId: string
  body?: { notes: string }
}

const { approveMutate } = vi.hoisted(() => ({
  approveMutate: vi.fn<(variables: ApproveVariables, options?: unknown) => void>(),
}))

vi.mock('@/lib/api/hooks', () => ({
  useApproveVisitMutation: () => ({ mutate: approveMutate, isPending: false }),
}))

/**
 * Fixture dengan `id` DAN `visit_id` berbeda supaya kebocoran catatan
 * antar-kunjungan tidak bisa disamarkan oleh data yang mirip.
 */
function buildVisit(overrides: Partial<VisitDetail> & Pick<VisitDetail, 'id' | 'visit_id'>): VisitDetail {
  return {
    status: 'requested',
    location: {
      id: 'loc-1',
      name: 'Kantor Pusat THC',
      type: 'pusat',
      address: 'Jl. Thamrin No. 1',
      city: 'Jakarta Pusat',
      timezone: 'WIB',
    },
    purposes: [{ id: 'purp-1', name: 'Splicing FO' }],
    vendor_user: {
      id: 'user-1',
      name: 'Budi Santoso',
      email: 'budi@thc.co.id',
      phone: '08123456789',
      nik: '1234567890123456',
      role: 'admin',
      location_id: 'loc-1',
      location_name: 'Kantor Pusat THC',
      status: 'active',
      type: 'internal',
      vendor_name: null,
      avatar_url: null,
    },
    vendor_name: 'PT Mitra Jaringan',
    start_date: '2026-09-26T08:00:00+07:00',
    end_date: '2026-09-26T16:00:00+07:00',
    assignment_letter_url: null,
    notes: null,
    visitors: [
      {
        id: 'visitor-1',
        name: 'Andi Wijaya',
        id_number: '1234567890123456',
        phone: '08123456789',
        id_card_photo_url: null,
        vendor_name: 'PT Mitra Jaringan',
      },
    ],
    created_at: '2026-09-20T10:00:00+07:00',
    ...overrides,
  }
}

const visitA = buildVisit({ id: 'visit-aaa', visit_id: 'VST-AAA-001' })
const visitB = buildVisit({ id: 'visit-bbb', visit_id: 'VST-BBB-002' })

const NOTE_FROM_A = 'Catatan khusus untuk kunjungan A'

/**
 * Meniru pola call site sebenarnya: modal di-mount KONDISIONAL oleh parent
 * (`target !== null ? <ApproveModal …/> : null`). Saat `target` menjadi null,
 * React meng-unmount elemen modal, sehingga state `notes` benar-benar hilang.
 */
function ApproveHarness({ target }: { target: VisitDetail | null }) {
  const onClose = vi.fn()
  return target !== null ? <ApproveModal open visit={target} onClose={onClose} /> : null
}

interface HarnessView {
  rerender: (target: VisitDetail | null) => void
}

function renderHarness(target: VisitDetail | null): HarnessView {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  function Root({ current }: { current: VisitDetail | null }) {
    return (
      <QueryClientProvider client={queryClient}>
        <ApproveHarness target={current} />
      </QueryClientProvider>
    )
  }

  const view = render(<Root current={target} />)

  return {
    rerender: (next) => view.rerender(<Root current={next} />),
  }
}

function notesTextarea(): HTMLTextAreaElement {
  return screen.getByLabelText<HTMLTextAreaElement>('Catatan Persetujuan')
}

function clickApprove(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Setujui' }))
}

beforeEach(() => {
  approveMutate.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('ApproveModal', () => {
  it('tidak membocorkan catatan antar-kunjungan setelah parent meng-unmount modal', () => {
    const view = renderHarness(visitA)

    fireEvent.change(notesTextarea(), { target: { value: NOTE_FROM_A } })
    expect(notesTextarea()).toHaveValue(NOTE_FROM_A)
    expect(screen.queryByDisplayValue(NOTE_FROM_A)).not.toBeNull()

    // Parent melepas modal (unmount), lalu me-mount modal baru untuk kunjungan B.
    view.rerender(null)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    view.rerender(visitB)

    const textarea = notesTextarea()
    expect(textarea).toHaveValue('')
    expect(screen.queryByDisplayValue(NOTE_FROM_A)).toBeNull()
    expect(screen.getByText(visitB.visit_id)).toBeInTheDocument()
  })

  it('tidak merender dialog maupun textarea ketika tidak ada kunjungan', () => {
    renderHarness(null)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Catatan Persetujuan')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('mengirim body undefined ketika catatan kosong atau hanya whitespace', () => {
    renderHarness(visitA)

    fireEvent.change(notesTextarea(), { target: { value: '   \n\t ' } })
    clickApprove()

    expect(approveMutate).toHaveBeenCalledTimes(1)
    const variables = approveMutate.mock.calls[0]?.[0]
    expect(variables?.visitId).toBe(visitA.id)
    expect(variables?.body).toBeUndefined()
  })

  it('mengirim catatan yang sudah di-trim ketika catatan terisi', () => {
    renderHarness(visitA)

    fireEvent.change(notesTextarea(), { target: { value: '  Bawa helm proyek  ' } })
    clickApprove()

    expect(approveMutate).toHaveBeenCalledTimes(1)
    const variables = approveMutate.mock.calls[0]?.[0]
    expect(variables?.visitId).toBe(visitA.id)
    expect(variables?.body).toEqual({ notes: 'Bawa helm proyek' })
  })

  it('membatasi catatan persetujuan dengan maxLength TEXT_MAX_LENGTH', () => {
    renderHarness(visitA)

    expect(notesTextarea()).toHaveAttribute(
      'maxlength',
      String(TEXT_MAX_LENGTH),
    )
  })
})
