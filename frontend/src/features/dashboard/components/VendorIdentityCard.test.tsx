// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { User } from '@/lib/api/types'

import { VendorIdentityCard } from './VendorIdentityCard'

const USER: User = {
  id: 'u-vendor-1',
  name: 'Budi Santoso',
  email: 'budi@mitra.example',
  phone: '0812000000',
  nik: '3175090101900001',
  role: 'vendor',
  location_id: null,
  location_name: null,
  status: 'active',
  type: 'external',
  vendor_name: 'PT Fiber Mandiri',
  avatar_url: null,
}

function renderCard(overrides: Partial<User> = {}) {
  return render(<VendorIdentityCard user={{ ...USER, ...overrides }} />)
}

function cardSection(): HTMLElement {
  return screen.getByRole('region', { name: 'Identitas Vendor/Mitra' })
}

function avatarWrapper(): HTMLElement | null {
  return cardSection().querySelector<HTMLElement>('[data-avatar-state]')
}

describe('VendorIdentityCard', () => {
  it('menampilkan foto profil sebagai <img> saat avatar_url tersedia', () => {
    renderCard({ avatar_url: 'https://cdn.example/u.png' })

    expect(cardSection()).toBeInTheDocument()
    const wrapper = avatarWrapper()
    expect(wrapper).toHaveAttribute('data-avatar-state', 'image')

    const img = wrapper?.querySelector('img')
    expect(img).not.toBeNull()
    expect(img).toHaveAttribute('src', 'https://cdn.example/u.png')
  })

  it('jatuh ke inisial 2 huruf tanpa <img> saat avatar_url kosong', () => {
    renderCard({ avatar_url: null })

    const wrapper = avatarWrapper()
    expect(wrapper).toHaveAttribute('data-avatar-state', 'initials')
    expect(wrapper?.textContent).toBe('BS')
    expect(cardSection().querySelector('img')).toBeNull()
  })

  it('jatuh ke inisial dan melepas <img> saat foto gagal dimuat', () => {
    renderCard({ avatar_url: 'https://cdn.example/expired.png' })

    const wrapper = avatarWrapper()
    expect(wrapper).toHaveAttribute('data-avatar-state', 'image')
    const img = wrapper?.querySelector('img')
    expect(img).not.toBeNull()

    fireEvent.error(img!)

    expect(wrapper).toHaveAttribute('data-avatar-state', 'initials')
    expect(wrapper?.textContent).toBe('BS')
    expect(cardSection().querySelector('img')).toBeNull()
  })

  it('tetap menampilkan teks identitas dan badge status Aktif', () => {
    renderCard()

    expect(screen.getByText('Budi Santoso')).toBeInTheDocument()
    expect(screen.getByText('PT Fiber Mandiri · budi@mitra.example')).toBeInTheDocument()
    expect(screen.getByText('NIK 3175090101900001')).toBeInTheDocument()
    expect(screen.getByText('Aktif')).toBeInTheDocument()
  })

  it('menampilkan fallback Vendor/NIK dan badge Nonaktif untuk akun non-aktif', () => {
    renderCard({ status: 'inactive', nik: null, vendor_name: null })

    expect(screen.getByText('Vendor · budi@mitra.example')).toBeInTheDocument()
    expect(screen.getByText('NIK —')).toBeInTheDocument()
    expect(screen.getByText('Nonaktif')).toBeInTheDocument()
    expect(screen.queryByText('Aktif')).not.toBeInTheDocument()
  })
})
