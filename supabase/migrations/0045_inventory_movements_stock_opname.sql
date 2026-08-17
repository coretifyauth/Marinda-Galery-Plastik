-- Kartu Stok — RPC #3 dari rangkaian bertahap (periodik, tapi paling kompleks sejauh ini: 1 RPC
-- bisa hasilkan movement IN maupun OUT tergantung tanda `variance` per baris). Lihat
-- memory/architecture/data/inventory-schema.md submodule "Kartu Stok / Riwayat Mutasi per Item"
-- > "Rencana Bertahap".
--
-- Signature TETAP SAMA -- CREATE OR REPLACE aman, gak perlu DROP FUNCTION dulu. Satu-satunya
-- perubahan: tiap baris stock_opname_lines yang diinsert sekarang juga diikuti 1 baris
-- inventory_movements. `qty = v_variance` dipakai LANGSUNG (bukan qty_actual/qty_system) --
-- v_variance sudah bertanda persis sesuai konvensi ledger (negatif = selisih kurang/OUT,
-- positif = selisih lebih/IN), jadi gak perlu transformasi apa pun. Baris variance=0 sudah
-- di-skip (`continue`) sebelum insert manapun -- otomatis gak pernah nyampe insert ledger juga.

create or replace function record_stock_opname(
  p_opname_date date,
  p_source_ref text,
  p_lines jsonb,
  p_shortage_expense_account_id uuid,
  p_surplus_revenue_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_opname_id uuid;
  v_line jsonb;
  v_item_id uuid;
  v_qty_actual numeric;
  v_inventory_account_id uuid;
  v_qty_system numeric;
  v_avg_cost numeric;
  v_variance numeric;
  v_value numeric;
  v_entry_id uuid;
  v_any_line boolean := false;
  v_line_id uuid;
begin
  insert into stock_opnames (opname_date, source_ref, created_by)
  values (p_opname_date, p_source_ref, auth.uid())
  returning id into v_opname_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty_actual := (v_line->>'qty_actual')::numeric;
    v_inventory_account_id := (v_line->>'inventory_account_id')::uuid;

    -- for update — kunci baris ini sepanjang transaksi. record_stock_opname melakukan SET
    -- absolut (bukan delta kayak consume_weighted_average/create_goods_receipt), jadi jendela
    -- read-then-write di sini lebih beresiko: sesi opname bisa berlangsung lama sebelum
    -- disubmit, dan transaksi lain (goods receipt/issue/produksi) yang nyelip di antaranya
    -- bakal ketiban timpa diam-diam tanpa error kalau baris ini gak dikunci.
    select qty_on_hand, avg_cost into v_qty_system, v_avg_cost
      from inventory_balances where item_id = v_item_id
      for update;

    if not found then
      raise exception 'Item % gak punya inventory_balances', v_item_id;
    end if;

    v_variance := v_qty_actual - v_qty_system;

    if v_variance = 0 then
      continue;
    end if;

    v_value := abs(v_variance) * v_avg_cost;
    v_any_line := true;

    if v_variance < 0 then
      v_entry_id := create_journal_entry(
        p_opname_date, 'Selisih stok opname (kurang)', p_source_ref,
        jsonb_build_array(
          jsonb_build_object('account_id', p_shortage_expense_account_id, 'debit', v_value, 'credit', 0),
          jsonb_build_object('account_id', v_inventory_account_id, 'debit', 0, 'credit', v_value)
        )
      );
    else
      v_entry_id := create_journal_entry(
        p_opname_date, 'Selisih stok opname (lebih)', p_source_ref,
        jsonb_build_array(
          jsonb_build_object('account_id', v_inventory_account_id, 'debit', v_value, 'credit', 0),
          jsonb_build_object('account_id', p_surplus_revenue_account_id, 'debit', 0, 'credit', v_value)
        )
      );
    end if;

    insert into stock_opname_lines (stock_opname_id, item_id, qty_system, qty_actual, unit_cost, journal_entry_id)
    values (v_opname_id, v_item_id, v_qty_system, v_qty_actual, v_avg_cost, v_entry_id)
    returning id into v_line_id;

    insert into inventory_movements (item_id, movement_date, qty, stock_opname_line_id)
    values (v_item_id, p_opname_date, v_variance, v_line_id);

    update inventory_balances
      set qty_on_hand = v_qty_actual, updated_at = now()
      where item_id = v_item_id;
  end loop;

  if not v_any_line then
    raise exception 'Gak ada selisih ditemukan di opname ini -- semua item cocok, gak perlu dicatat';
  end if;

  return v_opname_id;
end;
$$;
