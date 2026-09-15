# Pakai repo ini sebagai template

Repo ini template ERP generic (double-entry accounting spine: COA, GL, AR, AP, Inventory,
Financial Reports) yang bisa disesuaikan jadi ERP spesifik bisnis kamu.

## 1. Generate repo baru

Di GitHub, klik **Use this template** (bukan fork) di halaman repo ini — dapet repo baru
di akun kamu sendiri, history bersih. Clone repo barunya, bukan repo ini.

## 2. Setup Supabase sendiri

Repo ini gak bawa koneksi ke Supabase project asal:

```bash
npx supabase login
npx supabase link --project-ref <project-ref-kamu>
npx supabase db push
```

Update juga `project_id` di `supabase/config.toml` ke nama project kamu.

`db push` di atas cuma bikin SCHEMA-nya (tabel kosong) — Chart of Accounts, Default Akun,
dan identitas usaha sengaja gak lagi ikut ke-seed migration. Login sebagai admin pertama
(buat manual lewat database, lihat `docs/architecture/coa-schema.md` submodule "Registrasi
& Manajemen User"), lalu buka `/setup` — wizard ini nerapin template COA dagang/jasa
generik + Default Akun + Daftar Jenis Dokumen dalam 1 klik, kamu tinggal isi identitas
usaha & status pajak.

## 3. Customize ke bisnis kamu

Buka Claude Code di repo baru, jalankan skill `/customize-template` (atau minta langsung:
"customize template ini buat bisnis saya"). Skill ini bakal:
- Interview jenis bisnis kamu & modul mana dari Domain Roadmap (`AGENTS.md`) yang kepake.
- Bantu tentuin akun tambahan di luar template bawaan (manufaktur: WIP/raw material, dst) —
  ditambah lewat `/accounts/new` setelah `/setup` jalan, bukan edit seed migration.
- Tanya mau dikosongin atau dipertahankan riwayat `memory/scope-debt/` + narrative
  `memory/brief.md` project asal (itu riwayat development template, bukan punya kamu).

Setelah itu, development fitur baru ikut proses normal repo ini — gerbang wajib
`new-feature` skill (business context -> ERD -> schema -> API -> UI), Core Invariants di
`AGENTS.md` gak boleh dilanggar (balance debit=kredit, no edit posted period, traceability,
money non-float).

## Yang generic (dipertahankan apa adanya)

- Migration spine schema (`supabase/migrations/`) — reusable lintas jenis bisnis. Cuma
  reference data yang tetap di-seed migration (`app_roles`, `document_number_types`); COA/
  Default Akun/identitas usaha diisi lewat `/setup` (RPC `complete_onboarding`), bukan seed.
- Proses wajib di `AGENTS.md`/`CLAUDE.md` (teaching flow, schema->API->UI, core invariants).
- Tech stack (`memory/architecture/app/tech-stack-decisions.md`).

## Yang project-specific (disesuaikan lewat `/customize-template` atau `/setup`)

- `docs/domain/*.md` — knowledge akuntansi per modul, generic tapi modul yang gak kepake
  boleh dihapus.
- `memory/scope-debt/*.md`, narrative di `memory/brief.md` — riwayat keputusan development
  template asal, opsional dikosongin buat start fresh.
- Chart of Accounts — template bawaan diisi lewat `/setup`; akun tambahan di luar itu (mis.
  manufaktur butuh WIP/raw material) ditambah lewat `/accounts/new` setelahnya, bukan lewat
  migration.
