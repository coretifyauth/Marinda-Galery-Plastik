-- Purchase Order Gak Wajib Lagi Sebelum Penerimaan Barang — Fase 2 dari
-- memory/scope-debt/order-generalization.md (keputusan owner, 2026-09-03).
--
-- Konteks: dulu gak ada jalur terima barang tanpa PO sama sekali (goods_receipt_notes.
-- purchase_order_id + goods_receipt_lines.po_line_id keduanya not null). Mirror Sales Order
-- yang udah opsional sejak migration 0024 (goods_issue_lines.so_line_id nullable) — sekarang
-- Goods Receipt juga bisa dibuat langsung tanpa PO, buat kasus beli dadakan (misal beli
-- langsung di toko, gak lewat proses PO formal).
--
-- Beda dari Fase AR warranty replacement (0057): gak ada data existing yang perlu dibackfill
-- di sini (cuma melonggarkan constraint, bukan mindahin data ke kolom baru) — jadi gak perlu
-- disable/enable trigger imutabilitas apa pun.

-- ============================================================
-- 1. Kolom jadi nullable
-- ============================================================

alter table goods_receipt_notes alter column purchase_order_id drop not null;
alter table goods_receipt_lines alter column po_line_id drop not null;

-- ============================================================
-- 2. Trigger goods_receipt_lines_no_over_receipt — skip cek kalau po_line_id NULL, mirror
--    persis pola goods_issue_lines_no_over_issue yang udah skip kalau so_line_id null.
-- ============================================================

create or replace function goods_receipt_lines_no_over_receipt() returns trigger as $$
declare
  v_qty_ordered numeric;
  v_qty_received numeric;
  v_item_name text;
begin
  if new.po_line_id is null then
    return new;
  end if;

  select qty_ordered into v_qty_ordered from purchase_order_lines where id = new.po_line_id;
  select coalesce(sum(qty_received), 0) into v_qty_received
    from goods_receipt_lines where po_line_id = new.po_line_id;

  if v_qty_received + new.qty_received > v_qty_ordered then
    select name into v_item_name from items where id = new.item_id;
    raise exception 'Penerimaan item "%" melebihi qty dipesan (sisa %, coba terima %)',
      v_item_name, v_qty_ordered - v_qty_received, new.qty_received;
  end if;

  return new;
end;
$$ language plpgsql;

-- ============================================================
-- 3. create_goods_receipt — signature nambah 1 parameter baru di akhir (p_supplier_id,
--    wajib diisi kalau p_purchase_order_id NULL). WAJIB drop function dulu sebelum create
--    ulang -- daftar parameter berubah (bukan cuma nambah default di signature yang
--    identik), kalau enggak Postgres bikin overload ambigu (pelajaran dari bug 0011/0012
--    create_ap_bill, sudah pernah kejadian persis di project ini, dan lagi di 0057).
-- ============================================================

drop function if exists create_goods_receipt(uuid, date, text, jsonb, text, text, uuid, uuid, jsonb, boolean);

create function create_goods_receipt(
  p_purchase_order_id uuid,
  p_receipt_date date,
  p_delivery_note_ref text,
  p_lines jsonb, -- array of {"po_line_id":uuid|null,"item_id":uuid,"qty_received":numeric,"unit_cost":numeric}
  p_bill_description text,
  p_bill_source_ref text,
  p_debit_account_id uuid,
  p_payable_account_id uuid,
  p_extra_debit_lines jsonb default null,
  p_apply_tax boolean default false,
  p_supplier_id uuid default null -- wajib diisi kalau p_purchase_order_id NULL (terima barang langsung)
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
  if p_purchase_order_id is not null then
    select supplier_id into v_supplier_id from purchase_orders where id = p_purchase_order_id;

    if exists (select 1 from purchase_orders where id = p_purchase_order_id and cancelled_at is not null) then
      raise exception 'Purchase order % udah dibatalkan — gak bisa dibuat penerimaan barang', p_purchase_order_id;
    end if;
  else
    if p_supplier_id is null then
      raise exception 'Wajib pilih supplier kalau terima barang langsung tanpa Purchase Order';
    end if;

    if not exists (select 1 from suppliers where id = p_supplier_id) then
      raise exception 'Supplier % gak ditemukan', p_supplier_id;
    end if;

    v_supplier_id := p_supplier_id;
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
    values (v_grn_id, nullif(v_line->>'po_line_id', '')::uuid, v_item_id, v_qty_received, v_unit_cost)
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
