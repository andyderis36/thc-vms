'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { toast } from 'sonner'
import {
  ArrowLeft,
  CalendarClock,
  FileText,
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
  useVendorsQuery,
} from '@/lib/api/hooks'
import type { CreateVisitRequest } from '@/lib/api/types'
import { useSession } from '@/lib/auth/session'
import {
  areTechnicianRowsBlank,
  loadTechnicianRoster,
  saveTechnicianRoster,
} from '@/lib/visits/technician-autosave'
import { resolveVendorInput } from '@/lib/visits/vendor-input'
import { PurposeDropdown } from './PurposeDropdown'
import { TechnicianList } from './TechnicianList'
import { UploadBox } from './UploadBox'
import { visitFormSchema, type VisitFormValues } from './visit-schema'

/** Pernyataan wajib SOP keselamatan — teks persis dari spesifikasi SCR-03. */
const SOP_STATEMENT =
  'Saya menyatakan seluruh data teknisi akurat dan menyetujui seluruh Standar Operasional Prosedur (SOP) dan keselamatan kerja fasilitas jaringan THC.'

/**
 * SCR-03 — Formulir Pengajuan Kunjungan.
 * React Hook Form + zod; seluruh pesan galat berbahasa Indonesia.
 * Bilah kirim menempel di bawah layar (stabil di atas bottom navigation),
 * dengan padding bawah pada formulir agar tidak pernah menutupi isian terakhir.
 */
export function VisitForm() {
  const router = useRouter()
  const locationsQuery = useLocationsQuery()
  const purposesQuery = usePurposesQuery()
  const vendorsQuery = useVendorsQuery()
  const createVisit = useCreateVisitMutation()
  const { user } = useSession()

  const {
    control,
    register,
    handleSubmit,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<VisitFormValues>({
    resolver: zodResolver(visitFormSchema),
    defaultValues: {
      location_id: '',
      purpose_ids: [],
      purpose_note: '',
      start_date: '',
      end_date: '',
      is_multi_day: false,
      assignment_letter: null,
      notes: '',
      technicians: [
        { name: '', id_number: '', phone: '', id_card_photo: null, selfie: { url: '', name: '' }, vendor_name: '' },
      ],
      is_nda_accepted: false,
    },
  })

  const purposeIds = useWatch({ control, name: 'purpose_ids' }) ?? []

  // Prefill TEKS vendor milik pengguna yang sedang masuk pada baris teknisi
  // pertama, bila baris itu masih kosong. Katalog vendor TIDAK dipakai untuk
  // mencocokkan nama di sini — pemetaan ke vendor_id/vendor_name terjadi saat
  // submit lewat `resolveVendorInput`.
  const ownVendorName = user?.vendor_name ?? ''
  const userId = user?.id

  /*
   * Autosave roster per-akun (`localStorage` kunci
   * `thc-vms:technicians:<userId>`): muat daftar teknisi terakhir yang
   * berhasil dikirim akun ini, hanya bila SEMUA baris awal masih kosong —
   * ketikan pengguna tidak pernah ditimpa. Foto sengaja TIDAK pernah
   * dipulihkan; berkas wajib dipilih ulang tiap pengajuan. Nomor KTP/SIM
   * juga TIDAK pernah dipulihkan — autosave tidak pernah menyimpan PII
   * identitas, jadi kolomnya selalu mulai kosong.
   *
   * Precedence isian baris (dan baris lain yang masih kosong):
   *   saved-roster > nama vendor akun > kosong
   * — roster tersimpan menang lebih dulu; nama vendor akun di bawah hanya
   * mengisi bila roster (atau ketikan) meninggalkan baris masih kosong.
   *
   * URUTAN EFEK KRITIS: efek load ini DIDAHULUKAN dari prefill vendor akun.
   * Keduanya berjalan berurutan pada commit yang sama saat sesi selesai
   * hydrate; bila vendor akun jalan lebih dulu, baris 1 tak lagi kosong dan
   * syarat "semua baris kosong" gagal — roster tidak akan pernah termuat.
   */
  useEffect(() => {
    if (userId === undefined || userId === '') return
    if (!areTechnicianRowsBlank(getValues('technicians'))) return
    const saved = loadTechnicianRoster(userId)
    if (saved === null) return
    // `loadTechnicianRoster` sudah membatasi MAX_TECHNICIANS dan hanya
    // mengembalikan 3 field teks (nama, No. HP, nama vendor); Nomor KTP/SIM
    // selalu dikosongkan (PII tidak pernah dipersist) dan foto dikosongkan
    // (unduh ulang wajib).
    setValue(
      'technicians',
      saved.map((row) => ({
        name: row.name,
        id_number: '',
        phone: row.phone,
        id_card_photo: null,
        selfie: { url: '', name: '' },
        vendor_name: row.vendor_name,
      })),
      { shouldDirty: false },
    )
  }, [userId, getValues, setValue])

  useEffect(() => {
    if (ownVendorName.trim() === '') return
    const current = getValues('technicians.0.vendor_name')
    if (current === undefined || current.trim() === '') {
      setValue('technicians.0.vendor_name', ownVendorName, { shouldDirty: false })
    }
  }, [ownVendorName, getValues, setValue])

  const locationOptions = (locationsQuery.data ?? []).map((location) => ({
    value: location.id,
    label: `${location.name} — ${location.city}`,
  }))

  function togglePurpose(purposeId: string): void {
    const next = purposeIds.includes(purposeId)
      ? purposeIds.filter((id) => id !== purposeId)
      : [...purposeIds, purposeId]
    setValue('purpose_ids', next, { shouldDirty: true, shouldValidate: true })
  }

  async function onSubmit(values: VisitFormValues): Promise<void> {
    const vendors = vendorsQuery.data ?? []
    const purposeNote = (values.purpose_note ?? '').trim()

    const body: CreateVisitRequest = {
      location_id: values.location_id,
      purpose_ids: values.purpose_ids,
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
        return {
          name: technician.name,
          id_number: technician.id_number,
          phone: technician.phone,
          id_card_photo_url: technician.id_card_photo?.url ?? null,
          photo_url: technician.selfie.url,
          ...resolvedVendor,
        }
      }),
    }
    if (values.assignment_letter !== null && values.assignment_letter !== undefined) {
      body.assignment_letter_url = values.assignment_letter.url
    }

    try {
      const created = await createVisit.mutateAsync({ body })
      // Autosave roster teks per-akun TEPAT SEBELUM navigasi: agar pengajuan
      // berikutnya bisa pre-fill. Hanya 3 field teks (nama, HP, vendor);
      // nomor identitas (PII) dan foto tidak pernah disimpan. Tanpa user id
      // → lewati (tanpa autosave, bukan galat).
      if (user?.id !== undefined && user.id !== '') {
        saveTechnicianRoster(user.id, values.technicians)
      }
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

  return (
    <form
      noValidate
      onSubmit={handleSubmit(onSubmit)}
      className="flex flex-col gap-4 pb-28"
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
          Isi formulir berikut untuk mengajukan izin kunjungan teknisi ke
          fasilitas THC.
        </p>
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
            <Select
              label="Fasilitas Tujuan"
              required
              fieldSize="gate"
              placeholder={
                locationsQuery.isPending
                  ? 'Memuat fasilitas…'
                  : 'Pilih fasilitas (Cabang / POP / miniPOP)'
              }
              options={locationOptions}
              disabled={locationsQuery.isPending || locationsQuery.isError}
              error={
                errors.location_id?.message ??
                (locationsQuery.isError
                  ? 'Gagal memuat daftar fasilitas. Silakan muat ulang halaman.'
                  : undefined)
              }
              {...register('location_id')}
            />

            <div className="flex flex-col gap-1.5">
              <PurposeDropdown
                label="Tujuan Kunjungan"
                required
                placeholder="Pilih tujuan kunjungan"
                purposes={purposesQuery.data ?? []}
                selectedIds={purposeIds}
                onToggle={togglePurpose}
                isLoading={purposesQuery.isPending}
                isError={purposesQuery.isError}
                error={errors.purpose_ids?.message}
              />

              {/* Tujuan bebas-teks — memetakan ke `purpose_note`. Teks di sini
                  TIDAK pernah menjadi saran/salinan tujuan dari katalog. */}
              <Input
                label="Tujuan lain (opsional)"
                placeholder="Tulis tujuan bila tidak ada di daftar"
                hint="Opsional — maksimal 200 karakter. Cukup isi ini bila tidak memilih tujuan dari daftar."
                autoComplete="off"
                maxLength={200}
                error={errors.purpose_note?.message}
                {...register('purpose_note')}
              />
            </div>
          </div>

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
              label="Waktu Mulai"
              type="datetime-local"
              required
              fieldSize="gate"
              error={errors.start_date?.message}
              {...register('start_date')}
            />
            <Input
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

      {/* 3. Daftar Tim Teknisi */}
      <TechnicianList
        control={control}
        register={register}
        setValue={setValue}
        errors={errors}
        defaultVendorName={ownVendorName}
      />
      {/* Petunjuk halus: hanya nama, No. HP, dan nama vendor dari pengiriman
          terakhir yang tersimpan lokal per-akun di peramban ini; nomor
          identitas (PII) dan foto tidak ikut. */}
      <p className="-mt-2 px-1 text-xs text-ink-secondary">
        Nama, No. HP, dan nama vendor dari pengisian terakhir tersimpan
        otomatis di peramban ini dan terisi kembali saat formulir dibuka —
        semuanya masih bisa diedit. Nomor KTP/SIM tidak disimpan (kolomnya
        selalu terisi kosong), dan foto (KTP / selfie) tidak disimpan serta
        wajib diunggah ulang setiap kali.
      </p>

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
            render={({ field }) => (
              <UploadBox
                label="Unggah Surat Tugas / Surat Perintah Kerja"
                hint="Format PDF, JPG, atau PNG — maksimal 5 MB. Bisa dipilih dari galeri, kamera, atau berkas perangkat."
                idleButtonLabel="Pilih dari Galeri / Berkas"
                changeButtonLabel="Ganti Berkas"
                category="assignment_letter"
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
            label="Catatan Tambahan"
            placeholder="Rincian pekerjaan atau daftar peralatan yang dibawa (mis. splicer, OTDR, genset portable)."
            hint="Opsional — tuliskan rincian yang membantu petugas pos jaga."
            error={errors.notes?.message}
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
        Bilah kirim menempel di bawah viewport (sticky, BUKAN fixed): tetap
        terlihat saat mengisi form panjang tanpa menimpa sidebar shell mana
        pun (admin 250px / superadmin 260px / PIC tanpa sidebar). Di ponsel
        menempel di atas bottom nav; di desktop di tepi bawah viewport.
      */}
      <div className="sticky bottom-bottomnav z-30 mt-6 border-t border-border-light bg-surface px-4 py-4 lg:bottom-0">
        <Button type="submit" size="gate" fullWidth loading={isSubmitting}>
          Kirim Permohonan Kunjungan
        </Button>
      </div>
    </form>
  )
}
