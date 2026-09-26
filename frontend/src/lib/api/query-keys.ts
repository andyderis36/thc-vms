/**
 * Kunci cache TanStack Query terpusat.
 *
 * Seluruh string kunci hanya didefinisikan di berkas ini — jangan tulis ulang
 * kunci query secara manual di tempat lain.
 */

import type { VisitListParams } from '@/lib/api/types';

export const queryKeys = {
  visits: {
    list: (params: VisitListParams) => ['visits', 'list', params] as const,
    detail: (id: string) => ['visits', 'detail', id] as const,
    qr: (id: string) => ['visits', 'qr', id] as const,
  },
  locations: () => ['locations'] as const,
  purposes: () => ['purposes'] as const,
  securityUsers: (locationId?: string) => ['security-users', locationId ?? null] as const,
  me: () => ['me'] as const,
} as const;
