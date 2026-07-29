# Docs Brief — Entry Point

Peta seluruh `/docs`. Baca ini duluan tiap orientasi ulang.

## Struktur

```
/docs
  brief.md               <- file ini
  /domain
    /human                <- knowledge bisnis/akuntansi, versi manusia (naratif)
    /ai                   <- knowledge bisnis/akuntansi, versi compact context
  /rules                  <- mental model wajib agent SEBELUM bangun fitur
  /architecture
    /app                  <- keputusan level aplikasi (stack, konvensi kode)
    /data                 <- ERD, skema, DDL — level data
  /preferences
    /system               <- preferensi level sistem (naming, konvensi non-UI)
    /ui                    <- preferensi UI/UX & behavior design
  /story                  <- skenario bisnis riil (1 perusahaan fiktif), dipakai berkelanjutan lintas fase roadmap
```

Konvensi penamaan file: kebab-case deskriptif, tanpa prefix nomor — lihat `docs/preferences/system/md-file-naming.md`. Nama sama antara `domain/human/` dan `domain/ai/`.

## Isi saat ini

### domain/
- `chart-of-accounts.md` (human + ai) — 5 kategori akun, normal balance, kenapa expense=debit/revenue=kredit (derivasi dari persamaan akuntansi), struktur hierarkikal (header vs leaf account, rule leaf-only posting), contoh angka, common mistake.
- `general-ledger.md` (human + ai) — Journal Entry vs General Ledger, accrual vs cash basis, constraint wajib (balance, min 2 baris, leaf-only, immutability/reversing entry, source_ref, atomicity), period closing (konsep + kenapa levelnya beda dari immutability, belum termasuk scope awal), contoh transaksi generik, common mistake.

### rules/
(belum ada — diisi saat pertama kali dibutuhkan, lihat AGENT.md)

### architecture/app/
- `tech-stack-decisions.md` — Supabase (Postgres+Auth+RLS) dipilih, drop Prisma & NextAuth, impact ke tiap modul. Juga keputusan: Journal Entry gak pakai draft/posted workflow (entry final begitu dibuat), alasan & kapan perlu direvisit.

### architecture/data/
- `coa-schema.md` — DDL final tabel `accounts`, `roles`, `user_roles` + RLS policy, tiap tabel/policy dijelasin humanable. Normal_balance derived, is_active dibuang, published-lock & leaf-only-posting trigger dependency ke modul Journal Entry.
- `journal-entry-schema.md` — DDL final `journal_entries`+`journal_lines`, 5 trigger (leaf-only posting, balance-check deferred, block edit/delete, published-lock & no-retroactive-header di `accounts`), RPC atomik `create_journal_entry`+`reverse_journal_entry`, RLS/grant. Nutup dependency yang ditunda di `coa-schema.md`.

### preferences/system/
- `state-naming-convention.md` — pemisahan `archived` (soft-delete) vs `published` (derived, komitmen data/locked-state), berlaku semua modul.
- `md-file-naming.md` — konvensi penamaan file `.md`: kebab-case, tanpa prefix nomor.
- `schema-doc-format.md` — tiap schema doc (`architecture/data/*.md`) wajib ada penjelasan humanable per tabel & per RLS policy, gak boleh cuma dump SQL.

### preferences/ui/
- `admin-shell-design.md` — konvensi layout dari referensi (sidebar+topbar+breadcrumb, pola entity detail page: tab + grid kartu tematik + edit-per-section), visual style (1 warna aksen, kartu putih rounded), kapan pola ini dipakai vs enggak.
- `form-components.md` — background light (`slate-100` halaman, `white` kartu/input), komponen form reusable (`Label`/`Input`/`Select`/`Button`/`FormError`/`FormHint` di `src/components/ui/`), spacing, kenapa reusable bukan className diulang.

### story/
- `company-profile.md` — profil bisnis CV Roti Barokah (UMKM roti, Bandung), konteks & motivasi yang dipakai berulang tiap fase roadmap.
- `chart-of-accounts.md` — COA nyata Bu Nur (seed data di `supabase/migrations/0003_seed_demo_coa.sql`) + guide simulasi interface (Supabase Studio + curl REST) buat ngerasain RLS/grant beneran jalan tanpa UI custom.
- `general-ledger.md` — 6 transaksi Juli 2026 (seed data di `supabase/migrations/0005_seed_demo_journal_entries.sql`, lewat RPC `create_journal_entry`), tabel General Ledger `Kas di Bank` sebagai contoh, guide simulasi lewat `/journal-entries` + `/general-ledger`.

---

Update file ini tiap ada folder/file baru ditambahkan ke `/docs`.
