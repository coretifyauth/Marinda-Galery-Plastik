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
-- T1: skenario utama (barang A: 40 pcs @10.000 sudah ditagih dari data lama)
-- ============================================================================================
do $$
declare a uuid := 'b0000000-0000-0000-0000-0000000000a1'; g uuid; bill uuid; s record; v_hpp_before numeric;
begin
  perform pg_temp.check_gl('T1 awal');
  g := pg_temp.grn(a, 100, 10000);
  s := pg_temp.st(a);
  perform pg_temp.assert_eq('T1 Q', s.q, 140); perform pg_temp.assert_eq('T1 U', s.u, 100); perform pg_temp.assert_eq('T1 avg', s.avg, 10000);
  perform pg_temp.check_gl('T1 setelah barang masuk');

  perform pg_temp.sale(a, 60);
  s := pg_temp.st(a);
  perform pg_temp.assert_eq('T1 Q2', s.q, 80); perform pg_temp.assert_eq('T1 U2', s.u, 80); perform pg_temp.assert_eq('T1 SV', s.sv, 200000);
  perform pg_temp.check_gl('T1 setelah jual 60');

  perform pg_temp.revise(g, 10200);
  perform pg_temp.assert_eq('T1 nilai revisi', (select total_value from goods_notes_with_billing_status where id = g), 1020000);
  perform pg_temp.assert_eq('T1 revision_no', (select revision_no from goods_notes_with_billing_status where id = g), 2);
  perform pg_temp.check_gl('T1 setelah revisi');

  v_hpp_before := pg_temp.bal('5100');
  bill := pg_temp.bill(array[g]);
  s := pg_temp.st(a);
  perform pg_temp.assert_eq('T1 Q3', s.q, 80); perform pg_temp.assert_eq('T1 U3', s.u, 0); perform pg_temp.assert_eq('T1 avg baru', s.avg, 10200); perform pg_temp.assert_eq('T1 SV3', s.sv, 0);
  perform pg_temp.assert_eq('T1 koreksi HPP', pg_temp.bal('5100') - v_hpp_before, 4000);
  perform pg_temp.assert_eq('T1 jumlah tagihan', (select amount from transactions where id = bill), 1020000);
  perform pg_temp.assert_eq('T1 GRNI nol', pg_temp.bal('2150'), 0);
  if (select billing_status from goods_notes_with_billing_status where id = g) <> 'tertagih' then raise exception 'T1 status harusnya tertagih'; end if;
  perform pg_temp.check_gl('T1 setelah ditagih');

  perform pg_temp.sale(a, 30);
  s := pg_temp.st(a);
  perform pg_temp.assert_eq('T1 Q4', s.q, 50); perform pg_temp.assert_eq('T1 avg4', s.avg, 10200);
  perform pg_temp.assert_eq('T1 HPP total', pg_temp.bal('5100'), 910000);
  perform pg_temp.check_gl('T1 akhir');
  raise notice 'T1 OK (skenario utama)';
end $$;

-- ============================================================================================
-- T2: kasus ekstrem (aturan lama menghasilkan avg negatif): nota Rp5.000, 95 dari 100 sudah terjual
-- ============================================================================================
do $$
declare c uuid := 'b0000000-0000-0000-0000-0000000000c1'; g1 uuid; g2 uuid; s record; v_hpp_before numeric;
begin
  g1 := pg_temp.grn(c, 40, 10000); perform pg_temp.bill(array[g1]);
  s := pg_temp.st(c); perform pg_temp.assert_eq('T2 avg awal', s.avg, 10000);
  g2 := pg_temp.grn(c, 100, 10000);
  perform pg_temp.sale(c, 135);
  s := pg_temp.st(c);
  perform pg_temp.assert_eq('T2 Q', s.q, 5); perform pg_temp.assert_eq('T2 U', s.u, 5); perform pg_temp.assert_eq('T2 SV', s.sv, 950000);
  perform pg_temp.check_gl('T2 setelah jual 135');
  perform pg_temp.revise(g2, 5000);
  perform pg_temp.check_gl('T2 setelah revisi');
  v_hpp_before := pg_temp.bal('5100');
  perform pg_temp.bill(array[g2]);
  s := pg_temp.st(c);
  perform pg_temp.assert_eq('T2 avg', s.avg, 5000); perform pg_temp.assert_eq('T2 Q', s.q, 5); perform pg_temp.assert_eq('T2 U', s.u, 0);
  perform pg_temp.assert_eq('T2 koreksi HPP (negatif)', pg_temp.bal('5100') - v_hpp_before, -475000);
  perform pg_temp.check_gl('T2 akhir');
  raise notice 'T2 OK (kasus ekstrem, avg tidak negatif)';
end $$;

-- ============================================================================================
-- T3: harga 0 -> tidak bisa dijual / ditagih sampai direvisi
-- ============================================================================================
do $$
declare d uuid := 'b0000000-0000-0000-0000-0000000000d1'; g uuid; s record;
begin
  insert into items (id, name, item_type, uom, inventory_account_id)
    values (d, 'Kantong D', 'RAW_MATERIAL', 'pcs', (select id from accounts where code = '1400'));
  g := pg_temp.grn(d, 50, 0);
  if (select journal_entry_id from goods_notes where id = g) is not null then raise exception 'T3 harusnya tanpa jurnal'; end if;
  s := pg_temp.st(d); perform pg_temp.assert_eq('T3 avg', s.avg, 0); perform pg_temp.assert_eq('T3 U', s.u, 50);
  perform pg_temp.check_gl('T3 barang masuk 0');
  perform pg_temp.expect_error(format('select pg_temp.sale(%L, 5)', d), 'belum punya harga pokok');
  perform pg_temp.expect_error(format('select pg_temp.bill(array[%L::uuid])', g), 'berharga 0');
  perform pg_temp.revise(g, 8000);
  perform pg_temp.assert_eq('T3 jurnal revisi', pg_temp.bal('2150'), pg_temp.bal('2150')); -- sekadar jalan
  perform pg_temp.check_gl('T3 setelah revisi');
  perform pg_temp.expect_error(format('select pg_temp.sale(%L, 5)', d), 'belum punya harga pokok');
  perform pg_temp.bill(array[g]);
  s := pg_temp.st(d); perform pg_temp.assert_eq('T3 avg setelah tagih', s.avg, 8000); perform pg_temp.assert_eq('T3 U', s.u, 0);
  perform pg_temp.sale(d, 10);
  perform pg_temp.check_gl('T3 akhir');
  raise notice 'T3 OK (harga 0)';
end $$;

-- ============================================================================================
-- T4: pembatalan barang masuk belum ditagih
-- ============================================================================================
do $$
declare d uuid := 'b0000000-0000-0000-0000-0000000000d1'; g1 uuid; g2 uuid; s record; q0 numeric;
begin
  s := pg_temp.st(d); q0 := s.q;  -- D: 40 pcs @8000 sudah ditagih
  g1 := pg_temp.grn(d, 20, 8000);
  perform pg_temp.check_gl('T4 g1');
  perform cancel_goods_receipt(g1, '2026-10-10');
  s := pg_temp.st(d); perform pg_temp.assert_eq('T4 Q kembali', s.q, q0); perform pg_temp.assert_eq('T4 U', s.u, 0);
  if (select billing_status from goods_notes_with_billing_status where id = g1) <> 'dibatalkan' then raise exception 'T4 status harusnya dibatalkan'; end if;
  perform pg_temp.check_gl('T4 setelah batal');
  perform pg_temp.expect_error(format('select pg_temp.bill(array[%L::uuid])', g1), 'dibatalkan');
  perform pg_temp.expect_error(format('select cancel_goods_receipt(%L, %L)', g1, '2026-10-10'), 'dibatalkan');

  -- satu barang masuk, sebagian sudah terjual lebih dulu -> batal ditolak (stok kurang)
  g2 := pg_temp.grn(d, 30, 8000, 'a0000000-0000-0000-0000-000000000001', 0, '2026-10-04');
  perform pg_temp.sale(d, q0 + 10);   -- habiskan stok sudah-ditagih lalu 10 dari g2
  s := pg_temp.st(d); perform pg_temp.assert_eq('T4 U setelah spill', s.u, 20);
  perform pg_temp.expect_error(format('select cancel_goods_receipt(%L, %L)', g2, '2026-10-10'), 'gak bisa dibatalkan');
  perform pg_temp.check_gl('T4 spill');
  perform pg_temp.bill(array[g2]);
  perform pg_temp.check_gl('T4 g2 ditagih');

  -- dua barang masuk: stok cukup tapi 10 unit sudah terjual dari yang LEBIH LAMA (FIFO) -> yang lama ditolak, yang baru boleh
  declare ga uuid; gb uuid; sa record;
  begin
    ga := pg_temp.grn(d, 30, 8000, 'a0000000-0000-0000-0000-000000000001', 0, '2026-10-06');
    gb := pg_temp.grn(d, 30, 8000, 'a0000000-0000-0000-0000-000000000001', 0, '2026-10-07');
    sa := pg_temp.st(d);
    perform pg_temp.sale(d, sa.q - sa.u + 10);   -- habiskan sudah-ditagih lalu 10 unit dari ga (paling lama)
    perform pg_temp.expect_error(format('select cancel_goods_receipt(%L, %L)', ga, '2026-10-10'), 'sudah terjual lebih dulu');
    perform cancel_goods_receipt(gb, '2026-10-10');
    perform pg_temp.check_gl('T4 batal yang baru');
    perform pg_temp.bill(array[ga]);
    perform pg_temp.check_gl('T4 akhir');
  end;
  raise notice 'T4 OK (pembatalan barang masuk)';
end $$;

-- ============================================================================================
-- T5: pembatalan tagihan memulihkan kondisi sebelum ditagih; ditolak kalau stok sudah bergerak
-- ============================================================================================
do $$
declare f uuid := 'b0000000-0000-0000-0000-0000000000f1'; g uuid; bill uuid; s record; s0 record;
begin
  insert into items (id, name, item_type, uom, inventory_account_id)
    values (f, 'Kantong F', 'RAW_MATERIAL', 'pcs', (select id from accounts where code = '1400'));
  g := pg_temp.grn(f, 20, 50);
  s0 := pg_temp.st(f);
  bill := pg_temp.bill(array[g]);
  s := pg_temp.st(f); perform pg_temp.assert_eq('T5 avg setelah tagih', s.avg, 50);
  perform cancel_ap_bill(bill, '2026-10-11', 'BTL-T5');
  s := pg_temp.st(f);
  perform pg_temp.assert_eq('T5 avg pulih', s.avg, s0.avg); perform pg_temp.assert_eq('T5 U pulih', s.u, s0.u); perform pg_temp.assert_eq('T5 Q', s.q, 20);
  if (select billing_status from goods_notes_with_billing_status where id = g) <> 'belum_tertagih' then raise exception 'T5 harusnya kembali belum_tertagih'; end if;
  perform pg_temp.check_gl('T5 setelah batal tagihan');
  -- ditagih ulang + stok bergerak -> batal ditolak
  bill := pg_temp.bill(array[g]);
  perform pg_temp.sale(f, 5);
  perform pg_temp.expect_error(format('select cancel_ap_bill(%L, %L, %L)', bill, '2026-10-12', 'BTL-T5B'), 'sudah bergerak');
  perform pg_temp.check_gl('T5 akhir');
  raise notice 'T5 OK (pembatalan tagihan)';
end $$;

-- ============================================================================================
-- T6: banyak barang masuk 1 tagihan, supplier beda, tagih dua kali; T7: retur lintas barang masuk
-- ============================================================================================
do $$
declare g uuid := 'b0000000-0000-0000-0000-0000000000a2'; i1 uuid; i2 uuid; i3 uuid; bill uuid; rid uuid; s record;
begin
  insert into items (id, name, item_type, uom, inventory_account_id)
    values (g, 'Kantong G', 'RAW_MATERIAL', 'pcs', (select id from accounts where code = '1400'));
  i1 := pg_temp.grn(g, 10, 100);
  i2 := pg_temp.grn(g, 15, 120);
  i3 := pg_temp.grn(g, 5, 100, 'a0000000-0000-0000-0000-000000000002');
  perform pg_temp.expect_error(format('select pg_temp.bill(array[%L::uuid, %L::uuid])', i1, i3), 'supplier lain');
  bill := pg_temp.bill(array[i1, i2]);
  perform pg_temp.assert_eq('T6 jumlah', (select amount from transactions where id = bill), 10 * 100 + 15 * 120);
  s := pg_temp.st(g); perform pg_temp.assert_eq('T6 avg', s.avg, (10 * 100 + 15 * 120)::numeric / 25, 0.01); perform pg_temp.assert_eq('T6 U', s.u, 5);
  perform pg_temp.expect_error(format('select pg_temp.bill(array[%L::uuid])', i1), 'berstatus');
  perform pg_temp.check_gl('T6');

  -- T7 retur 20 (<= 25 total lintas 2 barang masuk) boleh; tambahan 6 -> 26 > 25 ditolak
  rid := create_ap_return(bill, '2026-10-13', 'RET-T7', 0, (select id from accounts where code = '2100'), (select id from accounts where code = '1400'),
    jsonb_build_array(jsonb_build_object('item_id', g, 'qty_returned', 20)), (select id from accounts where code = '1350'));
  perform pg_temp.expect_error(format($f$select create_ap_return(%L, '2026-10-13', 'RET-T7B', 0, %L, %L, %L::jsonb, %L)$f$,
    bill, (select id from accounts where code = '2100'), (select id from accounts where code = '1400'),
    jsonb_build_array(jsonb_build_object('item_id', g, 'qty_returned', 6))::text, (select id from accounts where code = '1350')), 'melebihi');
  raise notice 'T6/T7 OK (banyak barang masuk per tagihan, retur lintas barang masuk)';
end $$;

-- ============================================================================================
-- T8: revisi hanya selama belum ditagih; opname & fungsi bantu
-- ============================================================================================
do $$
declare h uuid := 'b0000000-0000-0000-0000-0000000000e1'; g uuid; s record; lines jsonb;
begin
  insert into items (id, name, item_type, uom, inventory_account_id)
    values (h, 'Kantong H', 'RAW_MATERIAL', 'pcs', (select id from accounts where code = '1400'));
  g := pg_temp.grn(h, 20, 100, 'a0000000-0000-0000-0000-000000000001', 100);   -- diskon item 100 -> nilai 1.900
  perform pg_temp.assert_eq('T8 nilai dg diskon', (select total_value from goods_notes_with_billing_status where id = g), 1900);
  perform pg_temp.expect_error(format('select record_stock_opname(%L, %L, %L::jsonb, %L, %L)', '2026-10-14', 'SOP-T8',
    jsonb_build_array(jsonb_build_object('item_id', h, 'qty_actual', 18, 'inventory_account_id', (select id from accounts where code = '1400')))::text,
    (select id from accounts where code = '6000'), (select id from accounts where code = '4400')), 'belum punya harga pokok');
  perform pg_temp.bill(array[g]);
  perform pg_temp.expect_error(format('select pg_temp.revise(%L, 90)', g), 'revisi cuma boleh selama belum ditagih');

  -- fungsi bantu: campur avg memakai stok sudah-ditagih (Q=20,U=0,avg=95) lalu barang masuk belum ditagih 10
  g := pg_temp.grn(h, 10, 100);
  s := pg_temp.st(h); perform pg_temp.assert_eq('T8 Q', s.q, 30); perform pg_temp.assert_eq('T8 U', s.u, 10);
  perform inventory_add_billed(h, 10, 125);   -- P=20 avg=95 -> (20*95+10*125)/30 = 105
  -- fungsi bantu dipanggil langsung (tanpa transaksi pembelian) -> beri jurnal pasangan supaya buku besar tetap cocok
  perform create_journal_entry('2026-10-14', 'Uji nilai barang tambahan', 'JE-T8',
    jsonb_build_array(jsonb_build_object('account_id', (select id from accounts where code = '1400'), 'debit', 1250, 'credit', 0),
                      jsonb_build_object('account_id', (select id from accounts where code = '3100'), 'debit', 0, 'credit', 1250)));
  s := pg_temp.st(h); perform pg_temp.assert_eq('T8 avg campur (pakai P bukan Q)', s.avg, 105); perform pg_temp.assert_eq('T8 Q2', s.q, 40);
  -- opname kekurangan 2 pcs lewat consume (pembagian pool konsisten)
  perform record_stock_opname('2026-10-14', 'SOP-T8B',
    jsonb_build_array(jsonb_build_object('item_id', h, 'qty_actual', 38, 'inventory_account_id', (select id from accounts where code = '1400'))),
    (select id from accounts where code = '6000'), (select id from accounts where code = '4400'));
  s := pg_temp.st(h); perform pg_temp.assert_eq('T8 Q opname', s.q, 38);
  raise notice 'T8 OK (revisi terkunci, opname, fungsi bantu)';
end $$;

-- ============================================================================================
-- T9: data lama tetap bekerja (retur atas tagihan bundel, pembatalan tagihan bundel)
-- ============================================================================================
do $$
declare b uuid := 'b0000000-0000-0000-0000-0000000000b1'; bill uuid; s record;
begin
  select t.id into bill from transactions t where t.source_ref = 'APB-LAMA-2';
  s := pg_temp.st(b); perform pg_temp.assert_eq('T9 awal Q', s.q, 10); perform pg_temp.assert_eq('T9 awal avg', s.avg, 4800);
  perform cancel_ap_bill(bill, '2026-10-15', 'BTL-LAMA-2');
  s := pg_temp.st(b); perform pg_temp.assert_eq('T9 Q setelah batal', s.q, 0);
  if (select status from transactions where id = bill) <> 'dibatalkan' then raise exception 'T9 status tagihan lama harusnya dibatalkan'; end if;
  if (select billing_status from goods_notes_with_billing_status where counterparty_id = 'a0000000-0000-0000-0000-000000000002' and inbound_flow = 'bundled' limit 1) <> 'dibatalkan' then
    raise exception 'T9 barang masuk lama harusnya dibatalkan';
  end if;
  raise notice 'T9 OK (alur lama tetap bekerja)';
end $$;

select 'SEMUA TES LULUS' as hasil;
select 'GL 1400' k, pg_temp.bal('1400') v union all select 'GRNI 2150', -pg_temp.bal('2150') union all select 'HPP 5100', pg_temp.bal('5100');
