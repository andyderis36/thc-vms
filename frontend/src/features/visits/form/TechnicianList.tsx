'use client'

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
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
import { technicianAnchorId } from './invalid-fields'
import {
  useJabatanQuery,
  useMemberSuggestionQuery,
  useMemberSuggestionsQuery,
  useVendorSuggestionsQuery,
  useVendorsQuery,
} from '@/lib/api/hooks'
import {
  EMAIL_MAX_LENGTH,
  ID_NUMBER_MAX_LENGTH,
  NAME_MAX_LENGTH,
  PHONE_MAX_LENGTH,
  sanitizePhoneInput,
} from '@/lib/limits'
import { JABATAN_MAX_LENGTH } from '@/lib/visits/jabatan-input'
import {
  mergeSuggestionNames,
  toMemberSuggestionOptions,
  toMemberSuggestionPatch,
  type SuggestionPick,
} from '@/lib/visits/suggestions'
import { VENDOR_NAME_MAX_LENGTH } from '@/lib/visits/vendor-input'
import {
  MAX_TECHNICIANS,
  type TechnicianFormValues,
  type VisitFormValues,
} from './visit-schema'

/** id <datalist> bersama — nama saran vendor + pelengkap katalog terdaftar. */
const VENDOR_DATALIST_ID = 'visit-vendor-datalist'

/** id <datalist> bersama — jabatan yang PERNAH terdaftar (bukan katalog). */
const JABATAN_DATALIST_ID = 'visit-jabatan-datalist'

/** Helper teks untuk isian vendor bebas-teks (bahasa Indonesia). */
const VENDOR_HINT = 'Pilih atau ketik vendor (manual tidak masuk daftar).'

/** Helper teks untuk isian jabatan bebas-teks (bahasa Indonesia). */
const JABATAN_HINT = 'Pilih atau ketik jabatan (manual tidak masuk saran).'

export interface TechnicianListProps {
  control: Control<VisitFormValues>
  register: UseFormRegister<VisitFormValues>
  setValue: UseFormSetValue<VisitFormValues>
  errors: FieldErrors<VisitFormValues>
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
  jabatanPending: boolean
  jabatanError: boolean
}

function emptyTechnician(): TechnicianFormValues {
  return {
    name: '',
    id_number: '',
    phone: '',
    // Sentinel kosong = belum diunggah; refine skema menolak saat submit.
    id_card_photo: { url: '', name: '' },
    selfie: { url: '', name: '' },
    jabatan: '',
    vendor_name: '',
    email: '',
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
  jabatanPending,
  jabatanError,
}: TechnicianRowProps) {
  const rowValues = useWatch({ control, name: `technicians.${index}` })
  const photo = rowValues.id_card_photo
  const selfie = rowValues.selfie
  const rowError = errors.technicians?.[index]
  const removeLabel = `Hapus anggota ${index + 1}`
  const phoneField = register(`technicians.${index}.phone`)
  const nameField = register(`technicians.${index}.name`)
  const nameDatalistId = `${technicianAnchorId(index, 'name')}-datalist`
  const visitVendorName = useWatch({ control, name: 'vendor_name' }) ?? ''

  const memberSuggestionsQuery = useMemberSuggestionsQuery({
    q: rowValues.name,
    vendor: visitVendorName,
  })

  /*
   * Pilihan saran anggota: daftar sudah membawa `visitor_id` baris visitor,
   * jadi pilihan langsung memanggil detail (foto presigned) tanpa perantara
   * kunjungan sumber. Query berbasis kunci: pilihan baru mengganti kunci,
   * respons basi tidak pernah terlihat; `appliedPickRef` menahan penerapan
   * ulang yang akan menimpa ketikan pengguna setelah autofill. Tanpa
   * kecocokan (nama ketikan manual) tidak ada pilihan dan tidak ada patch.
   */
  const [pick, setPick] = useState<SuggestionPick | null>(null)
  const memberDetailQuery = useMemberSuggestionQuery(pick?.visitorId ?? null)
  const appliedPickRef = useRef<string | null>(null)

  useEffect(() => {
    const detail = memberDetailQuery.data
    if (pick === null || detail === undefined) return
    if (appliedPickRef.current === pick.visitorId) return
    appliedPickRef.current = pick.visitorId
    setValue(
      `technicians.${index}`,
      { ...rowValues, ...toMemberSuggestionPatch(detail) },
      { shouldDirty: true, shouldValidate: true },
    )
  }, [memberDetailQuery.data, pick, index, rowValues, setValue])

  /*
   * Detail gagal dimuat (404/jaringan): pulihkan nama kanonis dan tandai
   * pilihan sudah dipakai, sehingga nilai berakhiran "(nomor HP)" tidak
   * pernah terkirim dan respons sukses yang datang belakangan tidak
   * menimpa ketikan pengguna.
   */
  useEffect(() => {
    if (pick === null || !memberDetailQuery.isError) return
    if (appliedPickRef.current === pick.visitorId) return
    appliedPickRef.current = pick.visitorId
    setValue(`technicians.${index}.name`, pick.name, {
      shouldDirty: true,
      shouldValidate: true,
    })
  }, [memberDetailQuery.isError, pick, index, setValue])

  const typedNameRef = useRef('')

  function findPickOption(value: string): SuggestionPick | null {
    if (value === '') return null
    const datalist = document.getElementById(nameDatalistId)
    if (datalist === null) return null
    const option = Array.from(datalist.querySelectorAll('option')).find(
      (item) => item.value === value,
    )
    const visitorId = option?.dataset.visitorId
    const name = option?.dataset.name
    if (
      option === undefined ||
      visitorId === undefined ||
      visitorId === '' ||
      name === undefined
    ) {
      return null
    }
    return { visitorId, name }
  }

  function applyPickFromValue(value: string): void {
    appliedPickRef.current = null
    setPick(findPickOption(value))
  }

  /*
   * Deteksi pemilihan datalist: sinyal `inputType` berbeda antar peramban —
   * Firefox mengirim `"insertReplacementText"`, Chrome/Edge mengirim
   * `null`/string kosong saat opsi dipilih, bukan `"insertText"`. Keduanya
   * diterima, TETAPI hanya bila nilainya PERSIS salah satu opsi datalist:
   * ketikan, tempel, dan hapus (`insertText`, `insertFromPaste`,
   * `deleteContent…`) tidak pernah memicu autofill dan justru me-reset
   * pilihan lama agar tidak pernah ditimpa ulang tanpa maksud pengguna.
   */
  function handleNameInput(event: FormEvent<HTMLInputElement>): void {
    const value = event.currentTarget.value
    const native = event.nativeEvent
    const inputType = native instanceof InputEvent ? native.inputType : null
    const isPickSignal =
      inputType === null ||
      inputType === '' ||
      inputType === 'insertReplacementText'
    if (isPickSignal && findPickOption(value) !== null) {
      typedNameRef.current = value
      applyPickFromValue(value)
      return
    }
    typedNameRef.current = value
    setPick(null)
    appliedPickRef.current = null
  }

  /*
   * Jaring pengaman `change`: peramban yang tidak mengirim `input` saat opsi
   * datalist dipilih tetap terdeteksi dari nilai yang berubah tanpa ketikan
   * (nilai ketikan selalu sinkron di `typedNameRef`).
   */
  function handleNameChange(event: ChangeEvent<HTMLInputElement>): void {
    nameField.onChange(event)
    const value = event.target.value
    if (value === typedNameRef.current) return
    typedNameRef.current = value
    applyPickFromValue(value)
  }

  return (
    <div className="card p-4">
      <div className="flex min-h-touch items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 text-label font-bold text-ink">
          <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-bold text-brand-dark">
            {index + 1}
          </span>
          Anggota {index + 1}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-touch min-w-touch px-2"
          onClick={onRemove}
          disabled={!canRemove}
          aria-label={removeLabel}
          title={
            canRemove
              ? removeLabel
              : 'Minimal satu anggota harus tetap terdaftar'
          }
        >
          <Trash aria-hidden="true" className="size-4 shrink-0" />
        </Button>
      </div>

      {/* 1 kolom di ponsel (kartu ringkas), 2 kolom >= sm:
          Nama | No. KTP/SIM, lalu No. HP | Jabatan, Foto KTP | Foto Selfie */}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Input
          label="Nama Lengkap"
          required
          fieldSize="gate"
          autoComplete="off"
          maxLength={NAME_MAX_LENGTH}
          placeholder="Sesuai KTP/SIM"
          error={rowError?.name?.message}
          id={technicianAnchorId(index, 'name')}
          list={nameDatalistId}
          {...nameField}
          onChange={handleNameChange}
          onInput={handleNameInput}
        />
        {/* Saran anggota (roster lama) — opsional: memilih satu mengisi ulang
            baris (termasuk foto + perusahaan anggota), mengetik bebas tetap
            tanpa saran. */}
        <datalist id={nameDatalistId}>
          {toMemberSuggestionOptions(memberSuggestionsQuery.data).map(
            (option) => (
              <option
                key={option.visitorId}
                value={option.value}
                label={option.label}
                data-name={option.name}
                data-visitor-id={option.visitorId}
              />
            ),
          )}
        </datalist>
        <Input
          label="Nomor KTP / SIM"
          required
          fieldSize="gate"
          inputMode="numeric"
          autoComplete="off"
          maxLength={ID_NUMBER_MAX_LENGTH}
          placeholder="Nomor identitas yang masih berlaku"
          error={rowError?.id_number?.message}
          id={technicianAnchorId(index, 'id_number')}
          {...register(`technicians.${index}.id_number`)}
        />
        <Input
          label="Nomor HP"
          required
          fieldSize="gate"
          type="tel"
          inputMode="tel"
          autoComplete="off"
          maxLength={PHONE_MAX_LENGTH}
          placeholder="08xxxxxxxxxx"
          error={rowError?.phone?.message}
          id={technicianAnchorId(index, 'phone')}
          {...phoneField}
          onChange={(event) => {
            event.target.value = sanitizePhoneInput(event.target.value)
            phoneField.onChange(event)
          }}
        />
        {/* Jabatan: teks bebas + saran jabatan yang pernah terdaftar. */}
        <Input
          label="Jabatan"
          fieldSize="gate"
          list={JABATAN_DATALIST_ID}
          autoComplete="off"
          maxLength={JABATAN_MAX_LENGTH}
          placeholder={
            jabatanPending ? 'Memuat jabatan…' : 'Pilih atau ketik jabatan'
          }
          hint={JABATAN_HINT}
          error={
            rowError?.jabatan?.message ??
            (jabatanError
              ? 'Gagal memuat daftar jabatan. Silakan muat ulang halaman.'
              : undefined)
          }
          id={technicianAnchorId(index, 'jabatan')}
          {...register(`technicians.${index}.jabatan`)}
        />
        <UploadBox
          compact
          label="Foto KTP"
          hint="Wajib diunggah — foto dikompresi otomatis (hasil ≤5 MB, JPG/PNG)."
          category="id_card"
          id={technicianAnchorId(index, 'id_card_photo')}
          value={photo.url === '' ? null : photo}
          error={rowError?.id_card_photo?.message}
          onChange={(next) =>
              setValue(
                `technicians.${index}.id_card_photo`,
                // Hapus berkas = kembali ke sentinel kosong (wajib isi ulang).
                next ?? { url: '', name: '' },
                {
                  shouldDirty: true,
                  // Galat "Foto KTP wajib diunggah." harus hilang begitu
                  // foto terunggah - tanpa ini pesan lama nempel sampai
                  // percobaan kirim berikutnya (pola sama di PurposeDropdown).
                  shouldValidate: true,
                },
              )
          }
        />
        <UploadBox
          compact
          label="Foto Selfie"
          hint="Wajah anggota terlihat jelas — foto dikompresi otomatis (hasil ≤5 MB, JPG/PNG)."
          idleButtonLabel="Unggah Foto Selfie"
          changeButtonLabel="Ganti Foto Selfie"
          category="id_card"
          id={technicianAnchorId(index, 'selfie')}
          value={selfie.url === '' ? null : selfie}
          error={rowError?.selfie?.message}
          onChange={(next) =>
              setValue(
                `technicians.${index}.selfie`,
                // Hapus berkas = kembali ke sentinel kosong (wajib isi ulang).
                next ?? { url: '', name: '' },
                {
                  shouldDirty: true,
                  // Sama seperti foto KTP: galat wajib hilang begitu berkas
                  // terunggah, bukan nempel sampai percobaan kirim berikutnya.
                  shouldValidate: true,
                },
              )
          }
        />
        {/* Input bebas-teks + <datalist>: saran dari feed vendor + katalog
            terdaftar; teks ketikan manual tidak pernah menjadi opsi. */}
        <Input
          label="Perusahaan Vendor"
          fieldSize="gate"
          list={VENDOR_DATALIST_ID}
          autoComplete="off"
          maxLength={VENDOR_NAME_MAX_LENGTH}
          placeholder={
            vendorsPending ? 'Memuat vendor…' : 'Pilih atau ketik vendor'
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
        {/* Email anggota: OPSIONAL — tanpa tanda `required`, format divalidasi
            zod hanya bila tidak kosong (maks 254, kontrak openapi). */}
        <Input
          label="Email"
          fieldSize="gate"
          type="email"
          inputMode="email"
          autoComplete="off"
          maxLength={EMAIL_MAX_LENGTH}
          placeholder="cth. nama@vendor.co.id"
          error={rowError?.email?.message}
          id={technicianAnchorId(index, 'email')}
          {...register(`technicians.${index}.email`)}
        />
      </div>
    </div>
  )
}

/**
 * Daftar anggota/pengunjung dinamis (1..10 baris) untuk SCR-03.
 * Setiap baris berupa kartu ringkas; tombol tambah dinonaktifkan di batas
 * atas dengan alasan berbahasa Indonesia yang selalu terlihat.
 */
export function TechnicianList({
  control,
  register,
  setValue,
  errors,
}: TechnicianListProps) {
  const { fields, append, remove } = useFieldArray({
    control,
    name: 'technicians',
  })
  const vendorsQuery = useVendorsQuery()
  const vendors = vendorsQuery.data ?? []
  // Saran "Perusahaan Vendor" per baris: feed `GET /vendors/suggestions`
  // (gerbang peran di dalam hook) + pelengkap katalog `GET /vendors` supaya
  // nama terdaftar yang dulu tampil tidak pernah hilang. Feed tanpa q (daftar
  // bersama); peramban menyaring saat ketik.
  const vendorSuggestionsQuery = useVendorSuggestionsQuery('')
  const vendorOptionNames = mergeSuggestionNames(vendorSuggestionsQuery.data, vendors)
  const jabatanQuery = useJabatanQuery()
  const jabatan = jabatanQuery.data ?? []
  const atLimit = fields.length >= MAX_TECHNICIANS
  const listError = errors.technicians?.message

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users aria-hidden="true" className="size-4 shrink-0 text-brand" />
          Daftar Anggota/Pengunjung
        </CardTitle>
        <Badge tone="neutral">
          {fields.length} / {MAX_TECHNICIANS}
        </Badge>
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        <p className="text-xs text-ink-secondary">
          Minimal 1 orang dan maksimal {MAX_TECHNICIANS} orang anggota. Data
          identitas wajib sesuai KTP/SIM yang masih berlaku.
        </p>

        {listError !== undefined ? (
          <p role="alert" className="text-xs text-danger-text">
            {listError}
          </p>
        ) : null}

        {/* Katalog saran vendor — feed saran + nama terdaftar; teks ketikan
            manual tidak pernah ditambahkan. */}
        <datalist id={VENDOR_DATALIST_ID}>
          {vendorOptionNames.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>

        {/* Saran jabatan — HANYA nilai yang pernah tersimpan di backend;
            pengguna tetap bebas mengetik jabatan baru. */}
        <datalist id={JABATAN_DATALIST_ID}>
          {jabatan.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>

        <div id="visit-technicians" tabIndex={-1} className="flex flex-col gap-4">
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
              jabatanPending={jabatanQuery.isPending}
              jabatanError={jabatanQuery.isError}
            />
          ))}
        </div>

        <div className="flex flex-col gap-1.5">
          <Button
            type="button"
            variant="secondary"
            fullWidth
            className="min-h-touch-lg"
            disabled={atLimit}
            onClick={() => append(emptyTechnician())}
          >
            <Plus aria-hidden="true" className="size-4 shrink-0" />
            Tambah Anggota
          </Button>
          {atLimit ? (
            <p className="text-xs text-warning-text">
              Maksimal {MAX_TECHNICIANS} anggota per permohonan. Hapus salah
              satu anggota bila ingin menambah anggota baru.
            </p>
          ) : (
            <p className="text-xs text-ink-secondary">
              Tekan untuk menambah anggota (maksimal {MAX_TECHNICIANS} orang).
            </p>
          )}
        </div>
      </CardBody>
    </Card>
  )
}
