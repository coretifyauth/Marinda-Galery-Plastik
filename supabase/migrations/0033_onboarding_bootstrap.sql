-- Onboarding / Setup Awal. Ref: docs/domain/chart-of-accounts.md submodule "Onboarding /
-- Setup Awal", docs/architecture/coa-schema.md submodule "Onboarding -- Bootstrap
-- Konfigurasi Awal".
--
-- Latar belakang: sistem gak bisa dipakai bertransaksi sebelum COA + Default Akun + Daftar
-- Jenis Dokumen + app_settings lengkap. accounts/app_default_account_settings/app_settings
-- sengaja TIDAK di-seed migration (lihat 0002/0006/0008) -- keputusan bisnis, bukan
-- reference data, jadi diisi lewat halaman /setup di bawah ini. Ini juga jadi satu-satunya
-- jalan pulih kalau seluruh data di database dihapus total (bukan cuma migration di-skip,
-- tapi baris-barisnya ditruncate) -- app_settings kosong dipakai sebagai sinyal "belum
-- di-setup" di seluruh sistem.
--
-- 2 RPC setup awal (`bootstrap_default_accounts` + `complete_onboarding`) SENGAJA dipisah
-- jadi 2 langkah, bukan 1 RPC gabungan: langkah 1 (akun/dokumen/mapping, gak ada input)
-- dipanggil duluan biar UI /setup bisa nampilin hasilnya sebagai tabel nyata (role -> akun
-- ter-resolve, mirip tampilan halaman Pengaturan > Default Akun) sebelum user masuk ke
-- langkah 2 (identitas usaha, satu-satunya bagian yang genuinely input manual).

-- create_account -- generate kode akun otomatis, gantiin insert langsung dari
-- /accounts/new. Pola kode ikutin konvensi seed lama (top-level: kelipatan 100 per
-- kategori; anak: kode induk + 10 per anak). security invoker (bukan definer) karena RLS
-- accounts_insert yang sudah ada (admin doang) sudah cukup, gak perlu bypass privilege.
--
-- Digerbangi app_settings sudah ada (setup awal sudah selesai) -- mencegah admin bikin akun
-- manual duluan sebelum /setup dijalankan, yang bisa "mencuri" kode dasar (mis. 1300) buat
-- akun gak terkait dan bikin complete_onboarding salah resolve akun template.
create or replace function create_account(
  p_name text,
  p_category account_category,
  p_parent_id uuid default null,
  p_is_contra boolean default false
) returns accounts
language plpgsql
security invoker
as $$
declare
  v_parent accounts%rowtype;
  v_next_code int;
  v_code text;
  v_attempt int := 0;
  v_max_attempts constant int := 20;
  v_new accounts%rowtype;
begin
  if not exists (select 1 from app_settings) then
    raise exception 'Selesaikan setup awal (/setup) dulu sebelum menambah akun manual';
  end if;

  if p_parent_id is not null then
    select * into v_parent from accounts where id = p_parent_id;
    if v_parent.id is null then
      raise exception 'Akun induk tidak ditemukan';
    end if;
    if v_parent.category <> p_category then
      raise exception 'Kategori akun anak (%) harus sama dengan akun induk (%)', p_category, v_parent.category;
    end if;
    if v_parent.code !~ '^[0-9]+$' then
      raise exception 'Kode akun induk bukan angka, gak bisa generate kode anak otomatis';
    end if;

    select coalesce(max(code::int), v_parent.code::int) into v_next_code
      from accounts where parent_id = p_parent_id and code ~ '^[0-9]+$';
    v_next_code := v_next_code + 10;
  else
    v_next_code := case p_category
      when 'asset' then 1000
      when 'liability' then 2000
      when 'equity' then 3000
      when 'revenue' then 4000
      when 'expense' then 5000
    end;

    select coalesce(max(code::int) + 100, v_next_code) into v_next_code
      from accounts where category = p_category and parent_id is null and code ~ '^[0-9]+$';
  end if;

  loop
    v_attempt := v_attempt + 1;
    v_code := v_next_code::text;
    begin
      insert into accounts (code, name, category, is_contra, parent_id, created_by)
        values (v_code, p_name, p_category, p_is_contra, p_parent_id, auth.jwt() ->> 'email')
        returning * into v_new;
      return v_new;
    exception when unique_violation then
      if v_attempt >= v_max_attempts then
        raise exception 'Gagal generate kode akun unik setelah % percobaan', v_attempt;
      end if;
      v_next_code := v_next_code + (case when p_parent_id is not null then 10 else 100 end);
    end;
  end loop;
end;
$$;

grant execute on function create_account(text, account_category, uuid, boolean) to authenticated;

-- accounts_insert diperketat sampai app_settings ada -- guard di create_account doang gak
-- cukup, insert langsung ke accounts lewat PostgREST/supabase-js masih bisa "mencuri" kode
-- dasar sebelum /setup selesai kalau gak ditutup di level RLS juga (AGENTS.md > Conventions:
-- "Role check: RLS policy di tiap tabel, jangan andalkan app-level check doang").
-- complete_onboarding aman dari policy ini karena security definer -- bypass RLS total,
-- insert COA template-nya (step 1) gak pernah lewat policy accounts_insert.
alter policy accounts_insert on accounts with check (
  exists (select 1 from app_user_roles ur
          where ur.user_id = auth.uid() and ur.role_name = 'admin')
  and exists (select 1 from app_settings)
);

-- bootstrap_default_accounts -- LANGKAH 1 setup awal: terapkan template COA + Daftar Jenis
-- Dokumen + Default Akun sekaligus, 1 tombol, gak ada input sama sekali (lihat
-- docs/domain/chart-of-accounts.md submodule "Onboarding / Setup Awal" -- kode akun/daftar
-- jenis dokumen bukan keputusan user). Idempotent (aman dipanggil ulang/parsial) --
-- BEDA dari complete_onboarding di bawah, gak ada guard "cuma sekali", karena semuanya
-- di-upsert by natural key (code/doc_type/role_key), bukan singleton. Dipanggil terpisah
-- dari complete_onboarding (bukan digabung 1 RPC) supaya UI /setup bisa nampilin tabel
-- hasilnya (role -> akun ter-resolve) sebagai konfirmasi visual SEBELUM user isi identitas
-- usaha, mirip tampilan halaman Pengaturan > Default Akun. security definer karena
-- app_default_account_settings/document_number_types gak punya policy INSERT untuk
-- authenticated (dulu cuma pernah diisi migration).
create or replace function bootstrap_default_accounts() returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_default_account_settings_count int;
begin
  if not exists (
    select 1 from app_user_roles ur
    where ur.user_id = auth.uid() and ur.role_name = 'admin'
  ) then
    raise exception 'Cuma admin yang boleh menjalankan setup awal';
  end if;

  -- 1) Template COA -- persis daftar seed 0002_coa_schema.sql, idempotent by code.
  insert into accounts (code, name, category, is_contra) values
    ('1000', 'Kas', 'asset', false),
    ('1300', 'Piutang Usaha', 'asset', false),
    ('1350', 'Piutang Retur Supplier', 'asset', false),
    ('1360', 'Uang Muka Pembelian', 'asset', false),
    ('1400', 'Persediaan Bahan Baku', 'asset', false),
    ('1420', 'Persediaan Barang Jadi', 'asset', false),
    ('1500', 'PPN Masukan', 'asset', false),
    ('2100', 'Utang Usaha', 'liability', false),
    ('2200', 'Utang Bank', 'liability', false),
    ('2300', 'Uang Muka Penjualan', 'liability', false),
    ('2400', 'PPN Keluaran', 'liability', false),
    ('2500', 'Saldo Kredit Retur Customer', 'liability', false),
    ('3100', 'Modal Pemilik', 'equity', false),
    ('3200', 'Laba Ditahan', 'equity', false),
    ('4100', 'Pendapatan Penjualan Toko', 'revenue', false),
    ('4200', 'Pendapatan Penjualan Grosir', 'revenue', false),
    ('4300', 'Pendapatan Lain-lain', 'revenue', false),
    ('4400', 'Pendapatan Selisih Persediaan', 'revenue', false),
    ('4900', 'Retur & Potongan Penjualan', 'revenue', true),
    ('5100', 'Harga Pokok Penjualan', 'expense', false),
    ('5200', 'Beban Gaji Karyawan', 'expense', false),
    ('5300', 'Beban Sewa Toko', 'expense', false),
    ('5400', 'Beban Listrik dan Air', 'expense', false),
    ('5500', 'Beban Bunga Bank', 'expense', false),
    ('5700', 'Beban Piutang Tak Tertagih', 'expense', false),
    ('5800', 'Beban Kerugian Uang Muka', 'expense', false),
    ('5900', 'Beban Kerugian Barang Rusak', 'expense', false),
    ('6000', 'Beban Selisih Persediaan', 'expense', false),
    ('6100', 'Beban Biaya Pembelian', 'expense', false)
  on conflict (code) do nothing;

  -- Sengaja TIDAK termasuk akun Aset Tetap (dulu 1600/1610/1620/1630/1640/5600/5610/6200)
  -- -- modul Fixed Assets sudah dicabut total dari roadmap (keputusan owner 2026-09-15,
  -- lihat AGENTS.md), dan 2 dari akun itu ("Rak Display Toko"/"Mobil Pickup Antar Barang")
  -- malah bukan nama generik sama sekali -- nama aset fisik spesifik 1 bisnis tertentu,
  -- gak pantas jadi bagian template yang dipakai bisnis lain. Kalau bisnis butuh akun aset
  -- tetap, tambah manual lewat /accounts/new (kode auto-generate) + preset jurnal manual
  -- (docs/domain/general-ledger.md submodule "Preset Jurnal").
  insert into accounts (code, name, category, is_contra, parent_id)
    select v.code, v.name, v.category, v.is_contra, p.id
    from (values
      ('1100', 'Kas Toko', 'asset'::account_category, false, '1000'),
      ('1200', 'Kas di Bank', 'asset'::account_category, false, '1000')
    ) as v(code, name, category, is_contra, parent_code)
    join accounts p on p.code = v.parent_code
  on conflict (code) do nothing;

  -- 2) Daftar Jenis Dokumen -- normalnya udah keisi dari seed 0007_document_numbering_schema.sql
  -- (reference data, tetap di-seed migration -- beda dari accounts/app_default_account_settings/
  -- app_settings). Insert di sini idempotent (on conflict do nothing) -- cuma jaring pengaman
  -- kalau baris-barisnya ikut ditruncate pas seluruh data dihapus.
  insert into document_number_types (doc_type, prefix, label) values
    ('ap_bills', 'APB', 'AP Bill'),
    ('ap_payments', 'APP', 'AP Payment'),
    ('ap_credit_notes', 'APC', 'Retur AP — Kurangi Utang'),
    ('purchase_replacements', 'APX', 'Retur AP — Tukar Barang'),
    ('purchase_writeoffs', 'APW', 'Retur AP — Tulis-jadi-Beban'),
    ('ap_return_credit_refunds', 'APF', 'Refund Piutang Retur Supplier'),
    ('ap_deposits', 'APD', 'AP Deposit (DP ke Supplier)'),
    ('ap_deposit_applications', 'ADA', 'Penerapan DP AP'),
    ('ap_deposit_refunds', 'ADR', 'Refund DP AP'),
    ('ap_deposit_forfeitures', 'ADF', 'DP AP Hangus'),
    ('ar_invoices', 'ARI', 'AR Invoice'),
    ('ar_payments', 'ARP', 'AR Payment'),
    ('ar_credit_notes', 'ARC', 'Retur AR'),
    ('ar_return_credit_refunds', 'ARF', 'Refund Saldo Kredit Retur AR'),
    ('warranty_replacements', 'AWR', 'Ganti Barang Garansi AR'),
    ('ar_deposits', 'ARD', 'AR Deposit (DP dari Customer)'),
    ('ar_deposit_applications', 'RDA', 'Penerapan DP AR'),
    ('ar_deposit_refunds', 'RDR', 'Refund DP AR'),
    ('ar_deposit_forfeitures', 'RDF', 'DP AR Hangus'),
    ('ar_bad_debt_writeoffs', 'ARW', 'Write-off Piutang Tak Tertagih'),
    ('purchase_orders', 'PO', 'Purchase Order'),
    ('sales_orders', 'SO', 'Sales Order'),
    ('goods_issues', 'GI', 'Goods Issue'),
    ('production_orders', 'PRD', 'Production Order'),
    ('stock_opnames', 'SOP', 'Stock Opname'),
    ('pos_sales', 'POS', 'POS Sale'),
    ('journal_entries', 'JE', 'Journal Entry (manual)'),
    ('period_closings', 'CLS', 'Tutup Buku'),
    ('item_unit_barcodes', 'SKU', 'Kode Scan Barang (item_units.barcode)')
  on conflict (doc_type) do nothing;

  -- 3) Default Akun -- persis seed 0008 (minus fixed_asset_account_presets, sudah dicabut
  -- 0030), idempotent by role_key. account_id di-resolve dari template yang baru diinsert
  -- di atas (atau yang sudah ada, kalau tabel accounts sebagian sudah keisi).
  -- Resolve by (code, name, category) sekaligus -- bukan cuma code -- biar kalau ternyata
  -- kode template kebetulan sudah dipakai akun LAIN yang gak terkait (nama/kategori beda),
  -- select-nya return 0 baris (assertion di bawah nangkep) daripada diam-diam nempel ke
  -- akun yang salah.
  insert into app_default_account_settings (role_key, label, account_id)
    select 'ar.receivable', 'Piutang Usaha', id from accounts where code = '1300' and name = 'Piutang Usaha' and category = 'asset'::account_category
  union all
    select 'ar.revenue', 'Pendapatan Penjualan Grosir', id from accounts where code = '4200' and name = 'Pendapatan Penjualan Grosir' and category = 'revenue'::account_category
  union all
    select 'ar.contra_revenue', 'Retur & Potongan Penjualan', id from accounts where code = '4900' and name = 'Retur & Potongan Penjualan' and category = 'revenue'::account_category
  union all
    select 'ar.deposit_liability', 'Uang Muka Penjualan', id from accounts where code = '2300' and name = 'Uang Muka Penjualan' and category = 'liability'::account_category
  union all
    select 'ar.writeoff_expense', 'Beban Piutang Tak Tertagih', id from accounts where code = '5700' and name = 'Beban Piutang Tak Tertagih' and category = 'expense'::account_category
  union all
    select 'ar.return_credit_liability', 'Saldo Kredit Retur Customer', id from accounts where code = '2500' and name = 'Saldo Kredit Retur Customer' and category = 'liability'::account_category
  union all
    select 'ar.other_revenue', 'Pendapatan Lain-lain', id from accounts where code = '4300' and name = 'Pendapatan Lain-lain' and category = 'revenue'::account_category
  union all
    select 'ap.payable', 'Utang Usaha', id from accounts where code = '2100' and name = 'Utang Usaha' and category = 'liability'::account_category
  union all
    select 'ap.return_credit_asset', 'Piutang Retur Supplier', id from accounts where code = '1350' and name = 'Piutang Retur Supplier' and category = 'asset'::account_category
  union all
    select 'ap.deposit_asset', 'Uang Muka Pembelian', id from accounts where code = '1360' and name = 'Uang Muka Pembelian' and category = 'asset'::account_category
  union all
    select 'ap.deposit_loss_expense', 'Beban Kerugian Uang Muka', id from accounts where code = '5800' and name = 'Beban Kerugian Uang Muka' and category = 'expense'::account_category
  union all
    select 'inventory.raw_material', 'Persediaan Bahan Baku', id from accounts where code = '1400' and name = 'Persediaan Bahan Baku' and category = 'asset'::account_category
  union all
    select 'inventory.finished_good', 'Persediaan Barang Jadi', id from accounts where code = '1420' and name = 'Persediaan Barang Jadi' and category = 'asset'::account_category
  union all
    select 'inventory.hpp', 'Harga Pokok Penjualan', id from accounts where code = '5100' and name = 'Harga Pokok Penjualan' and category = 'expense'::account_category
  union all
    select 'inventory.damage_loss_expense', 'Beban Kerugian Barang Rusak', id from accounts where code = '5900' and name = 'Beban Kerugian Barang Rusak' and category = 'expense'::account_category
  union all
    select 'inventory.shortage_expense', 'Beban Selisih Persediaan', id from accounts where code = '6000' and name = 'Beban Selisih Persediaan' and category = 'expense'::account_category
  union all
    select 'inventory.surplus_revenue', 'Pendapatan Selisih Persediaan', id from accounts where code = '4400' and name = 'Pendapatan Selisih Persediaan' and category = 'revenue'::account_category
  union all
    select 'cash.tunai', 'Kas Toko', id from accounts where code = '1100' and name = 'Kas Toko' and category = 'asset'::account_category
  union all
    select 'cash.bank', 'Kas di Bank', id from accounts where code = '1200' and name = 'Kas di Bank' and category = 'asset'::account_category
  on conflict (role_key) do nothing;

  -- Fail loud kalau ada role_key yang gagal ke-resolve (mis. kode template kebetulan sudah
  -- dipakai akun lain gak terkait) -- daripada diam-diam hilang dan baru meledak belakangan
  -- pas RPC lain (create_pos_sale, dst) butuh role_key ini di runtime.
  select count(*) into v_default_account_settings_count
    from app_default_account_settings
    where role_key in (
      'ar.receivable', 'ar.revenue', 'ar.contra_revenue', 'ar.deposit_liability',
      'ar.writeoff_expense', 'ar.return_credit_liability', 'ar.other_revenue',
      'ap.payable', 'ap.return_credit_asset', 'ap.deposit_asset', 'ap.deposit_loss_expense',
      'inventory.raw_material', 'inventory.finished_good', 'inventory.hpp',
      'inventory.damage_loss_expense', 'inventory.shortage_expense', 'inventory.surplus_revenue',
      'cash.tunai', 'cash.bank'
    );
  if v_default_account_settings_count <> 19 then
    raise exception 'Bootstrap Default Akun gak lengkap (% dari 19 role_key ke-resolve) -- kemungkinan kode akun template sudah dipakai akun lain', v_default_account_settings_count;
  end if;
end;
$$;

grant execute on function bootstrap_default_accounts() to authenticated;

-- complete_onboarding -- LANGKAH 2 setup awal: identitas usaha + status pajak (satu-satunya
-- bagian yang genuinely input manual -- lihat submodule "Onboarding / Setup Awal") + bikin
-- Pelanggan Umum + isi app_settings. Mensyaratkan bootstrap_default_accounts sudah pernah
-- jalan (COA template harus ada duluan, biar akun PPN Keluaran/Masukan bisa di-resolve).
-- app_settings sendiri tetap satu-satunya langkah NON-idempotent (guard "cuma sekali" di
-- bawah) -- beda dari bootstrap_default_accounts yang aman dipanggil ulang. security
-- definer karena app_settings gak punya policy INSERT untuk authenticated.
create or replace function complete_onboarding(
  p_company_name text,
  p_company_address text default null,
  p_npwp text default null,
  p_logo_url text default null,
  p_ppn_active boolean default false,
  p_ppn_rate numeric default 11
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_walk_in_id uuid;
  v_ppn_keluaran_id uuid;
  v_ppn_masukan_id uuid;
begin
  if not exists (
    select 1 from app_user_roles ur
    where ur.user_id = auth.uid() and ur.role_name = 'admin'
  ) then
    raise exception 'Cuma admin yang boleh menjalankan setup awal';
  end if;

  if exists (select 1 from app_settings) then
    raise exception 'Aplikasi sudah pernah di-setup -- ubah konfigurasi lewat halaman Pengaturan, bukan setup ulang';
  end if;

  if not exists (select 1 from accounts) or not exists (select 1 from app_default_account_settings) then
    raise exception 'Jalankan langkah 1 (Terapkan Akun Bawaan) dulu sebelum lanjut';
  end if;

  -- Pelanggan Umum -- reuse kalau sudah ada (mis. bekas jalur POS lama), bikin baru kalau
  -- belum, biar RPC ini aman dipanggil di tengah kondisi data campuran. Role 'customer'
  -- WAJIB ikut diinsert (bukan cuma baris counterparties-nya) -- tanpa ini, transaksi
  -- OUTBOUND pertama gagal kena trigger transactions_counterparty_role_guard_outbound
  -- (0015_transactions_schema.sql) begitu POS checkout dipakai. Pola sama seed asli
  -- 0024_pos_schema.sql.
  select id into v_walk_in_id from counterparties where name = 'Pelanggan Umum' limit 1;
  if v_walk_in_id is null then
    insert into counterparties (name, payment_term_days)
      values ('Pelanggan Umum', 1)
      returning id into v_walk_in_id;
    insert into counterparty_type_mapping (counterparty_id, role) values (v_walk_in_id, 'customer');
  elsif not exists (
    select 1 from counterparty_type_mapping where counterparty_id = v_walk_in_id and role = 'customer'
  ) then
    insert into counterparty_type_mapping (counterparty_id, role) values (v_walk_in_id, 'customer');
  end if;

  -- app_settings -- satu-satunya langkah non-idempotent, sudah dijaga guard di awal.
  if p_ppn_active then
    select id into v_ppn_keluaran_id from accounts where code = '2400';
    select id into v_ppn_masukan_id from accounts where code = '1500';
  end if;

  insert into app_settings (
    id, name, address, npwp, logo_url,
    is_active, ppn_rate, ppn_keluaran_account_id, ppn_masukan_account_id,
    walk_in_customer_id, updated_by
  ) values (
    true, p_company_name, p_company_address, p_npwp, p_logo_url,
    p_ppn_active, p_ppn_rate, v_ppn_keluaran_id, v_ppn_masukan_id,
    v_walk_in_id, auth.uid()
  );
end;
$$;

grant execute on function complete_onboarding(text, text, text, text, boolean, numeric) to authenticated;
