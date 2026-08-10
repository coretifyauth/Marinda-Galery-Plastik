-- Menutup scope-debt memory/scope-debt/compound-transactional-entries.md +
-- memory/scope-debt/tax-handling.md (sub-kasus). create_ap_bill/create_ar_invoice/
-- create_pos_sale (dan create_goods_issue yang manggil create_ar_invoice) diubah dari
-- "1 akun tetap per sisi jurnal" jadi menerima array baris kategori (Opsi A) --
-- create_journal_entry (fondasi) udah generik dari awal (p_lines jsonb N baris), RPC
-- modul-spesifik ini yang selama ini ngunci jadi 1:1. PPN dihitung OTOMATIS
-- server-side (bukan diinput manual client) lewat flag p_apply_tax + tabel
-- tax_settings, biar gak bisa dimanipulasi/dihilangkan dari sisi klien -- beda dari
-- kategori bebas (packing/ongkir dkk) yang tetap dipercaya dari klien, sama kayak
-- nominal invoice/bill yang emang dari dulu diinput manual.
--
-- Desain & rationale penuh: memory/architecture/data/ap-schema.md, ar-schema.md,
-- pos-schema.md, inventory-schema.md.

-- ============================================================
-- Pengaturan Pajak -- tabel singleton (dipaksa cuma 1 baris selamanya lewat PK
-- boolean + check). Tarif PPN itu aturan pemerintah (nasional), bukan per-transaksi
-- -- kalau berubah, cukup UPDATE 1 baris ini, gak perlu deploy ulang app. Akun PPN
-- Keluaran/Masukan disimpan di sini (bukan di-hardcode nama/kode akun di dalam RPC)
-- supaya RPC gak perlu nebak akun mana yang dimaksud.
-- ============================================================

create table tax_settings (
  id boolean primary key default true,
  is_active boolean not null default false,
  ppn_rate numeric(5,2) not null default 11 check (ppn_rate >= 0),
  ppn_keluaran_account_id uuid references accounts(id),
  ppn_masukan_account_id uuid references accounts(id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  constraint tax_settings_singleton check (id)
);

create trigger tax_settings_set_updated_at
  before update on tax_settings
  for each row execute function set_updated_at();

-- Seed baris tunggalnya sekarang -- is_active=false (kios CV Roti Barokah belum
-- PKP di cerita saat ini), akun Keluaran/Masukan dipetakan ke akun yang udah ada
-- dari 0022_seed_tax_accounts.sql. Match pakai `code` (unique) bukan `name`
-- (accounts.name gak ada unique constraint -- coa-schema.md).
insert into tax_settings (id, is_active, ppn_rate, ppn_keluaran_account_id, ppn_masukan_account_id)
select true, false, 11,
  (select id from accounts where code = '2400'),
  (select id from accounts where code = '1500');

alter table tax_settings enable row level security;

create policy tax_settings_select on tax_settings
  for select using (auth.role() = 'authenticated');

create policy tax_settings_update on tax_settings
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );
-- Sengaja gak ada policy INSERT/DELETE -- baris tunggalnya cuma diseed migration
-- ini, admin cuma boleh UPDATE nilai yang sudah ada, gak boleh nambah/hapus baris
-- (constraint singleton bakal nolak baris kedua walau ada yang nekat coba insert).

grant select, update on tax_settings to authenticated;

-- ============================================================
-- Katalog "Jenis Biaya Tambahan" -- 3 tabel terpisah per modul (pola project ini
-- misahin struktur serupa per modul, bukan 1 tabel generik lintas modul, contoh:
-- ar_deposits vs ap_deposits). Murni master data buat UI (dropdown pilihan
-- kasir/staff) -- GAK ADA FK dari sini ke tabel transaksional, sama kayak
-- item_units yang juga cuma dipakai UI buat resolve pilihan sebelum manggil RPC
-- (konversi/resolusi terjadi di UI, RPC cuma terima account_id+amount mentah --
-- trust boundary-nya sama persis kayak p_revenue_account_id yang udah ada
-- sekarang, gak ada mekanisme baru yang berubah soal itu).
-- ============================================================

create table pos_charge_types (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  account_id uuid not null references accounts(id),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger pos_charge_types_set_updated_at
  before update on pos_charge_types
  for each row execute function set_updated_at();

create table ar_invoice_charge_types (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  account_id uuid not null references accounts(id),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger ar_invoice_charge_types_set_updated_at
  before update on ar_invoice_charge_types
  for each row execute function set_updated_at();

create table ap_bill_expense_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  account_id uuid not null references accounts(id),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger ap_bill_expense_categories_set_updated_at
  before update on ap_bill_expense_categories
  for each row execute function set_updated_at();

-- RLS ketiganya identik: select semua authenticated (biar checkout/form bisa baca
-- daftar), insert+update admin doang (owner yang setup katalog, bukan kasir/staff
-- biasa). Gak ada delete -- nonaktifkan pakai archived_at (state-naming-convention.md
-- -- satu-satunya penanda lifecycle, bukan is_active terpisah), biar transaksi lama
-- yang pernah pakai kategori ini tetap valid secara historis.

alter table pos_charge_types enable row level security;
create policy pos_charge_types_select on pos_charge_types for select using (auth.role() = 'authenticated');
create policy pos_charge_types_insert on pos_charge_types for insert with check (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);
create policy pos_charge_types_update on pos_charge_types for update using (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);

alter table ar_invoice_charge_types enable row level security;
create policy ar_invoice_charge_types_select on ar_invoice_charge_types for select using (auth.role() = 'authenticated');
create policy ar_invoice_charge_types_insert on ar_invoice_charge_types for insert with check (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);
create policy ar_invoice_charge_types_update on ar_invoice_charge_types for update using (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);

alter table ap_bill_expense_categories enable row level security;
create policy ap_bill_expense_categories_select on ap_bill_expense_categories for select using (auth.role() = 'authenticated');
create policy ap_bill_expense_categories_insert on ap_bill_expense_categories for insert with check (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);
create policy ap_bill_expense_categories_update on ap_bill_expense_categories for update using (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);

grant select, insert, update on pos_charge_types to authenticated;
grant select, insert, update on ar_invoice_charge_types to authenticated;
grant select, insert, update on ap_bill_expense_categories to authenticated;

-- ============================================================
-- Baris kategori aktual per dokumen -- ini yang bener-bener kepakai RPC buat
-- kalkulasi jurnal (bukan cuma katalog). Immutable (pola sama semua tabel
-- transaksional lain -- block_edit_delete). `is_tax` dicentang OTOMATIS oleh RPC
-- (bukan dari input klien) begitu barisnya hasil hitungan PPN otomatis --
-- klien gak pernah bisa kirim is_tax=true sendiri.
-- ============================================================

create table ap_bill_debit_lines (
  id uuid primary key default gen_random_uuid(),
  ap_bill_id uuid not null references ap_bills(id) on delete cascade,
  account_id uuid not null references accounts(id),
  amount numeric(14,2) not null check (amount > 0),
  is_tax boolean not null default false,
  created_at timestamptz not null default now()
);

create index ap_bill_debit_lines_ap_bill_id_idx on ap_bill_debit_lines(ap_bill_id);

create trigger ap_bill_debit_lines_block_edit_delete
  before update or delete on ap_bill_debit_lines
  for each row execute function block_edit_delete();

create table ar_invoice_credit_lines (
  id uuid primary key default gen_random_uuid(),
  ar_invoice_id uuid not null references ar_invoices(id) on delete cascade,
  account_id uuid not null references accounts(id),
  amount numeric(14,2) not null check (amount > 0),
  is_tax boolean not null default false,
  created_at timestamptz not null default now()
);

create index ar_invoice_credit_lines_ar_invoice_id_idx on ar_invoice_credit_lines(ar_invoice_id);

create trigger ar_invoice_credit_lines_block_edit_delete
  before update or delete on ar_invoice_credit_lines
  for each row execute function block_edit_delete();

create table pos_sale_extra_credit_lines (
  id uuid primary key default gen_random_uuid(),
  pos_sale_id uuid not null references pos_sales(id) on delete cascade,
  account_id uuid not null references accounts(id),
  amount numeric(14,2) not null check (amount > 0),
  is_tax boolean not null default false,
  created_at timestamptz not null default now()
);

create index pos_sale_extra_credit_lines_pos_sale_id_idx on pos_sale_extra_credit_lines(pos_sale_id);

create trigger pos_sale_extra_credit_lines_block_edit_delete
  before update or delete on pos_sale_extra_credit_lines
  for each row execute function block_edit_delete();

-- RLS: select semua authenticated. Insert AP/AR ngikut role yang boleh bikin
-- dokumen induknya (admin/accountant, sama kayak ap_bills_insert/ar_invoices_insert
-- -- RPC-nya security invoker jadi RLS ini kena cek ke user yang manggil).
-- pos_sale_extra_credit_lines SENGAJA GAK ADA POLICY/GRANT INSERT SAMA SEKALI --
-- pola identik pos_sales/pos_sale_lines (pos-schema.md): satu-satunya jalur nulis
-- adalah create_pos_sale (SECURITY DEFINER, bypass RLS lewat privilege pemilik
-- fungsi), role cashier gak pernah dikasih akses insert langsung ke tabel manapun.

alter table ap_bill_debit_lines enable row level security;
create policy ap_bill_debit_lines_select on ap_bill_debit_lines for select using (auth.role() = 'authenticated');
create policy ap_bill_debit_lines_insert on ap_bill_debit_lines for insert with check (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
);

alter table ar_invoice_credit_lines enable row level security;
create policy ar_invoice_credit_lines_select on ar_invoice_credit_lines for select using (auth.role() = 'authenticated');
create policy ar_invoice_credit_lines_insert on ar_invoice_credit_lines for insert with check (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
);

alter table pos_sale_extra_credit_lines enable row level security;
create policy pos_sale_extra_credit_lines_select on pos_sale_extra_credit_lines for select using (auth.role() = 'authenticated');

grant select, insert on ap_bill_debit_lines to authenticated;
grant select, insert on ar_invoice_credit_lines to authenticated;
grant select on pos_sale_extra_credit_lines to authenticated;

-- ============================================================
-- create_ap_bill -- signature berubah (p_amount + p_debit_account_id tunggal jadi
-- p_debit_lines array), jadi DROP dulu baru CREATE (bukan create-or-replace biasa
-- -- signature beda bakal jadi overload baru, bukan gantiin yang lama, pola sama
-- kayak 0009/0011/0012). Kredit (Utang Usaha) TETAP 1 baris, gak berubah.
-- ============================================================

drop function if exists create_ap_bill(uuid, date, text, text, numeric, uuid, uuid);

create function create_ap_bill(
  p_supplier_id uuid,
  p_bill_date date,
  p_description text,
  p_source_ref text,
  p_debit_lines jsonb, -- array of {"account_id":uuid,"amount":numeric} -- Persediaan/Beban, BUKAN termasuk PPN
  p_payable_account_id uuid,
  p_apply_tax boolean default false
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_term_days int;
  v_due_date date;
  v_entry_id uuid;
  v_bill_id uuid;
  v_line jsonb;
  v_line_amount numeric;
  v_subtotal numeric := 0;
  v_tax_amount numeric := 0;
  v_total_amount numeric;
  v_tax_active boolean;
  v_tax_rate numeric;
  v_tax_account_id uuid;
  v_journal_lines jsonb := '[]'::jsonb;
begin
  if p_debit_lines is null or jsonb_array_length(p_debit_lines) = 0 then
    raise exception 'AP bill wajib punya minimal 1 baris debit';
  end if;

  select payment_term_days into v_term_days from suppliers where id = p_supplier_id;
  v_due_date := p_bill_date + v_term_days;

  for v_line in select * from jsonb_array_elements(p_debit_lines)
  loop
    v_line_amount := (v_line->>'amount')::numeric;
    if v_line_amount <= 0 then
      raise exception 'Nominal baris debit harus > 0';
    end if;
    v_subtotal := v_subtotal + v_line_amount;
    v_journal_lines := v_journal_lines || jsonb_build_array(
      jsonb_build_object('account_id', (v_line->>'account_id')::uuid, 'debit', v_line_amount, 'credit', 0)
    );
  end loop;

  if p_apply_tax then
    select is_active, ppn_rate, ppn_masukan_account_id
      into v_tax_active, v_tax_rate, v_tax_account_id
      from tax_settings where id = true;

    if not coalesce(v_tax_active, false) then
      raise exception 'PPN gak aktif di Pengaturan Pajak -- gak bisa nambah baris PPN Masukan';
    end if;
    if v_tax_account_id is null then
      raise exception 'Akun PPN Masukan belum diset di Pengaturan Pajak';
    end if;

    v_tax_amount := round(v_subtotal * v_tax_rate / 100, 2);
    v_journal_lines := v_journal_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_tax_account_id, 'debit', v_tax_amount, 'credit', 0)
    );
  end if;

  v_total_amount := v_subtotal + v_tax_amount;

  v_journal_lines := v_journal_lines || jsonb_build_array(
    jsonb_build_object('account_id', p_payable_account_id, 'debit', 0, 'credit', v_total_amount)
  );

  v_entry_id := create_journal_entry(p_bill_date, p_description, p_source_ref, v_journal_lines);

  insert into ap_bills (supplier_id, bill_date, due_date, description, source_ref, amount, journal_entry_id, created_by)
  values (p_supplier_id, p_bill_date, v_due_date, p_description, p_source_ref, v_total_amount, v_entry_id, auth.uid())
  returning id into v_bill_id;

  for v_line in select * from jsonb_array_elements(p_debit_lines)
  loop
    insert into ap_bill_debit_lines (ap_bill_id, account_id, amount, is_tax)
    values (v_bill_id, (v_line->>'account_id')::uuid, (v_line->>'amount')::numeric, false);
  end loop;

  if p_apply_tax then
    insert into ap_bill_debit_lines (ap_bill_id, account_id, amount, is_tax)
    values (v_bill_id, v_tax_account_id, v_tax_amount, true);
  end if;

  return v_bill_id;
end;
$$;

-- ============================================================
-- create_ar_invoice -- signature berubah (p_amount + p_revenue_account_id tunggal
-- jadi p_credit_lines array). Debit (Piutang Usaha) TETAP 1 baris, gak berubah.
-- Credit Hold (customers.credit_limit/overdue_threshold_days) tetap jalan, cuma
-- sekarang dihitung terhadap v_total_amount (SUM baris kredit + PPN kalau ada),
-- bukan p_amount mentah.
-- ============================================================

drop function if exists create_ar_invoice(uuid, date, text, text, numeric, uuid, uuid);

create function create_ar_invoice(
  p_customer_id uuid,
  p_invoice_date date,
  p_description text,
  p_source_ref text,
  p_credit_lines jsonb, -- array of {"account_id":uuid,"amount":numeric} -- kategori pendapatan, BUKAN termasuk PPN
  p_receivable_account_id uuid,
  p_apply_tax boolean default false
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_term_days int;
  v_due_date date;
  v_entry_id uuid;
  v_invoice_id uuid;
  v_credit_limit numeric;
  v_overdue_threshold_days int;
  v_outstanding numeric;
  v_max_overdue_days int;
  v_line jsonb;
  v_line_amount numeric;
  v_subtotal numeric := 0;
  v_tax_amount numeric := 0;
  v_total_amount numeric;
  v_tax_active boolean;
  v_tax_rate numeric;
  v_tax_account_id uuid;
  v_journal_lines jsonb;
begin
  if p_credit_lines is null or jsonb_array_length(p_credit_lines) = 0 then
    raise exception 'AR invoice wajib punya minimal 1 baris kredit';
  end if;

  select payment_term_days, credit_limit, overdue_threshold_days
    into v_term_days, v_credit_limit, v_overdue_threshold_days
    from customers where id = p_customer_id;
  v_due_date := p_invoice_date + v_term_days;

  for v_line in select * from jsonb_array_elements(p_credit_lines)
  loop
    v_line_amount := (v_line->>'amount')::numeric;
    if v_line_amount <= 0 then
      raise exception 'Nominal baris kredit harus > 0';
    end if;
    v_subtotal := v_subtotal + v_line_amount;
  end loop;

  if p_apply_tax then
    select is_active, ppn_rate, ppn_keluaran_account_id
      into v_tax_active, v_tax_rate, v_tax_account_id
      from tax_settings where id = true;

    if not coalesce(v_tax_active, false) then
      raise exception 'PPN gak aktif di Pengaturan Pajak -- gak bisa nambah baris PPN Keluaran';
    end if;
    if v_tax_account_id is null then
      raise exception 'Akun PPN Keluaran belum diset di Pengaturan Pajak';
    end if;

    v_tax_amount := round(v_subtotal * v_tax_rate / 100, 2);
  end if;

  v_total_amount := v_subtotal + v_tax_amount;

  select coalesce(sum(greatest(r.remaining, 0)), 0),
         coalesce(max(p_invoice_date - ai.due_date), 0)
    into v_outstanding, v_max_overdue_days
    from ar_invoices ai
    cross join lateral (select ar_invoice_remaining(ai.id) as remaining) r
    where ai.customer_id = p_customer_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = ai.journal_entry_id
      )
      and r.remaining > 0;

  if v_credit_limit is not null and (v_outstanding + v_total_amount) > v_credit_limit then
    raise exception 'Customer kena credit hold: piutang outstanding % + invoice baru % ngelewatin credit_limit %',
      v_outstanding, v_total_amount, v_credit_limit;
  end if;

  if v_overdue_threshold_days is not null and v_max_overdue_days > v_overdue_threshold_days then
    raise exception 'Customer kena credit hold: ada piutang telat % hari (toleransi % hari)',
      v_max_overdue_days, v_overdue_threshold_days;
  end if;

  v_journal_lines := jsonb_build_array(
    jsonb_build_object('account_id', p_receivable_account_id, 'debit', v_total_amount, 'credit', 0)
  );

  for v_line in select * from jsonb_array_elements(p_credit_lines)
  loop
    v_journal_lines := v_journal_lines || jsonb_build_array(
      jsonb_build_object('account_id', (v_line->>'account_id')::uuid, 'debit', 0, 'credit', (v_line->>'amount')::numeric)
    );
  end loop;

  if p_apply_tax then
    v_journal_lines := v_journal_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_tax_account_id, 'debit', 0, 'credit', v_tax_amount)
    );
  end if;

  v_entry_id := create_journal_entry(p_invoice_date, p_description, p_source_ref, v_journal_lines);

  insert into ar_invoices (
    customer_id, invoice_date, due_date, description, source_ref, amount,
    journal_entry_id, created_by
  )
  values (
    p_customer_id, p_invoice_date, v_due_date, p_description, p_source_ref, v_total_amount,
    v_entry_id, auth.uid()
  )
  returning id into v_invoice_id;

  for v_line in select * from jsonb_array_elements(p_credit_lines)
  loop
    insert into ar_invoice_credit_lines (ar_invoice_id, account_id, amount, is_tax)
    values (v_invoice_id, (v_line->>'account_id')::uuid, (v_line->>'amount')::numeric, false);
  end loop;

  if p_apply_tax then
    insert into ar_invoice_credit_lines (ar_invoice_id, account_id, amount, is_tax)
    values (v_invoice_id, v_tax_account_id, v_tax_amount, true);
  end if;

  return v_invoice_id;
end;
$$;

-- ============================================================
-- create_pos_sale -- p_revenue_account_id TETAP ADA (basket item tetap 1 baris
-- kredit, totalnya tetap dihitung server dari p_lines, TETAP gak dipercaya dari
-- klien -- sifat anti-tamper yang udah ada dari awal gak berubah). 2 param baru
-- ditambah di akhir: p_extra_credit_lines (opsional, default kosong -- packing/
-- ongkir dkk, dipercaya dari klien sama kayak nominal item) + p_apply_tax
-- (PPN dihitung server, gak pernah dari klien).
-- ============================================================

drop function if exists create_pos_sale(date, text, uuid, uuid, uuid, uuid, uuid, jsonb);

create function create_pos_sale(
  p_sale_date date,
  p_source_ref text,
  p_customer_id uuid,
  p_cash_account_id uuid,
  p_revenue_account_id uuid,
  p_hpp_account_id uuid,
  p_finished_good_account_id uuid,
  p_lines jsonb, -- array of {"item_id":uuid,"qty_sold":numeric,"unit_price":numeric}
  p_extra_credit_lines jsonb default '[]'::jsonb, -- array of {"account_id":uuid,"amount":numeric} -- packing/ongkir dkk, BUKAN PPN
  p_apply_tax boolean default false
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_line jsonb;
  v_item_id uuid;
  v_qty numeric;
  v_unit_price numeric;
  v_line_amount numeric;
  v_line_cost numeric;
  v_total_amount numeric := 0;
  v_total_cost numeric := 0;
  v_sale_id uuid;
  v_revenue_entry_id uuid;
  v_cogs_entry_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_prices numeric[] := '{}';
  v_line_amounts numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  v_extra_amount numeric;
  v_extra_total numeric := 0;
  v_tax_amount numeric := 0;
  v_tax_active boolean;
  v_tax_rate numeric;
  v_tax_account_id uuid;
  v_credit_lines jsonb;
  v_grand_total numeric;
begin
  if not exists (
    select 1 from user_roles ur
    where ur.user_id = auth.uid() and ur.role_name in ('admin', 'accountant', 'cashier')
  ) then
    raise exception 'Gak punya akses buat bikin POS Sale';
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'POS sale wajib punya minimal 1 baris item';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line ->> 'item_id')::uuid;
    v_qty := (v_line ->> 'qty_sold')::numeric;
    v_unit_price := (v_line ->> 'unit_price')::numeric;

    if v_qty <= 0 then
      raise exception 'qty_sold harus > 0';
    end if;
    if v_unit_price < 0 then
      raise exception 'unit_price gak boleh negatif';
    end if;

    v_line_amount := v_qty * v_unit_price;
    -- consume_weighted_average raise exception sendiri kalau stok gak cukup (no-oversell)
    v_line_cost := consume_weighted_average(v_item_id, v_qty);

    v_total_amount := v_total_amount + v_line_amount;
    v_total_cost := v_total_cost + v_line_cost;

    v_line_items := array_append(v_line_items, v_item_id);
    v_line_qtys := array_append(v_line_qtys, v_qty);
    v_line_prices := array_append(v_line_prices, v_unit_price);
    v_line_amounts := array_append(v_line_amounts, v_line_amount);
    v_line_costs := array_append(v_line_costs, v_line_cost);
  end loop;

  if p_extra_credit_lines is not null and jsonb_array_length(p_extra_credit_lines) > 0 then
    for v_line in select * from jsonb_array_elements(p_extra_credit_lines)
    loop
      v_extra_amount := (v_line->>'amount')::numeric;
      if v_extra_amount <= 0 then
        raise exception 'Nominal baris biaya tambahan harus > 0';
      end if;
      v_extra_total := v_extra_total + v_extra_amount;
    end loop;
  end if;

  if p_apply_tax then
    select is_active, ppn_rate, ppn_keluaran_account_id
      into v_tax_active, v_tax_rate, v_tax_account_id
      from tax_settings where id = true;

    if not coalesce(v_tax_active, false) then
      raise exception 'PPN gak aktif di Pengaturan Pajak -- gak bisa nambah baris PPN Keluaran';
    end if;
    if v_tax_account_id is null then
      raise exception 'Akun PPN Keluaran belum diset di Pengaturan Pajak';
    end if;

    v_tax_amount := round((v_total_amount + v_extra_total) * v_tax_rate / 100, 2);
  end if;

  v_grand_total := v_total_amount + v_extra_total + v_tax_amount;

  v_credit_lines := jsonb_build_array(
    jsonb_build_object('account_id', p_revenue_account_id, 'debit', 0, 'credit', v_total_amount)
  );

  if p_extra_credit_lines is not null and jsonb_array_length(p_extra_credit_lines) > 0 then
    for v_line in select * from jsonb_array_elements(p_extra_credit_lines)
    loop
      v_credit_lines := v_credit_lines || jsonb_build_array(
        jsonb_build_object('account_id', (v_line->>'account_id')::uuid, 'debit', 0, 'credit', (v_line->>'amount')::numeric)
      );
    end loop;
  end if;

  if p_apply_tax then
    v_credit_lines := v_credit_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_tax_account_id, 'debit', 0, 'credit', v_tax_amount)
    );
  end if;

  v_revenue_entry_id := create_journal_entry(
    p_sale_date, 'Penjualan POS', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_cash_account_id, 'debit', v_grand_total, 'credit', 0)
    ) || v_credit_lines
  );

  v_cogs_entry_id := create_journal_entry(
    p_sale_date, 'HPP Penjualan POS', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_hpp_account_id, 'debit', v_total_cost, 'credit', 0),
      jsonb_build_object('account_id', p_finished_good_account_id, 'debit', 0, 'credit', v_total_cost)
    )
  );

  insert into pos_sales (
    customer_id, sale_date, cash_account_id, revenue_account_id,
    revenue_journal_entry_id, cogs_journal_entry_id, source_ref, created_by
  ) values (
    p_customer_id, p_sale_date, p_cash_account_id, p_revenue_account_id,
    v_revenue_entry_id, v_cogs_entry_id, p_source_ref, auth.uid()
  ) returning id into v_sale_id;

  for i in 1..array_length(v_line_items, 1) loop
    insert into pos_sale_lines (pos_sale_id, item_id, qty_sold, unit_price, line_amount, total_cost)
    values (v_sale_id, v_line_items[i], v_line_qtys[i], v_line_prices[i], v_line_amounts[i], v_line_costs[i]);
  end loop;

  if p_extra_credit_lines is not null and jsonb_array_length(p_extra_credit_lines) > 0 then
    for v_line in select * from jsonb_array_elements(p_extra_credit_lines)
    loop
      insert into pos_sale_extra_credit_lines (pos_sale_id, account_id, amount, is_tax)
      values (v_sale_id, (v_line->>'account_id')::uuid, (v_line->>'amount')::numeric, false);
    end loop;
  end if;

  if p_apply_tax then
    insert into pos_sale_extra_credit_lines (pos_sale_id, account_id, amount, is_tax)
    values (v_sale_id, v_tax_account_id, v_tax_amount, true);
  end if;

  return v_sale_id;
end;
$$;

-- ============================================================
-- create_goods_issue -- ikut berubah karena manggil create_ar_invoice yang
-- signature-nya berubah. p_amount + p_revenue_account_id diganti p_credit_lines,
-- p_apply_tax diteruskan apa adanya. p_lines (item) & so_line_id (Sales Order,
-- 0024) TIDAK berubah sama sekali.
-- ============================================================

drop function if exists create_goods_issue(uuid, date, text, text, numeric, uuid, uuid, jsonb, uuid, uuid);

create function create_goods_issue(
  p_customer_id uuid,
  p_invoice_date date,
  p_description text,
  p_source_ref text,
  p_credit_lines jsonb, -- array of {"account_id":uuid,"amount":numeric} -- diteruskan ke create_ar_invoice
  p_receivable_account_id uuid,
  p_lines jsonb, -- array of {"item_id":uuid,"qty_issued":numeric,"so_line_id":uuid|null}
  p_hpp_account_id uuid,
  p_finished_good_account_id uuid,
  p_apply_tax boolean default false
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_issue_id uuid := gen_random_uuid();
  v_invoice_id uuid;
  v_line jsonb;
  v_item_id uuid;
  v_qty numeric;
  v_so_line_id uuid;
  v_line_cost numeric;
  v_total_cost numeric := 0;
  v_entry_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  v_line_so_lines uuid[] := '{}';
  i int;
begin
  v_invoice_id := create_ar_invoice(
    p_customer_id, p_invoice_date, p_description, p_source_ref,
    p_credit_lines, p_receivable_account_id, p_apply_tax
  );

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty := (v_line->>'qty_issued')::numeric;
    v_so_line_id := nullif(v_line->>'so_line_id', '')::uuid;

    v_line_cost := consume_weighted_average(v_item_id, v_qty);

    v_line_items := array_append(v_line_items, v_item_id);
    v_line_qtys := array_append(v_line_qtys, v_qty);
    v_line_costs := array_append(v_line_costs, v_line_cost);
    v_line_so_lines := array_append(v_line_so_lines, v_so_line_id);
    v_total_cost := v_total_cost + v_line_cost;
  end loop;

  v_entry_id := create_journal_entry(
    p_invoice_date, 'HPP ' || p_description, p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_hpp_account_id, 'debit', v_total_cost, 'credit', 0),
      jsonb_build_object('account_id', p_finished_good_account_id, 'debit', 0, 'credit', v_total_cost)
    )
  );

  insert into goods_issues (id, invoice_id, journal_entry_id, issue_date, source_ref, created_by)
  values (v_issue_id, v_invoice_id, v_entry_id, p_invoice_date, p_source_ref, auth.uid());

  for i in 1..array_length(v_line_items, 1) loop
    insert into goods_issue_lines (goods_issue_id, item_id, qty_issued, total_cost, so_line_id)
    values (v_issue_id, v_line_items[i], v_line_qtys[i], v_line_costs[i], v_line_so_lines[i]);
  end loop;

  return v_issue_id;
end;
$$;

-- ============================================================
-- create_goods_receipt -- ikut kena dampak karena manggil create_ap_bill di
-- dalamnya, sama kasusnya kayak create_goods_issue -> create_ar_invoice. Beda
-- perlakuan: signature EKSTERNAL-nya (p_debit_account_id, p_payable_account_id)
-- SENGAJA GAK DIUBAH -- PO/GRN gak pernah butuh kategori campur (1 GRN = barang
-- dari 1 PO, selalu 1 kategori Persediaan), jadi gak ada alasan bisnis buat
-- expose p_debit_lines array ke UI-nya. Cukup dibungkus jadi array 1 elemen
-- sebelum manggil create_ap_bill yang signature-nya sudah berubah -- UI
-- goods-receipts/page.tsx TIDAK PERLU diubah sama sekali.
-- ============================================================

drop function if exists create_goods_receipt(uuid, date, text, jsonb, text, text, uuid, uuid);

create function create_goods_receipt(
  p_purchase_order_id uuid,
  p_receipt_date date,
  p_delivery_note_ref text,
  p_lines jsonb, -- array of {"po_line_id":uuid,"item_id":uuid,"qty_received":numeric,"unit_cost":numeric}
  p_bill_description text,
  p_bill_source_ref text,
  p_debit_account_id uuid,
  p_payable_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_supplier_id uuid;
  v_line jsonb;
  v_total_amount numeric := 0;
  v_bill_id uuid;
  v_grn_id uuid;
  v_item_id uuid;
  v_qty_received numeric;
  v_unit_cost numeric;
  v_qty_before numeric;
  v_avg_before numeric;
begin
  select supplier_id into v_supplier_id from purchase_orders where id = p_purchase_order_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_total_amount := v_total_amount + (v_line->>'qty_received')::numeric * (v_line->>'unit_cost')::numeric;
  end loop;

  v_bill_id := create_ap_bill(
    v_supplier_id, p_receipt_date, p_bill_description, p_bill_source_ref,
    jsonb_build_array(jsonb_build_object('account_id', p_debit_account_id, 'amount', v_total_amount)),
    p_payable_account_id
  );

  insert into goods_receipt_notes (purchase_order_id, bill_id, delivery_note_ref, receipt_date, created_by)
  values (p_purchase_order_id, v_bill_id, p_delivery_note_ref, p_receipt_date, auth.uid())
  returning id into v_grn_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty_received := (v_line->>'qty_received')::numeric;
    v_unit_cost := (v_line->>'unit_cost')::numeric;

    insert into goods_receipt_lines (grn_id, po_line_id, item_id, qty_received, unit_cost)
    values (v_grn_id, (v_line->>'po_line_id')::uuid, v_item_id, v_qty_received, v_unit_cost);

    select qty_on_hand, avg_cost into v_qty_before, v_avg_before
      from inventory_balances where item_id = v_item_id;

    if not found then
      insert into inventory_balances (item_id, qty_on_hand, avg_cost)
      values (v_item_id, v_qty_received, v_unit_cost);
    else
      update inventory_balances
        set qty_on_hand = v_qty_before + v_qty_received,
            avg_cost = (v_qty_before * v_avg_before + v_qty_received * v_unit_cost) / (v_qty_before + v_qty_received),
            updated_at = now()
        where item_id = v_item_id;
    end if;
  end loop;

  return v_grn_id;
end;
$$;
