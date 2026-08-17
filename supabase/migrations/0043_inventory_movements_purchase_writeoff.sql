-- Kartu Stok — RPC #1 dari rangkaian bertahap (risiko paling rendah, barang rusak ditulis-jadi-
-- beban itu kejadian insidental, bukan transaksi harian). Lihat memory/architecture/data/
-- inventory-schema.md submodule "Kartu Stok / Riwayat Mutasi per Item" > "Rencana Bertahap".
--
-- Signature TETAP SAMA -- CREATE OR REPLACE aman, gak perlu DROP FUNCTION dulu. Satu-satunya
-- perubahan: tiap baris purchase_writeoff_lines yang diinsert sekarang juga diikuti 1 baris
-- inventory_movements (qty negatif -- barang rusak keluar dari stok, gak pernah balik).

create or replace function create_purchase_writeoff(
  p_bill_id uuid,
  p_writeoff_date date,
  p_source_ref text,
  p_lines jsonb, -- array of {"item_id":uuid,"qty":numeric}
  p_loss_expense_account_id uuid,
  p_inventory_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_grn_id uuid;
  v_writeoff_id uuid;
  v_line jsonb;
  v_item_id uuid;
  v_qty numeric;
  v_line_cost numeric;
  v_total_cost numeric := 0;
  v_entry_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  v_line_id uuid;
  i int;
begin
  select id into v_grn_id from goods_receipt_notes where bill_id = p_bill_id;

  if v_grn_id is null then
    raise exception 'Bill % gak punya goods_receipt_notes -- gak bisa tulis-jadi-beban per item', p_bill_id;
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'Tulis-jadi-beban butuh minimal 1 baris item';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty := (v_line->>'qty')::numeric;

    v_line_cost := consume_weighted_average(v_item_id, v_qty);

    v_line_items := array_append(v_line_items, v_item_id);
    v_line_qtys := array_append(v_line_qtys, v_qty);
    v_line_costs := array_append(v_line_costs, v_line_cost);
    v_total_cost := v_total_cost + v_line_cost;
  end loop;

  v_entry_id := create_journal_entry(
    p_writeoff_date, 'Barang rusak ditulis-jadi-beban -- supplier tolak kompensasi', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_loss_expense_account_id, 'debit', v_total_cost, 'credit', 0),
      jsonb_build_object('account_id', p_inventory_account_id, 'debit', 0, 'credit', v_total_cost)
    )
  );

  insert into purchase_writeoffs (bill_id, writeoff_date, source_ref, journal_entry_id, created_by)
  values (p_bill_id, p_writeoff_date, p_source_ref, v_entry_id, auth.uid())
  returning id into v_writeoff_id;

  for i in 1..array_length(v_line_items, 1) loop
    insert into purchase_writeoff_lines (purchase_writeoff_id, item_id, qty_written_off, total_cost)
    values (v_writeoff_id, v_line_items[i], v_line_qtys[i], v_line_costs[i])
    returning id into v_line_id;

    insert into inventory_movements (item_id, movement_date, qty, purchase_writeoff_line_id)
    values (v_line_items[i], p_writeoff_date, -v_line_qtys[i], v_line_id);
  end loop;

  return v_writeoff_id;
end;
$$;
