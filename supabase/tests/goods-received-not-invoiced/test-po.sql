\set ON_ERROR_STOP on
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","email":"tester@example.com"}', false);

-- ---------- helper ----------
create or replace function pg_temp.bal(p_code text) returns numeric language sql as $$
  select coalesce(sum(jl.debit - jl.credit), 0) from journal_lines jl join accounts a on a.id = jl.account_id where a.code = p_code
$$;
create or replace function pg_temp.assert_eq(p_label text, p_actual numeric, p_expected numeric, p_tol numeric default 0.01) returns void language plpgsql as $$
begin
  if p_actual is null or abs(p_actual - p_expected) > p_tol then
    raise exception 'ASSERT GAGAL [%]: actual=% expected=%', p_label, p_actual, p_expected;
  end if;
end $$;
create or replace function pg_temp.st(p_item uuid, out q numeric, out u numeric, out avg numeric, out sv numeric) language sql as $$
  select qty_on_hand, qty_unbilled, avg_cost, spill_value from inventory_balances where item_id = p_item
$$;
create or replace function pg_temp.expect_error(p_sql text, p_contains text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if position(p_contains in sqlerrm) = 0 then
      raise exception 'Error beda dari yang diharapkan: [%] (harusnya mengandung "%")', sqlerrm, p_contains;
    end if;
    return;
  end;
  raise exception 'Seharusnya error "%" tapi berhasil: %', p_contains, p_sql;
end $$;
create or replace function pg_temp.sale(p_item uuid, p_qty numeric, p_price numeric default 15000) returns uuid language plpgsql as $$
declare v_ref text := 'ARI-T-' || substr(gen_random_uuid()::text, 1, 8);
begin
  return create_goods_issue('a0000000-0000-0000-0000-000000000003', '2026-10-09', 'Penjualan uji', v_ref,
    jsonb_build_array(jsonb_build_object('account_id', (select id from accounts where code = '4200'), 'amount', p_qty * p_price)),
    (select id from accounts where code = '1300'),
    jsonb_build_array(jsonb_build_object('item_id', p_item, 'qty_issued', p_qty, 'unit_price', p_price)),
    (select id from accounts where code = '5100'), (select id from accounts where code = '1400'), false);
end $$;
create or replace function pg_temp.grn(p_item uuid, p_qty numeric, p_cost numeric, p_supplier uuid default 'a0000000-0000-0000-0000-000000000001', p_disc numeric default 0, p_date date default '2026-10-05') returns uuid language plpgsql as $$
begin
  return create_goods_receipt(null, p_date, 'SJ-' || substr(gen_random_uuid()::text, 1, 6),
    jsonb_build_array(jsonb_build_object('order_line_id', '', 'item_id', p_item, 'qty_received', p_qty, 'unit_cost', p_cost, 'discount_amount', p_disc)),
    (select id from accounts where code = '1400'), p_supplier, 0);
end $$;
create or replace function pg_temp.bill(p_ids uuid[]) returns uuid language plpgsql as $$
begin
  return create_ap_bill_from_goods_receipts(p_ids, '2026-10-08', 'Tagihan uji', 'APB-T-' || substr(gen_random_uuid()::text, 1, 8),
    (select id from accounts where code = '2100'));
end $$;
create or replace function pg_temp.revise(p_note uuid, p_cost numeric, p_date date default '2026-10-07') returns uuid language plpgsql as $$
declare v_lines jsonb;
begin
  select jsonb_agg(jsonb_build_object('goods_note_line_id', id, 'unit_cost', p_cost, 'discount_amount', 0)) into v_lines from goods_note_lines where goods_note_id = p_note;
  return revise_goods_receipt(p_note, p_date, v_lines, (select id from accounts where code = '1400'));
end $$;

-- invarian GL: Persediaan(1400) = sum P*avg + sum nilai barang masuk belum ditagih - sum spill_value ; GRNI(2150) = sum nilai belum ditagih
create or replace function pg_temp.check_gl(p_label text) returns void language plpgsql as $$
declare v_exp numeric; v_unb numeric; v_items int;
begin
  select coalesce(sum(total_value), 0) into v_unb from goods_notes_with_billing_status where billing_status = 'belum_tertagih';
  select count(*) into v_items from inventory_balances;
  v_exp := coalesce((select sum((qty_on_hand - qty_unbilled) * avg_cost) from inventory_balances), 0) + v_unb
           - coalesce((select sum(spill_value) from inventory_balances), 0);
  perform pg_temp.assert_eq(p_label || ' / Persediaan 1400', pg_temp.bal('1400'), v_exp, 0.51 * greatest(v_items, 1) * 100);
  perform pg_temp.assert_eq(p_label || ' / GRNI 2150', -pg_temp.bal('2150'), v_unb, 0.01);
  if exists (select 1 from inventory_balances where qty_unbilled < -0.0005 or qty_unbilled > qty_on_hand + 0.0005 or spill_value < -0.0005) then
    raise exception 'INVARIAN GAGAL [%]: qty_unbilled/spill_value di luar batas', p_label;
  end if;
end $$;


-- ============================================================================================
-- PO: status order, anti-over-fulfill, pembatalan barang masuk membebaskan qty PO, cancel PO
-- ============================================================================================
do $$
declare p uuid := 'b0000000-0000-0000-0000-0000000000a8'; so uuid; ol uuid; g1 uuid; g2 uuid; v_status text; v_lines jsonb; bill uuid;
begin
  insert into items (id, name, item_type, uom, inventory_account_id)
    values (p, 'Kantong PO', 'RAW_MATERIAL', 'pcs', (select id from accounts where code = '1400'));
  so := create_order('PURCHASE', 'a0000000-0000-0000-0000-000000000001', '2026-10-01', '2026-10-10', 'PO-T-1',
    jsonb_build_array(jsonb_build_object('item_id', p, 'qty_ordered', 100, 'unit_price', 500)));
  select id into ol from order_lines where order_id = so;
  select status into v_status from orders where id = so; if v_status <> 'OPEN' then raise exception 'PO awal harusnya OPEN, dapat %', v_status; end if;

  -- terima 60 dari PO
  g1 := create_goods_receipt(so, '2026-10-05', 'SJ-PO-1',
    jsonb_build_array(jsonb_build_object('order_line_id', ol, 'item_id', p, 'qty_received', 60, 'unit_cost', 500)),
    (select id from accounts where code = '1400'), null, 0);
  select status into v_status from orders where id = so; if v_status <> 'PARTIALLY_RECEIVED' then raise exception 'PO harusnya PARTIALLY_RECEIVED, dapat %', v_status; end if;

  -- over-fulfill: 60 + 50 > 100 ditolak
  perform pg_temp.expect_error(format($f$select create_goods_receipt(%L, '2026-10-06', 'SJ-PO-2', %L::jsonb, %L, null, 0)$f$, so,
    jsonb_build_array(jsonb_build_object('order_line_id', ol, 'item_id', p, 'qty_received', 50, 'unit_cost', 500))::text,
    (select id from accounts where code = '1400')), 'melebihi qty dipesan');

  -- batalkan barang masuk pertama (belum ditagih) -> qty PO dibebaskan, PO kembali OPEN
  perform cancel_goods_receipt(g1, '2026-10-07');
  select status into v_status from orders where id = so; if v_status <> 'OPEN' then raise exception 'PO setelah batal harusnya OPEN, dapat %', v_status; end if;

  -- terima penuh 100, tagih -> FULLY_RECEIVED, PO tidak bisa dibatalkan
  g2 := create_goods_receipt(so, '2026-10-08', 'SJ-PO-3',
    jsonb_build_array(jsonb_build_object('order_line_id', ol, 'item_id', p, 'qty_received', 100, 'unit_cost', 500)),
    (select id from accounts where code = '1400'), null, 0);
  select status into v_status from orders where id = so; if v_status <> 'FULLY_RECEIVED' then raise exception 'PO harusnya FULLY_RECEIVED, dapat %', v_status; end if;
  bill := pg_temp.bill(array[g2]);
  if (select origin from transactions where id = bill) <> 'order' then raise exception 'origin tagihan harusnya order'; end if;
  perform pg_temp.expect_error(format('select cancel_order(%L)', so), 'udah punya penerimaan');

  -- batalkan TAGIHAN -> barang masuk kembali belum tertagih tapi tetap dihitung diterima (PO tetap FULLY_RECEIVED)
  perform cancel_ap_bill(bill, '2026-10-09', 'BTL-PO');
  select status into v_status from orders where id = so; if v_status <> 'FULLY_RECEIVED' then raise exception 'PO setelah batal tagihan harusnya tetap FULLY_RECEIVED, dapat %', v_status; end if;
  if (select billing_status from goods_notes_with_billing_status where id = g2) <> 'belum_tertagih' then raise exception 'g2 harusnya belum_tertagih'; end if;
  raise notice 'PO OK (status order, anti over-fulfill, pembatalan, origin)';
end $$;

-- ============================================================================================
-- Produksi: hasil produksi memakai stok sudah-ditagih (inventory_add_billed) untuk avg barang jadi
-- ============================================================================================
do $$
declare raw uuid := 'b0000000-0000-0000-0000-0000000000a1'; fg uuid := 'b0000000-0000-0000-0000-0000000000f9'; bom uuid; po uuid; s record; fgr_before numeric;
begin
  insert into items (id, name, item_type, uom, inventory_account_id)
    values (fg, 'Barang Jadi Uji', 'FINISHED_GOOD', 'pcs', (select id from accounts where code = '1420'));
  insert into bom_headers (finished_item_id, output_qty) values (fg, 10) returning id into bom;
  insert into bom_lines (bom_header_id, raw_material_item_id, qty_per_batch) values (bom, raw, 5);
  -- bahan baku A: barang masuk belum ditagih ikut menambah qty, produksi tetap pakai avg_cost sudah-ditagih
  perform pg_temp.grn(raw, 30, 99999);
  s := pg_temp.st(raw);
  po := create_production_order(bom, 20, '2026-10-17', 'PRD-T-1', (select id from accounts where code = '1420'), (select id from accounts where code = '1400'));
  s := pg_temp.st(fg);
  -- 20 unit = 2 batch x 5 bahan = 10 bahan @ avg A (bukan 99999) => biaya/unit = 10 x avgA / 20
  perform pg_temp.assert_eq('PRD avg barang jadi', s.avg, 10 * (select avg_cost from inventory_balances where item_id = raw) / 20, 0.02);
  perform pg_temp.assert_eq('PRD Q barang jadi', s.q, 20);
  perform pg_temp.assert_eq('PRD U barang jadi', s.u, 0);
  raise notice 'PRD OK (produksi pakai avg sudah-ditagih)';
end $$;
select 'PO+PRD TES LULUS' as hasil;
