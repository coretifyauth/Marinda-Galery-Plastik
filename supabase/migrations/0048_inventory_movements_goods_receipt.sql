-- Kartu Stok — RPC #6 dari rangkaian bertahap (pembelian, cukup rutin). Lihat
-- memory/architecture/data/inventory-schema.md submodule "Kartu Stok / Riwayat Mutasi per Item"
-- > "Rencana Bertahap".
--
-- Signature TETAP SAMA -- CREATE OR REPLACE aman. Body ASLI disalin dari definisi TERKINI (sudah
-- di-extend migration 0012_grn_compound_ppn.sql + 0024_purchase_order_sales_order_cancel.sql,
-- keduanya sudah live) -- bukan dari definisi awal 0004 yang sudah usang. Satu-satunya perubahan:
-- tiap baris goods_receipt_lines yang diinsert sekarang diikuti 1 baris inventory_movements (qty
-- positif -- barang MASUK dari pembelian).

create or replace function create_goods_receipt(
  p_purchase_order_id uuid,
  p_receipt_date date,
  p_delivery_note_ref text,
  p_lines jsonb,
  p_bill_description text,
  p_bill_source_ref text,
  p_debit_account_id uuid,
  p_payable_account_id uuid,
  p_extra_debit_lines jsonb default null,
  p_apply_tax boolean default false
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
  v_debit_lines jsonb;
  v_line_id uuid;
begin
  select supplier_id into v_supplier_id from purchase_orders where id = p_purchase_order_id;

  if exists (select 1 from purchase_orders where id = p_purchase_order_id and cancelled_at is not null) then
    raise exception 'Purchase order % udah dibatalkan — gak bisa dibuat penerimaan barang', p_purchase_order_id;
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_total_amount := v_total_amount + (v_line->>'qty_received')::numeric * (v_line->>'unit_cost')::numeric;
  end loop;

  v_debit_lines := jsonb_build_array(jsonb_build_object('account_id', p_debit_account_id, 'amount', v_total_amount));
  if p_extra_debit_lines is not null then
    for v_line in select * from jsonb_array_elements(p_extra_debit_lines)
    loop
      v_debit_lines := v_debit_lines || jsonb_build_array(v_line);
    end loop;
  end if;

  v_bill_id := create_ap_bill(
    v_supplier_id, p_receipt_date, p_bill_description, p_bill_source_ref,
    v_debit_lines,
    p_payable_account_id,
    p_apply_tax
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
    values (v_grn_id, (v_line->>'po_line_id')::uuid, v_item_id, v_qty_received, v_unit_cost)
    returning id into v_line_id;

    insert into inventory_movements (item_id, movement_date, qty, goods_receipt_line_id)
    values (v_item_id, p_receipt_date, v_qty_received, v_line_id);

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
