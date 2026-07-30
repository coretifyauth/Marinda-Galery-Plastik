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
  /scope-debt              <- keputusan desain yang sengaja ditunda lintas modul, 1 file per konsep
```

Konvensi penamaan file: kebab-case deskriptif, tanpa prefix nomor — lihat `docs/preferences/system/md-file-naming.md`. Nama sama antara `domain/human/` dan `domain/ai/`.

## Isi saat ini

### domain/
- `chart-of-accounts.md` (human + ai) — 5 kategori akun, normal balance, kenapa expense=debit/revenue=kredit (derivasi dari persamaan akuntansi), struktur hierarkikal (header vs leaf account, rule leaf-only posting), contoh angka, common mistake.
- `general-ledger.md` (human + ai) — Journal Entry vs General Ledger, accrual vs cash basis, constraint wajib (balance, min 2 baris, leaf-only, immutability/reversing entry, source_ref, atomicity), period closing (konsep + kenapa levelnya beda dari immutability, belum termasuk scope awal), contoh transaksi generik, common mistake.
- `accounts-receivable.md` (human + ai) — customer master data + termin, invoice (due_date snapshot) & payment & payment allocation (many-to-many, kenapa gak cukup invoice_id langsung), status invoice derived, constraint (journal-backed, immutability, anti over-allocation, cancellation guard), 5 skenario alokasi, belum termasuk (retur, DP, overpayment) — ref `docs/scope-debt/`.
- `accounts-payable.md` (human + ai) — kebalikan AR: supplier master data + termin (ditentuin SUPPLIER, bukan kita — beda konteks bisnis dari AR), bill & payment & payment allocation, constraint identik AR + cancellation guard diterapkan dari awal, 5 skenario (termasuk aging yang maknanya kebalik dari AR), belum termasuk (retur, diskon bayar cepat, DP, bill compound) — ref `docs/scope-debt/`.

### rules/
(belum ada — diisi saat pertama kali dibutuhkan, lihat AGENT.md)

### architecture/app/
- `tech-stack-decisions.md` — Supabase (Postgres+Auth+RLS) dipilih, drop Prisma & NextAuth, impact ke tiap modul. Juga keputusan: Journal Entry gak pakai draft/posted workflow (entry final begitu dibuat), alasan & kapan perlu direvisit.

### architecture/data/
- `coa-schema.md` — DDL final tabel `accounts`, `roles`, `user_roles` + RLS policy, tiap tabel/policy dijelasin humanable. Normal_balance derived, is_active dibuang, published-lock & leaf-only-posting trigger dependency ke modul Journal Entry.
- `journal-entry-schema.md` — DDL final `journal_entries`+`journal_lines`, 5 trigger (leaf-only posting, balance-check deferred, block edit/delete, published-lock & no-retroactive-header di `accounts`), RPC atomik `create_journal_entry`+`reverse_journal_entry`, RLS/grant. Nutup dependency yang ditunda di `coa-schema.md`.
- `ar-schema.md` — DDL final `customers`+`ar_invoices`+`ar_payments`+`ar_payment_allocations`, due_date snapshot (bukan generated), status invoice derived dari alokasi, trigger anti over-allocation + reuse `block_edit_delete`, RPC atomik `create_ar_invoice`+`record_ar_payment`+`cancel_ar_invoice` (manggil `create_journal_entry`/`reverse_journal_entry`, gak insert GL manual), RLS/grant. Migration `0007`+`0009` (cancellation ditambah belakangan).
- `ap-schema.md` — DDL `suppliers`+`ap_bills`+`ap_payments`+`ap_payment_allocations`, struktur mirror persis `ar-schema.md` (arah kebalik), beda: `payment_term_days` maknanya syarat DARI supplier bukan yang kita tetapkan, `create_ap_bill` terima akun debit generik (Persediaan/Beban), `cancel_ap_bill` diterapkan dari awal. Migration `0010_ap_schema.sql`+`0011_seed_demo_ap.sql`.

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
- `accounts-receivable.md` — 3 customer (Warung Pak Budi/Bu Imas/Kang Ade, termin beda-beda), 3 skenario (lunas tepat waktu, cicil, telat bayar/aging lanjutan dari invoice 7 Juli di `general-ledger.md`), tabel saldo Piutang Usaha per 30 Juli 2026 (seed data di `supabase/migrations/0008_seed_demo_ar.sql`, lewat RPC `create_ar_invoice`/`record_ar_payment`). UI (`/customers`, `/ar-invoices`, `/ar-payments`) udah dibangun (client-side, langsung Supabase RPC, gak ada API route custom).
- `accounts-payable.md` — 2 supplier (Toko Tepung Makmur net-14, Toko Gula Sejahtera net-7), 5 skenario (lunas, cicil, bayar gabungan, telat/aging lanjutan dari bill 10 Juli di `general-ledger.md`, bill dibatalkan), tabel saldo Utang Usaha per 30 Juli 2026 (sisa Rp800.000 dari Toko Tepung Makmur, telat 6 hari). Seed data di `supabase/migrations/0011_seed_demo_ap.sql`. UI (`/suppliers`, `/ap-bills`, `/ap-payments`) belum dibangun.

### scope-debt/
Ledger keputusan desain yang sengaja ditunda, dikumpulin lintas modul biar gak keburu ilang di percakapan. 1 file = 1 konsep, isinya: kasus, kenapa ditunda, kapan perlu digarap, referensi balik ke domain/schema doc terkait.
- `ar-retur-barang.md`, `ar-uang-muka-dp.md`, `ar-overpayment-saldo-kredit.md` — 3 gap AR yang udah ditandain dari awal (`ar-schema.md` bagian "Belum termasuk").
- `ar-credit-hold.md`, `ar-piutang-tak-tertagih.md` — 2 dari 4 tindakan penjual ke piutang telat (level 2 & 4) yang belum diimplementasi, dari diskusi kasus Warung Pak Budi.
- `ap-retur-barang.md`, `ap-diskon-bayar-cepat.md`, `ap-uang-muka-dp.md`, `ap-bill-compound.md` — 4 kasus AP (Fase 4, masih tahap desain konsep, `ap-schema.md` belum ditulis) yang sengaja ditunda biar bentuk pertama AP simetris sama AR.
- `period-closing.md`, `trial-balance-rollup.md` — dependency GL ke Fase 7 (Financial Reports).
- `fixed-assets-akun-kontra-asset.md` — gap `normal_balance` generated column buat akun kontra-asset, dependency ke Fase 6 (Fixed Assets).
- `user-role-admin-assignment.md` — policy admin assign role user lain, butuh `security definer` function.

---

Update file ini tiap ada folder/file baru ditambahkan ke `/docs`.
