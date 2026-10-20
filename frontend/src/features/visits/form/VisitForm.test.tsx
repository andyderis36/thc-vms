// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { VisitForm } from './VisitForm'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({
    user: { id: 'u1', role: 'vendor', vendor_name: 'PT Uji' },
    status: 'authenticated',
  }),
}))

vi.mock('@/lib/api/hooks', () => ({
  useLocationsQuery: () => ({ data: [], isPending: false, isError: false }),
  usePurposesQuery: () => ({ data: [], isPending: false, isError: false }),
  useVendorsQuery: () => ({ data: [], isPending: false, isError: false }),
  useVisitsQuery: () => ({ data: { items: [] } }),
  useCreateVisitMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUploadFileMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

afterEach(cleanup)

describe('VisitForm - bilah kirim tidak lengket', () => {
  it('tombol kirim berada di akhir form, SETELAH kartu SOP, tanpa sticky', () => {
    render(<VisitForm />)

    const submit = screen.getByRole('button', { name: /Kirim Permohonan Kunjungan/i })
    const bar = submit.closest('div')
    const form = submit.closest('form')

    expect(bar).not.toBeNull()
    expect(form?.lastElementChild).toBe(bar)
    expect(bar?.className).not.toContain('sticky')
    expect(bar?.className).not.toContain('bottom-')
    expect(bar?.className).toContain('border-t')
    expect(bar?.className).toContain('pt-4')
    expect(form?.className).not.toContain('pb-28')

    const sop = screen.getByText('Persetujuan SOP Keselamatan')
    expect(sop.compareDocumentPosition(bar as Element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
