\set ON_ERROR_STOP on
-- Tes migration 0058 (pembersihan alur lama). Database LOKAL saja, setelah rangkaian 0057 + test-0057.sql + stage-0057.sql + 0058.
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
  ('b0000000-0000-0000-0000-0000000000d2','Kantong P','RAW_MATERIAL','pcs',(select id from accounts where code='1400')),
  ('b0000000-0000-0000-0000-0000000000e2','Kantong Q','RAW_MATERIAL','pcs',(select id from accounts where code='1400')),
  ('b0000000-0000-0000-0000-0000000000f2','Bahan Produksi','RAW_MATERIAL','pcs',(select id from accounts where code='1400')),
  ('b0000000-0000-0000-0000-0000000000ca','Barang Jadi','FINISHED_GOOD','pcs',(select id from accounts where code='1420')),
  ('b0000000-0000-0000-0000-0000000000cb','Barang Tanpa Harga','RAW_MATERIAL','pcs',(select id from accounts where code='1400'));

-- ============================================================================================
-- T0. Data utuh setelah 0058 (dibandingkan dengan snapshot sebelum 0058) + arsip + objek lama hilang
-- ============================================================================================
do $$
declare v_diff int; c record;
begin
  select * into c from snap57.counts;

  select count(*) into v_diff from (select * from snap57.goods_notes except select id, type, order_id, transaction_id, journal_entry_id, delivery_note_ref, source_ref, note_date, created_by, created_at, counterparty_id from goods_notes) x;
  perform pg_temp.assert_eq('T0 goods_notes snapshot hilang/berubah', v_diff, 0, 0);
  select count(*) into v_diff from (select id, type, order_id, transaction_id, journal_entry_id, delivery_note_ref, source_ref, note_date, created_by, created_at, counterparty_id from goods_notes except select * from snap57.goods_notes) x;
  perform pg_temp.assert_eq('T0 goods_notes baris tak terduga', v_diff, 0, 0);
  select count(*) into v_diff from (select * from snap57.goods_note_lines except select * from goods_note_lines) x;
  perform pg_temp.assert_eq('T0 goods_note_lines', v_diff, 0, 0);
  select count(*) into v_diff from (select * from snap57.goods_note_cancellations except select * from goods_note_cancellations) x;
  perform pg_temp.assert_eq('T0 goods_note_cancellations', v_diff, 0, 0);
  select count(*) into v_diff from (select * from snap57.inventory_balances except select item_id, qty_on_hand, avg_cost from inventory_balances) x;
  perform pg_temp.assert_eq('T0 inventory_balances', v_diff, 0, 0);
  select count(*) into v_diff from (select * from snap57.inventory_movements except select * from inventory_movements) x;
  perform pg_temp.assert_eq('T0 inventory_movements', v_diff, 0, 0);
  select count(*) into v_diff from (select * from snap57.transactions except select id, type, counterparty_id, amount, outstanding, status, origin, journal_entry_id from transactions) x;
  perform pg_temp.assert_eq('T0 transactions (status & origin)', v_diff, 0, 0);
  select count(*) into v_diff from (select * from snap57.journal_lines except select * from journal_lines) x;
  perform pg_temp.assert_eq('T0 journal_lines', v_diff, 0, 0);
  select count(*) into v_diff from (select * from snap57.deposits except select id, type, counterparty_id, amount, journal_entry_id from deposits) x;
  perform pg_temp.assert_eq('T0 deposits', v_diff, 0, 0);
  select count(*) into v_diff from (select * from snap57.bill_pool_releases except select * from bill_pool_releases) x;
  perform pg_temp.assert_eq('T0 bill_pool_releases', v_diff, 0, 0);
  perform pg_temp.assert_eq('T0 akun 2150 jurnal lama utuh', (select count(*) from journal_lines jl join accounts a on a.id = jl.account_id where a.code = '2150'), 2, 0);
  perform pg_temp.assert_eq('T0 akun 2150 saldo nol', pg_temp.bal('2150'), 0);

  -- arsip utuh
  perform pg_temp.assert_eq('T0 arsip billings', (select count(*) from archive.goods_note_billings_0058), c.billings, 0);
  perform pg_temp.assert_eq('T0 arsip alokasi', (select count(*) from archive.goods_note_billing_allocations_0058), c.allocations, 0);
  perform pg_temp.assert_eq('T0 arsip revisi', (select count(*) from archive.goods_note_revisions_0058), c.revisions, 0);
  perform pg_temp.assert_eq('T0 arsip inbound_flow', (select count(*) from archive.goods_notes_inbound_flow_0058), c.inbound, 0);
  perform pg_temp.assert_eq('T0 arsip peran lama', (select count(*) from archive.default_account_goods_received_not_invoiced_0058), c.old_role, 0);
  perform pg_temp.assert_eq('T0 arsip: 16 bundled + 1 deferred tercatat',
    (select count(*) from archive.goods_notes_inbound_flow_0058 where inbound_flow in ('bundled', 'deferred')), 17, 0);
  -- arsip tidak terjangkau API
  perform pg_temp.assert_true('T0 authenticated tak punya akses skema archive', not has_schema_privilege('authenticated', 'archive', 'USAGE'));
  perform pg_temp.assert_true('T0 anon tak punya akses skema archive', not has_schema_privilege('anon', 'archive', 'USAGE'));
  perform pg_temp.assert_true('T0 authenticated tak bisa select arsip', not has_table_privilege('authenticated', 'archive.goods_note_billings_0058', 'select'));

  -- objek lama hilang
  perform pg_temp.assert_true('T0 tabel lama hilang', to_regclass('goods_note_billings') is null and to_regclass('goods_note_billing_allocations') is null
    and to_regclass('goods_note_revisions') is null and to_regclass('goods_note_revision_lines') is null);
  perform pg_temp.assert_true('T0 view lama hilang', to_regclass('goods_notes_with_billing_status') is null and to_regclass('goods_note_line_current_cost') is null);
  perform pg_temp.assert_eq('T0 kolom lama hilang', (select count(*) from information_schema.columns
    where table_schema = 'public' and ((table_name = 'goods_notes' and column_name = 'inbound_flow')
       or (table_name = 'inventory_balances' and column_name in ('qty_unbilled', 'spill_value')))), 0, 0);
  perform pg_temp.assert_eq('T0 fungsi lama hilang', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('inventory_add_billed', 'grni_spill_allocation', 'revise_goods_receipt',
      'create_ap_bill_from_goods_receipts', 'goods_note_billings_guard', 'goods_note_billings_sync_status')), 0, 0);
  perform pg_temp.assert_eq('T0 peran Default Akun lama hilang', (select count(*) from app_default_account_settings where role_key = 'inventory.goods_received_not_invoiced'), 0, 0);
  perform pg_temp.assert_true('T0 peran baru tetap ada', exists (select 1 from app_default_account_settings where role_key = 'inventory.purchase_not_received'));
  perform bootstrap_default_accounts();
  -- arsip tahan ubah/hapus dan punya PK
  perform pg_temp.expect_error('delete from archive.goods_note_billings_0058', 'gak pernah bisa diedit');
  perform pg_temp.expect_error('update archive.goods_notes_inbound_flow_0058 set note_date = note_date', 'gak pernah bisa diedit');
  perform pg_temp.expect_error('delete from archive.default_account_goods_received_not_invoiced_0058', 'gak pernah bisa diedit');
  perform pg_temp.assert_eq('T0 arsip: 6 tabel ber-PK', (select count(*) from pg_constraint pc join pg_namespace pn on pn.oid = pc.connamespace
    where pn.nspname = 'archive' and pc.contype = 'p'), 6, 0);
  raise notice 'T0 OK (data utuh, arsip lengkap & tertutup, objek lama hilang)';
end $$;

-- ============================================================================================
-- T1. Alur stok setelah penulisan ulang fungsi bersama: penjualan, pembatalan, retur customer
-- ============================================================================================
do $$
declare p uuid := 'b0000000-0000-0000-0000-0000000000d2'; b uuid; g uuid; s uuid; inv uuid; s2 uuid; inv2 uuid; st record;
begin
  b := pg_temp.pbill(2000000);
  g := pg_temp.grn(b, p, 200, 10000);
  st := pg_temp.st(p); perform pg_temp.assert_eq('T1 Q', st.q, 200); perform pg_temp.assert_eq('T1 avg', st.avg, 10000);

  s := pg_temp.sale(p, 50);
  st := pg_temp.st(p); perform pg_temp.assert_eq('T1 Q setelah jual', st.q, 150); perform pg_temp.assert_eq('T1 avg tak berubah oleh konsumsi', st.avg, 10000);

  -- batalkan penjualan -> stok kembali (inventory_restore_stock)
  select transaction_id into inv from goods_notes where id = s;
  perform cancel_ar_invoice(inv, '2026-10-26', 'BTL-ARI-N-1');
  st := pg_temp.st(p); perform pg_temp.assert_eq('T1 Q kembali setelah batal penjualan', st.q, 200);

  -- retur customer dengan baris -> stok kembali & avg dicampur pada biaya retur
  s2 := pg_temp.sale(p, 40);
  select transaction_id into inv2 from goods_notes where id = s2;
  perform create_ar_return(inv2, '2026-10-26', 'ARC-N-1', 20000, pg_temp.acct('4900'), pg_temp.acct('1300'),
    jsonb_build_array(jsonb_build_object('item_id', p, 'qty_returned', 2)), pg_temp.acct('5100'), pg_temp.acct('1400'));
  st := pg_temp.st(p); perform pg_temp.assert_eq('T1 Q setelah retur customer', st.q, 162); perform pg_temp.assert_eq('T1 avg tetap (biaya retur = avg)', st.avg, 10000);
  raise notice 'T1 OK (konsumsi, pembatalan penjualan, retur customer)';
end $$;

-- ============================================================================================
-- T2. Opname, produksi, tukar barang ke supplier, item tanpa harga pokok
-- ============================================================================================
do $$
declare r uuid := 'b0000000-0000-0000-0000-0000000000f2'; fg uuid := 'b0000000-0000-0000-0000-0000000000ca'; z uuid := 'b0000000-0000-0000-0000-0000000000cb';
        p uuid := 'b0000000-0000-0000-0000-0000000000d2'; b uuid; bom uuid; st record; q_before numeric;
begin
  b := pg_temp.pbill(1000000);
  perform pg_temp.grn(b, r, 100, 5000);                      -- bahan baku 100 @5000 (Rp500.000)

  -- opname: kurang 5 lalu lebih 3
  perform record_stock_opname('2026-10-27', 'SOP-N-1',
    jsonb_build_array(jsonb_build_object('item_id', r, 'qty_actual', 95, 'inventory_account_id', pg_temp.acct('1400'))),
    pg_temp.acct('6000'), pg_temp.acct('4400'));
  st := pg_temp.st(r); perform pg_temp.assert_eq('T2 Q setelah opname kurang', st.q, 95);
  perform record_stock_opname('2026-10-27', 'SOP-N-2',
    jsonb_build_array(jsonb_build_object('item_id', r, 'qty_actual', 98, 'inventory_account_id', pg_temp.acct('1400'))),
    pg_temp.acct('6000'), pg_temp.acct('4400'));
  st := pg_temp.st(r); perform pg_temp.assert_eq('T2 Q setelah opname lebih', st.q, 98); perform pg_temp.assert_eq('T2 avg bahan tak berubah', st.avg, 5000);

  -- produksi: 2 batch x 5 bahan = 10 bahan @5000 = 50.000 -> 20 unit barang jadi @2500
  insert into bom_headers (finished_item_id, output_qty) values (fg, 10) returning id into bom;
  insert into bom_lines (bom_header_id, raw_material_item_id, qty_per_batch) values (bom, r, 5);
  perform create_production_order(bom, 20, '2026-10-27', 'PRD-N-1', pg_temp.acct('1420'), pg_temp.acct('1400'));
  st := pg_temp.st(fg); perform pg_temp.assert_eq('T2 Q barang jadi', st.q, 20); perform pg_temp.assert_eq('T2 avg barang jadi', st.avg, 2500);
  st := pg_temp.st(r); perform pg_temp.assert_eq('T2 Q bahan setelah produksi', st.q, 88);

  -- tukar barang ke supplier (inventory_add_stock): 5 pcs rusak diganti 5 pcs baru, stok net sama
  select qty_on_hand into q_before from inventory_balances where item_id = r;
  perform create_replacement('OUTBOUND', b, '2026-10-27', 'APX-N-1',
    jsonb_build_array(jsonb_build_object('item_id', r, 'qty', 5)), pg_temp.acct('1400'), pg_temp.acct('1400'));
  perform pg_temp.assert_eq('T2 stok net sama setelah tukar barang', (select qty_on_hand from inventory_balances where item_id = r), q_before);

  -- item tanpa harga pokok tidak bisa dijual
  insert into inventory_balances (item_id, qty_on_hand, avg_cost) values (z, 10, 0);
  perform pg_temp.expect_error(format('select pg_temp.sale(%L, 1)', z), 'belum punya harga pokok');
  raise notice 'T2 OK (opname, produksi, tukar barang, item tanpa harga pokok)';
end $$;

-- ============================================================================================
-- T3. Klasifikasi tanpa inbound_flow: tagihan lama, barang masuk lama, riwayat deferred, barang masuk baru
-- ============================================================================================
do $$
declare p uuid := 'b0000000-0000-0000-0000-0000000000e2'; b uuid; g uuid; legacy_note uuid; deferred_note uuid; legacy3 uuid; legacy4 uuid; a_before numeric; q_before numeric; q_after numeric; b_item uuid;
begin
  -- barang masuk lama (journal NULL) & riwayat deferred (transaction NULL) tidak bisa dibatalkan lewat cancel_goods_receipt
  select id into legacy_note from goods_notes where type = 'INBOUND' and journal_entry_id is null limit 1;
  perform pg_temp.expect_error(format('select cancel_goods_receipt(%L, ''2026-10-27'')', legacy_note), 'alur lama');
  select id into deferred_note from goods_notes where type = 'INBOUND' and transaction_id is null limit 1;
  perform pg_temp.assert_true('T3 riwayat deferred masih ada', deferred_note is not null);
  perform pg_temp.expect_error(format('select cancel_goods_receipt(%L, ''2026-10-27'')', deferred_note), 'alur lama');

  -- tagihan lama dibatalkan: stok dibalik; origin tetap goods_movement
  select id into legacy3 from transactions where source_ref = 'APB-LAMA-3';
  select qty_on_hand into q_before from inventory_balances where item_id = 'b0000000-0000-0000-0000-0000000000a1';
  perform cancel_ap_bill(legacy3, '2026-10-27', 'BTL-LAMA-3');
  select qty_on_hand into q_after from inventory_balances where item_id = 'b0000000-0000-0000-0000-0000000000a1';
  perform pg_temp.assert_eq('T3 stok A berkurang 13 (tagihan lama dibatalkan)', q_before - q_after, 13);
  perform recompute_transaction_status(legacy3);
  perform pg_temp.assert_true('T3 origin tagihan lama dibatalkan', (select origin from transactions where id = legacy3) = 'goods_movement');

  -- retur ke supplier atas tagihan lama
  select id into legacy4 from transactions where source_ref = 'APB-LAMA-4';
  select qty_on_hand into a_before from inventory_balances where item_id = 'b0000000-0000-0000-0000-0000000000b1';
  perform create_ap_return(legacy4, '2026-10-27', 'APC-LAMA-4', 0, pg_temp.acct('2100'), pg_temp.acct('1400'),
    jsonb_build_array(jsonb_build_object('item_id', 'b0000000-0000-0000-0000-0000000000b1', 'qty_returned', 3)), pg_temp.acct('1350'));
  perform pg_temp.assert_eq('T3 stok B berkurang 3 (retur tagihan lama)', a_before - (select qty_on_hand from inventory_balances where item_id = 'b0000000-0000-0000-0000-0000000000b1'), 3);

  -- barang masuk baru: buat, batalkan (kolam kembali), tagihan bisa dibatalkan
  b := pg_temp.pbill(500000);
  g := pg_temp.grn(b, p, 50, 10000);
  perform pg_temp.assert_eq('T3 sisa kolam', pg_temp.rem(b), 0);
  perform cancel_goods_receipt(g, '2026-10-27');
  perform pg_temp.assert_eq('T3 kolam kembali', pg_temp.rem(b), 500000);
  perform cancel_ap_bill(b, '2026-10-27', 'BTL-N-3');
  perform pg_temp.assert_true('T3 tagihan baru dibatalkan', (select status from transactions where id = b) = 'dibatalkan');

  -- pagar insert barang masuk tetap berlaku tanpa inbound_flow
  perform pg_temp.expect_error($q$insert into goods_notes (type, counterparty_id, note_date, source_ref)
    values ('INBOUND', 'a0000000-0000-0000-0000-000000000001', '2026-10-27', 'X-NOBILL')$q$, 'wajib');
  raise notice 'T3 OK (klasifikasi tanpa inbound_flow)';
end $$;

-- ============================================================================================
-- T4. Invarian seluruh data
-- ============================================================================================
do $$
declare v_pool_sum numeric; v_inv_gl numeric; v_inv_stock numeric; v_tol numeric; v_unbalanced int;
begin
  select coalesce(sum(remaining), 0) into v_pool_sum from ap_bill_goods_pool_status where bill_status <> 'dibatalkan';
  perform pg_temp.assert_eq('T4 saldo 1370 = jumlah sisa kolam tagihan aktif', pg_temp.bal('1370'), v_pool_sum, 0.01);
  select count(*) into v_unbalanced from (select journal_entry_id from journal_lines group by journal_entry_id having sum(debit) <> sum(credit)) x;
  perform pg_temp.assert_eq('T4 semua jurnal seimbang', v_unbalanced, 0, 0);
  v_inv_gl := pg_temp.bal('1400') + pg_temp.bal('1420');
  select coalesce(sum(qty_on_hand * avg_cost), 0), coalesce(sum(qty_on_hand * 0.005), 0) + 1 into v_inv_stock, v_tol from inventory_balances;
  perform pg_temp.assert_eq('T4 Persediaan (1400+1420) = jumlah qty x avg_cost', v_inv_gl, v_inv_stock, v_tol);
  raise notice 'T4 OK (saldo 1370, jurnal seimbang, Persediaan cocok stok)';
end $$;

select 'TES 0058 LULUS' as hasil;
