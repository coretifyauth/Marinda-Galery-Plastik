# Cetak Dokumen Fisik — Schema

Domain context: `memory/domain/print-templates.md` submodule "Kop Surat & Blok Tanda Tangan", naratif: `docs/domain/print-templates.md`. Cross-cutting, murni config presentasi — gak ada FK dari tabel transaksional manapun ke sini, dan sebaliknya gak ada FK dari sini ke tabel transaksional manapun.

## Kop Surat & Blok Tanda Tangan — migration `0026_print_letterhead_signatories.sql` + `0027_document_signatories_hard_delete.sql`

### `company_settings`

Identitas perusahaan buat kop surat cetakan — singleton, pola sama `tax_settings` (`memory/architecture/data/ar-schema.md`): PK `id boolean` yang cuma bisa bernilai `true`, dijaga `check (id)` supaya baris kedua gak mungkin ke-insert. `logo_url` murni link ke gambar yang sudah di-host di tempat lain (keputusan eksplisit 2026-08-15) — gak ada Supabase Storage bucket/upload file di fase ini, jadi kolomnya `text` nullable biasa, bukan referensi ke storage object.

```sql
create table company_settings (
  id boolean primary key default true,
  name text not null,
  address text,
  npwp text,
  logo_url text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  constraint company_settings_singleton check (id)
);

create trigger company_settings_set_updated_at
  before update on company_settings
  for each row execute function set_updated_at();

insert into company_settings (id, name) values (true, 'Nama Perusahaan Belum Diisi');
```

Baris tunggalnya diseed langsung di migration (constraint singleton nolak baris kedua kalau ada yang coba insert lagi) — `name` diisi placeholder karena kolomnya `not null`, admin ganti datanya sebenarnya lewat `/settings/charges` tab "Dokumen Cetak".

### `document_signatories`

Katalog jabatan penandatangan (mis. "Kepala Toko"), dibaca buat render blok tanda tangan di cetakan. **Sengaja gak ada kolom nama pegawai** — keputusan eksplisit 2026-08-15, cetakan cuma butuh label jabatan + garis kosong buat ditandatangani manual (bukan e-signature), gak ada kebutuhan sistem tahu siapa orangnya. `sort_order` nentuin urutan kolom dari kiri ke kanan di blok tanda tangan.

```sql
create table document_signatories (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  sort_order int not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger document_signatories_set_updated_at
  before update on document_signatories
  for each row execute function set_updated_at();
```

Pola master data mutable biasa (`archived_at` nullable, state-naming-convention.md) — mirip `item_categories`/`ar_invoice_charge_types`, bedanya tabel ini **juga** boleh di-hard-delete (lihat migration `0027` di bawah), gak cuma diarsipkan.

### RLS & Grant

`company_settings` — `select` terbuka semua `authenticated` (dipakai render kop surat oleh siapa pun yang nyetak), `update` cuma `admin`. **Gak ada policy `insert`/`delete`** — baris tunggalnya cuma pernah diseed migration ini, gak ada jalur nambah/hapus baris dari aplikasi (RLS default-deny otomatis nutup keduanya).

```sql
alter table company_settings enable row level security;

create policy company_settings_select on company_settings
  for select using (auth.role() = 'authenticated');

create policy company_settings_update on company_settings
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

grant select, update on company_settings to authenticated;
```

`document_signatories` — `select` terbuka semua `authenticated` (dipakai render blok tanda tangan pas siapa pun nyetak), `insert`/`update` cuma `admin`. Migration `0026` awalnya **sengaja gak ada policy `delete`** (default-deny, nonaktifkan lewat `archived_at` doang, pola sama `item_categories`).

```sql
alter table document_signatories enable row level security;

create policy document_signatories_select on document_signatories
  for select using (auth.role() = 'authenticated');

create policy document_signatories_insert on document_signatories
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

create policy document_signatories_update on document_signatories
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

grant select, insert, update on document_signatories to authenticated;
```

### Hard Delete — migration `0027_document_signatories_hard_delete.sql`

Follow-up same-day: `document_signatories` sengaja **dibedain dari pola `item_categories`/`ar_invoice_charge_types`** (yang delete-nya ditutup total, cuma bisa diarsipkan) — di sini hard delete AMAN karena gak ada FK dari tabel manapun ke `document_signatories.id` (cross-cutting config, dibaca by-value pas cetak, bukan direferensikan lewat FK). Keputusan eksplisit user (2026-08-15): admin boleh hapus permanen, `archived_at` (dari `0026`) tetap ada sebagai opsi nonaktifkan sementara tanpa hapus datanya.

```sql
create policy document_signatories_delete on document_signatories
  for delete using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

grant delete on document_signatories to authenticated;
```

## Pemakaian di Cetakan (bukan RPC — dibaca langsung lewat client)

Gak ada RPC — kedua tabel dibaca langsung pas halaman detail AR Invoice/PO dibuka (`fetchCompanySettings()`/`fetchActiveSignatoryLabels()`, `apps/erp/src/lib/company-settings/schema.ts` + `apps/erp/src/lib/document-signatories/schema.ts`), disimpan di state React, lalu dipakai `buildLetterheadHtml()`/`buildSignatureBlockHtml()` (`apps/erp/src/lib/print/print-window.ts`) pas tombol "Cetak" diklik. `fetchActiveSignatoryLabels()` filter `archived_at is null`, urut `sort_order` — jabatan nonaktif otomatis gak muncul di kertas tanpa perlu query tambahan.

Full body: `supabase/migrations/0026_print_letterhead_signatories.sql` + `supabase/migrations/0027_document_signatories_hard_delete.sql`.
