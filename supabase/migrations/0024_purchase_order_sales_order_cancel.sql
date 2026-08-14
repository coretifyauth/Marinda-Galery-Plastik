-- Cancel (Batalkan) untuk Purchase Order & Sales Order.
--
-- PO/SO gak pernah bikin journal entry (murni komitmen) tapi tetap immutable total
-- (block_edit_delete) sejak awal — garis pemisahnya bukan "terhubung jurnal atau
-- enggak", tapi "dokumen sumber transaksional vs master data" (lihat
-- memory/preferences/system/state-naming-convention.md). Fitur ini nambah SATU
-- pengecualian terkontrol: PO/SO boleh distempel `cancelled_at` (sekali, gak bisa
-- dibalik) SELAMA belum ada realisasi fisik (GRN/Goods Issue) sama sekali terhadap
-- baris manapun di dalamnya. Beda dari cancel_ar_invoice/cancel_ap_bill (reversing
-- journal entry) — PO/SO emang gak pernah punya jurnal buat dibalik, jadi cancel di
-- sini murni stempel status, gak ada jurnal yang dibuat.
--
-- purchase_order_lines/sales_order_lines TETAP full-immutable (block_edit_delete
-- generik gak disentuh) — cuma header yang dapat kolom+trigger baru.

alter table purchase_orders add column cancelled_at timestamptz;
alter table sales_orders add column cancelled_at timestamptz;

-- ============================================================
-- Purchase Order — selective-lock trigger (niru pola accounts_published_lock)
-- ============================================================

drop trigger purchase_orders_block_edit_delete on purchase_orders;

create function purchase_orders_block_edit_delete_or_cancel() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Purchase order gak pernah bisa dihapus';
  end if;

  if old.cancelled_at is not null then
    raise exception 'Purchase order % udah dibatalkan, gak bisa diubah lagi', old.id;
  end if;

  if (old.supplier_id, old.po_date, old.expected_date, old.source_ref, old.created_by, old.created_at)
     is distinct from (new.supplier_id, new.po_date, new.expected_date, new.source_ref, new.created_by, new.created_at) then
    raise exception 'purchase_orders immutable kecuali cancelled_at';
  end if;

  return new;
end;
$$ language plpgsql;

create trigger purchase_orders_block_edit_delete
  before update or delete on purchase_orders
  for each row execute function purchase_orders_block_edit_delete_or_cancel();

create policy purchase_orders_update on purchase_orders
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  ) with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

grant update on purchase_orders to authenticated;

create function cancel_purchase_order(p_purchase_order_id uuid) returns void
language plpgsql
security invoker
as $$
declare
  v_received_count int;
begin
  select count(*) into v_received_count
  from goods_receipt_lines grl
  join purchase_order_lines pol on pol.id = grl.po_line_id
  where pol.purchase_order_id = p_purchase_order_id;

  if v_received_count > 0 then
    raise exception 'Purchase order % udah punya penerimaan barang — gak bisa dibatalkan', p_purchase_order_id;
  end if;

  update purchase_orders set cancelled_at = now()
  where id = p_purchase_order_id and cancelled_at is null;

  if not found then
    raise exception 'Purchase order % gak ditemukan atau udah dibatalkan', p_purchase_order_id;
  end if;
end;
$$;

grant execute on function cancel_purchase_order(uuid) to authenticated;

-- ============================================================
-- Sales Order — mirror persis Purchase Order
-- ============================================================

drop trigger sales_orders_block_edit_delete on sales_orders;

create function sales_orders_block_edit_delete_or_cancel() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Sales order gak pernah bisa dihapus';
  end if;

  if old.cancelled_at is not null then
    raise exception 'Sales order % udah dibatalkan, gak bisa diubah lagi', old.id;
  end if;

  if (old.customer_id, old.so_date, old.expected_date, old.source_ref, old.created_by, old.created_at)
     is distinct from (new.customer_id, new.so_date, new.expected_date, new.source_ref, new.created_by, new.created_at) then
    raise exception 'sales_orders immutable kecuali cancelled_at';
  end if;

  return new;
end;
$$ language plpgsql;

create trigger sales_orders_block_edit_delete
  before update or delete on sales_orders
  for each row execute function sales_orders_block_edit_delete_or_cancel();

create policy sales_orders_update on sales_orders
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  ) with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

grant update on sales_orders to authenticated;

create function cancel_sales_order(p_sales_order_id uuid) returns void
language plpgsql
security invoker
as $$
declare
  v_issued_count int;
begin
  select count(*) into v_issued_count
  from goods_issue_lines gil
  join sales_order_lines sol on sol.id = gil.so_line_id
  where sol.sales_order_id = p_sales_order_id;

  if v_issued_count > 0 then
    raise exception 'Sales order % udah punya pengiriman barang — gak bisa dibatalkan', p_sales_order_id;
  end if;

  update sales_orders set cancelled_at = now()
  where id = p_sales_order_id and cancelled_at is null;

  if not found then
    raise exception 'Sales order % gak ditemukan atau udah dibatalkan', p_sales_order_id;
  end if;
end;
$$;

grant execute on function cancel_sales_order(uuid) to authenticated;

-- ============================================================
-- Guard sisi realisasi — cancel_purchase_order/cancel_sales_order di atas cuma
-- menjaga satu arah (PO/SO yang UDAH punya realisasi gak bisa dibatalkan). Arah
-- sebaliknya juga wajib dijaga: create_goods_receipt/create_goods_issue gak boleh
-- jalan buat PO/SO yang UDAH dibatalkan. Signature kedua fungsi TIDAK berubah
-- (cuma nambah guard di awal body), jadi aman pakai `create or replace` langsung
-- tanpa drop dulu.
-- ============================================================

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

create or replace function create_goods_issue(
  p_customer_id uuid,
  p_invoice_date date,
  p_description text,
  p_source_ref text,
  p_credit_lines jsonb,
  p_receivable_account_id uuid,
  p_lines jsonb,
  p_hpp_account_id uuid,
  p_finished_good_account_id uuid,
  p_apply_tax boolean default false
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
  v_so_line_id uuid;
  v_line_cost numeric;
  v_total_cost numeric := 0;
  v_entry_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  v_line_so_lines uuid[] := '{}';
  i int;
begin
  if exists (
    select 1
    from jsonb_array_elements(p_lines) as l
    join sales_order_lines sol on sol.id = nullif(l->>'so_line_id', '')::uuid
    join sales_orders so on so.id = sol.sales_order_id
    where so.cancelled_at is not null
  ) then
    raise exception 'Salah satu baris menunjuk sales order yang udah dibatalkan';
  end if;

  v_invoice_id := create_ar_invoice(
    p_customer_id, p_invoice_date, p_description, p_source_ref,
    p_credit_lines, p_receivable_account_id, p_apply_tax
  );

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty := (v_line->>'qty_issued')::numeric;
    v_so_line_id := nullif(v_line->>'so_line_id', '')::uuid;

    v_line_cost := consume_weighted_average(v_item_id, v_qty);

    v_line_items := array_append(v_line_items, v_item_id);
    v_line_qtys := array_append(v_line_qtys, v_qty);
    v_line_costs := array_append(v_line_costs, v_line_cost);
    v_line_so_lines := array_append(v_line_so_lines, v_so_line_id);
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
    insert into goods_issue_lines (goods_issue_id, item_id, qty_issued, total_cost, so_line_id)
    values (v_issue_id, v_line_items[i], v_line_qtys[i], v_line_costs[i], v_line_so_lines[i]);
  end loop;

  return v_issue_id;
end;
$$;
