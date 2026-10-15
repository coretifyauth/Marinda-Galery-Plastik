-- 0054_payment_rounding.sql
-- Selisih Pembulatan Pelunasan (AR/AP) + Kembalian & Selisih Pembulatan Kasir (POS).
-- Konsep: docs/domain/accounts-payable.md submodule "Selisih Pembulatan Pelunasan" (AR mirror
-- di accounts-receivable.md), docs/domain/pos.md submodule "Kembalian & Selisih Pembulatan
-- Kasir". Struktur data: docs/architecture/payments-schema.md, app-settings-schema.md,
-- pos-schema.md, default-account-settings-schema.md.
--
-- Prinsip: payments.amount TETAP berarti "nilai yang melunasi transaksi" (semantik lama, jadi
-- ar_invoice_remaining/ap_bill_remaining/recompute_transaction_status/void_pos_transaction/
-- cancel_* gak disentuh sama sekali). Uang riil yang pindah = amount -/+ rounding_amount, dan
-- selisihnya dijurnal di JURNAL YANG SAMA dengan pembayaran (ikut terbalik kalau dibalik).
-- Metode bayar (TUNAI/BANK) jadi fakta yang disimpan di payments -- akun kas diturunkan dari
-- metode lewat Default Akun (cash.tunai/cash.bank), akun gak pernah dipakai menebak metode.
--
-- Isi:
--   1. app_settings.rounding_unit_cash / rounding_unit_bank -- satuan pembulatan per metode.
--   2. payments.payment_method / rounding_amount / cash_tendered / change_given + backfill
--      payment_method baris lama (sekali jalan, dari akun kas di jurnalnya).
--   3. Akun COA 4500/6300 + role Default Akun rounding.revenue/rounding.expense -- template
--      onboarding (bootstrap_default_accounts) diperluas; DB yang SUDAH di-setup diisi di sini.
--   4. payment_rounding_unit(), _post_payment() (inti insert+jurnal), record_payment (signature
--      baru: p_payment_method gantiin p_cash_account_id), create_pos_sale (3 param trailing baru).
--   5. pos_sales_with_status -- baris kas dipilih eksplisit (jurnal pelunasan bisa punya 2 baris
--      debit sekarang: Kas + Beban Selisih Pembulatan) + kolom pembayaran baru.

-- 1. app_settings ------------------------------------------------------------------------------

alter table app_settings
  add column rounding_unit_cash numeric(14,2) not null default 100 check (rounding_unit_cash > 0),
  add column rounding_unit_bank numeric(14,2) not null default 1 check (rounding_unit_bank > 0);

comment on column app_settings.rounding_unit_cash is 'Satuan pembulatan pembayaran TUNAI (default Rp100 -- pecahan di bawahnya praktis gak beredar). Pelunasan AR/AP dianggap lunas kalau nominal = sisa dibulatkan ke bawah/atas ke kelipatan ini; di kasir jadi batas maksimal toko nombok.';
comment on column app_settings.rounding_unit_bank is 'Satuan pembulatan pembayaran BANK/transfer/QRIS (default Rp1 -- transfer gak bisa kirim sen).';

-- 2. payments ----------------------------------------------------------------------------------

alter table payments
  add column payment_method text check (payment_method in ('TUNAI', 'BANK')),
  add column rounding_amount numeric(14,2) not null default 0,
  add column cash_tendered numeric(14,2),
  add column change_given numeric(14,2),
  add constraint payments_rounding_needs_method check (rounding_amount = 0 or payment_method is not null),
  add constraint payments_cash_change_pair check ((cash_tendered is null) = (change_given is null)),
  add constraint payments_cash_change_valid check (
    cash_tendered is null
    or (payment_method is not distinct from 'TUNAI' and change_given >= 0 and change_given <= cash_tendered)
  );

comment on column payments.amount is 'Nilai yang MELUNASI transaksi (dikurangkan dari sisa tagihan). Uang riil yang pindah = amount + rounding_amount (OUTBOUND/AR) atau amount - rounding_amount (INBOUND/AP).';
comment on column payments.payment_method is 'TUNAI/BANK -- fakta cara uang berpindah, dipilih saat mencatat. Sumber satuan pembulatan & akun kas (lewat Default Akun cash.tunai/cash.bank). NULL hanya untuk baris lama yang akun kasnya gak bisa dipetakan.';
comment on column payments.rounding_amount is 'Selisih pembulatan dari sudut pandang perusahaan: + = Pendapatan Selisih Pembulatan, - = Beban Selisih Pembulatan. 0 = gak ada pembulatan.';
comment on column payments.cash_tendered is 'Kasir POS, metode TUNAI: uang yang diserahkan pelanggan. NULL di luar kasir.';
comment on column payments.change_given is 'Kasir POS, metode TUNAI: kembalian yang benar-benar diserahkan kasir. NULL di luar kasir.';

-- Backfill payment_method baris lama -- SEKALI JALAN, dari akun kas di jurnal pembayarannya
-- (record_payment lama selalu nulis persis 1 baris akun kas). Ini satu-satunya tempat akun
-- dipakai buat menurunkan metode bayar, dan cuma untuk data historis yang memang gak pernah
-- menyimpan metodenya; akun yang dipetakan ke KEDUA role (ambigu) dibiarkan NULL.
-- payments immutable (block_edit_delete) -- trigger dimatikan sementara khusus backfill ini.
alter table payments disable trigger payments_block_edit_delete;

update payments p
set payment_method = case d.role_key when 'cash.tunai' then 'TUNAI' else 'BANK' end
from journal_lines jl
join app_default_account_settings d
  on d.account_id = jl.account_id and d.role_key in ('cash.tunai', 'cash.bank')
where jl.journal_entry_id = p.journal_entry_id
  and (
    select count(*) from app_default_account_settings d2
    where d2.account_id = jl.account_id and d2.role_key in ('cash.tunai', 'cash.bank')
  ) = 1;

alter table payments enable trigger payments_block_edit_delete;

-- 3. Akun & Default Akun selisih pembulatan ----------------------------------------------------

-- DB yang SUDAH lewat onboarding (app_settings ada) gak akan pernah menjalankan
-- bootstrap_default_accounts lagi, jadi 2 akun + 2 role baru diisi di sini dengan statement
-- yang sama persis dengan template di bawah (idempotent, resolve by code+name+category).
-- DB yang belum di-setup dilewati -- template onboarding yang mengisinya. Gagal keras kalau
-- kode 4500/6300 ternyata sudah dipakai akun lain (daripada diam-diam salah petakan).
do $$
declare
  v_count int;
begin
  if not exists (select 1 from app_settings) then
    return;
  end if;

  insert into accounts (code, name, category, is_contra) values
    ('4500', 'Pendapatan Selisih Pembulatan', 'revenue', false),
    ('6300', 'Beban Selisih Pembulatan', 'expense', false)
  on conflict (code) do nothing;

  insert into app_default_account_settings (role_key, label, account_id)
    select 'rounding.revenue', 'Pendapatan Selisih Pembulatan', id from accounts where code = '4500' and name = 'Pendapatan Selisih Pembulatan' and category = 'revenue'::account_category
  union all
    select 'rounding.expense', 'Beban Selisih Pembulatan', id from accounts where code = '6300' and name = 'Beban Selisih Pembulatan' and category = 'expense'::account_category
  on conflict (role_key) do nothing;

  select count(*) into v_count
    from app_default_account_settings where role_key in ('rounding.revenue', 'rounding.expense');
  if v_count <> 2 then
    raise exception 'Default Akun selisih pembulatan gagal di-resolve (% dari 2) -- kode akun 4500/6300 kemungkinan sudah dipakai akun lain', v_count;
  end if;
end;
$$;

-- bootstrap_default_accounts -- template onboarding diperluas 2 akun (4500 Pendapatan Selisih
-- Pembulatan, 6300 Beban Selisih Pembulatan -- 6200 sengaja dilewati, bekas akun Aset Tetap yang
-- sudah dicabut) + 2 role Default Akun (rounding.revenue/rounding.expense), 19 -> 21 role_key.
-- Sisanya identik 0033_onboarding_bootstrap.sql.
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
    ('4500', 'Pendapatan Selisih Pembulatan', 'revenue', false),
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
    ('6100', 'Beban Biaya Pembelian', 'expense', false),
    ('6300', 'Beban Selisih Pembulatan', 'expense', false)
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
  union all
    select 'rounding.revenue', 'Pendapatan Selisih Pembulatan', id from accounts where code = '4500' and name = 'Pendapatan Selisih Pembulatan' and category = 'revenue'::account_category
  union all
    select 'rounding.expense', 'Beban Selisih Pembulatan', id from accounts where code = '6300' and name = 'Beban Selisih Pembulatan' and category = 'expense'::account_category
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
      'cash.tunai', 'cash.bank', 'rounding.revenue', 'rounding.expense'
    );
  if v_default_account_settings_count <> 21 then
    raise exception 'Bootstrap Default Akun gak lengkap (% dari 21 role_key ke-resolve) -- kemungkinan kode akun template sudah dipakai akun lain', v_default_account_settings_count;
  end if;
end;
$$;

grant execute on function bootstrap_default_accounts() to authenticated;

-- 4. Fungsi pembayaran -------------------------------------------------------------------------

-- payment_rounding_unit -- satuan pembulatan sesuai metode bayar (app_settings). NULL kalau
-- metode gak valid atau aplikasi belum di-setup -- pemanggil wajib nolak.
create function payment_rounding_unit(p_payment_method text) returns numeric
language sql
stable
as $$
  select case p_payment_method
           when 'TUNAI' then rounding_unit_cash
           when 'BANK' then rounding_unit_bank
         end
  from app_settings where id = true;
$$;

-- _post_payment -- INTI pencatatan pembayaran (insert payments + 1 jurnal, termasuk baris
-- selisih pembulatan), dipakai bareng record_payment (aturan "sisa dibulatkan ke bawah/atas")
-- dan create_pos_sale (aturan kasir: uang diterima - kembalian). Aturan KAPAN pembulatan sah
-- ada di pemanggil; di sini cuma pagar yang berlaku untuk semua jalur:
--   - applied (payments.amount) > 0 dan gak melebihi sisa tagihan (overpay tetap ditolak);
--   - rugi pembulatan (beban) selalu < satuan metode bayar;
--   - untung pembulatan (pendapatan) < satuan, KECUALI jalur kasir tunai (cash_tendered diisi)
--     yang memang boleh berapa pun (kembalian gak diambil pelanggan -- keputusan owner).
-- p_payment_method NULL cuma untuk row outbox offline POS lama (sebelum 0054): akun kas dari
-- p_cash_account_id apa adanya, wajib tanpa selisih (perilaku persis sebelum fitur ini).
-- security invoker -- pagar RLS payments_insert (admin) tetap berlaku untuk pemanggilan
-- langsung; create_pos_sale (security definer) memanggilnya sebagai owner.
create function _post_payment(
  p_type text,
  p_counterparty_id uuid,
  p_payment_date date,
  p_source_ref text,
  p_control_account_id uuid,
  p_transaction_id uuid,
  p_payment_method text,
  p_cash_account_id uuid,
  p_applied_amount numeric,
  p_cash_amount numeric,
  p_cash_tendered numeric default null,
  p_change_given numeric default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_remaining numeric;
  v_method text := p_payment_method;
  v_unit numeric;
  v_cash_account_id uuid;
  v_gain numeric;
  v_rounding_account_id uuid;
  v_lines jsonb := '[]'::jsonb;
  v_entry_id uuid;
  v_payment_id uuid;
begin
  if p_type not in ('INBOUND', 'OUTBOUND') then
    raise exception 'p_type harus INBOUND atau OUTBOUND, dapat %', p_type;
  end if;
  if p_applied_amount is null or p_applied_amount <= 0 then
    raise exception 'Nilai pelunasan harus lebih dari 0';
  end if;
  if p_cash_amount is null or p_cash_amount < 0 then
    raise exception 'Uang yang dibayar gak boleh negatif';
  end if;

  if p_type = 'OUTBOUND' then
    v_remaining := ar_invoice_remaining(p_transaction_id);
  else
    v_remaining := ap_bill_remaining(p_transaction_id);
  end if;
  if p_applied_amount > v_remaining then
    raise exception 'Pembayaran % melebihi sisa outstanding (sisa %)', p_applied_amount, v_remaining;
  end if;

  -- untung (+) / rugi (-) dari sudut pandang perusahaan
  v_gain := case when p_type = 'OUTBOUND' then p_cash_amount - p_applied_amount
                 else p_applied_amount - p_cash_amount end;

  if v_method is null then
    if p_cash_account_id is null then
      raise exception 'Metode bayar wajib diisi (TUNAI atau BANK)';
    end if;
    if v_gain <> 0 then
      raise exception 'Pembayaran tanpa metode bayar gak boleh punya selisih pembulatan';
    end if;
    v_cash_account_id := p_cash_account_id;
    -- simpan metode kalau akun ini jelas milik tepat 1 role kas (pola sama backfill 0054)
    select case max(role_key) when 'cash.tunai' then 'TUNAI' when 'cash.bank' then 'BANK' end
      into v_method
      from app_default_account_settings
      where account_id = p_cash_account_id and role_key in ('cash.tunai', 'cash.bank')
      having count(*) = 1;
  else
    if v_method not in ('TUNAI', 'BANK') then
      raise exception 'Metode bayar harus TUNAI atau BANK, dapat %', v_method;
    end if;
    select account_id into v_cash_account_id
      from app_default_account_settings
      where role_key = case v_method when 'TUNAI' then 'cash.tunai' else 'cash.bank' end;
    if v_cash_account_id is null then
      raise exception 'Default Akun % belum diset -- hubungi admin',
        case v_method when 'TUNAI' then 'cash.tunai' else 'cash.bank' end;
    end if;

    v_unit := payment_rounding_unit(v_method);
    if v_unit is null then
      raise exception 'Satuan pembulatan belum diset di app_settings -- hubungi admin';
    end if;
    if v_gain < 0 and -v_gain >= v_unit then
      raise exception 'Selisih kurang bayar % melebihi batas pembulatan % (metode %)', -v_gain, v_unit, v_method;
    end if;
    if v_gain > 0 and p_cash_tendered is null and v_gain >= v_unit then
      raise exception 'Selisih lebih bayar % melebihi batas pembulatan % (metode %)', v_gain, v_unit, v_method;
    end if;
  end if;

  if p_cash_tendered is not null and v_method is distinct from 'TUNAI' then
    raise exception 'Uang diterima & kembalian cuma berlaku untuk metode TUNAI';
  end if;

  if v_gain <> 0 then
    select account_id into v_rounding_account_id
      from app_default_account_settings
      where role_key = case when v_gain > 0 then 'rounding.revenue' else 'rounding.expense' end;
    if v_rounding_account_id is null then
      raise exception 'Default Akun % belum diset -- hubungi admin',
        case when v_gain > 0 then 'rounding.revenue' else 'rounding.expense' end;
    end if;
  end if;

  -- Jurnal: sisi kontrol selalu sebesar nilai pelunasan; sisi kas sebesar uang riil (dilewati
  -- kalau Rp0 -- pelunasan sisa receh tanpa uang); selisihnya ke akun pembulatan.
  if p_type = 'OUTBOUND' then
    if p_cash_amount > 0 then
      v_lines := v_lines || jsonb_build_array(
        jsonb_build_object('account_id', v_cash_account_id, 'debit', p_cash_amount, 'credit', 0));
    end if;
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account_id', p_control_account_id, 'debit', 0, 'credit', p_applied_amount));
  else
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account_id', p_control_account_id, 'debit', p_applied_amount, 'credit', 0));
    if p_cash_amount > 0 then
      v_lines := v_lines || jsonb_build_array(
        jsonb_build_object('account_id', v_cash_account_id, 'debit', 0, 'credit', p_cash_amount));
    end if;
  end if;

  if v_gain > 0 then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_rounding_account_id, 'debit', 0, 'credit', v_gain));
  elsif v_gain < 0 then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_rounding_account_id, 'debit', -v_gain, 'credit', 0));
  end if;

  v_entry_id := create_journal_entry(p_payment_date, 'Pembayaran', p_source_ref, v_lines);

  insert into payments (
    type, counterparty_id, transaction_id, payment_date, amount, source_ref, journal_entry_id, created_by,
    payment_method, rounding_amount, cash_tendered, change_given
  )
  values (
    p_type, p_counterparty_id, p_transaction_id, p_payment_date, p_applied_amount, p_source_ref, v_entry_id, auth.uid(),
    v_method, v_gain, p_cash_tendered, p_change_given
  )
  returning id into v_payment_id;

  return v_payment_id;
end;
$$;

-- record_payment -- signature baru: p_payment_method (TUNAI/BANK) gantiin p_cash_account_id
-- (akun kas sekarang diturunkan server dari metode lewat Default Akun). p_amount = UANG RIIL
-- yang pindah (sesuai mutasi bank/kuitansi). Aturan:
--   - p_amount = sisa tagihan                       -> pelunasan biasa
--   - p_amount = sisa dibulatkan ke bawah/atas ke   -> LUNAS, selisih dijurnal ke akun
--     kelipatan satuan metode bayar                    pembulatan (termasuk Rp0 kalau sisa
--                                                      tinggal receh di bawah satuan)
--   - p_amount < sisa (selain di atas)              -> cicilan biasa
--   - p_amount > sisa (selain di atas)              -> ditolak (overpay)
drop function if exists record_payment(text, uuid, date, numeric, text, uuid, uuid, uuid);

create function record_payment(
  p_type text,
  p_counterparty_id uuid,
  p_payment_date date,
  p_amount numeric,
  p_source_ref text,
  p_payment_method text,
  p_control_account_id uuid,
  p_transaction_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_remaining numeric;
  v_unit numeric;
  v_floor numeric;
  v_ceil numeric;
  v_applied numeric;
begin
  if p_type not in ('INBOUND', 'OUTBOUND') then
    raise exception 'p_type harus INBOUND atau OUTBOUND, dapat %', p_type;
  end if;
  if p_payment_method is null or p_payment_method not in ('TUNAI', 'BANK') then
    raise exception 'Metode bayar wajib TUNAI atau BANK';
  end if;
  if p_amount is null or p_amount < 0 then
    raise exception 'Jumlah dibayar gak boleh negatif';
  end if;

  if p_type = 'OUTBOUND' then
    v_remaining := ar_invoice_remaining(p_transaction_id);
  else
    v_remaining := ap_bill_remaining(p_transaction_id);
  end if;
  if v_remaining is null or v_remaining <= 0 then
    raise exception 'Transaksi ini sudah gak punya sisa tagihan';
  end if;

  v_unit := payment_rounding_unit(p_payment_method);
  if v_unit is null then
    raise exception 'Satuan pembulatan belum diset di app_settings -- hubungi admin';
  end if;
  v_floor := floor(v_remaining / v_unit) * v_unit;
  v_ceil := ceil(v_remaining / v_unit) * v_unit;

  if p_amount = v_remaining then
    v_applied := p_amount;
  elsif p_amount = v_floor or p_amount = v_ceil then
    v_applied := v_remaining;
  elsif p_amount > v_remaining then
    raise exception 'Pembayaran % melebihi sisa outstanding % (pelunasan dengan pembulatan hanya % atau %)',
      p_amount, v_remaining, v_floor, v_ceil;
  elsif p_amount = 0 then
    raise exception 'Jumlah dibayar harus lebih dari 0';
  else
    v_applied := p_amount;
  end if;

  return _post_payment(
    p_type, p_counterparty_id, p_payment_date, p_source_ref, p_control_account_id, p_transaction_id,
    p_payment_method, null, v_applied, p_amount
  );
end;
$$;

grant execute on function record_payment(text, uuid, date, numeric, text, text, uuid, uuid) to authenticated;

-- create_pos_sale -- 3 param trailing baru (default null, supaya row outbox offline lama tetap
-- bisa disinkronkan): p_payment_method, p_cash_tendered, p_change_given. Pelunasan sekarang
-- lewat _post_payment dengan aturan kasir:
--   - BANK : uang = total dibulatkan ke BAWAH ke satuan bank (menguntungkan pelanggan), selisih
--            jadi beban. Uang diterima/kembalian gak berlaku.
--   - TUNAI: uang = p_cash_tendered - p_change_given. Lebih berapa pun -> pendapatan (kembalian
--            gak diambil); kurang wajib < satuan tunai (di atas itu pakai diskon manual).
--   - NULL : row outbox lama -- perilaku persis sebelum 0054 (akun kas = p_cash_account_id,
--            lunas persis total, tanpa selisih).
-- Signature berubah -> drop dulu, create ulang, grant ulang.
drop function if exists create_pos_sale(date, text, uuid, uuid, uuid, uuid, uuid, jsonb, jsonb, boolean, numeric);

create function create_pos_sale(
  p_sale_date date,
  p_source_ref text,
  p_customer_id uuid,
  p_cash_account_id uuid,
  p_revenue_account_id uuid,
  p_hpp_account_id uuid,
  p_finished_good_account_id uuid,
  p_lines jsonb, -- array of {"item_id":uuid,"qty_sold":numeric,"unit_price":numeric}
  p_extra_credit_lines jsonb default '[]'::jsonb,
  p_apply_tax boolean default false,
  p_manual_discount numeric default 0, -- diskon manual kasir, 1 nominal Rupiah per transaksi, dibagi proporsional ke baris
  p_payment_method text default null, -- TUNAI/BANK; NULL = row outbox offline lama (sebelum 0054)
  p_cash_tendered numeric default null, -- TUNAI: uang diterima dari pelanggan
  p_change_given numeric default null -- TUNAI: kembalian yang benar-benar diserahkan
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer_id uuid;
  v_receivable_account_id uuid;
  v_line jsonb;
  v_qty numeric;
  v_unit_price numeric;
  v_gross_amount numeric;
  v_net_amount numeric;
  v_total_amount numeric := 0;
  v_total_discount numeric := 0;
  v_credit_lines jsonb;
  v_issue_lines jsonb := '[]'::jsonb;
  v_goods_issue_id uuid;
  v_transaction_id uuid;
  v_settle_amount numeric;
  v_unit numeric;
  v_cash numeric;
  v_bundle_results jsonb;
  v_item_totals jsonb := '{}'::jsonb;
  v_item_discount record;
  v_item_discount_amount numeric;
  v_item_discount_rule_id uuid;
  v_bundle_discount_amount numeric;
  v_bundle_promo_rule_id uuid;
  v_line_discount_amount numeric;
  v_line_nets numeric[] := '{}';
  v_manual numeric;
  v_alloc numeric[] := '{}';
  v_alloc_sum numeric := 0;
  v_share numeric;
  v_max_idx int := 1;
  i int := 0;
  k int;
begin
  if not exists (
    select 1 from app_user_roles ur
    where ur.user_id = auth.uid() and ur.role_name in ('admin', 'cashier')
  ) then
    raise exception 'Gak punya akses buat bikin POS Sale';
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'POS sale wajib punya minimal 1 baris item';
  end if;

  v_manual := coalesce(p_manual_discount, 0);
  if v_manual < 0 then
    raise exception 'Diskon manual gak boleh negatif';
  end if;
  -- Nominal diskon manual selalu Rupiah bulat -- pecahan ditolak (bukan dibulatkan diam-diam) biar
  -- bagian proporsional per baris gak pernah kena kasus sisa pembulatan negatif.
  if v_manual <> trunc(v_manual) then
    raise exception 'Diskon manual harus kelipatan Rp1 (diterima: %)', v_manual;
  end if;

  v_customer_id := p_customer_id;
  if v_customer_id is null then
    select walk_in_customer_id into v_customer_id from app_settings where id = true;
    if v_customer_id is null then
      raise exception 'app_settings.walk_in_customer_id belum diset -- hubungi admin';
    end if;
  end if;

  select account_id into v_receivable_account_id
    from app_default_account_settings where role_key = 'ar.receivable';
  if v_receivable_account_id is null then
    raise exception 'app_default_account_settings ar.receivable belum diset -- hubungi admin';
  end if;

  -- resolusi bundle promo butuh lihat SEMUA baris sekaligus (trigger qty lintas baris) --
  -- dihitung sekali di sini, hasilnya array sejajar p_lines.
  v_bundle_results := resolve_bundle_promo_discounts(p_lines);

  -- total qty (satuan dasar) per barang lintas semua baris -- basis cek syarat minimal diskon.
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_totals := jsonb_set(
      v_item_totals,
      array[v_line->>'item_id'],
      to_jsonb(coalesce((v_item_totals->>(v_line->>'item_id'))::numeric, 0) + (v_line->>'qty_sold')::numeric)
    );
  end loop;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    i := i + 1;
    v_qty := (v_line ->> 'qty_sold')::numeric;
    v_unit_price := (v_line ->> 'unit_price')::numeric;

    if v_qty <= 0 then
      raise exception 'qty_sold harus > 0';
    end if;
    if v_unit_price < 0 then
      raise exception 'unit_price gak boleh negatif';
    end if;

    v_gross_amount := v_qty * v_unit_price;

    -- diskon item/kategori -- resolve_item_discount return SETOF, ambil 0/1 baris. select * into
    -- record dari 0 baris bikin v_item_discount NULL keseluruhan (FOUND jadi false) -- makanya
    -- cek FOUND, bukan field-nya langsung.
    v_item_discount_rule_id := null;
    v_item_discount_amount := 0;
    select * into v_item_discount
      from resolve_item_discount(
        (v_line->>'item_id')::uuid, v_qty, v_gross_amount,
        (v_item_totals->>(v_line->>'item_id'))::numeric
      );
    if found then
      v_item_discount_rule_id := v_item_discount.discount_rule_id;
      v_item_discount_amount := v_item_discount.discount_amount;
    end if;

    -- diskon bundle promo -- hasil pre-computed di v_bundle_results, indeks sejajar p_lines
    v_bundle_promo_rule_id := (v_bundle_results->(i-1)->>'bundle_promo_rule_id')::uuid;
    v_bundle_discount_amount := coalesce((v_bundle_results->(i-1)->>'discount_amount')::numeric, 0);

    -- 2 mekanisme boleh nambah bareng di baris yang sama, dibatasi gak lebih dari gross baris ini
    v_line_discount_amount := least(v_item_discount_amount + v_bundle_discount_amount, v_gross_amount);
    v_net_amount := v_gross_amount - v_line_discount_amount;

    v_total_amount := v_total_amount + v_net_amount;
    v_total_discount := v_total_discount + v_line_discount_amount;
    v_line_nets := array_append(v_line_nets, v_net_amount);

    v_issue_lines := v_issue_lines || jsonb_build_array(
      jsonb_build_object(
        'item_id', v_line ->> 'item_id',
        'qty_issued', v_qty,
        'order_line_id', null,
        'unit_price', v_unit_price,
        'discount_rule_id', v_item_discount_rule_id,
        'discount_amount', v_line_discount_amount,
        'bundle_promo_rule_id', v_bundle_promo_rule_id,
        'manual_discount_amount', 0
      )
    );
  end loop;

  -- Diskon manual kasir -- ditumpuk DI ATAS diskon otomatis (basisnya total net setelah diskon
  -- otomatis). Pagar: harus < total net, karena transaction_lines.amount wajib > 0 (nilai
  -- transaksi gak boleh jadi Rp0/negatif) -- ini guard integritas data, bukan plafon bisnis.
  -- Dibagi proporsional ke nilai net tiap baris; sisa pembulatan (selisih v_manual vs jumlah
  -- bagian yang sudah dibulatkan) masuk ke baris net terbesar, jadi jumlah bagian PERSIS = v_manual.
  if v_manual > 0 then
    if v_manual >= v_total_amount then
      raise exception 'Diskon manual (%) harus lebih kecil dari total belanja setelah diskon otomatis (%)',
        v_manual, v_total_amount;
    end if;

    for k in 1..array_length(v_line_nets, 1) loop
      v_share := round(v_manual * v_line_nets[k] / v_total_amount, 2);
      v_alloc := array_append(v_alloc, v_share);
      v_alloc_sum := v_alloc_sum + v_share;
      if v_line_nets[k] > v_line_nets[v_max_idx] then
        v_max_idx := k;
      end if;
    end loop;
    v_alloc[v_max_idx] := v_alloc[v_max_idx] + (v_manual - v_alloc_sum);

    for k in 1..array_length(v_alloc, 1) loop
      if v_alloc[k] < 0 or v_alloc[k] > v_line_nets[k] then
        raise exception 'Alokasi diskon manual melebihi nilai baris ke-% -- kurangi diskon manual', k;
      end if;
      v_issue_lines := jsonb_set(v_issue_lines, array[(k - 1)::text, 'manual_discount_amount'], to_jsonb(v_alloc[k]));
    end loop;

    v_total_amount := v_total_amount - v_manual;
  end if;

  v_credit_lines := jsonb_build_array(
    jsonb_build_object('account_id', p_revenue_account_id, 'amount', v_total_amount)
  );

  if p_extra_credit_lines is not null and jsonb_array_length(p_extra_credit_lines) > 0 then
    for v_line in select * from jsonb_array_elements(p_extra_credit_lines)
    loop
      if (v_line ->> 'amount')::numeric <= 0 then
        raise exception 'Nominal baris biaya tambahan harus > 0';
      end if;
      v_credit_lines := v_credit_lines || jsonb_build_array(
        jsonb_build_object('account_id', v_line ->> 'account_id', 'amount', (v_line ->> 'amount')::numeric)
      );
    end loop;
  end if;

  v_goods_issue_id := create_goods_issue(
    v_customer_id, p_sale_date, 'Penjualan POS', p_source_ref,
    v_credit_lines, v_receivable_account_id,
    v_issue_lines, p_hpp_account_id, p_finished_good_account_id,
    p_apply_tax
  );

  select transaction_id into v_transaction_id from goods_notes where id = v_goods_issue_id;

  select amount into v_settle_amount from transactions where id = v_transaction_id;

  if p_payment_method is null then
    perform _post_payment(
      'OUTBOUND', v_customer_id, p_sale_date, p_source_ref, v_receivable_account_id, v_transaction_id,
      null, p_cash_account_id, v_settle_amount, v_settle_amount
    );
  elsif p_payment_method = 'BANK' then
    if p_cash_tendered is not null or p_change_given is not null then
      raise exception 'Uang diterima & kembalian cuma berlaku untuk metode TUNAI';
    end if;
    v_unit := payment_rounding_unit('BANK');
    if v_unit is null then
      raise exception 'Satuan pembulatan belum diset di app_settings -- hubungi admin';
    end if;
    v_cash := floor(v_settle_amount / v_unit) * v_unit;
    perform _post_payment(
      'OUTBOUND', v_customer_id, p_sale_date, p_source_ref, v_receivable_account_id, v_transaction_id,
      'BANK', null, v_settle_amount, v_cash
    );
  elsif p_payment_method = 'TUNAI' then
    if p_cash_tendered is null or p_change_given is null then
      raise exception 'Uang diterima & kembalian wajib diisi untuk pembayaran tunai';
    end if;
    if p_change_given < 0 or p_change_given > p_cash_tendered then
      raise exception 'Kembalian (%) harus antara 0 dan uang diterima (%)', p_change_given, p_cash_tendered;
    end if;
    v_unit := payment_rounding_unit('TUNAI');
    if v_unit is null then
      raise exception 'Satuan pembulatan belum diset di app_settings -- hubungi admin';
    end if;
    v_cash := p_cash_tendered - p_change_given;
    if v_settle_amount - v_cash >= v_unit then
      raise exception 'Uang kurang Rp% -- melebihi batas pembulatan Rp%, pakai Diskon Manual',
        v_settle_amount - v_cash, v_unit;
    end if;
    perform _post_payment(
      'OUTBOUND', v_customer_id, p_sale_date, p_source_ref, v_receivable_account_id, v_transaction_id,
      'TUNAI', null, v_settle_amount, v_cash, p_cash_tendered, p_change_given
    );
  else
    raise exception 'Metode bayar harus TUNAI atau BANK, dapat %', p_payment_method;
  end if;

  return v_transaction_id;
end;
$$;

grant execute on function create_pos_sale(date, text, uuid, uuid, uuid, uuid, uuid, jsonb, jsonb, boolean, numeric, text, numeric, numeric) to authenticated;

-- 5. pos_sales_with_status ---------------------------------------------------------------------

-- Jurnal pelunasan sekarang bisa punya 2 baris debit (Kas + Beban Selisih Pembulatan) -- join
-- lama "baris debit > 0" bakal menduplikasi penjualan. Baris kas dipilih eksplisit: debit ke akun
-- berkategori ASSET (Kas/Bank) -- bukan "selain akun rounding.expense saat ini", karena Default Akun
-- bisa dipetakan ulang admin dan jurnal lama tetap nyimpen akun beban lama. Pelunasan Rp0 (gak
-- ada baris kas) -> cash_account_* NULL. Kolom lama gak berubah urutan/tipe (create or replace view cuma
-- boleh menambah kolom di ujung); 4 kolom pembayaran baru ditambahkan di akhir.
create or replace view pos_sales_with_status
  with (security_invoker = true) as
select
  t.id, t.date as sale_date, t.source_ref, t.journal_entry_id as revenue_journal_entry_id,
  t.amount as total,
  case when t.status = 'lunas' then 'normal' else t.status end as status,
  t.counterparty_id as customer_id, c.name as customer_name,
  cash_jl.account_id as cash_account_id, ca.code as cash_account_code, ca.name as cash_account_name,
  pay.payment_method, pay.cash_tendered, pay.change_given, pay.rounding_amount
from transactions t
  join goods_notes gi on gi.transaction_id = t.id and gi.type = 'OUTBOUND'
  join payments pay on pay.transaction_id = t.id and pay.type = 'OUTBOUND' and pay.amount = t.amount
  left join lateral (
    select jl.account_id
    from journal_lines jl
    join accounts a on a.id = jl.account_id
    where jl.journal_entry_id = pay.journal_entry_id
      and jl.debit > 0
      and a.category = 'asset'
    order by jl.debit desc, jl.account_id
    limit 1
  ) cash_jl on true
  left join counterparties c on c.id = t.counterparty_id
  left join accounts ca on ca.id = cash_jl.account_id
where t.type = 'OUTBOUND'
  and not exists (
    select 1 from goods_notes gi2 where gi2.transaction_id = t.id and gi2.type = 'OUTBOUND' and gi2.id <> gi.id
  )
  and not exists (select 1 from payments p2 where p2.transaction_id = t.id and p2.type = 'OUTBOUND' and p2.id <> pay.id)
  and not exists (select 1 from returns r where r.transaction_id = t.id)
  and not exists (select 1 from deposit_applications da where da.transaction_id = t.id);
