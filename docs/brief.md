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
```

Konvensi penamaan file: kebab-case deskriptif, tanpa prefix nomor — lihat `docs/preferences/system/md-file-naming.md`. Nama sama antara `domain/human/` dan `domain/ai/`.

## Isi saat ini

### domain/
- `chart-of-accounts.md` (human + ai) — 5 kategori akun, normal balance, kenapa expense=debit/revenue=kredit (derivasi dari persamaan akuntansi), struktur hierarkikal (header vs leaf account, rule leaf-only posting), contoh angka, common mistake.

### rules/
(belum ada — diisi saat pertama kali dibutuhkan, lihat AGENT.md)

### architecture/app/
- `tech-stack-decisions.md` — Supabase (Postgres+Auth+RLS) dipilih, drop Prisma & NextAuth, impact ke tiap modul.

### architecture/data/
- `coa-schema.md` — DDL final tabel `accounts`, `roles`, `user_roles` + RLS policy, tiap tabel/policy dijelasin humanable. Normal_balance derived, is_active dibuang, published-lock & leaf-only-posting trigger dependency ke modul Journal Entry.

### preferences/system/
- `state-naming-convention.md` — pemisahan `archived` (soft-delete) vs `published` (derived, komitmen data/locked-state), berlaku semua modul.
- `md-file-naming.md` — konvensi penamaan file `.md`: kebab-case, tanpa prefix nomor.
- `schema-doc-format.md` — tiap schema doc (`architecture/data/*.md`) wajib ada penjelasan humanable per tabel & per RLS policy, gak boleh cuma dump SQL.

### preferences/ui/
(belum ada)

---

Update file ini tiap ada folder/file baru ditambahkan ke `/docs`.
