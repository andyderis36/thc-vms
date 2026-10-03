'use client'

import {
  useFieldArray,
  useWatch,
  type Control,
  type FieldErrors,
  type UseFormRegister,
  type UseFormSetValue,
} from 'react-hook-form'
import { Plus, Trash, Users } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { UploadBox } from './UploadBox'
import { useVendorsQuery } from '@/lib/api/hooks'
import { VENDOR_NAME_MAX_LENGTH } from '@/lib/visits/vendor-input'
import {
  MAX_TECHNICIANS,
  type TechnicianFormValues,
  type VisitFormValues,
} from './visit-schema'

/** id <datalist> bersama — hanya berisi nama vendor TERDAFTAR dari katalog. */
const VENDOR_DATALIST_ID = 'visit-vendor-datalist'

/** Helper teks untuk isian vendor bebas-teks (bahasa Indonesia). */
const VENDOR_HINT =
  'Pilih dari daftar atau ketik manual. Nama yang diketik manual tidak masuk daftar vendor.'

export interface TechnicianListProps {
  control: Control<VisitFormValues>
  register: UseFormRegister<VisitFormValues>
  setValue: UseFormSetValue<VisitFormValues>
  errors: FieldErrors<VisitFormValues>
  /** Teks vendor milik pengguna yang sedang masuk — isian awal tiap baris baru. */
  defaultVendorName?: string
}

interface TechnicianRowProps {
  index: number
  control: Control<VisitFormValues>
  register: UseFormRegister<VisitFormValues>
  setValue: UseFormSetValue<VisitFormValues>
  errors: FieldErrors<VisitFormValues>
  canRemove: boolean
  onRemove: () => void
  vendorsPending: boolean
  vendorsError: boolean
}

function emptyTechnician(defaultVendorName?: string): TechnicianFormValues {
  return {
    name: '',
    id_number: '',
    phone: '',
    id_card_photo: null,
    // Sentinel kosong = belum diunggah; refine skema menolak saat submit.
    selfie: { url: '', name: '' },
    vendor_name: defaultVendorName ?? '',
  }
}

function TechnicianRow({
  index,
  control,
  register,
  setValue,
  errors,
  canRemove,
  onRemove,
  vendorsPending,
  vendorsError,
}: TechnicianRowProps) {
  const photo = useWatch({
    control,
    name: `technicians.${index}.id_card_photo`,
  })
  const selfie = useWatch({
    control,
    name: `technicians.${index}.selfie`,
  })
  const rowError = errors.technicians?.[index]
  const removeLabel = `Hapus teknisi ${index + 1}`

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 text-label font-bold text-ink">
          <Users aria-hidden="true" className="size-4 shrink-0 text-brand" />
          Teknisi {index + 1}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-touch"
          onClick={onRemove}
          disabled={!canRemove}
          aria-label={removeLabel}
          title={canRemove ? removeLabel : 'Minimal satu teknisi harus tetap terdaftar'}
        >
          <Trash aria-hidden="true" className="size-4 shrink-0" />
        </Button>
      </div>

      {/* 1 kolom di ponsel (kartu ringkas), 2 kolom >= sm:
          Nama | No. KTP/SIM, lalu No. HP | Foto KTP */}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Input
          label="Nama Lengkap"
          required
          fieldSize="gate"
          autoComplete="off"
          placeholder="Sesuai KTP/SIM"
          error={rowError?.name?.message}
          {...register(`technicians.${index}.name`)}
        />
        <Input
          label="Nomor KTP / SIM"
          required
          fieldSize="gate"
          inputMode="numeric"
          autoComplete="off"
          placeholder="Nomor identitas yang masih berlaku"
          error={rowError?.id_number?.message}
          {...register(`technicians.${index}.id_number`)}
        />
        <Input
          label="Nomor HP"
          required
          fieldSize="gate"
          type="tel"
          inputMode="tel"
          autoComplete="off"
          placeholder="08xxxxxxxxxx"
          error={rowError?.phone?.message}
          {...register(`technicians.${index}.phone`)}
        />
        <UploadBox
          compact
          label="Foto KTP (opsional)"
          category="id_card"
          value={photo ?? null}
          error={rowError?.id_card_photo?.message}
          onChange={(next) =>
            setValue(`technicians.${index}.id_card_photo`, next, {
              shouldDirty: true,
            })
          }
        />
        <UploadBox
          compact
          label="Foto Selfie Teknisi"
          hint="Wajah teknisi terlihat jelas — maksimal 5 MB (JPG/PNG)."
          idleButtonLabel="Unggah Foto Selfie"
          changeButtonLabel="Ganti Foto Selfie"
          category="id_card"
          value={selfie.url === '' ? null : selfie}
          error={rowError?.selfie?.message}
          onChange={(next) =>
            setValue(
              `technicians.${index}.selfie`,
              // Hapus berkas = kembali ke sentinel kosong (wajib isi ulang).
              next ?? { url: '', name: '' },
              {
                shouldDirty: true,
              },
            )
          }
        />
        {/* Input bebas-teks + <datalist>: saran HANYA dari katalog vendor
            terdaftar; teks ketikan manual tidak pernah menjadi opsi. */}
        <Input
          label="Perusahaan Vendor"
          fieldSize="gate"
          list={VENDOR_DATALIST_ID}
          autoComplete="off"
          maxLength={VENDOR_NAME_MAX_LENGTH}
          placeholder={
            vendorsPending
              ? 'Memuat vendor…'
              : 'Pilih dari daftar atau ketik nama vendor'
          }
          hint={VENDOR_HINT}
          error={
            rowError?.vendor_name?.message ??
            (vendorsError
              ? 'Gagal memuat daftar vendor. Silakan muat ulang halaman.'
              : undefined)
          }
          {...register(`technicians.${index}.vendor_name`)}
        />
      </div>
    </div>
  )
}

/**
 * Daftar tim teknisi dinamis (1..10 baris) untuk SCR-03.
 * Setiap baris berupa kartu ringkas; tombol tambah dinonaktifkan di batas
 * atas dengan alasan berbahasa Indonesia yang selalu terlihat.
 */
export function TechnicianList({
  control,
  register,
  setValue,
  errors,
  defaultVendorName,
}: TechnicianListProps) {
  const { fields, append, remove } = useFieldArray({
    control,
    name: 'technicians',
  })
  const vendorsQuery = useVendorsQuery()
  const vendors = vendorsQuery.data ?? []
  const atLimit = fields.length >= MAX_TECHNICIANS
  const listError = errors.technicians?.message

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users aria-hidden="true" className="size-4 shrink-0 text-brand" />
          Daftar Tim Teknisi
        </CardTitle>
        <Badge tone="neutral">
          {fields.length} / {MAX_TECHNICIANS}
        </Badge>
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        <p className="text-xs text-ink-secondary">
          Minimal 1 orang dan maksimal {MAX_TECHNICIANS} orang teknisi. Data
          identitas wajib sesuai KTP/SIM yang masih berlaku.
        </p>

        {listError !== undefined ? (
          <p role="alert" className="text-xs text-danger-text">
            {listError}
          </p>
        ) : null}

        {/* Katalog saran vendor — HANYA nama terdaftar (master data
            Superadmin); teks ketikan manual tidak pernah ditambahkan. */}
        <datalist id={VENDOR_DATALIST_ID}>
          {vendors.map((vendor) => (
            <option key={vendor.id} value={vendor.name} />
          ))}
        </datalist>

        <div className="flex flex-col gap-4">
          {fields.map((field, index) => (
            <TechnicianRow
              key={field.id}
              index={index}
              control={control}
              register={register}
              setValue={setValue}
              errors={errors}
              canRemove={fields.length > 1}
              onRemove={() => remove(index)}
              vendorsPending={vendorsQuery.isPending}
              vendorsError={vendorsQuery.isError}
            />
          ))}
        </div>

        <div className="flex flex-col gap-1.5">
          <Button
            type="button"
            variant="secondary"
            fullWidth
            className="min-h-touch"
            disabled={atLimit}
            onClick={() => append(emptyTechnician(defaultVendorName))}
          >
            <Plus aria-hidden="true" className="size-4 shrink-0" />
            Tambah Anggota Teknisi
          </Button>
          {atLimit ? (
            <p className="text-xs text-warning-text">
              Maksimal {MAX_TECHNICIANS} teknisi per permohonan. Hapus salah
              satu teknisi bila ingin menambah anggota baru.
            </p>
          ) : (
            <p className="text-xs text-ink-secondary">
              Tekan untuk menambah anggota tim (maksimal {MAX_TECHNICIANS}{' '}
              orang).
            </p>
          )}
        </div>
      </CardBody>
    </Card>
  )
}
