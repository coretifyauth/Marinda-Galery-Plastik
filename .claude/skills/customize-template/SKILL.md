---
name: customize-template
description: Onboarding sekali-jalan buat owner baru yang generate repo dari template custom-erp ini — interview jenis bisnis, tentuin modul dari Domain Roadmap yang dipakai/dibuang, sesuaikan Chart of Accounts seed, putuskan nasib riwayat scope-debt/brief project asal. Gunakan sekali di awal setelah "Use this template", bukan buat fitur baru rutin (itu skill `new-feature`).
---

# Customize Template

Jalan SEKALI di awal, pas owner baru pertama kali pakai hasil "Use this template" dari
repo custom-erp ini (lihat `TEMPLATE.md`). Tujuan: sesuaikan schema generic ke bisnis
spesifik owner baru, sebelum lanjut development rutin.

**Jangan trigger ulang** di project yang udah pernah di-customize — cek dulu apakah
`memory/brief.md` udah punya narrative project-specific di luar isi generic template.

## Langkah wajib

### 1. Interview jenis bisnis

Ikut siklus "Cara Mengajar" (`AGENTS.md`) — interaktif, gali balik pemahaman, bukan form
sekali isi:
- Jenis bisnis: dagang/retail, jasa, manufaktur, F&B, dst.
- Dari Domain Roadmap (`AGENTS.md`): semua project butuh COA + GL, tapi AR/AP/Inventory/
  Fixed Assets/POS/Tax opsional tergantung bisnis — mana yang kepake, mana yang dibuang.
- Skala: single entity atau multi-cabang/multi-entity (pengaruh ke RLS role design).

### 2. Reset link Supabase

- `npx supabase login` lalu `npx supabase link --project-ref <project-ref-baru>` — bukan
  project-ref repo asal.
- Update `project_id` di `supabase/config.toml`.
- `npx supabase db push` — apply 25 migration spine apa adanya (invariant + COA generic
  reusable lintas bisnis, gak perlu ditulis ulang).

### 3. Sesuaikan Chart of Accounts seed

COA default (`supabase/migrations/0002_coa_schema.sql`) generic dagang/jasa. Kalau bisnis
owner butuh akun tambahan (manufaktur: WIP/raw material, dst) — migration BARU nambah
akun, jangan edit `0002` langsung (sudah live-linked, aturan `CLAUDE.md`).

### 4. Putuskan nasib docs/domain & riwayat memory

- `docs/domain/*.md`: knowledge akuntansi per modul, generic — pertahankan, kecuali
  modulnya emang gak dipakai (hapus file, update `docs/brief.md`).
- `memory/scope-debt/*.md` + narrative section `memory/brief.md`: riwayat keputusan
  development template ASAL, bukan punya project baru. Tanya user: kosongin (fresh start)
  atau pertahankan sebagai referensi historis? Kalau dikosongin, hapus isi folder + reset
  section terkait di `memory/brief.md`, jangan hapus strukturnya.

### 5. Serahkan ke flow normal

Setelah 1-4 selesai, modul/fitur tambahan berikutnya ikut skill `new-feature` seperti
biasa (business context -> ERD -> schema -> API -> UI). Skill ini gak menggantikan itu,
cuma sekali di awal.
