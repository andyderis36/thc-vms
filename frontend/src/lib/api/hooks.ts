'use client'

/**
 * Lapisan hook TanStack Query v5 untuk seluruh REST API THC VMS.
 *
 * Sisi baca: factory `queryOptions` + pembungkus `use*` tipis.
 * Sisi tulis: `useMutation` dengan invalidasi kunci cache yang tepat.
 *
 * API v5 murni — `onSuccess` hanya hidup di mutasi (`useQuery` v5 tidak
 * mengenalnya), flag pending adalah `isPending`, dan masa simpan cache adalah
 * `gcTime`. Token sesi dibaca `fetcher.ts` dari `localStorage` saat request,
 * jadi tidak ada plumbing token di lapisan ini.
 */

import { type QueryClient, queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  approveVisit,
  cancelVisit,
  checkInVisit,
  checkOutVisit,
  createLocation,
  createManagedUser,
  createSecurityUser,
  createVisit,
  deleteLocation,
  deleteManagedUser,
  deleteSecurityUser,
  deleteVisit,
  getMe,
  getVisit,
  getVisitQr,
  listLocations,
  listManagedUsers,
  listPurposes,
  listSecurityUsers,
  listVendors,
  listVisits,
  rejectVisit,
  rescheduleVisit,
  updateLocation,
  updateManagedUser,
  updateManagedUserStatus,
  updateSecurityUser,
  updateSecurityUserStatus,
  uploadFile,
} from '@/lib/api/client'
import { ApiError } from '@/lib/api/fetcher'
import { queryKeys } from '@/lib/api/query-keys'
import type {
  ApproveRequest,
  CancelRequest,
  CheckInRequest,
  CreateLocationRequest,
  CreateManagedUserRequest,
  CreateSecurityUserRequest,
  CreateVisitRequest,
  ManagedUserListParams,
  RejectRequest,
  RescheduleRequest,
  UpdateLocationRequest,
  UpdateManagedUserRequest,
  UpdateSecurityUserRequest,
  UpdateUserStatusRequest,
  UploadCategory,
  VisitListParams,
} from '@/lib/api/types'

/**
 * Master data (kantor/POP + tujuan kunjungan) praktis tidak pernah berubah dan
 * dibaca bareng oleh banyak petugas pos sekaligus. Target produk: P95 < 150 ms
 * dan ~1.000 req/detik, jadi 5 menit cache mencegah N pengguna gerbang
 * membanjiri API Go dengan permintaan identik.
 */
const MASTER_STALE_TIME = 5 * 60 * 1000

/** Kunjungan berubah cepat (approval, check-in) — 30 detik sudah cukup untuk layar. */
const VISIT_STALE_TIME = 30 * 1000

/**
 * Pembaruan otomatis layar detail kunjungan (SCR-04 sisi vendor):
 * QR & "Riwayat Status" wajib menyegarkan diri tanpa reload manual —
 * misalnya saat admin menyetujui atau satpam check-in/out dari klien lain.
 * Polling 12 detik (di dalam rentang 10–15 detik) + refetch saat jendela
 * kembali fokus; `refetchIntervalInBackground: false` menjaga agar tab yang
 * tersembunyi tidak membanjiri API.
 */
const VISIT_DETAIL_REFETCH_INTERVAL = 12_000

/**
 * Prefix kunci yang tetap diturunkan dari `queryKeys`, bukan string yang
 * ditulis ulang. `invalidateQueries` memakai partial match, jadi prefix daftar
 * kunjungan sekaligus mengenai seluruh varian `params`/filter.
 */
const VISIT_LIST_PREFIX = queryKeys.visits.list({}).slice(0, 2)
const SECURITY_USERS_PREFIX = queryKeys.securityUsers().slice(0, 1)
const MANAGED_USERS_PREFIX = queryKeys.managedUsers().slice(0, 1)
const LOCATIONS_PREFIX = queryKeys.locations().slice(0, 1)

/** 401/403/404 bersifat definitif — mengulanginya hanya menambah beban API. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  const isDefinitive = error instanceof ApiError && [401, 403, 404].includes(error.status)
  return !isDefinitive && failureCount < 1
}

/** Status kunjungan berubah → segarkan seluruh daftar + detail + QR kunjungan itu. */
function invalidateVisitStatus(queryClient: QueryClient, visitId: string): void {
  void queryClient.invalidateQueries({ queryKey: VISIT_LIST_PREFIX })
  void queryClient.invalidateQueries({ queryKey: queryKeys.visits.detail(visitId) })
  void queryClient.invalidateQueries({ queryKey: queryKeys.visits.qr(visitId) })
}

/**
 * Check-in/out juga menyegarkan QR: pas yang baru saja terpakai di gerbang
 * tidak boleh masih tampil sebagai valid di layar pemegang.
 */
function invalidateVisitPresence(queryClient: QueryClient, visitId: string): void {
  invalidateVisitStatus(queryClient, visitId)
  void queryClient.invalidateQueries({ queryKey: queryKeys.visits.qr(visitId) })
}

type VisitIdWithBody<TBody> = { visitId: string; body: TBody }
type VisitIdWithOptionalBody<TBody> = { visitId: string; body?: TBody }

// ---------------------------------------------------------------------------
// Query options (sisi baca)
// ---------------------------------------------------------------------------

export const meQueryOptions = queryOptions({
  queryKey: queryKeys.me(),
  queryFn: () => getMe(),
  // Identitas & cabang pengguna harus selalu divalidasi ulang tiap mount.
  staleTime: 0,
  retry: false,
})

/** Master data bersifat global (bukan per cabang) — aman dipakai bersama semua pengguna. */
export const locationsQueryOptions = (activeOnly?: boolean) =>
  queryOptions({
    queryKey: queryKeys.locations(activeOnly),
    queryFn: () => listLocations(activeOnly),
    staleTime: MASTER_STALE_TIME,
    retry: shouldRetry,
  })

/** Sama seperti lokasi: tujuan kunjungan jarang berubah, jadi layak 5 menit. */
export const purposesQueryOptions = queryOptions({
  queryKey: queryKeys.purposes(),
  queryFn: () => listPurposes(),
  staleTime: MASTER_STALE_TIME,
  retry: shouldRetry,
})

/** Katalog vendor mitra: master data global seperti lokasi/purposes. */
export const vendorsQueryOptions = queryOptions({
  queryKey: queryKeys.vendors(),
  queryFn: () => listVendors(),
  staleTime: MASTER_STALE_TIME,
  retry: shouldRetry,
})

export function visitsQueryOptions(params: VisitListParams) {
  return queryOptions({
    queryKey: queryKeys.visits.list(params),
    queryFn: () => listVisits(params),
    staleTime: VISIT_STALE_TIME,
    retry: shouldRetry,
  })
}

export function visitDetailQueryOptions(id: string | null) {
  return queryOptions({
    queryKey: queryKeys.visits.detail(id ?? ''),
    queryFn: () => getVisit(id ?? ''),
    enabled: id !== null,
    staleTime: VISIT_STALE_TIME,
    retry: shouldRetry,
    // Pembaruan mandiri SCR-04 vendor (lihat konstanta di atas).
    refetchInterval: VISIT_DETAIL_REFETCH_INTERVAL,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  })
}

/**
 * QR hanya ada untuk kunjungan berstatus `approved`; status lain dibalas 404,
 * jadi pemanggil wajib mengaktifkan query ini hanya setelah status terverifikasi
 * dan `shouldRetry` menyingkirkan 404 dari percobaan ulang.
 */
export function visitQrQueryOptions(id: string | null) {
  return queryOptions({
    queryKey: queryKeys.visits.qr(id ?? ''),
    queryFn: () => getVisitQr(id ?? ''),
    enabled: id !== null,
    staleTime: VISIT_STALE_TIME,
    retry: shouldRetry,
    // QR wajib ikut polling agar kartu QR selalu sinkron (lihat konstanta di atas).
    refetchInterval: VISIT_DETAIL_REFETCH_INTERVAL,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  })
}

export function securityUsersQueryOptions(locationId?: string) {
  return queryOptions({
    queryKey: queryKeys.securityUsers(locationId),
    queryFn: () => listSecurityUsers({ location_id: locationId }),
    staleTime: VISIT_STALE_TIME,
    retry: shouldRetry,
  })
}

/** Daftar user lintas cabang untuk super_admin (filter role/search/location). */
export function managedUsersQueryOptions(params: ManagedUserListParams) {
  return queryOptions({
    queryKey: queryKeys.managedUsers(params),
    queryFn: () => listManagedUsers(params),
    staleTime: VISIT_STALE_TIME,
    retry: shouldRetry,
  })
}

// ---------------------------------------------------------------------------
// Query hooks (sisi baca)
// ---------------------------------------------------------------------------

export function useMeQuery() {
  return useQuery(meQueryOptions)
}

export function useLocationsQuery(activeOnly?: boolean) {
  return useQuery(locationsQueryOptions(activeOnly));
}

export function usePurposesQuery() {
  return useQuery(purposesQueryOptions)
}

export function useVendorsQuery(enabled = true) {
  return useQuery({ ...vendorsQueryOptions, enabled })
}

export function useVisitsQuery(params: VisitListParams, enabled = true) {
  return useQuery({ ...visitsQueryOptions(params), enabled })
}

export function useVisitQuery(id: string | null) {
  return useQuery(visitDetailQueryOptions(id))
}

/** `enabled` berasal dari pemanggil — teruskan true untuk status `approved` (check-in) atau `visiting` (check-out, QR yang sama). */
export function useVisitQrQuery(id: string | null, enabled = true) {
  return useQuery({ ...visitQrQueryOptions(id), enabled: id !== null && enabled })
}

export function useSecurityUsersQuery(locationId?: string, enabled = true) {
  return useQuery({ ...securityUsersQueryOptions(locationId), enabled })
}

export function useManagedUsersQuery(params: ManagedUserListParams, enabled = true) {
  return useQuery({ ...managedUsersQueryOptions(params), enabled })
}

// ---------------------------------------------------------------------------
// Mutation hooks (sisi tulis)
// ---------------------------------------------------------------------------

export function useApproveVisitMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ visitId, body }: VisitIdWithOptionalBody<ApproveRequest>) => approveVisit(visitId, body),
    onSuccess: (_data, variables) => {
      invalidateVisitStatus(queryClient, variables.visitId)
    },
  })
}

export function useRejectVisitMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ visitId, body }: VisitIdWithBody<RejectRequest>) => rejectVisit(visitId, body),
    onSuccess: (_data, variables) => {
      invalidateVisitStatus(queryClient, variables.visitId)
    },
  })
}

export function useRescheduleVisitMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ visitId, body }: VisitIdWithBody<RescheduleRequest>) => rescheduleVisit(visitId, body),
    onSuccess: (_data, variables) => {
      invalidateVisitStatus(queryClient, variables.visitId)
    },
  })
}

export function useCancelVisitMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ visitId, body }: VisitIdWithOptionalBody<CancelRequest>) => cancelVisit(visitId, body),
    onSuccess: (_data, variables) => {
      invalidateVisitStatus(queryClient, variables.visitId)
    },
  })
}

export function useCreateVisitMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ body }: { body: CreateVisitRequest }) => createVisit(body),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: VISIT_LIST_PREFIX })
      queryClient.setQueryData(queryKeys.visits.detail(data.id), data)
    },
  })
}

export function useCheckInVisitMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ visitId, body }: VisitIdWithOptionalBody<CheckInRequest>) => checkInVisit(visitId, body),
    onSuccess: (_data, variables) => {
      invalidateVisitPresence(queryClient, variables.visitId)
    },
  })
}

export function useCheckOutVisitMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ visitId }: { visitId: string }) => checkOutVisit(visitId),
    onSuccess: (_data, variables) => {
      invalidateVisitPresence(queryClient, variables.visitId)
    },
  })
}

export function useCreateSecurityUserMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ body }: { body: CreateSecurityUserRequest }) => createSecurityUser(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SECURITY_USERS_PREFIX })
    },
  })
}

export function useUpdateSecurityUserStatusMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ userId, body }: { userId: string; body: UpdateUserStatusRequest }) =>
      updateSecurityUserStatus(userId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SECURITY_USERS_PREFIX })
      void queryClient.invalidateQueries({ queryKey: queryKeys.me() })
    },
  })
}

/** Hapus satpam cabang → segarkan daftar security-users (prefix ada). */
export function useDeleteSecurityUserMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ userId }: { userId: string }) => deleteSecurityUser(userId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SECURITY_USERS_PREFIX })
    },
  })
}

/** Ubah satpam cabang → segarkan daftar security-users (prefix ada). */
export function useUpdateSecurityUserMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ userId, body }: { userId: string; body: UpdateSecurityUserRequest }) =>
      updateSecurityUser(userId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SECURITY_USERS_PREFIX })
    },
  })
}

export function useCreateLocationMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ body }: { body: CreateLocationRequest }) => createLocation(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: LOCATIONS_PREFIX })
    },
  })
}

export function useUpdateLocationMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ locationId, body }: { locationId: string; body: UpdateLocationRequest }) =>
      updateLocation(locationId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: LOCATIONS_PREFIX })
    },
  })
}

export function useCreateManagedUserMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ body }: { body: CreateManagedUserRequest }) => createManagedUser(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MANAGED_USERS_PREFIX })
    },
  })
}

export function useUpdateManagedUserStatusMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ userId, body }: { userId: string; body: UpdateUserStatusRequest }) =>
      updateManagedUserStatus(userId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MANAGED_USERS_PREFIX })
      void queryClient.invalidateQueries({ queryKey: queryKeys.me() })
    },
  })
}

/** Ubah user terkelola → segarkan daftar managed-users (prefix ada). */
export function useUpdateManagedUserMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ userId, body }: { userId: string; body: UpdateManagedUserRequest }) =>
      updateManagedUser(userId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MANAGED_USERS_PREFIX })
    },
  })
}

/** Hapus kunjungan → segarkan daftar + detail kunjungan itu (prefix ada). */
export function useDeleteVisitMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ visitId }: { visitId: string }) => deleteVisit(visitId),
    onSuccess: (_data, variables) => {
      invalidateVisitStatus(queryClient, variables.visitId)
    },
  })
}

/** Hapus user terkelola → segarkan daftar managed-users (prefix ada). */
export function useDeleteManagedUserMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ userId }: { userId: string }) => deleteManagedUser(userId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MANAGED_USERS_PREFIX })
    },
  })
}

/** Hapus fasilitas → segarkan daftar locations (prefix ada). */
export function useDeleteLocationMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ locationId }: { locationId: string }) => deleteLocation(locationId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: LOCATIONS_PREFIX })
    },
  })
}

/** Unggahan mengembalikan URL, bukan daftar — tidak ada cache yang perlu disegarkan. */
export function useUploadFileMutation() {
  return useMutation({
    mutationFn: ({ file, category }: { file: File; category: UploadCategory }) => uploadFile(file, category),
  })
}
