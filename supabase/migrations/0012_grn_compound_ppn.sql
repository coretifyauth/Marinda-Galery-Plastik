-- Closes memory/scope-debt/grn-kategori-campur-ppn.md -- PO -> GRN -> Bill sekarang mendukung
-- kategori debit campur (mis. Persediaan + Beban Ongkir) dan PPN Masukan, mirror create_ap_bill
-- (0025_compound_transactional_entries_schema.sql).
--
-- WAJIB drop function dulu sebelum create or replace di sini -- ini BUKAN cuma nambah param
-- opsional dengan aman. `create or replace function` cuma "replace beneran" kalau nama+urutan+
-- TIPE parameter yang sudah ada persis sama; begitu daftar parameter berubah (di sini: 2 param
-- baru nambah dari signature yang lama), Postgres malah bikin OVERLOAD KEDUA yang bikin ambigu
-- (error "is not unique") setiap kali dipanggil -- gak peduli 0 param baru maupun 2 param baru
-- yang beda. Pola ini sudah didokumentasikan sebagai pelajaran project ini di
-- memory/architecture/data/ap-schema.md (bug record_ap_payment pra-squash) dan
-- 0010_ap_bill_remaining_return_credit_fix.sql (kebalikannya: gak perlu drop kalau signature
-- BENERAN gak berubah). Migration 0011_document_numbering.sql KELEWATAN aturan ini pas nambah
-- p_supplier_document_ref ke create_ap_bill -- drop di bawah sekalian memperbaiki itu (fix
-- retroaktif, gak bisa edit 0011 langsung karena sudah live-applied).
drop function if exists create_ap_bill(uuid, date, text, text, jsonb, uuid, boolean);
drop function if exists create_goods_receipt(uuid, date, text, jsonb, text, text, uuid, uuid);

create function create_goods_receipt(
  p_purchase_order_id uuid,
  p_receipt_date date,
  p_delivery_note_ref text,
  p_lines jsonb,
  p_bill_description text,
  p_bill_source_ref text,
  p_debit_account_id uuid,
  p_payable_account_id uuid,
  p_extra_debit_lines jsonb default null, -- array of {"account_id":uuid,"amount":numeric} -- Beban tambahan (ongkir, dst), BUKAN kategori Persediaan, BUKAN termasuk PPN
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
