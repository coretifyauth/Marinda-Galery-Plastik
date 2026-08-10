-- POS / Jualan Eceran schema.
-- Konsolidasi dari migration historis 0022 (seed akun pajak) + 0023 (schema dasar) +
-- bagian POS dari 0025 (compounding & PPN) — lihat git log untuk riwayat evolusi.
-- Ref: docs/architecture/pos-schema.md

-- Role baru: cashier. Roles pakai lookup table (bukan enum, coa-schema.md) --
-- nambah role baru cukup INSERT baris ini, gak butuh ALTER TYPE.
insert into roles (name, description) values
  ('cashier', 'Bikin POS Sale doang lewat create_pos_sale — gak punya akses insert langsung ke journal_entries/tabel finansial lain manapun');

create table pos_sales (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id),
  sale_date date not null,
  cash_account_id uuid not null references accounts(id),
  revenue_account_id uuid not null references accounts(id),
  revenue_journal_entry_id uuid not null references journal_entries(id),
  cogs_journal_entry_id uuid not null references journal_entries(id),
  source_ref text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create trigger pos_sales_block_edit_delete
  before update or delete on pos_sales
  for each row execute function block_edit_delete();

create table pos_sale_lines (
  id uuid primary key default gen_random_uuid(),
  pos_sale_id uuid not null references pos_sales(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_sold numeric(14,3) not null check (qty_sold > 0),
  unit_price numeric(14,2) not null check (unit_price >= 0),
  line_amount numeric(14,2) not null check (line_amount >= 0),
  total_cost numeric(14,2) not null check (total_cost > 0)
);

create trigger pos_sale_lines_block_edit_delete
  before update or delete on pos_sale_lines
  for each row execute function block_edit_delete();

-- ============================================================
-- Kategori Biaya Tambahan & PPN (Compounding, bagian POS dari 0025) --
-- memory/scope-debt/compound-transactional-entries.md (sudah dihapus, ditutup di sini).
-- pos_charge_types: katalog master data (dropdown checkout kasir), gak ada FK ke tabel
-- transaksional -- kasir cuma pilih dari daftar, gak pernah lihat/pilih akun mentah.
-- pos_sale_extra_credit_lines: baris kredit tambahan aktual per transaksi (immutable).
-- PPN Keluaran-nya sendiri pakai tabel tax_settings (memory/architecture/data/ar-schema.md,
-- dipakai bareng AR/AP juga -- didefinisikan di ar-schema, bukan di sini).
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

-- ============================================================
-- RPC (financial write — atomik, reuse create_journal_entry/reverse_journal_entry)
-- ============================================================

-- create_pos_sale — konsumsi stok (Weighted Average) + 2 jurnal (Kas/Bank<>[Pendapatan +
-- kategori tambahan + PPN], HPP<>Persediaan) + header + lines, sekaligus dalam 1 transaksi.
-- Total item DIHITUNG server-side dari p_lines (qty x unit_price, qty x avg_cost) -- BUKAN
-- parameter yang dipercaya dari client. p_extra_credit_lines (packing/ongkir dkk) TETAP
-- dipercaya dari klien, sama kayak nominal item -- beda dari PPN (p_apply_tax) yang dihitung
-- server sendiri dari tax_settings, gak pernah dari input klien.
--
-- SECURITY DEFINER -- PERTAMA di project ini (semua RPC lain security invoker). Alasan:
-- role cashier sengaja TIDAK dikasih akses insert langsung ke journal_entries (RLS
-- journal_entries_insert cuma admin/accountant) -- kalau dilonggarkan, cashier bisa insert
-- jurnal APAPUN lewat create_journal_entry generik, bukan cuma lewat jalur resmi ini. Definer
-- bikin fungsi ini jalan pakai privilege pemilik fungsi (bypass RLS table-level), TAPI guard
-- role di baris pertama body ini adalah satu-satunya gerbang keamanannya -- gak boleh ada
-- write sebelum guard ini lolos. `set search_path` dikunci eksplisit (pola wajib SECURITY
-- DEFINER, cegah search_path hijacking) -- gak perlu di RPC lain karena semuanya invoker.
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

-- void_pos_sale — pembatalan (reversing entry), pola cancel_ar_invoice. SECURITY INVOKER
-- biasa (beda dari create_pos_sale) -- cuma admin/accountant yang bakal manggil ini (void
-- hidup di apps/erp, bukan layar kasir apps/pos), dan mereka udah lolos RLS
-- journal_entries_insert langsung lewat reverse_journal_entry, gak perlu privilege escalation.
-- Beda dari cancel_ar_invoice: gak ada guard "sudah ada payment" (penjualan kios lunas
-- seketika di titik transaksi dibuat, gak ada tahap payment terpisah) -- guard yang berlaku
-- cuma "belum pernah dibatalkan" + reuse trigger block-retroactive-period yang otomatis
-- nolak periode tertutup. reverse_journal_entry copy SEMUA baris journal_lines apa adanya
-- (gak peduli jumlah barisnya), jadi kategori tambahan & PPN ikut kebalik otomatis tanpa
-- fungsi ini perlu tahu soal itu sama sekali.
create function void_pos_sale(
  p_sale_id uuid,
  p_entry_date date,
  p_source_ref text
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_sale record;
  v_already_voided boolean;
  v_new_revenue_entry_id uuid;
begin
  select * into v_sale from pos_sales where id = p_sale_id;

  if not found then
    raise exception 'POS sale % gak ditemukan', p_sale_id;
  end if;

  select exists (
    select 1 from journal_entries je where je.reverses_entry_id = v_sale.revenue_journal_entry_id
  ) into v_already_voided;

  if v_already_voided then
    raise exception 'POS sale % udah pernah dibatalkan', p_sale_id;
  end if;

  v_new_revenue_entry_id := reverse_journal_entry(v_sale.revenue_journal_entry_id, p_entry_date, p_source_ref);
  perform reverse_journal_entry(v_sale.cogs_journal_entry_id, p_entry_date, p_source_ref);

  update inventory_balances ib
    set qty_on_hand = ib.qty_on_hand + agg.qty_sold,
        updated_at = now()
    from (
      select item_id, sum(qty_sold) as qty_sold
      from pos_sale_lines
      where pos_sale_id = p_sale_id
      group by item_id
    ) agg
    where ib.item_id = agg.item_id;

  return v_new_revenue_entry_id;
end;
$$;

-- ============================================================
-- RLS & Grant
-- ============================================================

-- Beda dari semua tabel transaksional lain di project ini — gak ada policy/grant `insert`
-- sama sekali ke `authenticated` di pos_sales/pos_sale_lines/pos_sale_extra_credit_lines
-- (bukan cuma "dibatasi role tertentu" kayak AR/AP/Inventory). Satu-satunya jalur nulis
-- adalah create_pos_sale (security definer, bypass RLS lewat privilege pemilik fungsi).

alter table pos_sales enable row level security;
alter table pos_sale_lines enable row level security;

create policy pos_sales_select on pos_sales
  for select using (auth.role() = 'authenticated');

create policy pos_sale_lines_select on pos_sale_lines
  for select using (auth.role() = 'authenticated');

grant select on pos_sales to authenticated;
grant select on pos_sale_lines to authenticated;

-- pos_charge_types: katalog master data, select semua authenticated (biar checkout bisa baca
-- daftar), insert+update admin doang (owner yang setup katalog). Gak ada delete --
-- nonaktifkan pakai archived_at (state-naming-convention.md).
alter table pos_charge_types enable row level security;

create policy pos_charge_types_select on pos_charge_types for select using (auth.role() = 'authenticated');
create policy pos_charge_types_insert on pos_charge_types for insert with check (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);
create policy pos_charge_types_update on pos_charge_types for update using (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);

grant select, insert, update on pos_charge_types to authenticated;

-- pos_sale_extra_credit_lines: sengaja gak ada policy/grant INSERT sama sekali, sama pola
-- pos_sales/pos_sale_lines — satu-satunya jalur nulis adalah create_pos_sale.
alter table pos_sale_extra_credit_lines enable row level security;

create policy pos_sale_extra_credit_lines_select on pos_sale_extra_credit_lines
  for select using (auth.role() = 'authenticated');

grant select on pos_sale_extra_credit_lines to authenticated;
