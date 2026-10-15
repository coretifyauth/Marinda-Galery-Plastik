-- Pembatalan Barang Masuk (GRN) DAN Barang Keluar (Goods Issue / penjualan). GRN + Bill dibuat 1 RPC (create_goods_receipt), jadi
-- "batalkan GRN" = batalkan Bill-nya: cancel_ap_bill diperluas (sebelumnya MENOLAK bill dari GRN)
-- supaya sekalian balikin stok. Status "dibatalkan" GRN diturunkan dari transactions.status
-- (goods_notes immutable, gak ada kolom status sendiri).
--
-- Stok dibalik pakai pendekatan NILAI, bukan mundurin rumus: qty -= qty GRN, nilai persediaan
-- (qty * avg_cost) -= nilai bersih baris GRN (qty*unit_cost - diskon prorata), avg_cost baru =
-- nilai / qty. Ini persis sama dengan jurnal pembalik yang ngurangin Persediaan di GL, jadi
-- GL tetap cocok dengan valuasi Kartu Stok walau sudah ada mutasi lain sesudah GRN. Dengan
-- GRN terakhir, hasilnya identik dengan "mundurin" avg_cost. HPP penjualan yang SUDAH dijurnal
-- di antara tidak di-restate (jurnal immutable).
--
-- Qty GRN yang dibatalkan juga dibebaskan dari qty PO (recompute_order_status, trigger
-- anti-over-fulfill, cancel_order mengabaikan baris GRN yang bill-nya dibatalkan).

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
  select source_ref, journal_entry_id into v_bill_ref, v_original_entry_id
    from transactions where id = p_bill_id and type = 'INBOUND' for update;
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

-- recompute_order_status -- sama persis 0014 kecuali kedua cabang (PURCHASE & SALE) ngabaikan baris
-- goods note yang transaksinya dibatalkan.
create or replace function recompute_order_status(p_order_id uuid) returns void as $$
declare
  v_direction text;
  v_cancelled_at timestamptz;
  v_all_done boolean;
  v_none_done boolean;
  v_status text;
begin
  select direction, cancelled_at into v_direction, v_cancelled_at from orders where id = p_order_id;
  if not found then
    return;
  end if;

  if v_cancelled_at is not null then
    return;
  end if;

  if v_direction = 'PURCHASE' then
    select
      coalesce(bool_and(coalesce(gr.received, 0) >= ol.qty_ordered - 0.0005), true),
      coalesce(bool_and(coalesce(gr.received, 0) <= 0.0005), true)
      into v_all_done, v_none_done
    from order_lines ol
    left join lateral (
      select sum(gnl.qty) as received
      from goods_note_lines gnl
      join goods_notes gn on gn.id = gnl.goods_note_id
      join transactions t on t.id = gn.transaction_id
      where gnl.order_line_id = ol.id and t.status <> 'dibatalkan'
    ) gr on true
    where ol.order_id = p_order_id;

    v_status := case
      when v_all_done then 'FULLY_RECEIVED'
      when v_none_done then 'OPEN'
      else 'PARTIALLY_RECEIVED'
    end;
  else
    select
      coalesce(bool_and(coalesce(gi.issued, 0) >= ol.qty_ordered - 0.0005), true),
      coalesce(bool_and(coalesce(gi.issued, 0) <= 0.0005), true)
      into v_all_done, v_none_done
    from order_lines ol
    left join lateral (
      select sum(gnl.qty) as issued
      from goods_note_lines gnl
      join goods_notes gn on gn.id = gnl.goods_note_id
      join transactions t on t.id = gn.transaction_id
      where gnl.order_line_id = ol.id and t.status <> 'dibatalkan'
    ) gi on true
    where ol.order_id = p_order_id;

    v_status := case
      when v_all_done then 'FULLY_FULFILLED'
      when v_none_done then 'OPEN'
      else 'PARTIALLY_FULFILLED'
    end;
  end if;

  update orders set status = v_status where id = p_order_id;
end;
$$ language plpgsql security definer set search_path = public;

-- goods_note_lines_no_over_fulfill -- sama persis 0018 kecuali qty goods note yang transaksinya
-- dibatalkan gak dihitung sebagai "sudah terpenuhi".
create or replace function goods_note_lines_no_over_fulfill() returns trigger as $$
declare
  v_qty_ordered numeric;
  v_qty_fulfilled numeric;
  v_item_name text;
begin
  if new.order_line_id is null then
    return new;
  end if;

  select qty_ordered into v_qty_ordered from order_lines where id = new.order_line_id;
  select coalesce(sum(gnl.qty), 0) into v_qty_fulfilled
    from goods_note_lines gnl
    join goods_notes gn on gn.id = gnl.goods_note_id
    join transactions t on t.id = gn.transaction_id
    where gnl.order_line_id = new.order_line_id
      and t.status <> 'dibatalkan';

  if v_qty_fulfilled + new.qty > v_qty_ordered then
    select name into v_item_name from items where id = new.item_id;
    raise exception 'Qty item "%" melebihi qty dipesan di order (sisa %, coba %)',
      v_item_name, v_qty_ordered - v_qty_fulfilled, new.qty;
  end if;

  return new;
end;
$$ language plpgsql;

-- cancel_ar_invoice -- sisi penjualan. Invoice dari Goods Issue sekarang BOLEH dibatalkan: jurnal HPP
-- dan jurnal invoice dibalik, stok dikembalikan (qty_on_hand += qty keluar; avg_cost TIDAK disentuh --
-- konsumsi gak pernah mengubahnya, sama pola void_pos_transaction), mutasi kompensasi (qty positif)
-- ke Kartu Stok, qty Sales Order dibebaskan. Guard retur ditambah (sebelumnya gak ada) untuk SEMUA invoice.
-- Pembatalan ganda untuk invoice non-Goods-Issue tetap gak dicegah (perilaku lama).
create or replace function cancel_ar_invoice(
  p_invoice_id uuid, p_entry_date date, p_source_ref text
) returns uuid language plpgsql security invoker as $$
declare
  v_paid_count int; v_return_count int; v_replacement_count int;
  v_original_entry_id uuid; v_new_entry_id uuid;
  v_application record; v_invoice_ref text; v_note record; v_line record;
begin
  select source_ref, journal_entry_id into v_invoice_ref, v_original_entry_id
    from transactions where id = p_invoice_id and type = 'OUTBOUND' for update;
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

-- cancel_order -- sama persis 0014 kecuali penerimaan yang sudah dibatalkan gak menghalangi
-- pembatalan PO.
create or replace function cancel_order(p_order_id uuid) returns void
language plpgsql
security invoker
as $$
declare
  v_direction text;
  v_realized_count int;
begin
  select direction into v_direction from orders where id = p_order_id;
  if not found then
    raise exception 'Order % gak ditemukan', p_order_id;
  end if;

  select count(*) into v_realized_count
  from goods_note_lines gnl
  join order_lines ol on ol.id = gnl.order_line_id
  join goods_notes gn on gn.id = gnl.goods_note_id
  join transactions t on t.id = gn.transaction_id
  where ol.order_id = p_order_id
    and t.status <> 'dibatalkan';

  if v_realized_count > 0 then
    if v_direction = 'PURCHASE' then
      raise exception 'Order % udah punya penerimaan barang — gak bisa dibatalkan', p_order_id;
    else
      raise exception 'Order % udah punya pengiriman barang — gak bisa dibatalkan', p_order_id;
    end if;
  end if;

  update orders set cancelled_at = now()
  where id = p_order_id and cancelled_at is null;

  if not found then
    raise exception 'Order % gak ditemukan atau udah dibatalkan', p_order_id;
  end if;
end;
$$;

-- returns_block_cancelled_transaction -- retur gak boleh dibuat di atas tagihan/invoice yang sudah
-- dibatalkan. Sebelumnya aman karena tagihan dari GRN gak bisa dibatalkan; sekarang bisa, dan
-- create_ap_return bakal konsumsi stok yang sudah dibalik + balikin utang dua kali. Trigger (bukan
-- edit fungsi) karena RPC jalan dalam 1 transaksi -- raise di sini membatalkan konsumsi stoknya juga.
create function returns_block_cancelled_transaction() returns trigger as $$
begin
  if exists (select 1 from transactions where id = new.transaction_id and status = 'dibatalkan') then
    raise exception 'Transaksi % udah dibatalkan -- gak bisa dibuat retur', new.transaction_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger returns_block_cancelled_transaction_trigger
  before insert on returns
  for each row execute function returns_block_cancelled_transaction();

-- Kartu Stok: mutasi kompensasi pembatalan GRN (qty negatif di baris INBOUND) dikasih label sendiri.
-- Sama persis 0023 kecuali CASE pertama.
create or replace view inventory_movements_with_source
  with (security_invoker = true) as
select
  im.id,
  im.item_id,
  im.movement_date,
  im.qty,
  im.created_at,
  coalesce(
    case when im.goods_note_line_id is not null and gn.type = 'INBOUND'
      then case when im.qty < 0 then 'Pembatalan Barang Masuk' else 'Pembelian (Terima Barang)' end
      else null end,
    case when im.goods_note_line_id is not null and gn.type = 'OUTBOUND' and im.qty > 0 then 'Pembatalan Barang Keluar' else null end,
    case when im.production_order_id is not null then 'Produksi (Hasil)' else null end,
    case when im.return_line_id is not null and rl.type = 'INBOUND' then 'Retur dari Customer' else null end,
    case when im.stock_opname_line_id is not null then 'Penyesuaian Stock Opname' else null end,
    case when im.goods_note_line_id is not null and gn.type = 'OUTBOUND' then 'Penjualan (Kirim Barang)' else null end,
    case when im.production_order_line_id is not null then 'Produksi (Konsumsi Bahan)' else null end,
    case when im.return_line_id is not null and rl.type = 'OUTBOUND' then 'Retur ke Supplier' else null end,
    case when im.replacement_line_id is not null and rp.type = 'INBOUND' then 'Penggantian Garansi' else null end,
    case when im.replacement_line_id is not null and rp.type = 'OUTBOUND' then 'Tukar Barang (Retur Supplier)' else null end
  ) as source_label,
  coalesce(ap_bill.source_ref, prod_header.source_ref, r.source_ref, so.source_ref, gn.source_ref, prod_line_header.source_ref, rp.source_ref) as source_ref
from inventory_movements im
  left join goods_note_lines gnl on gnl.id = im.goods_note_line_id
  left join goods_notes gn on gn.id = gnl.goods_note_id
  left join transactions ap_bill on ap_bill.id = gn.transaction_id and gn.type = 'INBOUND'
  left join production_orders prod_header on prod_header.id = im.production_order_id
  left join return_lines rl on rl.id = im.return_line_id
  left join returns r on r.id = rl.return_id
  left join stock_opname_lines sol on sol.id = im.stock_opname_line_id
  left join stock_opnames so on so.id = sol.stock_opname_id
  left join production_order_lines pol on pol.id = im.production_order_line_id
  left join production_orders prod_line_header on prod_line_header.id = pol.production_order_id
  left join replacement_lines rpl on rpl.id = im.replacement_line_id
  left join replacements rp on rp.id = rpl.replacement_id;
