\set ON_ERROR_STOP on
-- Tes migration 0057 (Tagihan Dulu, Barang Menyusul). Database LOKAL saja, setelah fixtures-live-like.sql,
-- 0056, stage-0056.sql, dan 0057. Berhenti dengan error kalau ada invarian yang bocor.
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
create or replace function pg_temp.assert_true(p_label text, p_cond boolean) returns void language plpgsql as $$
begin
  if p_cond is not true then raise exception 'ASSERT GAGAL [%]', p_label; end if;
end $$;
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
create or replace function pg_temp.acct(p_code text) returns uuid language sql as $$ select id from accounts where code = p_code $$;
create or replace function pg_temp.st(p_item uuid, out q numeric, out avg numeric) language sql as $$
  select qty_on_hand, avg_cost from inventory_balances where item_id = p_item
$$;
create or replace function pg_temp.sale(p_item uuid, p_qty numeric, p_price numeric default 15000) returns uuid language plpgsql as $$
declare v_ref text := 'ARI-N-' || substr(gen_random_uuid()::text, 1, 8);
begin
  return create_goods_issue('a0000000-0000-0000-0000-000000000003', '2026-10-25', 'Penjualan uji', v_ref,
    jsonb_build_array(jsonb_build_object('account_id', pg_temp.acct('4200'), 'amount', p_qty * p_price)),
    pg_temp.acct('1300'),
    jsonb_build_array(jsonb_build_object('item_id', p_item, 'qty_issued', p_qty, 'unit_price', p_price)),
    pg_temp.acct('5100'), pg_temp.acct('1400'), false);
end $$;
create or replace function pg_temp.pbill(p_goods numeric, p_supplier uuid default 'a0000000-0000-0000-0000-000000000001', p_extra jsonb default null, p_date date default '2026-10-24') returns uuid language plpgsql as $$
begin
  return create_ap_bill_with_goods_pool(p_supplier, p_date, 'Tagihan barang uji', 'APB-N-' || substr(gen_random_uuid()::text, 1, 8),
    pg_temp.acct('2100'), p_goods, p_extra);
end $$;
create or replace function pg_temp.grn(p_bill uuid, p_item uuid, p_qty numeric, p_cost numeric, p_disc numeric default 0, p_order uuid default null, p_order_line uuid default null, p_date date default '2026-10-25') returns uuid language plpgsql as $$
begin
  return create_goods_receipt(p_bill, p_date, 'SJ-N-' || substr(gen_random_uuid()::text, 1, 6),
    jsonb_build_array(jsonb_build_object('order_line_id', coalesce(p_order_line::text, ''), 'item_id', p_item, 'qty_received', p_qty, 'unit_cost', p_cost)),
    pg_temp.acct('1400'), p_order, p_disc);
end $$;
create or replace function pg_temp.rem(p_bill uuid) returns numeric language sql as $$ select ap_bill_pool_remaining(p_bill) $$;

insert into items (id, name, item_type, uom, inventory_account_id) values
  ('b0000000-0000-0000-0000-0000000000d1','Kantong D','RAW_MATERIAL','pcs',(select id from accounts where code='1400')),
  ('b0000000-0000-0000-0000-0000000000e1','Kantong E','RAW_MATERIAL','pcs',(select id from accounts where code='1400')),
  ('b0000000-0000-0000-0000-0000000000f1','Kantong F','RAW_MATERIAL','pcs',(select id from accounts where code='1400')),
  ('b0000000-0000-0000-0000-0000000000a7','Kantong G (PO)','RAW_MATERIAL','pcs',(select id from accounts where code='1400'));

-- ============================================================================================
-- T0. Data lama utuh setelah 0057 (dibandingkan dengan snapshot sebelum 0057)
-- ============================================================================================
do $$
declare v_diff int;
begin
  select count(*) into v_diff from (select * from snap.goods_notes except select * from goods_notes) x;
  perform pg_temp.assert_eq('T0 goods_notes: baris snapshot hilang/berubah', v_diff, 0, 0);
  select count(*) into v_diff from (select * from goods_notes except select * from snap.goods_notes) x;
  perform pg_temp.assert_eq('T0 goods_notes: baris baru muncul', v_diff, 0, 0);
  select count(*) into v_diff from (select * from snap.goods_note_lines except select * from goods_note_lines) x;
  perform pg_temp.assert_eq('T0 goods_note_lines', v_diff, 0, 0);
  select count(*) into v_diff from (select * from snap.goods_note_billings except select * from goods_note_billings) x;
  perform pg_temp.assert_eq('T0 goods_note_billings', v_diff, 0, 0);
  select count(*) into v_diff from (select * from snap.goods_note_cancellations except select * from goods_note_cancellations) x;
  perform pg_temp.assert_eq('T0 goods_note_cancellations', v_diff, 0, 0);
  select count(*) into v_diff from (select * from snap.inventory_balances except select * from inventory_balances) x;
  perform pg_temp.assert_eq('T0 inventory_balances', v_diff, 0, 0);
  select count(*) into v_diff from (select * from snap.inventory_movements except select * from inventory_movements) x;
  perform pg_temp.assert_eq('T0 inventory_movements', v_diff, 0, 0);
  select count(*) into v_diff from (select * from snap.transactions except select id, type, counterparty_id, amount, outstanding, status, origin, journal_entry_id from transactions) x;
  perform pg_temp.assert_eq('T0 transactions (termasuk status & origin)', v_diff, 0, 0);
  select count(*) into v_diff from (select * from snap.journal_lines except select * from journal_lines) x;
  perform pg_temp.assert_eq('T0 journal_lines', v_diff, 0, 0);
  select count(*) into v_diff from (select * from snap.gl except select a.code, sum(jl.debit), sum(jl.credit) from journal_lines jl join accounts a on a.id = jl.account_id group by a.code) x;
  perform pg_temp.assert_eq('T0 saldo buku besar per akun', v_diff, 0, 0);
  perform pg_temp.assert_eq('T0 akun 2150 saldo bersih nol', pg_temp.bal('2150'), 0);
  perform pg_temp.assert_eq('T0 bundled', (select count(*) from goods_notes where inbound_flow = 'bundled'), 16, 0);
  perform pg_temp.assert_eq('T0 deferred (dibatalkan) tetap', (select count(*) from goods_notes where inbound_flow = 'deferred'), 1, 0);
  perform pg_temp.assert_true('T0 akun 1370 + peran Default Akun terbentuk (DB yang sudah onboarding)',
    exists (select 1 from accounts a join app_default_account_settings d on d.account_id = a.id
            where a.code = '1370' and a.category = 'asset' and d.role_key = 'inventory.purchase_not_received'));
  -- bootstrap idempotent: dipanggil ulang gak membuat duplikat / gagal
  perform bootstrap_default_accounts();
  perform pg_temp.assert_eq('T0 peran baru tepat 1', (select count(*) from app_default_account_settings where role_key = 'inventory.purchase_not_received'), 1, 0);
  raise notice 'T0 OK (data lama utuh, akun & peran baru ada)';
end $$;

-- ============================================================================================
-- T1. Alur normal: tagihan Rp10 juta dulu, barang menyusul 3x
-- ============================================================================================
do $$
declare d uuid := 'b0000000-0000-0000-0000-0000000000d1'; b1 uuid; g1 uuid; g2 uuid; g3 uuid; s record;
begin
  b1 := pg_temp.pbill(10000000);
  perform pg_temp.assert_eq('T1 saldo 1370 setelah tagihan', pg_temp.bal('1370'), 10000000);
  perform pg_temp.assert_eq('T1 sisa kolam awal', pg_temp.rem(b1), 10000000);
  perform pg_temp.assert_true('T1 origin tagihan tanpa barang', (select origin from transactions where id = b1) = 'financial_only');
  perform pg_temp.assert_eq('T1 jurnal tagihan: Utang Usaha kredit', (select sum(jl.credit) from journal_lines jl join transactions t on t.journal_entry_id = jl.journal_entry_id where t.id = b1 and jl.account_id = pg_temp.acct('2100')), 10000000);

  g1 := pg_temp.grn(b1, d, 400, 10000);
  perform pg_temp.assert_eq('T1 sisa setelah barang masuk 1', pg_temp.rem(b1), 6000000);
  perform pg_temp.assert_eq('T1 saldo 1370 setelah barang masuk 1', pg_temp.bal('1370'), 6000000);
  s := pg_temp.st(d);
  perform pg_temp.assert_eq('T1 Q', s.q, 400); perform pg_temp.assert_eq('T1 avg langsung dihitung', s.avg, 10000);
  perform pg_temp.assert_true('T1 origin jadi goods_movement', (select origin from transactions where id = b1) = 'goods_movement');
  perform pg_temp.assert_true('T1 supplier barang masuk = supplier tagihan',
    (select counterparty_id from goods_notes where id = g1) = 'a0000000-0000-0000-0000-000000000001');
  perform pg_temp.assert_true('T1 qty_unbilled tetap 0', (select qty_unbilled from inventory_balances where item_id = d) = 0);

  g2 := pg_temp.grn(b1, d, 300, 10000);
  g3 := pg_temp.grn(b1, d, 300, 10000);
  perform pg_temp.assert_eq('T1 kolam habis', pg_temp.rem(b1), 0);
  perform pg_temp.assert_eq('T1 saldo 1370 nol lagi', pg_temp.bal('1370'), 0);

  -- view sisa kolam
  perform pg_temp.assert_eq('T1 view: pool', (select pool_amount from ap_bill_goods_pool_status where bill_id = b1), 10000000);
  perform pg_temp.assert_eq('T1 view: received', (select received_value from ap_bill_goods_pool_status where bill_id = b1), 10000000);
  perform pg_temp.assert_eq('T1 view: remaining', (select remaining from ap_bill_goods_pool_status where bill_id = b1), 0);
  perform pg_temp.assert_true('T1 view: umur kosong kalau kolam habis', (select open_age_days from ap_bill_goods_pool_status where bill_id = b1) is null);
  raise notice 'T1 OK (tagihan dulu, barang menyusul 3x)';
end $$;

-- ============================================================================================
-- T2. Penolakan: melebihi kolam, harga 0, tagihan bukan barang, barang masuk tanpa tagihan
-- ============================================================================================
do $$
declare d uuid := 'b0000000-0000-0000-0000-0000000000d1'; b2 uuid; plain uuid;
begin
  b2 := pg_temp.pbill(1000000);
  perform pg_temp.expect_error(format('select pg_temp.grn(%L, %L, 101, 10000)', b2, d), 'melebihi sisa kolam');
  perform pg_temp.expect_error(format('select pg_temp.grn(%L, %L, 10, 0)', b2, d), 'harus lebih dari 0');
  perform pg_temp.assert_eq('T2 kolam utuh setelah penolakan', pg_temp.rem(b2), 1000000);

  plain := create_transaction('INBOUND', 'a0000000-0000-0000-0000-000000000001', '2026-10-24', 'biaya', 'APB-N-PLAIN',
    jsonb_build_array(jsonb_build_object('account_id', pg_temp.acct('6100'), 'amount', 1000)), pg_temp.acct('2100'));
  perform pg_temp.expect_error(format('select pg_temp.grn(%L, %L, 1, 100)', plain, d), 'bukan tagihan barang');

  perform pg_temp.expect_error($q$insert into goods_notes (type, counterparty_id, note_date, inbound_flow, source_ref)
    values ('INBOUND', 'a0000000-0000-0000-0000-000000000001', '2026-10-25', 'deferred', 'X-DEF')$q$, 'sudah dihapus');
  perform pg_temp.expect_error($q$insert into goods_notes (type, counterparty_id, note_date, source_ref)
    values ('INBOUND', 'a0000000-0000-0000-0000-000000000001', '2026-10-25', 'X-NOBILL')$q$, 'wajib dibuat dari tagihan barang');
  perform pg_temp.expect_error(format('select create_goods_receipt(%L, %L, ''x'', ''[]''::jsonb, %L)', b2, '2026-10-25'::date, pg_temp.acct('1400')), 'minimal 1 baris');
  raise notice 'T2 OK (kolam, harga 0, bukan tagihan barang, tanpa tagihan ditolak)';
end $$;

-- ============================================================================================
-- T3. avg_cost rata-rata tertimbang langsung (dua tagihan, harga beda)
-- ============================================================================================
do $$
declare d uuid := 'b0000000-0000-0000-0000-0000000000d1'; b3 uuid; s record;
begin
  s := pg_temp.st(d); perform pg_temp.assert_eq('T3 Q awal', s.q, 1000); perform pg_temp.assert_eq('T3 avg awal', s.avg, 10000);
  b3 := pg_temp.pbill(6500000);
  perform pg_temp.grn(b3, d, 500, 13000);
  s := pg_temp.st(d);
  perform pg_temp.assert_eq('T3 Q', s.q, 1500);
  perform pg_temp.assert_eq('T3 avg tertimbang (10jt + 6,5jt) / 1500', s.avg, 11000);
  raise notice 'T3 OK (avg tertimbang)';
end $$;

-- ============================================================================================
-- T4. Batalkan barang masuk: stok & avg dibalik, kolam kembali; ditolak kalau stok kurang
-- ============================================================================================
do $$
declare d uuid := 'b0000000-0000-0000-0000-0000000000d1'; b4 uuid; g uuid; gx uuid; s record;
begin
  b4 := pg_temp.pbill(2000000);
  g := pg_temp.grn(b4, d, 100, 10000);           -- stok D: 1600
  perform pg_temp.assert_eq('T4 sisa setelah barang masuk', pg_temp.rem(b4), 1000000);
  perform cancel_goods_receipt(g, '2026-10-26');
  perform pg_temp.assert_eq('T4 kolam kembali penuh', pg_temp.rem(b4), 2000000);
  perform pg_temp.assert_eq('T4 saldo 1370 mengikuti', pg_temp.bal('1370'), 1000000 /*b2*/ + 6500000 - 6500000 + 2000000, 0.01);
  s := pg_temp.st(d); perform pg_temp.assert_eq('T4 Q kembali', s.q, 1500);
  perform pg_temp.assert_true('T4 barang masuk tercatat batal', exists (select 1 from goods_note_cancellations where goods_note_id = g));
  perform pg_temp.expect_error(format('select cancel_goods_receipt(%L, ''2026-10-26'')', g), 'sudah dibatalkan');

  -- jual sebagian besar stok D lalu coba batalkan barang masuk baru -> stok kurang
  gx := pg_temp.grn(b4, d, 100, 10000);          -- Q 1600
  perform pg_temp.sale(d, 1550);                 -- Q 50
  perform pg_temp.expect_error(format('select cancel_goods_receipt(%L, ''2026-10-27'')', gx), 'stok');
  perform pg_temp.assert_eq('T4 kolam tak berubah karena batal ditolak', pg_temp.rem(b4), 1000000);
  raise notice 'T4 OK (pembatalan barang masuk, stok kurang ditolak)';
end $$;

-- ============================================================================================
-- T5. Pelepasan sisa kolam: pembulatan
-- ============================================================================================
do $$
declare e uuid := 'b0000000-0000-0000-0000-0000000000e1'; b5 uuid; b6 uuid; rounding_before numeric;
begin
  rounding_before := pg_temp.bal('6300');
  b5 := pg_temp.pbill(1000000);
  perform pg_temp.grn(b5, e, 1, 999999.60);
  perform pg_temp.assert_eq('T5 sisa receh', pg_temp.rem(b5), 0.40);
  perform release_ap_bill_pool(b5, 'pembulatan', 0.40, '2026-10-26');
  perform pg_temp.assert_eq('T5 sisa nol', pg_temp.rem(b5), 0);
  perform pg_temp.assert_eq('T5 Beban Selisih Pembulatan naik 0,40', pg_temp.bal('6300') - rounding_before, 0.40);

  b6 := pg_temp.pbill(1000000);
  perform pg_temp.grn(b6, e, 1, 998998.60);      -- sisa 1.001,40
  perform pg_temp.expect_error(format('select release_ap_bill_pool(%L, ''pembulatan'', 1001.40, ''2026-10-26'')', b6), 'kurang dari');
  perform pg_temp.expect_error(format('select release_ap_bill_pool(%L, ''lainnya'', 1, ''2026-10-26'')', b6), 'pembulatan atau uang_muka');
  perform pg_temp.expect_error(format('select release_ap_bill_pool(%L, ''pembulatan'', 99999999, ''2026-10-26'')', b6), 'melebihi sisa kolam');
  raise notice 'T5 OK (pembulatan receh)';
end $$;

-- ============================================================================================
-- T6. Pelepasan sisa kolam: uang muka (hanya bagian yang sudah dibayar)
-- ============================================================================================
do $$
declare f uuid := 'b0000000-0000-0000-0000-0000000000f1'; b7 uuid; b8 uuid; dep record; um_before numeric; rel uuid;
begin
  um_before := pg_temp.bal('1360');
  b7 := pg_temp.pbill(10000000, 'a0000000-0000-0000-0000-000000000002');
  perform record_payment('INBOUND', 'a0000000-0000-0000-0000-000000000002', '2026-10-25', 7000000, 'APP-N-1', 'BANK', pg_temp.acct('2100'), b7);
  perform pg_temp.grn(b7, f, 400, 10000);
  perform pg_temp.assert_eq('T6 sisa kolam', pg_temp.rem(b7), 6000000);

  perform pg_temp.expect_error(format('select release_ap_bill_pool(%L, ''uang_muka'', 3000000.01, ''2026-10-26'')', b7), 'maksimal');
  rel := release_ap_bill_pool(b7, 'uang_muka', 3000000, '2026-10-26');
  select * into dep from deposits where id = (select deposit_id from bill_pool_releases where id = rel);
  perform pg_temp.assert_true('T6 deposit INBOUND untuk supplier', dep.type = 'INBOUND' and dep.counterparty_id = 'a0000000-0000-0000-0000-000000000002');
  perform pg_temp.assert_eq('T6 deposit amount', dep.amount, 3000000);
  perform pg_temp.assert_eq('T6 deposit remaining', dep.remaining, 3000000);
  perform pg_temp.assert_eq('T6 Uang Muka Pembelian naik', pg_temp.bal('1360') - um_before, 3000000);
  perform pg_temp.assert_eq('T6 sisa kolam turun', pg_temp.rem(b7), 3000000);
  perform pg_temp.expect_error(format('select release_ap_bill_pool(%L, ''uang_muka'', 1, ''2026-10-26'')', b7), 'maksimal');

  -- biaya tambahan dianggap dibayar duluan: bayar Rp100.000 saja dari tagihan Rp1,1 juta (barang 1jt + ongkir 100rb) -> belum ada bagian barang yang dibayar
  b8 := pg_temp.pbill(1000000, 'a0000000-0000-0000-0000-000000000001',
    jsonb_build_array(jsonb_build_object('account_id', pg_temp.acct('6100'), 'amount', 100000)));
  perform record_payment('INBOUND', 'a0000000-0000-0000-0000-000000000001', '2026-10-25', 100000, 'APP-N-2', 'BANK', pg_temp.acct('2100'), b8);
  perform pg_temp.expect_error(format('select release_ap_bill_pool(%L, ''uang_muka'', 1, ''2026-10-26'')', b8), 'maksimal');
  raise notice 'T6 OK (uang muka dibatasi bagian yang sudah dibayar)';
end $$;

-- ============================================================================================
-- T7. Batalkan tagihan: barang masuk aktif menahan; tagihan lama (bundled) tetap bisa dibatalkan
-- ============================================================================================
do $$
declare f uuid := 'b0000000-0000-0000-0000-0000000000f1'; b9 uuid; g uuid; legacy uuid; q_before numeric; q_after numeric;
begin
  b9 := pg_temp.pbill(2000000);
  g := pg_temp.grn(b9, f, 100, 10000);
  perform pg_temp.expect_error(format('select cancel_ap_bill(%L, ''2026-10-26'', ''BTL-N-1'')', b9), 'masih punya barang masuk aktif');
  perform cancel_goods_receipt(g, '2026-10-26');
  perform cancel_ap_bill(b9, '2026-10-26', 'BTL-N-1');
  perform pg_temp.assert_true('T7 status dibatalkan', (select status from transactions where id = b9) = 'dibatalkan');
  perform pg_temp.expect_error(format('select pg_temp.grn(%L, %L, 1, 100)', b9, f), 'sudah dibatalkan');

  -- tagihan lama (bundled): stok dibalik seperti sebelumnya
  select id into legacy from transactions where source_ref = 'APB-LAMA-2';
  select qty_on_hand into q_before from inventory_balances where item_id = 'b0000000-0000-0000-0000-0000000000b1';
  perform cancel_ap_bill(legacy, '2026-10-26', 'BTL-LAMA-2');
  select qty_on_hand into q_after from inventory_balances where item_id = 'b0000000-0000-0000-0000-0000000000b1';
  perform pg_temp.assert_eq('T7 stok B berkurang 10 (tagihan lama dibatalkan)', q_before - q_after, 10);
  perform pg_temp.assert_true('T7 tagihan lama dibatalkan', (select status from transactions where id = legacy) = 'dibatalkan');
  raise notice 'T7 OK (pembatalan tagihan baru & lama)';
end $$;

-- ============================================================================================
-- T8. Retur ke supplier: barang masuk baru dan tagihan lama
-- ============================================================================================
do $$
declare f uuid := 'b0000000-0000-0000-0000-0000000000f1'; b10 uuid; g uuid; ret uuid; legacy uuid; a_before numeric;
begin
  b10 := pg_temp.pbill(5000000);
  g := pg_temp.grn(b10, f, 300, 10000);
  perform pg_temp.expect_error(format($q$select create_ap_return(%L, '2026-10-26', 'APC-N-X', 0, %L, %L, '[{"item_id":"%s","qty_returned":301}]'::jsonb, %L)$q$,
    b10, pg_temp.acct('2100'), pg_temp.acct('1400'), f, pg_temp.acct('1350')), 'melebihi qty diterima');
  ret := create_ap_return(b10, '2026-10-26', 'APC-N-1', 0, pg_temp.acct('2100'), pg_temp.acct('1400'),
    jsonb_build_array(jsonb_build_object('item_id', f, 'qty_returned', 100)), pg_temp.acct('1350'));
  perform pg_temp.assert_true('T8 retur tercatat', ret is not null);
  perform pg_temp.expect_error(format('select cancel_goods_receipt(%L, ''2026-10-27'')', g), 'retur/tukar');

  -- tagihan lama (bundled) tetap bisa diretur
  select id into legacy from transactions where source_ref = 'APB-LAMA-1';
  select qty_on_hand into a_before from inventory_balances where item_id = 'b0000000-0000-0000-0000-0000000000a1';
  ret := create_ap_return(legacy, '2026-10-26', 'APC-LAMA-1', 0, pg_temp.acct('2100'), pg_temp.acct('1400'),
    jsonb_build_array(jsonb_build_object('item_id', 'b0000000-0000-0000-0000-0000000000a1', 'qty_returned', 5)), pg_temp.acct('1350'));
  perform pg_temp.assert_eq('T8 stok A berkurang 5 (retur tagihan lama)', a_before - (select qty_on_hand from inventory_balances where item_id = 'b0000000-0000-0000-0000-0000000000a1'), 5);
  raise notice 'T8 OK (retur tagihan baru & lama)';
end $$;

-- ============================================================================================
-- T9. Purchase Order: status, anti over-fulfill, supplier beda, pembatalan membebaskan qty
-- ============================================================================================
do $$
declare p uuid := 'b0000000-0000-0000-0000-0000000000a7'; so uuid; ol uuid; b11 uuid; b12 uuid; bsup2 uuid; g1 uuid; g2 uuid; v_status text;
begin
  so := create_order('PURCHASE', 'a0000000-0000-0000-0000-000000000001', '2026-10-01', '2026-10-30', 'PO-N-1',
    jsonb_build_array(jsonb_build_object('item_id', p, 'qty_ordered', 100, 'unit_price', 500)));
  select id into ol from order_lines where order_id = so;
  b11 := pg_temp.pbill(1000000);

  g1 := pg_temp.grn(b11, p, 60, 500, 0, so, ol);
  select status into v_status from orders where id = so;
  perform pg_temp.assert_true('T9 PARTIALLY_RECEIVED', v_status = 'PARTIALLY_RECEIVED');
  perform pg_temp.assert_true('T9 origin tagihan = order', (select origin from transactions where id = b11) = 'order');
  perform pg_temp.expect_error(format('select pg_temp.grn(%L, %L, 50, 500, 0, %L, %L)', b11, p, so, ol), 'melebihi qty dipesan');

  bsup2 := pg_temp.pbill(1000000, 'a0000000-0000-0000-0000-000000000002');
  perform pg_temp.expect_error(format('select pg_temp.grn(%L, %L, 10, 500, 0, %L, %L)', bsup2, p, so, ol), 'beda dengan supplier tagihan');

  perform cancel_goods_receipt(g1, '2026-10-27');
  select status into v_status from orders where id = so;
  perform pg_temp.assert_true('T9 PO kembali OPEN setelah barang masuk dibatalkan', v_status = 'OPEN');

  g2 := pg_temp.grn(b11, p, 100, 500, 0, so, ol);
  select status into v_status from orders where id = so;
  perform pg_temp.assert_true('T9 FULLY_RECEIVED', v_status = 'FULLY_RECEIVED');
  raise notice 'T9 OK (Purchase Order)';
end $$;

-- ============================================================================================
-- T9b. Temuan review: presisi input, null, diskon header, tanggal pembatalan, pelepasan berurutan,
--      origin tagihan lama yang dibatalkan, pagar inbound_flow di OUTBOUND
-- ============================================================================================
do $$
declare d uuid := 'b0000000-0000-0000-0000-0000000000d1'; b uuid; g uuid; r1 uuid; r2 uuid; ref1 text; ref2 text; legacy uuid; o record;
begin
  b := pg_temp.pbill(1000000);
  perform pg_temp.expect_error(format('select pg_temp.grn(%L, %L, 1, 1.005)', b, d), 'maksimal 2 desimal');
  perform pg_temp.expect_error(format('select pg_temp.grn(%L, %L, 1.0005, 1000)', b, d), 'maksimal 3 desimal');
  perform pg_temp.expect_error(format($q$select create_goods_receipt(%L, '2026-10-25', 'x', '[{"item_id":"%s","qty_received":1}]'::jsonb, %L)$q$, b, d, pg_temp.acct('1400')), 'wajib punya item_id');
  perform pg_temp.assert_eq('T9b kolam utuh setelah input ditolak', pg_temp.rem(b), 1000000);

  -- diskon header: 100 x 1.000 = 100.000, diskon header 5.000 -> nilai bersih 95.000 (kolam & jurnal sama-sama memakai nilai bersih)
  g := pg_temp.grn(b, d, 100, 1000, 5000);
  perform pg_temp.assert_eq('T9b sisa kolam memakai nilai bersih', pg_temp.rem(b), 905000);
  perform pg_temp.assert_eq('T9b jurnal Persediaan = nilai bersih',
    (select sum(jl.debit) from journal_lines jl join goods_notes gn on gn.journal_entry_id = jl.journal_entry_id
      where gn.id = g and jl.account_id = pg_temp.acct('1400')), 95000);
  perform pg_temp.expect_error(format('select cancel_goods_receipt(%L, ''2026-10-24'')', g), 'lebih awal');

  -- dua pelepasan uang muka berurutan: batas memperhitungkan yang sudah dilepas, nomor jurnal tidak sama
  b := pg_temp.pbill(500000);
  perform record_payment('INBOUND', 'a0000000-0000-0000-0000-000000000001', '2026-10-25', 500000, 'APP-N-3', 'BANK', pg_temp.acct('2100'), b);
  r1 := release_ap_bill_pool(b, 'uang_muka', 100000, '2026-10-26');
  r2 := release_ap_bill_pool(b, 'uang_muka', 100000, '2026-10-26');
  select source_ref into ref1 from bill_pool_releases where id = r1;
  select source_ref into ref2 from bill_pool_releases where id = r2;
  perform pg_temp.assert_true('T9b nomor pelepasan unik', ref1 <> ref2);
  perform pg_temp.assert_eq('T9b sisa kolam setelah 2 pelepasan', pg_temp.rem(b), 300000);
  perform pg_temp.expect_error(format('select release_ap_bill_pool(%L, ''uang_muka'', 400000, ''2026-10-26'')', b), 'melebihi sisa kolam');
  perform release_ap_bill_pool(b, 'uang_muka', 300000, '2026-10-26');
  perform pg_temp.assert_eq('T9b kolam habis lewat pelepasan', pg_temp.rem(b), 0);
  perform pg_temp.expect_error(format('select cancel_ap_bill(%L, ''2026-10-27'', ''BTL-N-2'')', b), 'udah punya');  -- sudah dibayar -> ditolak oleh guard pembayaran

  -- origin tagihan lama yang sudah dibatalkan tidak berubah jadi financial_only (perilaku 0056)
  select id into legacy from transactions where source_ref = 'APB-LAMA-2';
  perform recompute_transaction_status(legacy);
  perform pg_temp.assert_true('T9b origin tagihan lama dibatalkan tetap goods_movement', (select origin from transactions where id = legacy) = 'goods_movement');

  -- inbound_flow hanya boleh di baris INBOUND
  select transaction_id, journal_entry_id into o from goods_notes where type = 'OUTBOUND' limit 1;
  perform pg_temp.expect_error(format($q$insert into goods_notes (type, transaction_id, journal_entry_id, source_ref, note_date, inbound_flow)
    values ('OUTBOUND', %L, %L, 'X-OUT', '2026-10-25', 'bundled')$q$, o.transaction_id, o.journal_entry_id), 'inbound_flow_only_inbound');
  raise notice 'T9b OK (presisi, null, diskon header, tanggal, pelepasan berurutan, origin lama, pagar OUTBOUND)';
end $$;

-- ============================================================================================
-- T10. Invarian buku besar & stok (seluruh data, termasuk data lama)
-- ============================================================================================
do $$
declare v_pool_sum numeric; v_inv_gl numeric; v_inv_stock numeric; v_tol numeric; v_unbalanced int;
begin
  select coalesce(sum(remaining), 0) into v_pool_sum from ap_bill_goods_pool_status where bill_status <> 'dibatalkan';
  perform pg_temp.assert_eq('T10 saldo 1370 = jumlah sisa kolam tagihan aktif', pg_temp.bal('1370'), v_pool_sum, 0.01);

  select count(*) into v_unbalanced from (
    select journal_entry_id from journal_lines group by journal_entry_id having sum(debit) <> sum(credit)) x;
  perform pg_temp.assert_eq('T10 semua jurnal seimbang', v_unbalanced, 0, 0);

  perform pg_temp.assert_true('T10 stok belum-ditagih tetap 0',
    not exists (select 1 from inventory_balances where qty_unbilled <> 0 or spill_value <> 0));

  v_inv_gl := pg_temp.bal('1400');
  select coalesce(sum(qty_on_hand * avg_cost), 0), coalesce(sum(qty_on_hand * 0.005), 0) + 1 into v_inv_stock, v_tol from inventory_balances;
  perform pg_temp.assert_eq('T10 Persediaan 1400 = jumlah qty x avg_cost', v_inv_gl, v_inv_stock, v_tol);
  raise notice 'T10 OK (saldo 1370 = sisa kolam, jurnal seimbang, Persediaan cocok stok)';
end $$;

-- ============================================================================================
-- T11. RLS: non-admin tidak boleh membuat tagihan barang / barang masuk
-- ============================================================================================
reset role;
insert into app_user_signup_whitelist (email, role_name) values ('kasir@example.com', 'cashier') on conflict do nothing;
insert into auth.users (id, email, aud, role) values ('22222222-2222-2222-2222-222222222222', 'kasir@example.com', 'authenticated', 'authenticated') on conflict do nothing;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated","email":"kasir@example.com"}', false);
set role authenticated;
do $$
begin
  perform pg_temp.expect_error($q$select pg_temp.pbill(1000)$q$, 'row-level security');
  raise notice 'T11 OK (non-admin ditolak)';
end $$;
reset role;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","email":"tester@example.com"}', false);

select 'TES 0057 LULUS' as hasil;
