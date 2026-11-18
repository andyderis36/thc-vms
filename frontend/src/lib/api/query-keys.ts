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
    logs: (id: string) => ['visits', 'logs', id] as const,
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
  notificationSettings: () => ['notification-settings', 'matrix'] as const,
  notificationMatrix: () => ['notification-settings', 'matrix'] as const,
  settingsNotifications: () => ['notification-settings', 'matrix'] as const,
  notificationsSettings: () => ['notification-settings', 'matrix'] as const,
  systemSettings: () => ['notification-settings', 'system'] as const,
  settingsSystem: () => ['notification-settings', 'system'] as const,
  notificationSettingsSystem: () => ['notification-settings', 'system'] as const,
  mailLogs: (params?: unknown) => (params === undefined ? (['notification-settings', 'mail-logs'] as const) : (['notification-settings', 'mail-logs', params] as const)),
  mailLog: (id?: string) => (id === undefined ? (['notification-settings', 'mail-logs'] as const) : (['notification-settings', 'mail-logs', id] as const)),
  mailLogsList: (params?: unknown) => (params === undefined ? (['notification-settings', 'mail-logs'] as const) : (['notification-settings', 'mail-logs', params] as const)),
  settingsMailLogs: () => ['notification-settings', 'mail-logs'] as const,
  notificationSettingsMailLogs: () => ['notification-settings', 'mail-logs'] as const,
  pendingRegistrations: (params?: PendingRegistrationListParams) =>
    ['pending-registrations', params ?? null] as const,
  me: () => ['me'] as const,
} as const;
