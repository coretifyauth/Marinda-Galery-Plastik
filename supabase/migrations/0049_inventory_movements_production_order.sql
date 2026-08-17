-- Kartu Stok — RPC #7 dari rangkaian bertahap (paling kompleks: 1 pemanggilan hasilkan 1 baris
-- IN [barang jadi] + N baris OUT [tiap bahan baku dikonsumsi] sekaligus). Lihat
-- memory/architecture/data/inventory-schema.md submodule "Kartu Stok / Riwayat Mutasi per Item"
-- > "Rencana Bertahap".
--
-- Body ASLI disalin dari definisi TERKINI di migration 0042_inventory_movements_schema.sql
-- (yang SUDAH nambah kolom item_id ke INSERT production_orders, perbaikan bug yang ketauan
-- schema-reviewer pas migration itu direview) -- bukan dari definisi awal 0004. Signature TETAP
-- SAMA. 2 perubahan: (1) 1 insert baru ke inventory_movements persis setelah insert
-- production_orders (qty POSITIF = p_qty_produced, production_order_id = v_po_id -- barang jadi
-- MASUK dari hasil produksi); (2) di loop production_order_lines, tambah RETURNING id INTO
-- v_line_id + 1 insert ke inventory_movements per baris (qty NEGATIF -- bahan baku KELUAR
-- dikonsumsi).

create or replace function create_production_order(
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
