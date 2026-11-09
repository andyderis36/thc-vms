/**
 * Kunci cache TanStack Query terpusat.
 *
 * Seluruh string kunci hanya didefinisikan di berkas ini — jangan tulis ulang
 * kunci query secara manual di tempat lain.
 */

import type {
  AuditLogListParams,
  ManagedUserListParams,
  NotificationListParams,
  PendingRegistrationListParams,
  VisitListParams,
} from '@/lib/api/types';

export const queryKeys = {
  visits: {
    list: (params: VisitListParams) => ['visits', 'list', params] as const,
    detail: (id: string) => ['visits', 'detail', id] as const,
    qr: (id: string) => ['visits', 'qr', id] as const,
  },
  locations: (activeOnly?: boolean) => ['locations', activeOnly ?? null] as const,
  purposes: () => ['purposes'] as const,
  vendors: () => ['vendors'] as const,
  publicVendors: () => ['public-vendors'] as const,
  vendorAccounts: () => ['vendor-accounts'] as const,
  jabatan: () => ['jabatan'] as const,
  vendorSuggestions: (q: string) => ['vendor-suggestions', q] as const,
  memberSuggestions: (params: { q: string; vendor: string }) =>
    ['member-suggestions', params] as const,
  memberSuggestion: (visitorId: string) => ['member-suggestion', visitorId] as const,
  securityUsers: (locationId?: string) => ['security-users', locationId ?? null] as const,
  managedUsers: (params?: ManagedUserListParams) =>
    ['managed-users', params ?? null] as const,
  auditLogs: (params: AuditLogListParams) => ['audit-logs', 'list', params] as const,
  notifications: (params?: NotificationListParams) =>
    ['notifications', params ?? null] as const,
  pendingRegistrations: (params?: PendingRegistrationListParams) =>
    ['pending-registrations', params ?? null] as const,
  me: () => ['me'] as const,
} as const;
