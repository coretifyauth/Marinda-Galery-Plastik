-- Fix 0052: `select ... from transactions ... for update` di cancel_ap_bill/cancel_ar_invoice bikin
-- bill/invoice "gak ditemukan" -- role authenticated cuma punya select+insert di transactions (gak ada
-- policy/grant update), jadi FOR UPDATE nggak mengembalikan baris. Cegah pembatalan ganda bersamaan
-- pakai advisory lock per transaksi (pola sama check_scan_code_unique_across_tables di 0049).

create or replace function cancel_ap_bill(
  p_bill_id uuid, p_entry_date date, p_source_ref text
) returns uuid language plpgsql security invoker as $$
declare
  v_allocated_count int; v_return_count int; v_deposit_count int; v_replacement_count int;
  v_grn_id uuid; v_order_id uuid;
  v_original_entry_id uuid; v_new_entry_id uuid; v_bill_ref text;
  v_line record; v_qty_on_hand numeric; v_avg_cost numeric;
  v_net_value numeric; v_new_qty numeric; v_new_value numeric; v_item_name text;
begin
  perform pg_advisory_xact_lock(hashtext('cancel_transaction:' || p_bill_id::text));
  select source_ref, journal_entry_id into v_bill_ref, v_original_entry_id
    from transactions where id = p_bill_id and type = 'INBOUND';
  if not found then
    raise exception 'Bill % gak ditemukan', p_bill_id;
  end if;

  select count(*) into v_allocated_count
  from payments where transaction_id = p_bill_id and type = 'INBOUND';

  if v_allocated_count > 0 then
    raise exception 'Bill % udah punya % payment -- gak bisa dibatalkan lewat jalur ini', v_bill_ref, v_allocated_count;
  end if;

  select count(*) into v_return_count
  from returns where transaction_id = p_bill_id and type = 'OUTBOUND';

  if v_return_count > 0 then
    raise exception 'Bill % udah punya % retur -- gak bisa dibatalkan lewat jalur ini', v_bill_ref, v_return_count;
  end if;

  select id, order_id into v_grn_id, v_order_id
    from goods_notes where transaction_id = p_bill_id and type = 'INBOUND';

  if v_grn_id is not null then
    select count(*) into v_deposit_count from deposit_applications where transaction_id = p_bill_id;
    select count(*) into v_replacement_count from replacements where transaction_id = p_bill_id;

    if v_deposit_count > 0 or v_replacement_count > 0 then
      raise exception 'Bill % (barang masuk) udah punya DP/tukar barang -- urus itu dulu sebelum dibatalkan', v_bill_ref;
    end if;

    if exists (select 1 from journal_entries je where je.reverses_entry_id = v_original_entry_id) then
      raise exception 'Bill % udah pernah dibatalkan', v_bill_ref;
    end if;

    for v_line in
      select id, item_id, qty, unit_cost, coalesce(discount_amount, 0) as discount_amount
      from goods_note_lines where goods_note_id = v_grn_id
    loop
      select name into v_item_name from items where id = v_line.item_id;
      select qty_on_hand, avg_cost into v_qty_on_hand, v_avg_cost
        from inventory_balances where item_id = v_line.item_id for update;

      if not found or v_qty_on_hand < v_line.qty then
        raise exception 'Barang masuk % gak bisa dibatalkan: stok "%" tinggal %, kurang dari qty diterima % (sebagian sudah terpakai/terjual) -- pakai Retur AP atau Stock Opname',
          v_bill_ref, v_item_name, coalesce(v_qty_on_hand, 0), v_line.qty;
      end if;

      v_net_value := v_line.qty * v_line.unit_cost - v_line.discount_amount;
      v_new_qty := v_qty_on_hand - v_line.qty;
      v_new_value := v_qty_on_hand * v_avg_cost - v_net_value;

      if v_new_qty > 0 and v_new_value <= 0 then
        raise exception 'Barang masuk % gak bisa dibatalkan: nilai persediaan "%" sisa gak cukup buat dibalik -- pakai Retur AP atau Stock Opname',
          v_bill_ref, v_item_name;
      end if;

      update inventory_balances
        set qty_on_hand = v_new_qty,
            avg_cost = case when v_new_qty > 0 then v_new_value / v_new_qty else avg_cost end,
            updated_at = now()
        where item_id = v_line.item_id;

      insert into inventory_movements (item_id, movement_date, qty, goods_note_line_id)
      values (v_line.item_id, p_entry_date, -v_line.qty, v_line.id);
    end loop;
  end if;

  v_new_entry_id := reverse_journal_entry(v_original_entry_id, p_entry_date, p_source_ref);

  -- status transaksi sudah 'dibatalkan' (trigger journal_entries) -> qty PO kebebas.
  if v_order_id is not null then
    perform recompute_order_status(v_order_id);
  end if;

  return v_new_entry_id;
end;
$$;

create or replace function cancel_ar_invoice(
  p_invoice_id uuid, p_entry_date date, p_source_ref text
) returns uuid language plpgsql security invoker as $$
declare
  v_paid_count int; v_return_count int; v_replacement_count int;
  v_original_entry_id uuid; v_new_entry_id uuid;
  v_application record; v_invoice_ref text; v_note record; v_line record;
begin
  perform pg_advisory_xact_lock(hashtext('cancel_transaction:' || p_invoice_id::text));
  select source_ref, journal_entry_id into v_invoice_ref, v_original_entry_id
    from transactions where id = p_invoice_id and type = 'OUTBOUND';
  if not found then
    raise exception 'Invoice % gak ditemukan', p_invoice_id;
  end if;

  select count(*) into v_paid_count
  from payments where transaction_id = p_invoice_id and type = 'OUTBOUND';

  if v_paid_count > 0 then
    raise exception 'Invoice % udah punya payment -- gak bisa dibatalkan lewat jalur ini', v_invoice_ref;
  end if;

  select count(*) into v_return_count
  from returns where transaction_id = p_invoice_id and type = 'INBOUND';

  if v_return_count > 0 then
    raise exception 'Invoice % udah punya % retur -- gak bisa dibatalkan lewat jalur ini', v_invoice_ref, v_return_count;
  end if;

  if exists (select 1 from goods_notes where transaction_id = p_invoice_id and type = 'OUTBOUND') then
    select count(*) into v_replacement_count from replacements where transaction_id = p_invoice_id;
    if v_replacement_count > 0 then
      raise exception 'Invoice % (barang keluar) udah punya penggantian barang -- urus itu dulu sebelum dibatalkan', v_invoice_ref;
    end if;

    if exists (select 1 from journal_entries je where je.reverses_entry_id = v_original_entry_id) then
      raise exception 'Invoice % udah pernah dibatalkan', v_invoice_ref;
    end if;

    for v_note in
      select id, journal_entry_id, order_id from goods_notes
      where transaction_id = p_invoice_id and type = 'OUTBOUND'
    loop
      perform reverse_journal_entry(v_note.journal_entry_id, p_entry_date, p_source_ref);

      for v_line in select id, item_id, qty from goods_note_lines where goods_note_id = v_note.id
      loop
        update inventory_balances
          set qty_on_hand = qty_on_hand + v_line.qty, updated_at = now()
          where item_id = v_line.item_id;

        insert into inventory_movements (item_id, movement_date, qty, goods_note_line_id)
        values (v_line.item_id, p_entry_date, v_line.qty, v_line.id);
      end loop;
    end loop;
  end if;

  v_new_entry_id := reverse_journal_entry(v_original_entry_id, p_entry_date, p_source_ref);

  for v_application in
    select da.journal_entry_id from deposit_applications da
    where da.transaction_id = p_invoice_id
      and not exists (select 1 from journal_entries je where je.reverses_entry_id = da.journal_entry_id)
  loop
    perform reverse_journal_entry(v_application.journal_entry_id, p_entry_date, p_source_ref);
  end loop;

  -- status transaksi sudah 'dibatalkan' (trigger journal_entries) -> qty SO kebebas.
  for v_note in
    select distinct order_id from goods_notes
    where transaction_id = p_invoice_id and type = 'OUTBOUND' and order_id is not null
  loop
    perform recompute_order_status(v_note.order_id);
  end loop;

  return v_new_entry_id;
end;
$$;
