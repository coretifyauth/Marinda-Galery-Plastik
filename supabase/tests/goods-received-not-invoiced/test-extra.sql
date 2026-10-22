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
  -- hanya item yang akun Persediaannya 1400 (barang jadi di 1420 dikecualikan)
  v_exp := coalesce((select sum((b.qty_on_hand - b.qty_unbilled) * b.avg_cost) from inventory_balances b
                     join items i on i.id = b.item_id where i.inventory_account_id = (select id from accounts where code = '1400')), 0) + v_unb
           - coalesce((select sum(b.spill_value) from inventory_balances b
                       join items i on i.id = b.item_id where i.inventory_account_id = (select id from accounts where code = '1400')), 0);
  perform pg_temp.assert_eq(p_label || ' / Persediaan 1400', pg_temp.bal('1400'), v_exp, 0.51 * greatest(v_items, 1) * 100);
  perform pg_temp.assert_eq(p_label || ' / GRNI 2150', -pg_temp.bal('2150'), v_unb, 0.01);
  if exists (select 1 from inventory_balances where qty_unbilled < -0.0005 or qty_unbilled > qty_on_hand + 0.0005 or spill_value < -0.0005) then
    raise exception 'INVARIAN GAGAL [%]: qty_unbilled/spill_value di luar batas', p_label;
  end if;
end $$;

-- ============================================================================================
-- T10 (review W1): penjualan yang SUDAH menghabiskan stok sudah-ditagih lalu dibatalkan -> spill diisi kembali,
-- penagihan sesudahnya TIDAK menjurnal koreksi HPP palsu
-- ============================================================================================
do $$
declare j uuid := 'b0000000-0000-0000-0000-0000000000aa'; g0 uuid; g1 uuid; inv uuid; tx uuid; s record; hpp0 numeric;
begin
  insert into items (id, name, item_type, uom, inventory_account_id)
    values (j, 'Kantong J', 'RAW_MATERIAL', 'pcs', (select id from accounts where code = '1400'));
  g0 := pg_temp.grn(j, 5, 80); perform pg_temp.bill(array[g0]);
  g1 := pg_temp.grn(j, 10, 100);
  inv := pg_temp.sale(j, 8);                       -- 5 dari stok sudah-ditagih + 3 spill dari g1
  s := pg_temp.st(j);
  perform pg_temp.assert_eq('T10 Q', s.q, 7); perform pg_temp.assert_eq('T10 U', s.u, 7); perform pg_temp.assert_eq('T10 SV', s.sv, 240);
  select transaction_id into tx from goods_notes where id = inv;
  perform cancel_ar_invoice(tx, '2026-10-12', 'BTL-T10');
  s := pg_temp.st(j);
  perform pg_temp.assert_eq('T10 Q pulih', s.q, 15); perform pg_temp.assert_eq('T10 U pulih', s.u, 10); perform pg_temp.assert_eq('T10 SV pulih', s.sv, 0);
  perform pg_temp.check_gl('T10 setelah batal penjualan');
  hpp0 := pg_temp.bal('5100');
  perform pg_temp.bill(array[g1]);
  perform pg_temp.assert_eq('T10 tanpa koreksi HPP palsu', pg_temp.bal('5100') - hpp0, 0);
  s := pg_temp.st(j);
  perform pg_temp.assert_eq('T10 avg', s.avg, (5 * 80 + 10 * 100)::numeric / 15, 0.01);
  perform pg_temp.check_gl('T10 akhir');
  raise notice 'T10 OK (pembatalan penjualan mengisi kembali spill)';
end $$;

-- ============================================================================================
-- T11 (review W2): retur dari customer -- avg dicampur dengan stok sudah-ditagih saja, spill diisi kembali dulu
-- ============================================================================================
do $$
declare k uuid := 'b0000000-0000-0000-0000-0000000000ab'; g0 uuid; g1 uuid; inv uuid; tx uuid; s record;
begin
  insert into items (id, name, item_type, uom, inventory_account_id)
    values (k, 'Kantong K', 'RAW_MATERIAL', 'pcs', (select id from accounts where code = '1400'));
  g0 := pg_temp.grn(k, 5, 80); perform pg_temp.bill(array[g0]);
  g1 := pg_temp.grn(k, 10, 100);
  inv := pg_temp.sale(k, 8);                       -- 3 spill
  select transaction_id into tx from goods_notes where id = inv;
  perform create_ar_return(tx, '2026-10-13', 'RET-T11', 120000,
    (select id from accounts where code = '4900'), (select id from accounts where code = '1300'),
    jsonb_build_array(jsonb_build_object('item_id', k, 'qty_returned', 8)),
    (select id from accounts where code = '5100'), (select id from accounts where code = '1400'), (select id from accounts where code = '2500'));
  s := pg_temp.st(k);
  perform pg_temp.assert_eq('T11 Q', s.q, 15); perform pg_temp.assert_eq('T11 U', s.u, 10); perform pg_temp.assert_eq('T11 SV', s.sv, 0);
  perform pg_temp.assert_eq('T11 avg tetap', s.avg, 80);
  perform pg_temp.check_gl('T11 setelah retur');
  perform pg_temp.bill(array[g1]);
  perform pg_temp.check_gl('T11 akhir');
  raise notice 'T11 OK (retur dari customer)';
end $$;

-- ============================================================================================
-- T12 (review W4): barang masuk bernilai 0 (tanpa jurnal) tetap tidak boleh bertanggal di periode tertutup
-- ============================================================================================
do $$
declare m uuid := 'b0000000-0000-0000-0000-0000000000ac'; g uuid;
begin
  insert into items (id, name, item_type, uom, inventory_account_id)
    values (m, 'Kantong M', 'RAW_MATERIAL', 'pcs', (select id from accounts where code = '1400'));
  g := pg_temp.grn(m, 5, 0);                       -- Oktober, belum ada periode tertutup
  insert into period_closings (start_date, end_date, journal_entry_id, source_ref, created_by)
    values ('2026-09-01', '2026-09-30', (select id from journal_entries limit 1), 'CLS-T12', '11111111-1111-1111-1111-111111111111');
  perform pg_temp.expect_error(format('select pg_temp.grn(%L, 5, 0, %L, 0, %L)', m, 'a0000000-0000-0000-0000-000000000001', '2026-09-15'), 'periode yang ditutup');
  perform pg_temp.expect_error(format('select pg_temp.revise(%L, 100, %L)', g, '2026-09-20'), 'periode yang ditutup');
  perform pg_temp.expect_error(format('select cancel_goods_receipt(%L, %L)', g, '2026-09-20'), 'periode yang ditutup');
  raise notice 'T12 OK (periode tertutup)';
end $$;
select 'TES TAMBAHAN LULUS' as hasil;
