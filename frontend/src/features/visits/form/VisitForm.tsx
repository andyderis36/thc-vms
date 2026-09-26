'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/navigation'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { toast } from 'sonner'
import {
  ArrowLeft,
  CalendarClock,
  Check,
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
import { Spinner } from '@/components/ui/Spinner'
import { Textarea } from '@/components/ui/Textarea'
import { ApiError } from '@/lib/api/fetcher'
import {
  useCreateVisitMutation,
  useLocationsQuery,
  usePurposesQuery,
} from '@/lib/api/hooks'
import type { CreateVisitRequest } from '@/lib/api/types'
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
  const createVisit = useCreateVisitMutation()

  const {
    control,
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<VisitFormValues>({
    resolver: zodResolver(visitFormSchema),
    defaultValues: {
      location_id: '',
      purpose_ids: [],
      start_date: '',
      end_date: '',
      is_multi_day: false,
      assignment_letter: null,
      notes: '',
      technicians: [{ name: '', id_number: '', phone: '', id_card_photo: null }],
      is_nda_accepted: false,
    },
  })

  const purposeIds = useWatch({ control, name: 'purpose_ids' }) ?? []

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
    const body: CreateVisitRequest = {
      location_id: values.location_id,
      purpose_ids: values.purpose_ids,
      start_date: new Date(values.start_date).toISOString(),
      end_date: new Date(values.end_date).toISOString(),
      is_multi_day: values.is_multi_day,
      is_nda_accepted: true,
      notes:
        values.notes !== undefined && values.notes !== ''
          ? values.notes
          : undefined,
      visitors: values.technicians.map((technician) => ({
        name: technician.name,
        id_number: technician.id_number,
        phone: technician.phone,
        id_card_photo_url: technician.id_card_photo?.url ?? null,
      })),
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
          <ArrowLeft aria-hidden="true" className="size-4" />
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
            <span className="text-label font-semibold text-ink">
              Tujuan Kunjungan
              <span className="text-brand"> *</span>
            </span>

            {purposesQuery.isPending ? (
              <span className="inline-flex items-center gap-2 text-sm text-ink-secondary">
                <Spinner size="sm" />
                Memuat tujuan kunjungan…
              </span>
            ) : (
              <div
                role="group"
                aria-label="Tujuan kunjungan"
                className="flex flex-wrap gap-2"
              >
                {(purposesQuery.data ?? []).map((purpose) => {
                  const selected = purposeIds.includes(purpose.id)
                  return (
                    <button
                      key={purpose.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => togglePurpose(purpose.id)}
                      className={[
                        'inline-flex min-h-touch items-center gap-1.5 rounded-full border px-4 text-label font-semibold transition-colors',
                        selected
                          ? 'border-brand bg-brand text-brand-contrast'
                          : 'border-border-mid bg-surface text-ink-secondary hover:bg-neutral-bg hover:text-ink',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {selected ? (
                        <Check aria-hidden="true" className="size-4" />
                      ) : null}
                      {purpose.name}
                    </button>
                  )
                })}
              </div>
            )}

            {purposesQuery.isError ? (
              <p className="text-xs text-danger-text">
                Gagal memuat daftar tujuan kunjungan. Silakan muat ulang
                halaman.
              </p>
            ) : null}
            {errors.purpose_ids?.message !== undefined ? (
              <p role="alert" className="text-xs text-danger-text">
                {errors.purpose_ids.message}
              </p>
            ) : null}
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
            render={({ field }) => (
              <UploadBox
                label="Unggah Surat Tugas / Surat Perintah Kerja"
                hint="Format PDF, JPG, atau PNG — maksimal 5 MB."
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

      {/* Bilah kirim menempel di bawah layar; menempel di atas bottom nav. */}
      <div className="fixed inset-x-0 bottom-bottomnav z-40 border-t border-border-light bg-surface px-4 py-4 lg:bottom-0">
        <Button type="submit" size="gate" fullWidth loading={isSubmitting}>
          Kirim Permohonan Kunjungan
        </Button>
      </div>
    </form>
  )
}
