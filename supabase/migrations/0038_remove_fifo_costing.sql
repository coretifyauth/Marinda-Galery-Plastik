-- Penghapusan metode costing FIFO dari sistem (memory/scope-debt/penghapusan-fifo.md).
-- Cuma Weighted Average yang dipertahankan. Ketauan/diputuskan pas desain AP Retur Barang
-- (2026-08-06); AP (0035) sudah didesain Weighted-Average-only dari awal, 0 dampak balik ke situ.
--
-- Urutan wajib: (1) migrasi data item FIFO existing ke inventory_balances SEBELUM tabel lot
-- dihapus (butuh baca inventory_lots/inventory_lot_consumptions), (2) redefinisi RPC yang
-- branch FIFO vs Weighted Average jadi jalur Weighted Average doang, (3) baru drop
-- consume_fifo + tabel lot + kolom items.costing_method (satu-satunya metode tersisa,
-- kolomnya jadi redundant — dihapus total, bukan disisain sebagai dead single-value column).

-- ============================================================
-- 1. Migrasi data: item FIFO existing -> inventory_balances
-- ============================================================
-- avg_cost = SUM(qty_sisa x unit_cost lot) / SUM(qty_sisa), qty_sisa = qty_in - akumulasi konsumsi.
-- on conflict jaga-jaga kalau item itu somehow udah punya baris inventory_balances (gak
-- seharusnya kejadian buat item FIFO murni, tapi migration harus aman buat state DB apa pun).

insert into inventory_balances (item_id, qty_on_hand, avg_cost)
select
  l.item_id,
  sum(l.qty_in - coalesce(c.consumed, 0)) as qty_remaining,
  sum((l.qty_in - coalesce(c.consumed, 0)) * l.unit_cost) / sum(l.qty_in - coalesce(c.consumed, 0)) as avg_cost
from inventory_lots l
left join (
  select lot_id, sum(qty) as consumed from inventory_lot_consumptions group by lot_id
) c on c.lot_id = l.id
where l.item_id in (select id from items where costing_method = 'FIFO')
group by l.item_id
having sum(l.qty_in - coalesce(c.consumed, 0)) > 0
on conflict (item_id) do update
  set qty_on_hand = inventory_balances.qty_on_hand + excluded.qty_on_hand,
      avg_cost = (inventory_balances.qty_on_hand * inventory_balances.avg_cost + excluded.qty_on_hand * excluded.avg_cost)
                 / (inventory_balances.qty_on_hand + excluded.qty_on_hand),
      updated_at = now();

-- ============================================================
-- 2. Redefinisi RPC — hapus semua cabang FIFO, sisain Weighted Average
-- ============================================================

create or replace function create_goods_receipt(
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
    v_total_amount, p_debit_account_id, p_payable_account_id
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

  insert into production_orders (id, bom_header_id, qty_produced, production_date, source_ref, journal_entry_id, created_by)
  values (v_po_id, p_bom_header_id, p_qty_produced, p_production_date, p_source_ref, v_entry_id, auth.uid());

  for i in 1..array_length(v_line_items, 1) loop
    insert into production_order_lines (production_order_id, item_id, qty_consumed, total_cost)
    values (v_po_id, v_line_items[i], v_line_qtys[i], v_line_costs[i]);
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

create or replace function create_goods_issue(
  p_customer_id uuid,
  p_invoice_date date,
  p_description text,
  p_source_ref text,
  p_amount numeric,
  p_receivable_account_id uuid,
  p_revenue_account_id uuid,
  p_lines jsonb, -- array of {"item_id":uuid,"qty_issued":numeric}
  p_hpp_account_id uuid,
  p_finished_good_account_id uuid
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
  v_line_cost numeric;
  v_total_cost numeric := 0;
  v_entry_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  i int;
begin
  v_invoice_id := create_ar_invoice(
    p_customer_id, p_invoice_date, p_description, p_source_ref,
    p_amount, p_receivable_account_id, p_revenue_account_id
  );

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty := (v_line->>'qty_issued')::numeric;

    v_line_cost := consume_weighted_average(v_item_id, v_qty);

    v_line_items := array_append(v_line_items, v_item_id);
    v_line_qtys := array_append(v_line_qtys, v_qty);
    v_line_costs := array_append(v_line_costs, v_line_cost);
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
    insert into goods_issue_lines (goods_issue_id, item_id, qty_issued, total_cost)
    values (v_issue_id, v_line_items[i], v_line_qtys[i], v_line_costs[i]);
  end loop;

  return v_issue_id;
end;
$$;

create or replace function create_ar_credit_note(
  p_invoice_id uuid,
  p_credit_note_date date,
  p_source_ref text,
  p_amount numeric,
  p_contra_revenue_account_id uuid,
  p_receivable_account_id uuid,
  p_lines jsonb default null, -- array of {"item_id":uuid,"qty_returned":numeric}
  p_hpp_account_id uuid default null,
  p_finished_good_account_id uuid default null,
  p_return_credit_liability_account_id uuid default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_invoice_date date;
  v_return_window_days int;
  v_entry_id uuid;
  v_credit_note_id uuid;
  v_goods_issue_id uuid;
  v_line jsonb;
  v_item_id uuid;
  v_qty_returned numeric;
  v_qty_issued numeric;
  v_total_cost numeric;
  v_unit_cost numeric;
  v_line_cost numeric;
  v_total_cost_returned numeric := 0;
  v_qty_before numeric;
  v_avg_before numeric;
  v_hpp_entry_id uuid;
  v_return_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  i int;
  v_remaining_before numeric;
  v_excess numeric;
  v_customer_id uuid;
  v_return_credit_entry_id uuid;
begin
  select invoice_date, return_window_days into v_invoice_date, v_return_window_days
    from ar_invoices where id = p_invoice_id;

  if v_return_window_days is not null and (p_credit_note_date - v_invoice_date) > v_return_window_days then
    raise exception 'Retur invoice % ditolak: toleransi retur customer ini % hari (invoice %, retur diajukan %, telat % hari dari batas)',
      p_invoice_id, v_return_window_days, v_invoice_date, p_credit_note_date,
      (p_credit_note_date - v_invoice_date) - v_return_window_days;
  end if;

  select ar_invoice_remaining(p_invoice_id) into v_remaining_before;

  v_entry_id := create_journal_entry(
    p_credit_note_date, 'Retur barang', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_contra_revenue_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_receivable_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ar_credit_notes (invoice_id, credit_note_date, source_ref, amount, journal_entry_id, created_by)
  values (p_invoice_id, p_credit_note_date, p_source_ref, p_amount, v_entry_id, auth.uid())
  returning id into v_credit_note_id;

  v_excess := greatest(0, p_amount - greatest(0, v_remaining_before));

  if v_excess > 0 then
    if p_return_credit_liability_account_id is null then
      raise exception 'Retur % bikin outstanding invoice jadi minus (excess %) — wajib isi p_return_credit_liability_account_id',
        p_source_ref, v_excess;
    end if;

    select customer_id into v_customer_id from ar_invoices where id = p_invoice_id;

    v_return_credit_entry_id := create_journal_entry(
      p_credit_note_date, 'Saldo kredit dari retur', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_receivable_account_id, 'debit', v_excess, 'credit', 0),
        jsonb_build_object('account_id', p_return_credit_liability_account_id, 'debit', 0, 'credit', v_excess)
      )
    );

    insert into ar_return_credits (customer_id, credit_note_id, amount, journal_entry_id, created_by)
    values (v_customer_id, v_credit_note_id, v_excess, v_return_credit_entry_id, auth.uid());
  end if;

  if p_lines is not null and jsonb_array_length(p_lines) > 0 then
    select id into v_goods_issue_id from goods_issues where invoice_id = p_invoice_id;

    if v_goods_issue_id is null then
      raise exception 'Invoice % gak punya goods_issue — gak bisa retur stok/HPP', p_invoice_id;
    end if;

    for v_line in select * from jsonb_array_elements(p_lines)
    loop
      v_item_id := (v_line->>'item_id')::uuid;
      v_qty_returned := (v_line->>'qty_returned')::numeric;

      select qty_issued, total_cost into v_qty_issued, v_total_cost
        from goods_issue_lines
        where goods_issue_id = v_goods_issue_id and item_id = v_item_id;

      if not found then
        raise exception 'Item % gak ada di goods_issue %, gak bisa diretur', v_item_id, v_goods_issue_id;
      end if;

      v_unit_cost := v_total_cost / v_qty_issued;
      v_line_cost := v_qty_returned * v_unit_cost;
      v_total_cost_returned := v_total_cost_returned + v_line_cost;

      select qty_on_hand, avg_cost into v_qty_before, v_avg_before
        from inventory_balances where item_id = v_item_id;

      update inventory_balances
        set qty_on_hand = v_qty_before + v_qty_returned,
            avg_cost = (v_qty_before * v_avg_before + v_qty_returned * v_unit_cost) / (v_qty_before + v_qty_returned),
            updated_at = now()
        where item_id = v_item_id;

      v_line_items := array_append(v_line_items, v_item_id);
      v_line_qtys := array_append(v_line_qtys, v_qty_returned);
      v_line_costs := array_append(v_line_costs, v_line_cost);
    end loop;

    v_hpp_entry_id := create_journal_entry(
      p_credit_note_date, 'Reversal HPP retur', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_finished_good_account_id, 'debit', v_total_cost_returned, 'credit', 0),
        jsonb_build_object('account_id', p_hpp_account_id, 'debit', 0, 'credit', v_total_cost_returned)
      )
    );

    insert into inventory_returns (credit_note_id, goods_issue_id, journal_entry_id, return_date, source_ref, created_by)
    values (v_credit_note_id, v_goods_issue_id, v_hpp_entry_id, p_credit_note_date, p_source_ref, auth.uid())
    returning id into v_return_id;

    for i in 1..array_length(v_line_items, 1) loop
      insert into inventory_return_lines (inventory_return_id, item_id, qty_returned, total_cost)
      values (v_return_id, v_line_items[i], v_line_qtys[i], v_line_costs[i]);
    end loop;
  end if;

  return v_credit_note_id;
end;
$$;

create or replace function create_warranty_replacement(
  p_credit_note_id uuid,
  p_replacement_date date,
  p_source_ref text,
  p_lines jsonb, -- array of {"item_id":uuid,"qty":numeric}
  p_hpp_account_id uuid,
  p_finished_good_account_id uuid,
  p_contra_revenue_account_id uuid,
  p_receivable_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_replacement_id uuid := gen_random_uuid();
  v_line jsonb;
  v_item_id uuid;
  v_qty numeric;
  v_line_cost numeric;
  v_total_cost numeric := 0;
  v_entry_id uuid;
  v_reversal_entry_id uuid := null;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  i int;
  v_credit_note_amount numeric;
  v_total_returned_cost numeric;
  v_orig_qty_returned numeric;
  v_orig_total_cost numeric;
  v_reversal_share_cost numeric := 0;
  v_reversal_amount numeric;
begin
  if not exists (select 1 from inventory_returns where credit_note_id = p_credit_note_id) then
    raise exception 'Credit note % financial-only (gak ada retur fisik) — gak bisa bikin penukaran barang', p_credit_note_id;
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'Penukaran barang butuh minimal 1 baris item';
  end if;

  select amount into v_credit_note_amount from ar_credit_notes where id = p_credit_note_id;

  select coalesce(sum(irl.total_cost), 0) into v_total_returned_cost
    from inventory_return_lines irl
    join inventory_returns ir on ir.id = irl.inventory_return_id
    where ir.credit_note_id = p_credit_note_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty := (v_line->>'qty')::numeric;

    v_line_cost := consume_weighted_average(v_item_id, v_qty);

    v_line_items := array_append(v_line_items, v_item_id);
    v_line_qtys := array_append(v_line_qtys, v_qty);
    v_line_costs := array_append(v_line_costs, v_line_cost);
    v_total_cost := v_total_cost + v_line_cost;

    select irl.qty_returned, irl.total_cost into v_orig_qty_returned, v_orig_total_cost
      from inventory_return_lines irl
      join inventory_returns ir on ir.id = irl.inventory_return_id
      where ir.credit_note_id = p_credit_note_id and irl.item_id = v_item_id;

    if not found then
      raise exception 'Item % gak ada di retur credit note %, gak bisa ditukar', v_item_id, p_credit_note_id;
    end if;

    v_reversal_share_cost := v_reversal_share_cost + (v_qty * (v_orig_total_cost / v_orig_qty_returned));
  end loop;

  v_entry_id := create_journal_entry(
    p_replacement_date, 'Penukaran barang pasca-retur/garansi', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_hpp_account_id, 'debit', v_total_cost, 'credit', 0),
      jsonb_build_object('account_id', p_finished_good_account_id, 'debit', 0, 'credit', v_total_cost)
    )
  );

  v_reversal_amount := round(v_credit_note_amount * v_reversal_share_cost / v_total_returned_cost, 2);

  if v_reversal_amount > 0 then
    v_reversal_entry_id := create_journal_entry(
      p_replacement_date, 'Pembalikan diskon retur — barang ditukar, bukan didiskon', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_receivable_account_id, 'debit', v_reversal_amount, 'credit', 0),
        jsonb_build_object('account_id', p_contra_revenue_account_id, 'debit', 0, 'credit', v_reversal_amount)
      )
    );
  end if;

  insert into warranty_replacements (
    id, credit_note_id, replacement_date, source_ref, journal_entry_id,
    discount_reversed_amount, discount_reversal_journal_entry_id, created_by
  )
  values (
    v_replacement_id, p_credit_note_id, p_replacement_date, p_source_ref, v_entry_id,
    v_reversal_amount, v_reversal_entry_id, auth.uid()
  );

  for i in 1..array_length(v_line_items, 1) loop
    insert into warranty_replacement_lines (warranty_replacement_id, item_id, qty_replaced, total_cost)
    values (v_replacement_id, v_line_items[i], v_line_qtys[i], v_line_costs[i]);
  end loop;

  return v_replacement_id;
end;
$$;

-- ============================================================
-- 3. Drop consume_fifo + tabel lot + kolom items.costing_method
-- ============================================================
-- DROP TABLE otomatis nyeret trigger/index/RLS policy/grant yang nempel ke tabel itu
-- sendiri (block_edit_delete instance, inventory_lot_consumptions_no_over_consumption
-- trigger instance) — fungsi trigger generik (block_edit_delete) TIDAK ikut ke-drop
-- (dipakai tabel lain). Fungsi guard yang cuma dipakai inventory_lot_consumptions
-- (inventory_lot_consumptions_no_over_consumption) di-drop eksplisit karena gak ada
-- pemakai lain.

drop function if exists consume_fifo(uuid, numeric, text, uuid);

drop table if exists inventory_lot_consumptions;
drop function if exists inventory_lot_consumptions_no_over_consumption();
drop table if exists inventory_lots;

alter table items drop column costing_method;
