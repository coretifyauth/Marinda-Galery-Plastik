# Pakai repo ini sebagai template

Repo ini template ERP generic (double-entry accounting spine: COA, GL, AR, AP, Inventory,
Fixed Assets, Financial Reports) yang bisa disesuaikan jadi ERP spesifik bisnis kamu.

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

## 3. Customize ke bisnis kamu

Buka Claude Code di repo baru, jalankan skill `/customize-template` (atau minta langsung:
"customize template ini buat bisnis saya"). Skill ini bakal:
- Interview jenis bisnis kamu & modul mana dari Domain Roadmap (`AGENTS.md`) yang kepake.
- Bantu sesuaikan Chart of Accounts seed kalau perlu akun tambahan (manufaktur, dst).
- Tanya mau dikosongin atau dipertahankan riwayat `memory/scope-debt/` + narrative
  `memory/brief.md` project asal (itu riwayat development template, bukan punya kamu).

Setelah itu, development fitur baru ikut proses normal repo ini — gerbang wajib
`new-feature` skill (business context -> ERD -> schema -> API -> UI), Core Invariants di
`AGENTS.md` gak boleh dilanggar (balance debit=kredit, no edit posted period, traceability,
money non-float).

## Yang generic (dipertahankan apa adanya)

- 25 migration spine schema (`supabase/migrations/`) + seed structural-config-only (COA,
  `document_number_types`, `roles`, dst) — reusable lintas jenis bisnis.
- Proses wajib di `AGENTS.md`/`CLAUDE.md` (teaching flow, schema->API->UI, core invariants).
- Tech stack (`memory/architecture/app/tech-stack-decisions.md`).

## Yang project-specific (disesuaikan lewat `/customize-template`)

- `docs/domain/*.md` — knowledge akuntansi per modul, generic tapi modul yang gak kepake
  boleh dihapus.
- `memory/scope-debt/*.md`, narrative di `memory/brief.md` — riwayat keputusan development
  template asal, opsional dikosongin buat start fresh.
- Chart of Accounts seed (`0002_coa_schema.sql`) kalau bisnis kamu butuh akun di luar
  default dagang/jasa — tambah migration baru, JANGAN edit `0002` langsung.
