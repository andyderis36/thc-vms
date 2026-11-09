'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Controller,
  useForm,
  useWatch,
  type FieldErrors,
} from 'react-hook-form'
import { toast } from 'sonner'
import {
  ArrowLeft,
  CalendarClock,
  FileText,
  History,
  MapPin,
  ShieldCheck,
  StickyNote,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card'
import { Checkbox } from '@/components/ui/Checkbox'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { ApiError } from '@/lib/api/fetcher'
import {
  useCreateVisitMutation,
  useLocationsQuery,
  usePurposesQuery,
  useVendorAccountsQuery,
  useVendorSuggestionsQuery,
  useVendorsQuery,
  useVisitsQuery,
} from '@/lib/api/hooks'
import type { CreateVisitRequest } from '@/lib/api/types'
import { isSuperAdminRole } from '@/lib/auth/capabilities'
import { useSession } from '@/lib/auth/session'
import {
  FACILITY_NAME_MAX_LENGTH,
  PURPOSE_NOTE_MAX_LENGTH,
  TEXT_MAX_LENGTH,
  VENDOR_NAME_MAX_LENGTH,
} from '@/lib/limits'
import {
  selectLatestVisit,
  toTechnicianRows,
} from '@/lib/visits/prefill-last-visit'
import { isLocationScopeUnresolved, scopeLocations } from '@/lib/visits/location-scope'
import { mergeSuggestionNames } from '@/lib/visits/suggestions'
import { resolveVendorInput } from '@/lib/visits/vendor-input'
import { PurposeDropdown } from './PurposeDropdown'
import { TechnicianList } from './TechnicianList'
import { UploadBox } from './UploadBox'
import {
  collectInvalidFields,
  formatInvalidMessage,
  revealInvalidField,
} from './invalid-fields'
import { visitFormSchema, type VisitFormValues } from './visit-schema'

/** Pernyataan wajib SOP keselamatan — teks persis dari spesifikasi SCR-03. */
const SOP_STATEMENT =
  'Saya menyatakan seluruh data anggota akurat dan menyetujui seluruh Standar Operasional Prosedur (SOP) dan keselamatan kerja fasilitas jaringan THC.'

/**
 * SCR-03 — Formulir Pengajuan Kunjungan.
 * React Hook Form + zod; seluruh pesan galat berbahasa Indonesia.
 * Tombol kirim berada di aliran normal SETELAH bagian SOP keselamatan —
 * bukan bilah lengket — sehingga tidak pernah menutupi isian saat menggulir.
 */
export function VisitForm() {
  const router = useRouter()
  const locationsQuery = useLocationsQuery()
  const purposesQuery = usePurposesQuery()
  const vendorsQuery = useVendorsQuery()
  const createVisit = useCreateVisitMutation()
  const { user, status } = useSession()

  const {
    control,
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<VisitFormValues>({
    resolver: zodResolver(visitFormSchema),
    // Kita mengambil alih seluruh perilaku fokus (lihat `onInvalidSubmit`),
    // agar fokus bawaan react-hook-form tidak bertarung dengan scroll ke
    // field invalid pertama milik kita sendiri.
    shouldFocusError: false,
    defaultValues: {
      location_id: '',
      vendor_user_id: '',
      vendor_name: '',
      purpose_ids: [],
      purpose_note: '',
      start_date: '',
      end_date: '',
      is_multi_day: false,
      assignment_letter: null,
      notes: '',
      technicians: [
        {
          name: '',
          id_number: '',
          phone: '',
          id_card_photo: { url: '', name: '' },
          selfie: { url: '', name: '' },
          jabatan: '',
          vendor_name: '',
          email: '',
        },
      ],
      is_nda_accepted: false,
    },
  })

  const purposeIds = useWatch({ control, name: 'purpose_ids' }) ?? []

  /*
   * Saran "Vendor Pengaju": feed DB-backed `GET /vendors/suggestions`
   * (di-debounce + di-clamp di dalam hook) dilengkapi katalog `GET /vendors`
   * — supaya nama yang dulu tampil tidak pernah hilang ketika feed kosong /
   * 403 (peran vendor) / galat. Ketikan manual tetap diterima apa adanya.
   */
  const visitVendorName = useWatch({ control, name: 'vendor_name' }) ?? ''
  const vendorSuggestionsQuery = useVendorSuggestionsQuery(visitVendorName)
  const vendorSuggestionNames = mergeSuggestionNames(
    vendorSuggestionsQuery.data,
    vendorsQuery.data ?? [],
  )

  /*
   * Prefill dari kunjungan terakhir (khusus peran `vendor`): halaman
   * riwayat `GET /visits?limit=20` diambil HANYA ketika tombol ditekan
   * (`enabled only when needed`) — pengurutan backend `start_date DESC`,
   * jadi pemilihan yang terbaru dibuat dilakukan klien via
   * `selectLatestVisit` (maks `created_at`).
   */
  const [prefillRequested, setPrefillRequested] = useState(false)
  const prefillStartedAt = useRef(0)
  const isVendor = user?.role === 'vendor'
  // Perusahaan kunjungan manual hanya untuk admin/superadmin; peran vendor
  // tetap memakai nama perusahaan per anggota seperti sebelumnya.
  const canSetVisitVendor =
    user !== null && (user.role === 'admin' || isSuperAdminRole(user.role))
  /*
   * Akun vendor aktif (pemilik kunjungan) — hanya untuk admin/superadmin;
   * endpoint dijaga peran, jadi query nonaktif untuk peran lain agar tak
   * pernah menembak 403. Opsi selalu menyertakan nilai kosong yang dapat
   * dipilih untuk melepas pilihan.
   */
  const vendorAccountsQuery = useVendorAccountsQuery(canSetVisitVendor)
  const vendorAccountOptions = useMemo(() => {
    const accounts = canSetVisitVendor ? (vendorAccountsQuery.data ?? []) : []
    return [
      { value: '', label: '— Tanpa akun vendor —' },
      ...accounts.map((account) => {
        const company = account.company?.trim() ?? ''
        return {
          value: account.id,
          label: company !== '' ? `${account.name} — ${company}` : account.name,
        }
      }),
    ]
  }, [canSetVisitVendor, vendorAccountsQuery.data])
  const vendorAccountHint = vendorAccountsQuery.isError
    ? 'Daftar akun vendor tidak dapat dimuat. Kunjungan tetap bisa diajukan tanpa akun vendor.'
    : vendorAccountsQuery.isPending
      ? 'Memuat akun vendor…'
      : 'Opsional jika vendor punya akun. Bila dipilih, kunjungan menjadi milik akun vendor tersebut; kosongkan bila pengajuan atas nama Anda sendiri.'
  const prefillQuery = useVisitsQuery(
    { limit: 20 },
    isVendor && prefillRequested,
  )

  /*
   * Penerapan prefill — berjalan HANYA setelah tombol ditekan (tidak pernah
   * otomatis). HANYA baris roster anggota yang ditimpa; fasilitas, tujuan,
   * jadwal, SPK, catatan, dan SOP tetap pada nilai awal kosong (data itu
   * bervariasi tiap kunjungan, hanya kru yang stabil).
   *
   * Dipilih `setValue('technicians', …)` bertarget — BUKAN `reset()` seluruh
   * formulir — agar nilai + status dirty/touched field lain tidak tersentuh:
   * `reset()` akan me-re-baseline SEMUA field menjadi pristine dan mencuci
   * ketikan pengguna sebelum klik menjadi "bersih". `shouldDirty: false`
   * menjaga perilaku guard konfirmasi + `isDirty` identik dengan sebelumnya
   * pada alur baku.
   *
   * Guard `errorUpdatedAt`: refetch klik TERBARU dimulai pada commit yang
   * sama dengan klik, sedangkan snapshot galat di render itu masih milik
   * klik sebelumnya — galat basi tidak boleh di-toast (tunggu hasil baru).
   */
  useEffect(() => {
    if (!prefillRequested) return
    if (prefillQuery.isPending || prefillQuery.isFetching) return
    if (
      prefillQuery.isError &&
      prefillQuery.errorUpdatedAt < prefillStartedAt.current
    ) {
      return
    }
    setPrefillRequested(false)
    if (prefillQuery.isError) {
      toast.error(
        prefillQuery.error instanceof ApiError
          ? prefillQuery.error.message
          : 'Gagal memuat riwayat kunjungan. Silakan coba lagi.',
      )
      return
    }
    const latest = selectLatestVisit(prefillQuery.data?.items)
    if (latest === undefined) {
      toast.info('Belum ada riwayat kunjungan')
      return
    }
    setValue('technicians', toTechnicianRows(latest), { shouldDirty: false })
    toast.success(
      'Data kunjungan terakhir dimuat — periksa kembali sebelum kirim',
    )
  }, [prefillRequested, prefillQuery, setValue])

  // `GET /locations` global-by-design; scoping per-peran dilakukan klien.
  // Sesi belum ter-hydrate (`loading`/`user` null) → kosong & terkunci;
  // fallback vendor (tanpa scope) hanya untuk sesi `authenticated` vendor.
  const isSessionAuthenticated = status === 'authenticated' && user !== null
  const locationScopeUser = isSessionAuthenticated ? user : null
  const sessionNotReady = !isSessionAuthenticated
  const locationLocked = sessionNotReady || (locationScopeUser !== null && isLocationScopeUnresolved(locationScopeUser))
  /*
   * Katalog fasilitas TERPAKU di layar ini sudah disaring ke cakupan sesi
   * (`location_ids ?? [location_id]`): admin/security hanya melihat
   * cabangnya, super_admin/vendor tetap katalog utuh. Satu sumber untuk
   * KEDUA `<datalist>` dan resolusi `location_id` saat submit, sehingga
   * payload admin tidak pernah memuat fasilitas di luar cakupannya.
   */
  const facilityCatalog = locationScopeUser !== null
    ? scopeLocations(locationsQuery.data ?? [], locationScopeUser)
    : []

  function togglePurpose(purposeId: string): void {
    const next = purposeIds.includes(purposeId)
      ? purposeIds.filter((id) => id !== purposeId)
      : [...purposeIds, purposeId]
    setValue('purpose_ids', next, { shouldDirty: true, shouldValidate: true })
  }

  /*
   * Klik "Gunakan data kunjungan terakhir": bila formulir sudah kotor
   * (`isDirty`), timpaan dikonfirmasi dulu lewat dialog bawaan peramban —
   * dibatalkan berarti batal diam-diam (tanpa fetch, tanpa toast).
   */
  function handleUseLastVisit(): void {
    if (prefillRequested) return
    if (isDirty) {
      const confirmed = window.confirm(
        'Isi formulir saat ini akan ditimpa dengan data kunjungan terakhir. Lanjutkan?',
      )
      if (!confirmed) return
    }
    prefillStartedAt.current = Date.now()
    setPrefillRequested(true)
  }

  async function onSubmit(values: VisitFormValues): Promise<void> {
    const vendors = vendorsQuery.data ?? []
    const purposes = purposesQuery.data ?? []
    const selectedPurposes = values.purpose_ids ?? []
    // Pemetaan tujuan keras → katalog: yang cocok persis namanya mengirim
    // purpose_id; yang tidak cocok (katalog kosong setelah wipe DB) serta
    // "Other" jatuh ke purpose_note. Tidak pernah mengirim purpose_id dan
    // purpose_note untuk pilihan yang sama.
    const matchedPurposeIds: string[] = []
    const fallbackLabels: string[] = []
    for (const label of selectedPurposes) {
      if (label === 'Other') {
        // "Other" selalu memakai teks bebas purpose_note.
        continue
      }
      const match = purposes.find((purpose) => purpose.name === label)
      if (match !== undefined) {
        matchedPurposeIds.push(match.id)
      } else {
        fallbackLabels.push(label)
      }
    }
    const userNote = (values.purpose_note ?? '').trim()
    const noteParts: string[] = [...fallbackLabels]
    if (userNote !== '') noteParts.push(userNote)
    const purposeNote = noteParts.join(', ').trim()

    // Perusahaan kunjungan (admin/superadmin): teks manual apa adanya;
    // kosong = field tidak dikirim sama sekali (BE memetakan ke NULL).
    const visitVendorName = (values.vendor_name ?? '').trim()

    // Akun vendor pemilik kunjungan (admin/superadmin): kosong = absen,
    // sehingga kunjungan tetap menjadi milik akun pemanggil.
    const visitVendorUserId = (values.vendor_user_id ?? '').trim()

    // Fasilitas tujuan: saran dari katalog SUDAH ter-scope cakupan sesi;
    // ketikan (id atau nama) dipetakan ke location_id yang valid bila cocok,
    // selain itu diteruskan apa adanya (backend menolak bila tidak valid —
    // `requireBranchAccess` juga menutup fasilitas luar cakupan admin).
    const resolvedLocationId = (() => {
      const raw = (values.location_id ?? '').trim()
      const match = facilityCatalog.find(
        (location) => location.id === raw || location.name === raw,
      )
      return match !== undefined ? match.id : raw
    })()

    const body: CreateVisitRequest = {
      location_id: resolvedLocationId,
      ...(visitVendorUserId !== '' ? { vendor_user_id: visitVendorUserId } : {}),
      ...(visitVendorName !== '' ? { vendor_name: visitVendorName } : {}),
      purpose_ids: matchedPurposeIds,
      // "Tujuan lain" mengisi kontrak `purpose_note` (≤200); `purpose_ids`
      // boleh kosong selama field ini terisi (divalidasi zod sebelum submit).
      ...(purposeNote !== '' ? { purpose_note: purposeNote } : {}),
      start_date: new Date(values.start_date).toISOString(),
      end_date: new Date(values.end_date).toISOString(),
      is_multi_day: values.is_multi_day,
      is_nda_accepted: true,
      notes:
        values.notes !== undefined && values.notes !== ''
          ? values.notes
          : undefined,
      visitors: values.technicians.map((technician) => {
        // Teks baris dipetakan ke kontrak BE: cocok persis dengan katalog
        // (case-insensitive) → `vendor_id`; selain itu → `vendor_name` manual;
        // kosong → tanpa field. Nama ketikan manual TIDAK masuk katalog.
        const resolvedVendor = resolveVendorInput(technician.vendor_name, vendors)
        // Jabatan: teks bebas; kosong = field tidak dikirim sama sekali
        // (backend memperlakukan string kosong sebagai absen).
        const jabatan = (technician.jabatan ?? '').trim()
        // Email anggota: opsional; kosong = field tidak dikirim sama sekali
        // (backend memetakan input kosong ke NULL, kontrak openapi).
        const email = (technician.email ?? '').trim()
        return {
          name: technician.name,
          id_number: technician.id_number,
          phone: technician.phone,
          id_card_photo_url: technician.id_card_photo.url,
          photo_url: technician.selfie.url,
          ...(jabatan !== '' ? { jabatan } : {}),
          ...(email !== '' ? { email } : {}),
          ...resolvedVendor,
        }
      }),
    }
    if (values.assignment_letter !== null && values.assignment_letter !== undefined) {
      body.assignment_letter_url = values.assignment_letter.url
    }

    try {
      const created = await createVisit.mutateAsync({ body })
      toast.success(
        'Permohonan kunjungan berhasil dikirim dan sedang menunggu persetujuan admin cabang.',
      )
      router.push(`/visits/${created.id}`)
    } catch (err: unknown) {
      toast.error(
        err instanceof ApiError
          ? err.message
          : 'Permohonan gagal dikirim. Silakan coba lagi.',
      )
    }
  }

  /*
   * Dipanggil HANYA saat zod menolak submit. Kita memegang kendali penuh atas
   * perilaku fokus (lihat `shouldFocusError: false` di atas): toast menyebut
   * nama field wajib yang galat secara berurutan, lalu layar digulirkan dan
   * difokuskan ke field invalid PERTAMA sesuai urutan visual DOM.
   *
   * `revealInvalidField` menyimpan timer-nya sendiri (melepas cincin
   * `field-attention` setelah 1600ms), sehingga tidak perlu state timer
   * tambahan di sini — satu panggilan per submit, dan pengiriman cepat
   * beruntun tidak menumpuk timeout.
   */
  function onInvalidSubmit(formErrors: FieldErrors<VisitFormValues>): void {
    const fields = collectInvalidFields(formErrors)
    toast.warning(formatInvalidMessage(fields))
    const first = fields[0]
    if (first === undefined) return
    const el = document.getElementById(first.anchorId)
    if (el !== null) revealInvalidField(el)
  }

  return (
    <form
      noValidate
      onSubmit={handleSubmit(onSubmit, onInvalidSubmit)}
      className="flex flex-col gap-4"
    >
      <div className="flex flex-col gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-touch self-start"
          onClick={() => router.push('/dashboard')}
        >
          <ArrowLeft aria-hidden="true" className="size-4 shrink-0" />
          Kembali ke Dashboard
        </Button>
        <h1 className="text-xl font-bold text-ink sm:text-2xl">
          Pengajuan Akses Fasilitas Jaringan THC
        </h1>
        <p className="text-sm text-ink-secondary">
          Isi formulir berikut untuk mengajukan izin kunjungan ke fasilitas
          THC.
        </p>
        {/* Prefill riwayat — hanya untuk vendor; admin/superadmin tak melihatnya. */}
        {isVendor ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="min-h-touch self-start"
            loading={prefillRequested}
            onClick={handleUseLastVisit}
          >
            <History aria-hidden="true" className="size-4 shrink-0" />
            Gunakan data kunjungan terakhir
          </Button>
        ) : null}
      </div>

      {/* 1. Fasilitas & Keperluan */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MapPin aria-hidden="true" className="size-4 shrink-0 text-brand" />
            Fasilitas &amp; Keperluan
          </CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          {/* 1 kolom di ponsel, 2 kolom >= sm: Fasilitas | Tujuan Kunjungan */}
          <div className="grid gap-4 sm:grid-cols-2">
            <>
              <Input
                id="visit-location"
                label="Fasilitas Tujuan"
                required
                fieldSize="gate"
                list="visit-facility-datalist"
                autoComplete="off"
                maxLength={FACILITY_NAME_MAX_LENGTH}
                placeholder={
                  locationsQuery.isPending || sessionNotReady
                    ? 'Memuat fasilitas…'
                    : 'Pilih fasilitas (Cabang / POP / miniPOP)'
                }
                disabled={
                  locationsQuery.isPending ||
                  locationsQuery.isError ||
                  locationLocked
                }
                error={
                  errors.location_id?.message ??
                  (locationsQuery.isError
                    ? 'Gagal memuat daftar fasilitas. Silakan muat ulang halaman.'
                    : undefined)
                }
                {...register('location_id')}
              />
              <datalist id="visit-facility-datalist">
                {facilityCatalog.map((location) => (
                  <option key={location.id} value={location.name} />
                ))}
              </datalist>
              {/* Alias id untuk kompatibilitas saran (cache yang sama). */}
              <datalist id="visit-location-datalist">
                {facilityCatalog.map((location) => (
                  <option key={location.id} value={location.name} />
                ))}
              </datalist>
            </>

            <div className="flex flex-col gap-2">
              <PurposeDropdown
                id="visit-purpose"
                label="Tujuan Kunjungan"
                required
                placeholder="Pilih tujuan kunjungan"
                selectedIds={purposeIds}
                onToggle={togglePurpose}
                error={errors.purpose_ids?.message}
              />

              {/* Tujuan bebas-teks — memetakan ke `purpose_note`. Teks di sini
                  TIDAK pernah menjadi saran/salinan tujuan dari katalog. */}
              <Input
                id="visit-purpose-note"
                label="Tujuan lain (opsional)"
                placeholder="Tulis tujuan bila tidak ada di daftar"
                hint="Opsional — maksimal 200 karakter. Cukup isi bila tidak memilih tujuan dari daftar."
                autoComplete="off"
                maxLength={PURPOSE_NOTE_MAX_LENGTH}
                error={errors.purpose_note?.message}
                {...register('purpose_note')}
              />
            </div>
          </div>

          {/* Perusahaan kunjungan manual — hanya admin/superadmin. Saran dari
              feed `GET /vendors/suggestions` + pelengkap katalog vendor
              terdaftar; ketikan manual tidak pernah menjadi opsi maupun
              master data. */}
          {canSetVisitVendor ? (
            <>
              <Controller
                control={control}
                name="vendor_user_id"
                render={({ field }) => (
                  <Select
                    id="visit-vendor-account"
                    label="Akun Vendor (Pemilik Kunjungan)"
                    fieldSize="gate"
                    options={vendorAccountOptions}
                    value={field.value ?? ''}
                    onBlur={field.onBlur}
                    disabled={vendorAccountsQuery.isPending}
                    hint={vendorAccountHint}
                    onChange={(event) => {
                      const next = event.target.value
                      field.onChange(next)
                      // Pilihan kosong TIDAK menyentuh vendor_name yang sudah
                      // diketik pengguna (hanya pilihan akun yang mengisi).
                      if (next === '') return
                      const account = (vendorAccountsQuery.data ?? []).find(
                        (item) => item.id === next,
                      )
                      if (account === undefined) return
                      setValue(
                        'vendor_name',
                        account.company?.trim() || account.name,
                        { shouldDirty: true, shouldValidate: true },
                      )
                    }}
                  />
                )}
              />
              <Input
                id="visit-vendor-name"
                label="Vendor Pengaju"
                list="visit-company-datalist"
                autoComplete="off"
                maxLength={VENDOR_NAME_MAX_LENGTH}
                placeholder={
                  vendorsQuery.isPending
                    ? 'Memuat vendor…'
                    : 'Pilih dari daftar atau ketik nama vendor/mitra'
                }
                hint="Opsional — maksimal 120 karakter. Tampil sebagai Vendor/Mitra pada detail kunjungan."
                error={
                  errors.vendor_name?.message ??
                  (vendorsQuery.isError
                    ? 'Gagal memuat daftar vendor. Silakan muat ulang halaman.'
                    : undefined)
                }
                {...register('vendor_name')}
              />
              <datalist id="visit-company-datalist">
                {vendorSuggestionNames.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </>
          ) : null}

        </CardBody>
      </Card>

      {/* 2. Jadwal Kunjungan */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarClock
              aria-hidden="true"
              className="size-4 shrink-0 text-brand"
            />
            Jadwal Kunjungan
          </CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              id="visit-start-date"
              label="Waktu Mulai"
              type="datetime-local"
              required
              fieldSize="gate"
              error={errors.start_date?.message}
              {...register('start_date')}
            />
            <Input
              id="visit-end-date"
              label="Waktu Selesai"
              type="datetime-local"
              required
              fieldSize="gate"
              error={errors.end_date?.message}
              {...register('end_date')}
            />
          </div>

          <Controller
            control={control}
            name="is_multi_day"
            render={({ field }) => (
              <Checkbox
                label="Pekerjaan Multi-Hari"
                name={field.name}
                checked={field.value}
                onChange={field.onChange}
              />
            )}
          />
          <p className="text-xs text-ink-secondary">
            Aktifkan bila pekerjaan berlangsung lebih dari satu hari kalender.
            Waktu selesai wajib setelah waktu mulai.
          </p>
        </CardBody>
      </Card>

      {/* 3. Daftar Anggota/Pengunjung */}
      <TechnicianList
        control={control}
        register={register}
        setValue={setValue}
        errors={errors}
      />

      {/* 4. Surat Tugas / SPK Vendor */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText
              aria-hidden="true"
              className="size-4 shrink-0 text-brand"
            />
            Surat Tugas / SPK Vendor
          </CardTitle>
        </CardHeader>
        <CardBody>
          <Controller
            control={control}
            name="assignment_letter"
            render={({ field, fieldState }) => (
              <UploadBox
                id="visit-assignment-letter"
                label="Unggah Surat Tugas / Surat Perintah Kerja"
                hint="Format PDF, JPG, atau PNG. Foto dikompresi otomatis (hasil ≤5 MB); PDF hingga 20 MB dikompresi otomatis oleh server (hasil ≤5 MB). Bisa dipilih dari galeri, kamera, atau berkas perangkat."
                idleButtonLabel="Pilih dari Galeri / Berkas"
                changeButtonLabel="Ganti Berkas"
                category="assignment_letter"
                error={fieldState.error?.message}
                value={field.value ?? null}
                onChange={field.onChange}
              />
            )}
          />
        </CardBody>
      </Card>

      {/* 5. Catatan Tambahan */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <StickyNote
              aria-hidden="true"
              className="size-4 shrink-0 text-brand"
            />
            Catatan Tambahan
          </CardTitle>
        </CardHeader>
        <CardBody>
          <Textarea
            id="visit-notes"
            label="Catatan Tambahan"
            placeholder="Rincian pekerjaan atau daftar peralatan yang dibawa (mis. splicer, OTDR, genset portable)."
            hint="Opsional — tuliskan rincian yang membantu petugas pos jaga."
            error={errors.notes?.message}
            maxLength={TEXT_MAX_LENGTH}
            {...register('notes')}
          />
        </CardBody>
      </Card>

      {/* 6. Persetujuan SOP Keselamatan */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck
              aria-hidden="true"
              className="size-4 shrink-0 text-brand"
            />
            Persetujuan SOP Keselamatan
          </CardTitle>
        </CardHeader>
        <CardBody>
          <Controller
            control={control}
            name="is_nda_accepted"
            render={({ field, fieldState }) => (
              <Checkbox
                id="visit-nda"
                label={SOP_STATEMENT}
                name={field.name}
                required
                checked={field.value}
                onChange={field.onChange}
                error={fieldState.error?.message}
              />
            )}
          />
        </CardBody>
      </Card>

      {/*
        Bilah kirim mengalir NORMAL di akhir formulir — TIDAK sticky/fixed.
        Ia duduk tepat SETELAH kartu "Persetujuan SOP Keselamatan" dan hanya
        terlihat bila pengguna menggulir sampai bawah. Shell sudah
        menyediakan padding bawah untuk bottom nav (vendor `pb-24`, admin/
        superadmin `pb-bottomnav`), jadi tidak perlu ruang cadangan `pb-28`.
      */}
      <div className="border-t border-border-light pt-4">
        <Button type="submit" size="gate" fullWidth loading={isSubmitting}>
          Kirim Permohonan Kunjungan
        </Button>
      </div>
    </form>
  )
}
