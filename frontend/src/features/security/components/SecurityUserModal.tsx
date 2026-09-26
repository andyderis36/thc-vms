'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import { Spinner } from '@/components/ui/Spinner'
import {
  useCreateSecurityUserMutation,
  useLocationsQuery,
  useSecurityUsersQuery,
  useUpdateSecurityUserStatusMutation,
} from '@/lib/api/hooks'
import { useSession } from '@/lib/auth/session'
import { can } from '@/lib/auth/capabilities'
import type { Role, UpdateUserStatusRequest } from '@/lib/api/types'

/** Salinan lokal (sengaja tanpa lintas-feature import): pesan error aman untuk UI. */
function apiErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') {
    return error.message
  }
  return 'Terjadi kesalahan. Silakan coba lagi.'
}

export interface SecurityUserModalProps {
  open: boolean
  onClose: () => void
}

/**
 * Modal Kelola Satpam Cabang (bagian dari SCR-02).
 *
 * Dua bagian:
 * 1. Form tambah satpam (`id="security-user-form"` — tombol Kirim berada di
 *    footer modal dan merujuk form lewat atribut `form` lintas-elemen).
 * 2. Daftar satpam dengan pemilah aktif/nonaktif.
 *
 * Guard kapabilitas `manageSecurity` dievaluasi DI SINI juga — peran `pic`
 * dan `security` yang secara tidak sengaja menerima prop `open` tetap tidak
 * pernah melihat kontrol (lapisan pertahanan kedua setelah dashboard).
 */
export function SecurityUserModal({ open, onClose }: SecurityUserModalProps) {
  const { user } = useSession()
  const role: Role | null = user !== null ? user.role : null
  const ownLocationId = user !== null ? user.location_id : null

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [locationId, setLocationId] = useState('')

  const locationsQuery = useLocationsQuery()
  const createUser = useCreateSecurityUserMutation()
  const toggleStatus = useUpdateSecurityUserStatusMutation()

  // Lokasi cabang penugasan: super_admin memilih; admin terkunci ke cabangnya.
  const effectiveLocationId = role === 'super_admin' ? locationId : (ownLocationId ?? '')
  const usersQuery = useSecurityUsersQuery(effectiveLocationId !== '' ? effectiveLocationId : undefined, open)

  // Reset form setiap kali modal dibuka agar data sebelumnya tidak tertinggal.
  useEffect(() => {
    if (open) {
      setName('')
      setEmail('')
      setPhone('')
      setPassword('')
      setLocationId('')
    }
  }, [open])

  if (role === null || !can(role, 'manageSecurity')) return null

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (name.trim() === '' || email.trim() === '' || password === '') return
    if (effectiveLocationId === '') return

    createUser.mutate(
      {
        body: {
          name: name.trim(),
          email: email.trim(),
          password,
          ...(phone.trim() !== '' ? { phone: phone.trim() } : {}),
          location_id: effectiveLocationId,
        },
      },
      {
        onSuccess: () => {
          toast.success(`Satpam ${name.trim()} berhasil ditambahkan`)
          onClose()
        },
        onError: (error) => {
          toast.error(apiErrorMessage(error))
        },
      },
    )
  }

  const handleToggle = (userId: string, userName: string, next: UpdateUserStatusRequest['status']): void => {
    toggleStatus.mutate(
      { userId, body: { status: next } },
      {
        onSuccess: () => {
          toast.success(`Status ${userName} diperbarui`)
        },
        onError: (error) => {
          toast.error(apiErrorMessage(error))
        },
      },
    )
  }

  const locationOptions = (locationsQuery.data ?? []).map((location) => ({
    value: location.id,
    label: location.name,
  }))
  const canPickLocation = role === 'super_admin'

  const users = usersQuery.data ?? []

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Kelola Satpam Cabang"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Tutup
          </Button>
          <Button
            type="submit"
            form="security-user-form"
            className="min-h-touch"
            loading={createUser.isPending}
          >
            Tambah Satpam
          </Button>
        </>
      }
    >
      <form id="security-user-form" onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Nama Lengkap"
            placeholder="Nama satpam"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="name"
            required
          />
          <Input
            label="Email"
            type="email"
            placeholder="nama@thc.id"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            required
          />
          <Input
            label="No. Telepon"
            type="tel"
            placeholder="08xxxxxxxxxx"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            autoComplete="tel"
          />
          <Input
            label="Kata Sandi"
            type="password"
            placeholder="Kata sandi awal"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            hint="Dibagikan ke satpam; dapat diubah setelah masuk."
            required
          />
        </div>

        {canPickLocation ? (
          <Select
            label="Cabang Penugasan"
            placeholder="Pilih cabang / POP"
            options={locationOptions}
            value={locationId}
            onChange={(event) => setLocationId(event.target.value)}
            required
          />
        ) : (
          <div className="flex flex-col gap-1.5">
            <span className="text-label font-semibold text-ink">Cabang Penugasan</span>
            <p className="inline-flex w-fit items-center gap-1.5 rounded-control border border-border-light bg-neutral-bg px-3 py-2 text-label text-ink-secondary">
              {user !== null ? (user.location_name ?? 'Cabang') : 'Cabang'}
              <span className="text-ink-muted">(terkunci)</span>
            </p>
          </div>
        )}
      </form>

      <div className="mt-6 border-t border-border-light pt-4">
        <p className="mb-3 text-label font-semibold text-ink">Daftar Satpam</p>

        {usersQuery.isPending ? (
          <div className="flex items-center gap-2 py-4 text-sm text-ink-muted">
            <Spinner size="sm" />
            Memuat daftar satpam…
          </div>
        ) : users.length === 0 ? (
          <p className="py-4 text-sm text-ink-muted">Belum ada satpam terdaftar.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {users.map((member) => {
              const isActive = member.status === 'active'
              const toggleable = member.status !== 'blacklisted'
              return (
                <li
                  key={member.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-border-light px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">{member.name}</p>
                    <p className="truncate text-xs text-ink-muted">
                      {member.email}
                      {member.location_name !== null ? ` · ${member.location_name}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={isActive ? 'success' : member.status === 'blacklisted' ? 'danger' : 'neutral'}>
                      {isActive ? 'AKTIF' : member.status === 'blacklisted' ? 'DIBLOKIR' : 'NONAKTIF'}
                    </Badge>
                    {toggleable ? (
                      <Button
                        size="sm"
                        variant={isActive ? 'secondary' : 'primary'}
                        className="min-h-touch px-3"
                        loading={toggleStatus.isPending && toggleStatus.variables?.userId === member.id}
                        onClick={() => handleToggle(member.id, member.name, isActive ? 'inactive' : 'active')}
                      >
                        {isActive ? 'Nonaktifkan' : 'Aktifkan'}
                      </Button>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Modal>
  )
}
