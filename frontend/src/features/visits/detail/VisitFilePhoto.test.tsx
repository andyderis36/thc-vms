// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useVisitFile } from '@/features/visits/hooks/useVisitFile'
import type { VisitorItem } from '@/lib/api/types'
import { VisitFilePhoto } from './VisitFilePhoto'

vi.mock('@/features/visits/hooks/useVisitFile', () => ({
  useVisitFile: vi.fn(),
}))

const mockedUseVisitFile = vi.mocked(useVisitFile)

const visitor: VisitorItem = {
  name: 'Teknisi Uji',
  id_number: '3573000000000001',
  phone: '081200000001',
  id_card_photo_url: null,
}

function mockHook(result: {
  objectUrl: string | null
  loading: boolean
  error: string | null
  retry: () => void
}): void {
  mockedUseVisitFile.mockReturnValue(result)
}

describe('VisitFilePhoto', () => {
  it('meneruskan object URL ke foto saat muat sukses', () => {
    mockHook({
      objectUrl: 'blob:http://localhost/foto-uji',
      loading: false,
      error: null,
      retry: vi.fn(),
    })
    const { container } = render(
      <VisitFilePhoto visitId="visit-1" visitor={visitor} variant="selfie" />,
    )
    expect(container.querySelector('img')).not.toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('menampilkan pesan galat Indonesia + tombol Coba lagi saat fetch 400', () => {
    const retry = vi.fn()
    mockHook({
      objectUrl: null,
      loading: false,
      error: 'Gagal memuat berkas. Silakan coba lagi.',
      retry,
    })
    render(<VisitFilePhoto visitId="visit-1" visitor={visitor} variant="ktp" />)
    expect(
      screen.getByRole('alert'),
    ).toHaveTextContent('Gagal memuat berkas. Silakan coba lagi.')
    fireEvent.click(screen.getByRole('button', { name: 'Coba lagi' }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('tidak menampilkan galat saat masih memuat', () => {
    mockHook({ objectUrl: null, loading: true, error: null, retry: vi.fn() })
    render(<VisitFilePhoto visitId="visit-1" visitor={visitor} variant="selfie" />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Coba lagi' }),
    ).toBeNull()
  })
})
