-- Production Orders. Ref: memory/architecture/data/production-orders-schema.md.
-- Kejadian produksi beneran, menjalankan resep dari bom_headers/bom_lines (0010).
--
-- item_id digabung LANGSUNG ke CREATE TABLE utama di sini (riwayat asli nambah belakangan
-- lewat ALTER migration 0042 + backfill dari bom_headers.finished_item_id) -- file ini
-- representasi final state, bukan histori incremental.

create table production_orders (
  id uuid primary key default gen_random_uuid(),
  bom_header_id uuid not null references bom_headers(id),
  item_id uuid not null references items(id),
  qty_produced numeric(14,3) not null check (qty_produced > 0),
  production_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (id, item_id) -- prasyarat composite FK inventory_movements (inventory-ledger-schema.md)
);

create trigger production_orders_block_edit_delete
  before update or delete on production_orders
  for each row execute function block_edit_delete();

create table production_order_lines (
  id uuid primary key default gen_random_uuid(),
  production_order_id uuid not null references production_orders(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_consumed numeric(14,3) not null check (qty_consumed > 0),
  total_cost numeric(14,2) not null check (total_cost > 0),
  unique (id, item_id) -- prasyarat composite FK inventory_movements (inventory-ledger-schema.md)
);

create trigger production_order_lines_block_edit_delete
  before update or delete on production_order_lines
  for each row execute function block_edit_delete();

-- create_production_order -- ambil bom_lines dari bom_header_id, hitung batch_multiplier =
-- qty_produced / output_qty, konsumsi tiap bahan baku (Weighted Average, via
-- consume_weighted_average -- didefinisikan belakangan di 0022_inventory_ledger_schema.sql,
-- aman direferensikan di sini karena plpgsql resolve referensi function lain secara lazy,
-- cuma divalidasi pas beneran dipanggil bukan pas CREATE FUNCTION), total biayanya jadi
-- jurnal (Debit Persediaan Barang Jadi, Kredit Persediaan Bahan Baku), lalu barang jadi
-- hasil produksi nambah inventory_balances DAN nyatet 2 sisi kartu stok ke
-- inventory_movements (barang jadi masuk + tiap bahan baku keluar).
--
-- Body ini gabungan efek 3 migration lama (final state): 0012_inventory_schema.sql (base,
-- batch_multiplier + consume_weighted_average + jurnal + insert production_orders/lines) +
-- 0042_inventory_movements_schema.sql (ngisi item_id di INSERT production_orders) +
-- 0049_inventory_movements_production_order.sql (2 insert ke inventory_movements).

create function create_production_order(
  p_bom_header_id uuid,
  p_qty_produced numeric,
  p_production_date date,
  p_source_ref text,
  p_finished_good_debit_account_id uuid,
  p_raw_material_credit_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_po_id uuid := gen_random_uuid();
  v_finished_item_id uuid;
  v_output_qty numeric;
  v_batch_multiplier numeric;
  v_bom_line record;
  v_qty_needed numeric;
  v_line_cost numeric;
  v_total_raw_cost numeric := 0;
  v_entry_id uuid;
  v_unit_cost numeric;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  i int;
  v_line_id uuid;
begin
  select finished_item_id, output_qty into v_finished_item_id, v_output_qty
    from bom_headers where id = p_bom_header_id;

  v_batch_multiplier := p_qty_produced / v_output_qty;

  for v_bom_line in
    select bl.raw_material_item_id, bl.qty_per_batch
    from bom_lines bl
    where bl.bom_header_id = p_bom_header_id
  loop
    v_qty_needed := v_bom_line.qty_per_batch * v_batch_multiplier;

    v_line_cost := consume_weighted_average(v_bom_line.raw_material_item_id, v_qty_needed);

    v_line_items := array_append(v_line_items, v_bom_line.raw_material_item_id);
    v_line_qtys := array_append(v_line_qtys, v_qty_needed);
    v_line_costs := array_append(v_line_costs, v_line_cost);
    v_total_raw_cost := v_total_raw_cost + v_line_cost;
  end loop;

  v_entry_id := create_journal_entry(
    p_production_date, 'Produksi ' || p_qty_produced || ' unit', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_finished_good_debit_account_id, 'debit', v_total_raw_cost, 'credit', 0),
      jsonb_build_object('account_id', p_raw_material_credit_account_id, 'debit', 0, 'credit', v_total_raw_cost)
    )
  );

  insert into production_orders (id, bom_header_id, item_id, qty_produced, production_date, source_ref, journal_entry_id, created_by)
  values (v_po_id, p_bom_header_id, v_finished_item_id, p_qty_produced, p_production_date, p_source_ref, v_entry_id, auth.uid());

  insert into inventory_movements (item_id, movement_date, qty, production_order_id)
  values (v_finished_item_id, p_production_date, p_qty_produced, v_po_id);

  for i in 1..array_length(v_line_items, 1) loop
    insert into production_order_lines (production_order_id, item_id, qty_consumed, total_cost)
    values (v_po_id, v_line_items[i], v_line_qtys[i], v_line_costs[i])
    returning id into v_line_id;

    insert into inventory_movements (item_id, movement_date, qty, production_order_line_id)
    values (v_line_items[i], p_production_date, -v_line_qtys[i], v_line_id);
  end loop;

  v_unit_cost := v_total_raw_cost / p_qty_produced;

  insert into inventory_balances (item_id, qty_on_hand, avg_cost)
  values (v_finished_item_id, p_qty_produced, v_unit_cost)
  on conflict (item_id) do update
    set qty_on_hand = inventory_balances.qty_on_hand + excluded.qty_on_hand,
        avg_cost = (inventory_balances.qty_on_hand * inventory_balances.avg_cost + excluded.qty_on_hand * excluded.avg_cost)
                   / (inventory_balances.qty_on_hand + excluded.qty_on_hand),
        updated_at = now();

  return v_po_id;
end;
$$;

-- RLS & Grant -- pola identik AR/AP: select terbuka semua authenticated, insert cuma
-- admin. Transaksional -- gak ada policy update/delete.

alter table production_orders enable row level security;

create policy production_orders_select on production_orders
  for select using (auth.role() = 'authenticated');

create policy production_orders_insert on production_orders
  for insert with check (
    exists (select 1 from app_user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

alter table production_order_lines enable row level security;

create policy production_order_lines_select on production_order_lines
  for select using (auth.role() = 'authenticated');

create policy production_order_lines_insert on production_order_lines
  for insert with check (
    exists (select 1 from app_user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

grant select, insert on production_orders to authenticated;
grant select, insert on production_order_lines to authenticated;
