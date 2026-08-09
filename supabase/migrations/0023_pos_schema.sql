-- POS / Jualan Eceran — penjualan tunai kios, berdiri sendiri dari AR (gak pernah
-- nyentuh ar_invoices/ar_payments sama sekali). Desain & rationale penuh:
-- memory/domain/pos.md, memory/architecture/data/pos-schema.md.

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

-- RPC `create_pos_sale` — konsumsi stok (Weighted Average) + 2 jurnal (Kas/Bank<>Pendapatan,
-- HPP<>Persediaan) + header + lines, sekaligus dalam 1 transaksi. Total nominal/HPP DIHITUNG
-- server-side dari p_lines (qty x unit_price, qty x avg_cost) -- BUKAN parameter yang dipercaya
-- dari client, beda dari create_goods_issue yang masih nerima p_amount mentah (ar_invoices
-- sudah ada duluan sebelum goods_issue_lines, jadi gak bisa didekomposisi ulang; pos_sales
-- gak punya beban sejarah itu).
--
-- SECURITY DEFINER -- PERTAMA di project ini (semua RPC lain security invoker). Alasan:
-- role `cashier` sengaja TIDAK dikasih akses insert langsung ke journal_entries (RLS
-- journal_entries_insert cuma admin/accountant, journal-entry-schema.md) -- kalau
-- dilonggarkan, cashier bisa insert jurnal APAPUN lewat create_journal_entry generik,
-- bukan cuma lewat jalur resmi ini. Definer bikin fungsi ini jalan pakai privilege
-- pemilik fungsi (bypass RLS table-level), TAPI guard role di baris pertama body ini
-- adalah satu-satunya gerbang keamanannya -- gak boleh ada write sebelum guard ini lolos.
-- `set search_path` dikunci eksplisit (pola wajib SECURITY DEFINER, cegah search_path
-- hijacking) -- gak perlu di RPC lain karena semuanya security invoker.
create function create_pos_sale(
  p_sale_date date,
  p_source_ref text,
  p_customer_id uuid,
  p_cash_account_id uuid,
  p_revenue_account_id uuid,
  p_hpp_account_id uuid,
  p_finished_good_account_id uuid,
  p_lines jsonb -- array of {"item_id":uuid,"qty_sold":numeric,"unit_price":numeric}
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

  v_revenue_entry_id := create_journal_entry(
    p_sale_date, 'Penjualan POS', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_cash_account_id, 'debit', v_total_amount, 'credit', 0),
      jsonb_build_object('account_id', p_revenue_account_id, 'debit', 0, 'credit', v_total_amount)
    )
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

  return v_sale_id;
end;
$$;

-- RPC `void_pos_sale` — pembatalan (reversing entry), pola cancel_ar_invoice. SECURITY
-- INVOKER biasa (beda dari create_pos_sale) -- gak butuh definer karena cuma admin/accountant
-- yang bakal manggil ini (RLS journal_entries_insert udah otomatis nolak cashier lewat jalur
-- reverse_journal_entry di dalam sini, gak perlu guard role manual tambahan). Beda dari
-- cancel_ar_invoice: gak ada guard "sudah ada payment" (POS gak punya tahap payment terpisah
-- dari sale-nya sendiri, lunas seketika) -- guard yang berlaku cuma "belum pernah dibatalkan"
-- + reuse trigger block-retroactive-period yang otomatis nolak periode tertutup.
create function void_pos_sale(
  p_sale_id uuid,
  p_entry_date date,
  p_source_ref text
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_revenue_entry_id uuid;
  v_cogs_entry_id uuid;
  v_new_revenue_entry_id uuid;
begin
  select revenue_journal_entry_id, cogs_journal_entry_id
    into v_revenue_entry_id, v_cogs_entry_id
    from pos_sales where id = p_sale_id;

  if v_revenue_entry_id is null then
    raise exception 'POS sale % gak ditemukan', p_sale_id;
  end if;

  if exists (select 1 from journal_entries where reverses_entry_id = v_revenue_entry_id) then
    raise exception 'POS sale % udah pernah dibatalkan', p_sale_id;
  end if;

  v_new_revenue_entry_id := reverse_journal_entry(v_revenue_entry_id, p_entry_date, p_source_ref);
  perform reverse_journal_entry(v_cogs_entry_id, p_entry_date, p_source_ref);

  -- Reversing entry cuma balikin sisi jurnal -- konsumsi stok (consume_weighted_average)
  -- gak otomatis kebalik dari situ, jadi qty_on_hand wajib disesuaikan manual di sini.
  -- avg_cost SENGAJA gak disentuh (konsisten pola restock retur RESALABLE di AR).
  -- Di-agregasi per item_id DULU (bukan UPDATE...FROM langsung ke pos_sale_lines) --
  -- kalau 1 sale punya >1 baris item_id yang sama (kasir scan SKU sama 2x sebagai baris
  -- terpisah), UPDATE...FROM yang join langsung ke banyak baris sumber cuma makan SATU
  -- baris match (perilaku terdokumentasi Postgres, "not readily predictable" yang mana),
  -- bukan menjumlahkan semuanya -- qty_on_hand bakal under-restock diam-diam tanpa error.
  update inventory_balances ib
    set qty_on_hand = ib.qty_on_hand + agg.qty,
        updated_at = now()
    from (
      select item_id, sum(qty_sold) as qty
      from pos_sale_lines
      where pos_sale_id = p_sale_id
      group by item_id
    ) agg
    where agg.item_id = ib.item_id;

  return v_new_revenue_entry_id;
end;
$$;

alter table pos_sales enable row level security;
alter table pos_sale_lines enable row level security;

create policy pos_sales_select on pos_sales
  for select using (auth.role() = 'authenticated');

create policy pos_sale_lines_select on pos_sale_lines
  for select using (auth.role() = 'authenticated');

-- Sengaja TIDAK ada policy insert/update/delete di kedua tabel ini -- satu-satunya jalur
-- nulis adalah create_pos_sale (security definer, bypass RLS lewat privilege pemilik
-- fungsi), bukan insert langsung dari client mana pun termasuk admin/accountant. Ini
-- juga kenapa GRANT di bawah cuma select, gak ada insert -- PostgREST bakal nolak
-- percobaan insert langsung duluan sebelum sempat kena cek RLS sama sekali.
grant select on pos_sales to authenticated;
grant select on pos_sale_lines to authenticated;
