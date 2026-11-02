\set ON_ERROR_STOP on
-- Tes migration 0061 (batalkan retur ke supplier). Database LOKAL saja. Dijalankan dalam satu transaksi yang di-ROLLBACK
-- di akhir, jadi data lokal gak berubah. Lihat README.md.
begin;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","email":"tester@example.com"}', true);

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
create or replace function pg_temp.role_acct(p_role text) returns uuid language sql as $$
  select account_id from app_default_account_settings where role_key = p_role
$$;
create or replace function pg_temp.bal(p_account uuid) returns numeric language sql as $$
  select coalesce(sum(debit - credit), 0) from journal_lines where account_id = p_account
$$;
create or replace function pg_temp.pbill(p_goods numeric, p_supplier uuid) returns uuid language plpgsql as $$
begin
  return create_ap_bill_with_goods_pool(p_supplier, current_date, 'Tagihan uji', 'APB-T-' || substr(gen_random_uuid()::text, 1, 8),
    pg_temp.role_acct('ap.payable'), p_goods, null);
end $$;
create or replace function pg_temp.grn(p_bill uuid, p_item uuid, p_qty numeric, p_cost numeric) returns uuid language plpgsql as $$
begin
  return create_goods_receipt(p_bill, current_date, null,
    jsonb_build_array(jsonb_build_object('item_id', p_item, 'qty_received', p_qty, 'unit_cost', p_cost)),
    pg_temp.role_acct('inventory.raw_material'), null, 0);
end $$;
create or replace function pg_temp.pay(p_bill uuid, p_supplier uuid, p_amount numeric) returns uuid language plpgsql as $$
begin
  return record_payment('INBOUND', p_supplier, current_date, p_amount, 'APP-T-' || substr(gen_random_uuid()::text, 1, 8),
    'BANK', pg_temp.role_acct('ap.payable'), p_bill);
end $$;
create or replace function pg_temp.sell(p_item uuid, p_customer uuid, p_qty numeric) returns uuid language plpgsql as $$
begin
  return create_goods_issue(p_customer, current_date, 'Penjualan uji', 'ARI-T-' || substr(gen_random_uuid()::text, 1, 8),
    jsonb_build_array(jsonb_build_object('account_id', pg_temp.role_acct('ar.revenue'), 'amount', p_qty * 50000)),
    pg_temp.role_acct('ar.receivable'),
    jsonb_build_array(jsonb_build_object('item_id', p_item, 'qty_issued', p_qty, 'unit_price', 50000)),
    pg_temp.role_acct('inventory.hpp'), pg_temp.role_acct('inventory.raw_material'), false);
end $$;
-- Satu transaksi = satu now(), jadi urutan waktu mutasi harus dibuat eksplisit: mundurkan barang masuk ini sekian jam.
create or replace function pg_temp.age_note(p_note uuid, p_hours int) returns void language plpgsql as $$
begin
  alter table goods_notes disable trigger user;
  alter table inventory_movements disable trigger user;
  update goods_notes set created_at = created_at - make_interval(hours => p_hours) where id = p_note;
  update inventory_movements set created_at = created_at - make_interval(hours => p_hours)
    where goods_note_line_id in (select id from goods_note_lines where goods_note_id = p_note);
  alter table goods_notes enable trigger user;
  alter table inventory_movements enable trigger user;
end $$;
-- invarian buku besar: saldo akun Pembelian Belum Diterima berubah persis sebesar perubahan total sisa barang
create or replace function pg_temp.pbd_gap() returns numeric language sql as $$
  select pg_temp.bal(pg_temp.role_acct('inventory.purchase_not_received'))
       - coalesce((select sum(remaining) from ap_bill_goods_pool_status where bill_status <> 'dibatalkan'), 0)
$$;
create temp table t_ctx as select pg_temp.pbd_gap() as gap0,
  pg_temp.bal(pg_temp.role_acct('inventory.raw_material')) as inv0,
  pg_temp.bal(pg_temp.role_acct('inventory.hpp')) as hpp0,
  pg_temp.bal(pg_temp.role_acct('cash.bank')) as bank0,
  pg_temp.bal(pg_temp.role_acct('ap.payable')) as ap0;

-- Satu transaksi = satu now(): mundurkan retur ini sekian jam supaya urutan "terbaru dulu" pasti.
create or replace function pg_temp.age_return(p_return uuid, p_hours int) returns void language plpgsql as $$
begin
  alter table returns disable trigger user;
  update returns set created_at = created_at - make_interval(hours => p_hours) where id = p_return;
  alter table returns enable trigger user;
end $$;
create or replace function pg_temp.aret(p_bill uuid, p_item uuid, p_qty numeric, p_ref text) returns uuid language plpgsql as $$
begin
  return create_ap_return(p_bill, current_date, p_ref, 0, pg_temp.role_acct('ap.payable'), pg_temp.role_acct('inventory.raw_material'),
    jsonb_build_array(jsonb_build_object('item_id', p_item, 'qty_returned', p_qty)), pg_temp.role_acct('ap.return_credit_asset'));
end $$;
do $$
declare
  s uuid := gen_random_uuid();
  i1 uuid := gen_random_uuid(); i2 uuid := gen_random_uuid(); i3 uuid := gen_random_uuid(); i4 uuid := gen_random_uuid();
  inv uuid := pg_temp.role_acct('inventory.raw_material');
  ctx t_ctx%rowtype;
  b uuid; g uuid; p uuid; r1 uuid; r2 uuid; cr uuid;
begin
  select * into ctx from t_ctx;
  insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111', 'tester@example.com') on conflict do nothing;
  insert into app_user_roles (user_id, role_name) values ('11111111-1111-1111-1111-111111111111', 'admin') on conflict do nothing;

  insert into counterparties (id, name, payment_term_days) values (s, 'Supplier Uji', 30);
  insert into counterparty_type_mapping (counterparty_id, role) values (s, 'supplier');
  insert into items (id, name, item_type, uom, inventory_account_id) values
    (i1, 'Uji 1', 'RAW_MATERIAL', 'pcs', inv), (i2, 'Uji 2', 'RAW_MATERIAL', 'pcs', inv),
    (i3, 'Uji 3', 'RAW_MATERIAL', 'pcs', inv), (i4, 'Uji 4', 'RAW_MATERIAL', 'pcs', inv);

  -- T1 retur sebagian, belum dibayar: batalkan retur -> sisa, stok, akun kembali; lalu barang masuk + tagihan bisa dibatalkan
  b := pg_temp.pbill(1000000, s);
  g := pg_temp.grn(b, i1, 100, 10000);
  r1 := pg_temp.aret(b, i1, 40, 'APC-U1');
  perform pg_temp.assert_eq('T1 sisa setelah retur', ap_bill_remaining(b), 600000);
  perform pg_temp.assert_eq('T1 stok setelah retur', (select qty_on_hand from inventory_balances where item_id = i1), 60);
  perform pg_temp.expect_error(format($q$select cancel_goods_receipt(%L, current_date)$q$, g), 'retur');
  perform pg_temp.expect_error(format($q$select cancel_ap_return(%L, current_date, '  ')$q$, r1), 'Alasan');
  perform pg_temp.expect_error(format($q$select cancel_ap_return(%L, current_date - 1, 'x')$q$, r1), 'lebih awal');
  perform cancel_ap_return(r1, current_date, 'Salah input');
  perform pg_temp.assert_eq('T1 sisa kembali', ap_bill_remaining(b), 1000000);
  perform pg_temp.assert_eq('T1 stok kembali', (select qty_on_hand from inventory_balances where item_id = i1), 100);
  perform pg_temp.assert_eq('T1 avg kembali', (select avg_cost from inventory_balances where item_id = i1), 10000);
  perform pg_temp.assert_eq('T1 qty retur tidak dihitung', purchase_returned_qty(b, i1), 0);
  perform pg_temp.expect_error(format($q$select cancel_ap_return(%L, current_date, 'x')$q$, r1), 'sudah dibatalkan');
  perform pg_temp.assert_true('T1 dokumen retur tetap ada', exists (select 1 from returns where id = r1));
  perform pg_temp.assert_true('T1 label Kartu Stok', exists (
    select 1 from inventory_movements_with_source where item_id = i1 and source_label = 'Pembatalan Retur ke Supplier'));
  perform cancel_goods_receipt(g, current_date);
  perform cancel_ap_bill(b, current_date, 'JE-U1');
  perform pg_temp.assert_true('T1 dibatalkan', (select status from transactions where id = b) = 'dibatalkan');
  perform pg_temp.assert_eq('T1 persediaan nol', pg_temp.bal(inv) - ctx.inv0, 0);
  perform pg_temp.assert_eq('T1 utang nol', pg_temp.bal(pg_temp.role_acct('ap.payable')) - ctx.ap0, 0);
  perform pg_temp.assert_eq('T1 stok nol', (select qty_on_hand from inventory_balances where item_id = i1), 0);
  raise notice 'T1 OK';

  -- T2 sudah dibayar + retur penuh menghasilkan saldo: pembayaran diblokir; setelah retur dibatalkan saldo nol dan pembayaran bisa dibatalkan
  b := pg_temp.pbill(1000000, s);
  g := pg_temp.grn(b, i2, 100, 10000);
  p := pg_temp.pay(b, s, 1000000);
  r1 := pg_temp.aret(b, i2, 100, 'APC-U2');
  select id into cr from return_credits where return_id = r1;
  perform pg_temp.assert_true('T2 ada saldo retur', cr is not null);
  perform pg_temp.expect_error(format($q$select cancel_payment(%L, current_date, 'x', true)$q$, p), 'jadi saldo');
  perform cancel_ap_return(r1, current_date, 'Retur salah input');
  perform pg_temp.assert_eq('T2 saldo retur nol', return_credit_remaining(cr), 0);
  perform pg_temp.expect_error(format($q$select refund_return_credit(%L, 1000, current_date, 'RF-U2', %L, %L)$q$, cr,
    pg_temp.role_acct('ap.return_credit_asset'), pg_temp.role_acct('cash.bank')), 'melebihi sisa');
  perform pg_temp.assert_eq('T2 sisa utang', ap_bill_remaining(b), 0);
  perform cancel_payment(p, current_date, 'Salah catat', false);
  perform pg_temp.assert_eq('T2 sisa utang setelah bayar batal', ap_bill_remaining(b), 1000000);
  raise notice 'T2 OK';

  -- T3 saldo retur sudah dicairkan tunai: retur gak bisa dibatalkan
  b := pg_temp.pbill(1000000, s);
  g := pg_temp.grn(b, i3, 100, 10000);
  p := pg_temp.pay(b, s, 1000000);
  r1 := pg_temp.aret(b, i3, 100, 'APC-U3');
  select id into cr from return_credits where return_id = r1;
  perform refund_return_credit(cr, 1000000, current_date, 'RF-U3', pg_temp.role_acct('ap.return_credit_asset'), pg_temp.role_acct('cash.bank'));
  perform pg_temp.expect_error(format($q$select cancel_ap_return(%L, current_date, 'x')$q$, r1), 'dicairkan tunai');
  raise notice 'T3 OK';

  -- T4 terbaru dulu: retur lama gak bisa dibatalkan selama ada retur aktif yang lebih baru
  b := pg_temp.pbill(1000000, s);
  g := pg_temp.grn(b, i4, 100, 10000);
  r1 := pg_temp.aret(b, i4, 10, 'APC-U4a');
  r2 := pg_temp.aret(b, i4, 10, 'APC-U4b');
  perform pg_temp.age_return(r1, 2);
  perform pg_temp.expect_error(format($q$select cancel_ap_return(%L, current_date, 'x')$q$, r1), 'lebih baru');
  perform pg_temp.assert_true('T4 pratinjau menyebut retur aktif', jsonb_array_length(ap_bill_cancellation_preview(b)->'blockers') > 0);
  perform cancel_ap_return(r2, current_date, 'x');
  perform cancel_ap_return(r1, current_date, 'x');
  perform pg_temp.assert_true('T4 pratinjau bersih', jsonb_array_length(ap_bill_cancellation_preview(b)->'blockers') = 0);
  perform pg_temp.assert_eq('T4 stok utuh', (select qty_on_hand from inventory_balances where item_id = i4), 100);
  raise notice 'T4 OK';

  -- T5 retur penuh salah input, dibatalkan, lalu diretur ulang dengan benar: cap nilai tagihan tidak menghitung yang batal
  b := pg_temp.pbill(1000000, s);
  g := pg_temp.grn(b, i1, 100, 10000);
  r1 := pg_temp.aret(b, i1, 100, 'APC-U5a');
  perform pg_temp.expect_error(format($q$select create_ap_return(%L, current_date, 'APC-U5x', 1, %L, %L, null, %L)$q$,
    b, pg_temp.role_acct('ap.payable'), inv, pg_temp.role_acct('ap.return_credit_asset')), 'melebihi nilai transaksi');
  perform cancel_ap_return(r1, current_date, 'Salah input');
  r2 := pg_temp.aret(b, i1, 30, 'APC-U5b');
  perform pg_temp.assert_eq('T5 sisa setelah retur ulang', ap_bill_remaining(b), 700000);
  raise notice 'T5 OK';

  -- Invarian akhir
  perform pg_temp.assert_eq('INV saldo Pembelian Belum Diterima = total sisa barang', pg_temp.pbd_gap(), ctx.gap0);
  perform pg_temp.assert_true('INV semua jurnal seimbang', not exists (
    select 1 from journal_lines group by journal_entry_id having sum(debit) <> sum(credit)));
  raise notice 'INVARIAN OK';
end $$;

rollback;
