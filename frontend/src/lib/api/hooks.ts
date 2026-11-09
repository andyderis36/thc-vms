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

import { useEffect, useState } from 'react'
import {
  type QueryClient,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  approveVisit,
  cancelVisit,
  checkInVisit,
  checkOutVisit,
  confirmEmailChange,
  createLocation,
  createManagedUser,
  createSecurityUser,
  createVisit,
  deleteLocation,
  deleteManagedUser,
  deleteSecurityUser,
  deleteVisit,
  getMe,
  getMemberSuggestion,
  getVisit,
  getVisitQr,
  listAuditLogs,
  listJabatan,
  listLocations,
  listManagedUsers,
  listMemberSuggestions,
  listNotifications,
  listPendingRegistrations,
  listPublicVendors,
  listPurposes,
  listSecurityUsers,
  listVendorAccounts,
  listVendors,
  listVendorSuggestions,
  listVisits,
  markAllNotificationsRead,
  markNotificationRead,
  rejectVisit,
  requestEmailChange,
  rescheduleVisit,
  updateLocation,
  updateManagedUser,
  updateManagedUserStatus,
  updateMe,
  updateSecurityUser,
  updateSecurityUserStatus,
  updateVisitorContact,
  uploadFile,
} from '@/lib/api/client'
import { ApiError } from '@/lib/api/fetcher'
import { queryKeys } from '@/lib/api/query-keys'
import { isSuperAdminRole } from '@/lib/auth/capabilities'
import { useSession } from '@/lib/auth/session'
import { selectActiveQrVisit } from '@/lib/visits/active-qr-ticket'
import { clampSuggestionQuery } from '@/lib/visits/suggestions'
import type {
  ApproveRequest,
  AuditLogListParams,
  CancelRequest,
  CheckInRequest,
  CreateLocationRequest,
  CreateManagedUserRequest,
  CreateSecurityUserRequest,
  CreateVisitRequest,
  EmailChangeConfirmRequest,
  EmailChangeRequest,
  Location,
  ManagedUserListParams,
  NotificationListParams,
  NotificationListResult,
  PendingRegistrationListParams,
  RejectRequest,
  RescheduleRequest,
  UpdateLocationRequest,
  UpdateManagedUserRequest,
  UpdateSecurityUserRequest,
  UpdateSelfProfileRequest,
  UpdateUserStatusRequest,
  UpdateVisitorContactRequest,
  UploadCategory,
  User,
  VisitDetail,
  VisitListParams,
  VisitStatus,
} from '@/lib/api/types'

/**
 * Master data (kantor/POP + tujuan + katalog vendor) praktis tidak pernah
 * berubah dan dibaca bareng oleh banyak petugas pos sekaligus. Diet data S5:
 * `staleTime: Infinity` + `gcTime: 24 jam` — N pengguna gerbang tidak
 * menuju API Go dengan permintaan identik, dan pindah menu tidak memicu
 * refetch. Klien global di `providers.tsx` memakai default yang sama.
 */
const MASTER_STALE_TIME = Number.POSITIVE_INFINITY
const MASTER_GC_TIME = 24 * 60 * 60 * 1000

/** Kunjungan berubah cepat (approval, check-in) — 30 detik sudah cukup untuk layar. */
const VISIT_STALE_TIME = 30 * 1000

/**
 * Interval polling default daftar kunjungan (dashboard/approvals/badge/prefill):
 * 30 detik selama tab terlihat.
 */
const VISIT_LIST_REFETCH_INTERVAL = 30_000

/**
 * Interval bersyarat resolver tiket /qr: poll 30 dtk HANYA selama kunjungan
 * belum resolved (requested/rescheduled, daftar kosong, atau galat yang
 * mengosongkan items) agar approval yang mendarat tetap auto-advance seperti
 * baseline; stop (false) begitu tiket aktif terpilih (approved/visiting —
 * halaman detail mengambil alih + redirect melepas mount) atau semua baris
 * terminal. Satu kunci + satu owner, jadi membalik nilai ini tidak pernah
 * menciptakan timer ganda.
 */
export function qrResolverRefetchInterval(items: VisitDetail[]): number | false {
  if (selectActiveQrVisit(items) !== null) return false
  if (items.length === 0) return VISIT_LIST_REFETCH_INTERVAL
  const awaitingDecision = items.some(
    (visit) => visit.status === 'requested' || visit.status === 'rescheduled',
  )
  return awaitingDecision ? VISIT_LIST_REFETCH_INTERVAL : false
}

/**
 * Tier kios gerbang: antrean pos jaga dipoll tiap 15 detik (OPT-IN, hanya
 * dipakai 3 query /gate). Kunci query gerbang tidak pernah ter-mount
 * bersamaan dengan pemilik 30 dtk pada kunci yang sama (halaman berbeda /
 * role berbeda), jadi tidak ada timer ganda pada satu kunci.
 */
export const GATE_LIST_REFETCH_INTERVAL = 15_000

/**
 * Pembaruan otomatis layar detail kunjungan (SCR-04 sisi vendor): QR &
 * "Riwayat Status" menyegarkan diri tanpa reload manual — misalnya saat admin
 * menyetujui, pengawas check-in, atau pengawas check-out dari klien lain. Diet
 * baterai/data S5: hanya polling saat tab terlihat, dan hanya untuk status yang
 * masih bergerak — `approved` (menunggu datang) dan `visiting` (di dalam
 * gerbang, menunggu check-out). Status terminal (`completed`/`cancelled`/
 * `rejected`/`not_visit`), `requested` (belum ada konten cepat berubah), dan
 * `rescheduled` menghentikan polling; `document.hidden` juga menghentikannya.
 */
const VISIT_DETAIL_REFETCH_INTERVAL = 60_000

/**
 * Jendela check-out gerbang sengaja dipoll lebih rapat: `visiting` adalah
 * transisi keluar yang akan datang dan tamu biasanya masih berdiri di depan pos,
 * jadi jeda 60 detik membuat pas tertinggal "masih di lokasi" sampai satu menit
 * setelah check-out. 30 detik memotong separuh lag itu tanpa melipatgandakan
 * laju permintaan; karena jendela `visiting` pendek dan terbatas, total tambahan
 * beban tetap kecil — masih sesuai diet S5.
 */
const VISIT_VISITING_REFETCH_INTERVAL = 30_000

/**
 * Gerbang jeda polling detail/QR: `false` bila tab tersembunyi
 * (`document.hidden`) ATAU status kunjungan terminal/`requested`/`rescheduled`/
 * belum termuat. `approved` → 60 detik, `visiting` → 30 detik (lihat
 * `VISIT_*_REFETCH_INTERVAL`). Status `undefined` (data belum termuat)
 * diperlakukan fail-closed → polling berhenti sampai status diketahui.
 */
function visitRefetchInterval(status: VisitStatus | undefined): number | false {
  if (typeof document !== 'undefined' && document.hidden) return false
  if (status === 'approved') return VISIT_DETAIL_REFETCH_INTERVAL
  if (status === 'visiting') return VISIT_VISITING_REFETCH_INTERVAL
  return false
}

/**
 * Prefix kunci yang tetap diturunkan dari `queryKeys`, bukan string yang
 * ditulis ulang. `invalidateQueries` memakai partial match, jadi prefix daftar
 * kunjungan sekaligus mengenai seluruh varian `params`/filter.
 */
const VISIT_LIST_PREFIX = queryKeys.visits.list({}).slice(0, 2)
const SECURITY_USERS_PREFIX = queryKeys.securityUsers().slice(0, 1)
const MANAGED_USERS_PREFIX = queryKeys.managedUsers().slice(0, 1)
const LOCATIONS_PREFIX = queryKeys.locations().slice(0, 1)
const NOTIFICATIONS_PREFIX = queryKeys.notifications().slice(0, 1)

/**
 * Lonceng header menyegarkan feed notifikasi setiap 30 detik SELAMA panel
 * terbuka (`refetchIntervalInBackground: false`); saat tertutup, pemanggil
 * mematikan query (`enabled: false`) sehingga tak ada polling latar.
 */
const NOTIFICATIONS_REFETCH_INTERVAL = 30_000

/**
 * Ukuran halaman feed lonceng — satu-satunya sumber angka baris per halaman
 * (dipakai hook feed di bawah; komponen panel tidak mendefinisikannya ulang).
 *
 * Panel menampilkan halaman TERBARU lebih dulu (10 baris teratas) lalu memuat
 * halaman berikutnya saat petugas menekan "Muat lebih banyak", sampai seluruh
 * `total` habis. TIDAK ADA jendela tanggal / cap "2 hari" di mana pun pada
 * feed ini — angka 10 semata-mata ukuran halaman hard-coded ini, bukan filter
 * waktu. Backend mengklamp `limit > 100` kembali ke 20, jadi halaman kecil +
 * muat lanjut progresif adalah satu-satunya cara menjangkau seluruh
 * notifikasi (mis. 126 baris untuk super_admin).
 */
export const FEED_LIMIT = 10

/**
 * Jumlah entri pendaftaran vendor yang ditampilkan di section panel lonceng
 * superadmin — daftar ringkas di atas feed notifikasi; pengelolaan penuh
 * (setujui/tolak) tetap lewat `/vendor-registrations`.
 */
export const PENDING_FEED_LIMIT = 5

/**
 * 401/403/404 bersifat definitif — mengulanginya hanya menambah beban API.
 * Selain galat definitif itu, kegagalan jaringan/5xx diulang sampai 2 kali
 * (selaras default global `retry: 2` + backoff eksponensial cap 30 detik)
 * demi ketahanan S5 di koneksi seluler yang putus-putus.
 */
function shouldRetry(failureCount: number, error: unknown): boolean {
  const isDefinitive = error instanceof ApiError && [401, 403, 404].includes(error.status)
  return !isDefinitive && failureCount < 2
}

/** Status kunjungan berubah → segarkan daftar + detail + QR + feed notifikasi. */
function invalidateVisitStatus(queryClient: QueryClient, visitId: string): void {
  void queryClient.invalidateQueries({ queryKey: VISIT_LIST_PREFIX })
  void queryClient.invalidateQueries({ queryKey: queryKeys.visits.detail(visitId) })
  void queryClient.invalidateQueries({ queryKey: queryKeys.visits.qr(visitId) })
  void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_PREFIX })
}

/**
 * Check-in/out juga menyegarkan QR: pas yang baru saja terpakai di gerbang
 * tidak boleh masih tampil sebagai valid di layar pemegang.
 */
function invalidateVisitPresence(queryClient: QueryClient, visitId: string): void {
  invalidateVisitStatus(queryClient, visitId)
  void queryClient.invalidateQueries({ queryKey: queryKeys.visits.qr(visitId) })
}

/**
 * Sisipkan entitas hasil create ke cache daftar yang SUDAH terisi. Invalidasi
 * saja tidak cukup untuk daftar yang difilter/diurutkan di klien (mis.
 * `/facilities`): kebijakan global `staleTime: Infinity` membuat layar bisa
 * tetap memegang cache pra-create sampai reload. Baris baru diletakkan di
 * depan agar langsung tampil; invalidasi tetap dijalankan supaya konsumen
 * lain menyegarkan diri ke data server.
 *
 * Entri dengan `id` yang sama DIGANTI, bukan diduplikasi — pemanggilan ganda
 * atau baris yang sudah ada (mis. refetch yang balapan) tetap aman.
 */
function withCreatedRow<T extends { id: string }>(rows: T[], created: T): T[] {
  return [created, ...rows.filter((row) => row.id !== created.id)]
}

/**
 * Tulis fasilitas baru ke seluruh varian cache `locations` yang sudah dimuat.
 * Varian `active_only` (key[1] bukan `false`) hanya menerima fasilitas aktif,
 * sehingga katalog form pengajuan tidak pernah memuat fasilitas nonaktif.
 */
function insertLocationIntoCaches(queryClient: QueryClient, created: Location): void {
  const entries = queryClient.getQueriesData<Location[]>({ queryKey: LOCATIONS_PREFIX })
  for (const [key, rows] of entries) {
    if (!Array.isArray(rows)) continue
    const activeOnly = key[1] !== false
    if (activeOnly && created.is_active === false) continue
    queryClient.setQueryData<Location[]>(key, withCreatedRow(rows, created))
  }
}

/**
 * Tulis pengawas baru hanya ke cache `security-users` yang cakupannya memuat
 * cabang akun itu: daftar global (`null`, superadmin lintas cabang) atau
 * daftar cabang yang sama. Cache cabang lain TIDAK disentuh (isolasi cabang).
 */
function insertSecurityUserIntoCaches(queryClient: QueryClient, created: User): void {
  const entries = queryClient.getQueriesData<User[]>({ queryKey: SECURITY_USERS_PREFIX })
  for (const [key, rows] of entries) {
    if (!Array.isArray(rows)) continue
    const scopedLocationId = key[1] ?? null
    if (scopedLocationId !== null && scopedLocationId !== created.location_id) continue
    queryClient.setQueryData<User[]>(key, withCreatedRow(rows, created))
  }
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
    gcTime: MASTER_GC_TIME,
    retry: shouldRetry,
  })

/** Sama seperti lokasi: tujuan kunjungan jarang berubah — Infinity + gcTime 24 jam. */
export const purposesQueryOptions = queryOptions({
  queryKey: queryKeys.purposes(),
  queryFn: () => listPurposes(),
  staleTime: MASTER_STALE_TIME,
  gcTime: MASTER_GC_TIME,
  retry: shouldRetry,
})

/** Katalog vendor mitra: master data global seperti lokasi/purposes. */
export const vendorsQueryOptions = queryOptions({
  queryKey: queryKeys.vendors(),
  queryFn: () => listVendors(),
  staleTime: MASTER_STALE_TIME,
  gcTime: MASTER_GC_TIME,
  retry: shouldRetry,
})

/**
 * Katalog vendor publik (`GET /public/vendors`, tanpa auth) — layar
 * pendaftaran mandiri. Master data global dengan diet yang sama.
 */
export const publicVendorsQueryOptions = queryOptions({
  queryKey: queryKeys.publicVendors(),
  queryFn: () => listPublicVendors(),
  staleTime: MASTER_STALE_TIME,
  gcTime: MASTER_GC_TIME,
  retry: shouldRetry,
})

/**
 * Akun vendor aktif (`GET /users/vendors`) — master data global untuk pemilih
 * pemilik kunjungan (admin/super_admin). 403 untuk peran lain ditahan
 * pemanggil lewat `enabled`.
 */
export const vendorAccountsQueryOptions = queryOptions({
  queryKey: queryKeys.vendorAccounts(),
  queryFn: () => listVendorAccounts(),
  staleTime: MASTER_STALE_TIME,
  gcTime: MASTER_GC_TIME,
  retry: shouldRetry,
})

/**
 * Saran jabatan: nilai yang pernah tersimpan pada baris visitor — berubah
 * jarang dan dipakai bersama semua pengajuan, jadi diet data yang sama
 * dengan master data lain.
 */
export const jabatanQueryOptions = queryOptions({
  queryKey: queryKeys.jabatan(),
  queryFn: () => listJabatan(),
  staleTime: MASTER_STALE_TIME,
  gcTime: MASTER_GC_TIME,
  retry: shouldRetry,
})

// ---------------------------------------------------------------------------
// Saran isian (T9 vendor identity + T11 member reuse)
// ---------------------------------------------------------------------------

/** Jeda debounce ketikan → request saran (kontrak T9/T11: 250-300 ms). */
const SUGGESTION_DEBOUNCE_MS = 300

/**
 * Nilai setelah debounce — pola `searchInput`/`search` halaman gerbang &
 * dashboard: hanya nilai AKHIR ketikan yang menjadi query key, sehingga
 * respons request sebelumnya tidak pernah ter-render (kunci = nilai kirim).
 */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}

/** Feed vendor hanya untuk admin/super_admin — vendor/security dijaga 403 backend. */
function canSuggestVendors(user: User | null): boolean {
  return user !== null && (user.role === 'admin' || isSuperAdminRole(user.role))
}

/** Feed anggota untuk super_admin/admin/vendor — security dijaga 403 backend. */
function canSuggestMembers(user: User | null): boolean {
  return (
    user !== null &&
    (user.role === 'vendor' || user.role === 'admin' || isSuperAdminRole(user.role))
  )
}

/** `GET /vendors/suggestions` — per `q` hasil debounce + clamp klien. */
export const vendorSuggestionsQueryOptions = (q: string) =>
  queryOptions({
    queryKey: queryKeys.vendorSuggestions(q),
    queryFn: () => listVendorSuggestions(q),
    staleTime: VISIT_STALE_TIME,
    retry: shouldRetry,
  })

/**
 * `GET /visits/member-suggestions` — kunci memuat `q` + `vendor` yang sudah
 * dinormalisasi; peran vendor mengabaikan `vendor` di backend, jadi nilai itu
 * tetap aman dikirim (field Vendor Pengaju tidak ada pada peran itu).
 */
export const memberSuggestionsQueryOptions = (params: { q: string; vendor: string }) =>
  queryOptions({
    queryKey: queryKeys.memberSuggestions(params),
    queryFn: () => listMemberSuggestions(params),
    staleTime: VISIT_STALE_TIME,
    retry: shouldRetry,
  })

/**
 * `GET /visits/member-suggestions/{visitorId}` — detail satu pilihan anggota
 * (foto presigned). 404 id luar cakupan tidak di-retry (`shouldRetry`).
 */
export const memberSuggestionQueryOptions = (visitorId: string) =>
  queryOptions({
    queryKey: queryKeys.memberSuggestion(visitorId),
    queryFn: () => getMemberSuggestion(visitorId),
    staleTime: VISIT_STALE_TIME,
    retry: shouldRetry,
  })

export function visitsQueryOptions(
  params: VisitListParams,
  refetchInterval: number | false = VISIT_LIST_REFETCH_INTERVAL,
) {
  return queryOptions({
    queryKey: queryKeys.visits.list(params),
    queryFn: () => listVisits(params),
    staleTime: VISIT_STALE_TIME,
    retry: shouldRetry,
    // Polling terlingkup daftar kunjungan (dashboard/approvals/gate/qr +
    // badge usePendingApprovalCount): default 30 detik selama tab terlihat;
    // tab latar diam (`refetchIntervalInBackground: false`); kembali fokus
    // menyegarkan bila sudah basi (staleTime 30 detik yang menggerbanginya).
    // Satu owner polling per queryKey — timer per-observer, bukan per-komponen.
    // Override OPT-IN: gerbang oper `GATE_LIST_REFETCH_INTERVAL` (15 dtk),
    // resolver /qr oper `false` (tanpa timer).
    refetchInterval,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  })
}

export function visitDetailQueryOptions(id: string | null) {
  return queryOptions({
    queryKey: queryKeys.visits.detail(id ?? ''),
    queryFn: () => getVisit(id ?? ''),
    enabled: id !== null,
    staleTime: VISIT_STALE_TIME,
    retry: shouldRetry,
    // Pembaruan mandiri SCR-04 vendor: polling hanya saat tab terlihat dan
    // status masih bergerak — approved 60 detik, visiting 30 detik (jendela
    // check-out); refetch-on-focus dihapus (lihat `visitRefetchInterval`).
    refetchInterval: (query) => visitRefetchInterval(query.state.data?.status),
    refetchIntervalInBackground: false,
  })
}

/**
 * `GET /visits/{id}/qr` mengembalikan `{ visit_id, qr_code_payload }` untuk
 * kunjungan apa pun yang boleh dilihat aktor (handler tidak menggerbangi status);
 * payload yang sama dipakai saat check-in (`approved`) maupun check-out
 * (`visiting`). Karena itu `status` di sini hanya mengatur gerbang polling QR
 * (lihat `visitRefetchInterval`), bukan keabsahan payload.
 */
export function visitQrQueryOptions(id: string | null, status?: VisitStatus) {
  return queryOptions({
    queryKey: queryKeys.visits.qr(id ?? ''),
    queryFn: () => getVisitQr(id ?? ''),
    enabled: id !== null,
    staleTime: VISIT_STALE_TIME,
    retry: shouldRetry,
    // QR mengikuti gerbang status yang sama selama tab terlihat — approved 60
    // detik / visiting 30 detik (diet S5); tanpa refetch-on-focus.
    refetchInterval: () => visitRefetchInterval(status),
    refetchIntervalInBackground: false,
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

/** Daftar jejak audit lintas cabang — super_admin saja (403 untuk role lain). */
export function auditLogsQueryOptions(params: AuditLogListParams) {
  return queryOptions({
    queryKey: queryKeys.auditLogs(params),
    queryFn: () => listAuditLogs(params),
    placeholderData: (previous) => previous,
    staleTime: VISIT_STALE_TIME,
    retry: shouldRetry,
  })
}

/**
 * Feed notifikasi lonceng header (SCR-02/approvals). Di-poll hanya saat panel
 * lonceng terbuka — pemanggil mengoper `enabled` dari status buka/tutup panel.
 */
export function notificationsQueryOptions(params: NotificationListParams = {}) {
  return queryOptions({
    queryKey: queryKeys.notifications(params),
    queryFn: () => listNotifications(params),
    staleTime: VISIT_STALE_TIME,
    retry: shouldRetry,
    refetchInterval: NOTIFICATIONS_REFETCH_INTERVAL,
    refetchIntervalInBackground: false,
    // Badge unread selalu menyala: kembali fokus menyegarkan bila sudah basi.
    refetchOnWindowFocus: true,
  })
}

/**
 * Antre pendaftaran vendor menunggu persetujuan (superadmin). Probe ringan
 * `limit: 1` mengikuti idiom `useUnreadNotificationCount`: angka badge
 * diambil dari `pending_count` agregat server tanpa endpoint count terpisah.
 * Polling & staleTime sama dengan feed lonceng (30 detik, latar mati).
 */
export function pendingRegistrationsQueryOptions(params: PendingRegistrationListParams = {}) {
  return queryOptions({
    queryKey: queryKeys.pendingRegistrations(params),
    queryFn: () => listPendingRegistrations(params),
    staleTime: VISIT_STALE_TIME,
    retry: shouldRetry,
    refetchInterval: NOTIFICATIONS_REFETCH_INTERVAL,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
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

/** Katalog vendor publik (tanpa auth) — layar pendaftaran mandiri. */
export function usePublicVendorsQuery(enabled = true) {
  return useQuery({ ...publicVendorsQueryOptions, enabled })
}

/** Akun vendor aktif untuk pemilih pemilik kunjungan (admin/super_admin). */
export function useVendorAccountsQuery(enabled = true) {
  return useQuery({ ...vendorAccountsQueryOptions, enabled })
}

export function useJabatanQuery(enabled = true) {
  return useQuery({ ...jabatanQueryOptions, enabled })
}

/**
 * Saran nama vendor (`GET /vendors/suggestions`). `rawQuery` di-debounce 300 ms
 * lalu di-clamp ke 80 karakter rune sebelum menjadi kunci query; gerbang peran
 * (admin/super_admin) di sini agar peran lain tidak pernah menembak 403.
 */
export function useVendorSuggestionsQuery(rawQuery = '', enabled = true) {
  const { user } = useSession()
  const q = clampSuggestionQuery(useDebouncedValue(rawQuery, SUGGESTION_DEBOUNCE_MS))
  return useQuery({
    ...vendorSuggestionsQueryOptions(q),
    enabled: enabled && canSuggestVendors(user),
  })
}

/**
 * Saran anggota (`GET /visits/member-suggestions`). `q` dan `vendor` sama-sama
 * di-debounce 300 ms; `q` di-clamp ke 80 karakter (81 = 400 backend), `vendor`
 * cukup di-trim (input sudah berbatas 120). Sengaja TANPA `placeholderData`:
 * saat kunci berganti (vendor berubah), opsi lama tidak boleh sempat tampil
 * seolah hasil kunci baru.
 */
export function useMemberSuggestionsQuery(
  params: { q?: string; vendor?: string } = {},
  enabled = true,
) {
  const { user } = useSession()
  const q = clampSuggestionQuery(useDebouncedValue(params.q ?? '', SUGGESTION_DEBOUNCE_MS))
  const vendor = useDebouncedValue(params.vendor ?? '', SUGGESTION_DEBOUNCE_MS).trim()
  return useQuery({
    ...memberSuggestionsQueryOptions({ q, vendor }),
    enabled: enabled && canSuggestMembers(user),
  })
}

/**
 * Detail satu anggota pilihan (`GET /visits/member-suggestions/{visitorId}`)
 * beserta foto presigned untuk autofill. `visitorId` null = nonaktif (sebelum
 * pilihan terpilih / kunjungan sumber belum terbaca).
 */
export function useMemberSuggestionQuery(visitorId: string | null, enabled = true) {
  const { user } = useSession()
  return useQuery({
    ...memberSuggestionQueryOptions(visitorId ?? ''),
    enabled: enabled && visitorId !== null && canSuggestMembers(user),
  })
}

export function useVisitsQuery(
  params: VisitListParams,
  enabled = true,
  refetchInterval: number | false = VISIT_LIST_REFETCH_INTERVAL,
) {
  return useQuery({ ...visitsQueryOptions(params, refetchInterval), enabled })
}

/** Total antrean approval (requested + rescheduled) untuk badge shell — server-total, scope cabang/peran ikut backend. `locationId` meneruskan filter cabang halaman ('all' = tanpa filter). */
export function usePendingApprovalCount(enabled = true, locationId = 'all') {
  const locationFilter = locationId !== 'all' ? { location_id: locationId } : {}
  const requested = useVisitsQuery(
    { status: 'requested', limit: 1, ...locationFilter },
    enabled,
  )
  const rescheduled = useVisitsQuery(
    { status: 'rescheduled', limit: 1, ...locationFilter },
    enabled,
  )
  return {
    pendingCount: (requested.data?.total ?? 0) + (rescheduled.data?.total ?? 0),
    isPending: requested.isPending || rescheduled.isPending,
    isError: requested.isError,
    refetch: () => { void requested.refetch(); void rescheduled.refetch() },
  }
}

export function useVisitQuery(id: string | null) {
  return useQuery(visitDetailQueryOptions(id))
}

/** `enabled` berasal dari pemanggil — teruskan true untuk status `approved` (check-in) atau `visiting` (check-out, QR yang sama). */
export function useVisitQrQuery(id: string | null, enabled = true) {
  const queryClient = useQueryClient()
  // Status kunjungan diambil dari cache detail (halaman yang sama sudah
  // memakainya) sebagai gerbang polling QR — tanpa langganan query baru.
  const visitStatus = queryClient.getQueryData<VisitDetail>(
    queryKeys.visits.detail(id ?? ''),
  )?.status
  return useQuery({ ...visitQrQueryOptions(id, visitStatus), enabled: id !== null && enabled })
}

export function useSecurityUsersQuery(locationId?: string, enabled = true) {
  return useQuery({ ...securityUsersQueryOptions(locationId), enabled })
}

export function useManagedUsersQuery(params: ManagedUserListParams, enabled = true) {
  return useQuery({ ...managedUsersQueryOptions(params), enabled })
}

export function useAuditLogsQuery(params: AuditLogListParams, enabled = true) {
  return useQuery({ ...auditLogsQueryOptions(params), enabled })
}

/** `enabled` dari pemanggil: `false` saat panel lonceng tertutup → tanpa polling latar. */
export function useNotificationsQuery(params: NotificationListParams = {}, enabled = true) {
  return useQuery({ ...notificationsQueryOptions(params), enabled })
}

/**
 * Feed lonceng progresif panel (`useInfiniteQuery` v5): halaman 1 dulu, lalu
 * halaman berikutnya saat petugas menekan "Muat lebih banyak". Kunci diturunkan
 * dari `NOTIFICATIONS_PREFIX`, sehingga invalidasi parsel `['notifications']`
 * oleh mutasi tandai-baca (per baris maupun "semua") ikut menyegarkan feed.
 * `enabled` datang dari status buka/tutup panel — feed hanya diambil selama
 * panel terbuka (tanpa polling latar saat tertutup).
 */
const NOTIFICATIONS_FEED_KEY = [...NOTIFICATIONS_PREFIX, 'feed'] as const

export function useNotificationsFeed(enabled = true) {
  return useInfiniteQuery({
    queryKey: NOTIFICATIONS_FEED_KEY,
    queryFn: ({ pageParam }) => listNotifications({ limit: FEED_LIMIT, page: pageParam }),
    initialPageParam: 1,
    getNextPageParam: (lastPage: NotificationListResult) =>
      lastPage.page * lastPage.limit < lastPage.total ? lastPage.page + 1 : undefined,
    staleTime: VISIT_STALE_TIME,
    retry: shouldRetry,
    refetchInterval: NOTIFICATIONS_REFETCH_INTERVAL,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    enabled,
  })
}

/** Jumlah notifikasi belum dibaca untuk pemanggil — dipakai badge lonceng di shell. */
export function useUnreadNotificationCount() {
  const { data } = useNotificationsQuery({ limit: 1 })
  return data?.unread_count ?? 0
}

/**
 * Jumlah pendaftaran vendor menunggu persetujuan — angka lonceng superadmin.
 * Hook SELALU ter-mount di lonceng (semua shell), tetapi query hanya menyala
 * untuk sesi `super_admin`/`dev-superadmin`; role lain: nol query. Probe
 * `limit: 1` mengikuti `useUnreadNotificationCount`; `pending_count` agregat
 * dari respons pertama (nol bila query nonaktif/galat).
 */
export function usePendingRegistrationCount() {
  const { user } = useSession()
  const enabled = user !== null && isSuperAdminRole(user.role)
  const { data } = useQuery({ ...pendingRegistrationsQueryOptions({ limit: 1 }), enabled })
  return enabled ? (data?.pending_count ?? 0) : 0
}

/**
 * Entri pendaftaran vendor untuk section panel lonceng superadmin.
 * `enabled = open ∧ super_admin`: panel tertutup atau role lain → nol query,
 * tanpa polling latar; terbuka → ikut polling 30 detik seperti feed notifikasi.
 */
export function usePendingRegistrationsFeed(open: boolean) {
  const { user } = useSession()
  const enabled = open && user !== null && isSuperAdminRole(user.role)
  return useQuery({ ...pendingRegistrationsQueryOptions({ limit: PENDING_FEED_LIMIT }), enabled })
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
    onSuccess: (created) => {
      insertSecurityUserIntoCaches(queryClient, created)
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

/** Hapus pengawas cabang → segarkan daftar security-users (prefix ada). */
export function useDeleteSecurityUserMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ userId }: { userId: string }) => deleteSecurityUser(userId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SECURITY_USERS_PREFIX })
    },
  })
}

/** Ubah pengawas cabang → segarkan daftar security-users (prefix ada). */
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
    onSuccess: (created) => {
      insertLocationIntoCaches(queryClient, created)
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

/** Ubah user terkelola → segarkan daftar managed-users (prefix ada) + sesi sendiri. */
export function useUpdateManagedUserMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ userId, body }: { userId: string; body: UpdateManagedUserRequest }) =>
      updateManagedUser(userId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MANAGED_USERS_PREFIX })
      void queryClient.invalidateQueries({ queryKey: queryKeys.me() })
    },
  })
}

/**
 * `PATCH /auth/me` — perbarui profil sendiri. Cache `me` langsung diisi
 * respons terbaru (avatar presigned berumur pendek, jadi selalu dari respons),
 * lalu sesi React state ditulis sinkron via `applyUser` agar header memakai
 * nama/avatar baru tanpa reload dan tanpa bisa ditimpa `/auth/me` yang basi.
 */
export function useUpdateProfileMutation() {
  const queryClient = useQueryClient()
  const { applyUser } = useSession()
  return useMutation({
    mutationFn: (body: UpdateSelfProfileRequest) => updateMe(body),
    onSuccess: (user) => {
      queryClient.setQueryData(queryKeys.me(), user)
      applyUser(user)
    },
  })
}

/**
 * `POST /auth/email-change/request` — permintaan tautan verifikasi ganti
 * email. Tanpa invalidasi: respons 202 generik tidak mengubah data apa pun;
 * konsekuensi (email berubah) baru terlihat setelah konfirmasi token.
 */
export function useRequestEmailChangeMutation() {
  return useMutation({
    mutationFn: (body: EmailChangeRequest) => requestEmailChange(body),
  })
}

/**
 * `POST /auth/email-change/confirm` — konfirmasi token ganti email. Respons
 * membawa `User` terbaru, jadi cache `me` + sesi React ditulis sinkron
 * (pola sama `useUpdateProfileMutation`); layar pemanggil tetap memanggil
 * `refresh()` agar hidrasi `/auth/me` jadi kanonik sebelum redirect.
 */
export function useConfirmEmailChangeMutation() {
  const queryClient = useQueryClient()
  const { applyUser } = useSession()
  return useMutation({
    mutationFn: (body: EmailChangeConfirmRequest) => confirmEmailChange(body),
    onSuccess: (user) => {
      queryClient.setQueryData(queryKeys.me(), user)
      applyUser(user)
    },
  })
}

/** Hapus kunjungan → segarkan daftar + detail kunjungan itu (prefix ada). */
export function useUpdateVisitorContactMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      visitId,
      visitorId,
      body,
    }: {
      visitId: string
      visitorId: string
      body: UpdateVisitorContactRequest
    }) => updateVisitorContact(visitId, visitorId, body),
    onSuccess: (_data, variables) => {
      invalidateVisitStatus(queryClient, variables.visitId)
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
    mutationFn: ({ file, category, compress }: { file: File; category: UploadCategory; compress?: boolean }) =>
      uploadFile(file, category, { compress }),
  });
}

/** Tandai satu notifikasi dibaca → segarkan cache notifikasi (prefix). */
export function useMarkNotificationReadMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_PREFIX });
    },
  });
}

/** Tandai semua notifikasi dibaca → segarkan cache notifikasi (prefix). */
export function useMarkAllNotificationsReadMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => markAllNotificationsRead(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_PREFIX });
    },
  });
}
