import { Badge } from '@/components/ui/Badge'
import { UserAvatar } from '@/components/ui/UserAvatar'
import type { User } from '@/lib/api/types'

export interface VendorIdentityCardProps {
  user: User
}

/**
 * Kartu identitas Vendor/Mitra di dashboard (di atas metrik, ikut VendorMobileShell).
 * Geometri identik dengan blok inline sebelumnya: slot avatar 48px (`size="lg"`)
 * berisi foto profil bila ada, inisial 2 huruf bila `avatar_url` kosong/gagal muat.
 */
export function VendorIdentityCard({ user }: VendorIdentityCardProps) {
  return (
    <section aria-label="Identitas Vendor/Mitra" className="card mb-5 flex items-center gap-4 p-4">
      <UserAvatar name={user.name} avatarUrl={user.avatar_url} size="lg" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-bold text-ink">{user.name}</p>
        <p className="truncate text-xs text-ink-secondary">
          {user.vendor_name ?? 'Vendor'}
          {' · '}
          {user.email}
        </p>
        <p className="mt-0.5 truncate text-xs text-ink-muted">
          {user.nik !== null ? `NIK ${user.nik}` : 'NIK —'}
        </p>
      </div>
      <Badge tone={user.status === 'active' ? 'success' : 'neutral'}>
        {user.status === 'active' ? 'Aktif' : 'Nonaktif'}
      </Badge>
    </section>
  )
}
