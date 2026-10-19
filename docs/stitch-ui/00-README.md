> ⛔ **ARSIP — BUKAN SUMBER KEBENARAN (NON-SSOT). JANGAN DIEDIT.**
>
> Dokumen ini adalah *starter kit* desain Google Stitch dari awal proyek dan **sudah basi**: isinya tidak lagi mencerminkan UI yang benar-benar berjalan. `radius`, warna, tipografi, dan spesifikasi layarnya **tidak boleh** dipakai sebagai acuan.
>
> - Otoritas desain visual yang berlaku: pola komponen **jokoui** (`https://www.jokoui.web.id/components/application`) + palet tetap THC `#422AD5` (primary) dan `#F43098` (secondary) — lihat `AGENTS.md` §3.1.
> - Kebenaran bisnis, data, dan kontrak API: `docs/0. PRD - THC Visitor App.md`, `docs/1. Entity Relationship Diagram (ERD).mermaid`, `docs/4. openapi.yaml`.
> - Alur kerja yang berlaku: perubahan dibuat **di codebase** lebih dulu, lalu docs/PRD disinkronkan menyusul — bukan sebaliknya.
> - Perlu menyelaraskan sesuatu di sini? **Jangan** — perbarui SSOT yang disebut di atas.

# Stitch Docs – THC Visitor Management System (VMS)

Folder ini berisi dokumentasi antarmuka pengguna (UI) yang dioptimalkan untuk **Google Stitch** dan **Next.js 16.3+ (Tailwind CSS v4) Frontend**.

---

## 1. Struktur Folder

```text
docs/stitch-ui/
├── 00-README.md                # Panduan alur pembuatan UI di Google Stitch
├── 01-screen-inventory.md       # Daftar 5 Layar Core UI MVP + 4 Base Layout Shells
├── 02-design-system.md         # Design tokens (Warna, Tipografi, RBAC Base Layouts)
├── 03-user-flow.md             # Alur navigasi antar 5 layar inti MVP
├── 04-screen-specs-mvp.md      # Spesifikasi detail layout & interaksi 5 screen inti MVP
└── 06-prompt-templates.md      # Master prompt siap salin ke Google Stitch (SHELL & SCR)
```

---

## 2. Urutan Pembuatan UI di Google Stitch

1. **Langkah 1**: Baca `01-screen-inventory.md` & `02-design-system.md` untuk memahami token visual (Ungu-Biru THC `#422AD5`, Dark Topbar `#18181B`, Background `#FFFFFF`).
2. **Langkah 2**: Buka `06-prompt-templates.md` Bagian 1, salin prompt **Base Layout Shell** (`SHELL-01` s/d `SHELL-04`) ke Google Stitch untuk mengunci konsistensi bingkai navbar & sidebar tiap peran.
3. **Langkah 3**: Salin prompt **5 Layar Inti MVP** (`SCR-01` s/d `SCR-05`) satu per satu ke Google Stitch.

---

## 3. Prinsip Desain untuk Solo Dev & AI Agent

- **Satu Prompt = Satu Shell / Screen**: Prompt dirancang *self-contained* sehingga bisa langsung di-copy-paste tanpa kehilangan konteks.
- **KISS & Fungsional**: UI bersih, responsif, touch target 44px–52px untuk mobile petugas lapangan/teknisi, tanpa komponen dekoratif yang tidak fungsional.
- **Bahasa UI**: Bahasa Indonesia profesional.
- **Konsistensi Data**: Seluruh field form, badge status, dan tipe data 100% selaras dengan PRD v3.1, ERD, dan OpenAPI v3.1.
