-- scope-debt print-template-letterhead-signature: kop surat resmi + blok tanda tangan
-- di cetakan AR Invoice/PO. 2 tabel config baru, cross-cutting, gak nyentuh tabel
-- transaksional manapun -- dibaca live pas cetak (pola sama "Live Data" print-templates).
-- Ref: memory/domain/print-templates.md submodule "Kop Surat & Blok Tanda Tangan".

-- company_settings: singleton (pola sama tax_settings, 0005_ar_schema.sql) -- identitas
-- perusahaan buat kop surat. logo_url murni link ke gambar yang sudah di-host di tempat
-- lain (keputusan eksplisit 2026-08-15) -- gak ada Supabase Storage bucket/upload file
-- di fase ini.
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

-- Baris tunggalnya diseed di sini (constraint singleton nolak baris kedua), admin isi
-- nama sebenarnya belakangan lewat Settings -- placeholder, bukan "" karena name NOT NULL.
insert into company_settings (id, name) values (true, 'Nama Perusahaan Belum Diisi');

-- document_signatories: master jabatan penandatangan (mis. "Kepala Toko"). TANPA kolom
-- nama pegawai -- keputusan eksplisit 2026-08-15, cetakan cuma butuh label jabatan +
-- garis kosong buat ditandatangani manual. Pola sama item_categories/ar_invoice_charge_types
-- (master data katalog, insert/update doang, nonaktifkan via archived_at bukan delete).
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

-- ============================================================
-- RLS
-- ============================================================

-- company_settings: semua authenticated boleh baca (dipakai render kop surat di cetakan
-- oleh siapa pun yang nyetak), cuma admin boleh update. Gak ada policy insert/delete --
-- baris tunggalnya cuma diseed migration ini (sama pola tax_settings).
alter table company_settings enable row level security;

create policy company_settings_select on company_settings
  for select using (auth.role() = 'authenticated');

create policy company_settings_update on company_settings
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

-- document_signatories: semua authenticated boleh baca (dipakai render blok tanda tangan
-- di cetakan), cuma admin boleh insert/update. Gak ada policy delete -- nonaktifkan via
-- archived_at (default deny RLS = gak ada yang bisa delete lewat API sama sekali).
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

-- ============================================================
-- Grant
-- ============================================================

grant select, update on company_settings to authenticated;
grant select, insert, update on document_signatories to authenticated;
