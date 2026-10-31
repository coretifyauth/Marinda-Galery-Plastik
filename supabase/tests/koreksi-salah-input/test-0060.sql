\set ON_ERROR_STOP on
-- Tes migration 0060 (jalan keluar salah input). Database LOKAL saja. Dijalankan dalam satu transaksi yang di-ROLLBACK
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

do $$
declare
  s uuid := gen_random_uuid(); c uuid := gen_random_uuid();
  i1 uuid := gen_random_uuid(); i2 uuid := gen_random_uuid(); i3 uuid := gen_random_uuid(); i4 uuid := gen_random_uuid();
  inv uuid := pg_temp.role_acct('inventory.raw_material');
  ctx t_ctx%rowtype;
  b uuid; b2 uuid; g uuid; g2 uuid; p uuid; p2 uuid; prev jsonb; ret uuid; dep uuid; rev goods_receipt_revisions%rowtype;
  gap numeric;
begin
  select * into ctx from t_ctx;
  insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111', 'tester@example.com') on conflict do nothing;
  insert into app_user_roles (user_id, role_name) values ('11111111-1111-1111-1111-111111111111', 'admin') on conflict do nothing;

  insert into counterparties (id, name, payment_term_days) values (s, 'Supplier Uji', 30), (c, 'Customer Uji', 30);
  insert into counterparty_type_mapping (counterparty_id, role) values (s, 'supplier'), (c, 'customer');
  insert into items (id, name, item_type, uom, inventory_account_id) values
    (i1, 'Uji 1', 'RAW_MATERIAL', 'pcs', inv), (i2, 'Uji 2', 'RAW_MATERIAL', 'pcs', inv),
    (i3, 'Uji 3', 'RAW_MATERIAL', 'pcs', inv), (i4, 'Uji 4', 'RAW_MATERIAL', 'pcs', inv);

  -- T1 alur utama yang ditanyakan: tagihan, bayar, barang masuk, lalu batal berurutan -- semua akun kembali
  b := pg_temp.pbill(1000000, s);
  p := pg_temp.pay(b, s, 1000000);
  g := pg_temp.grn(b, i1, 100, 10000);
  perform pg_temp.assert_true('T1 lunas', (select status from transactions where id = b) = 'lunas');
  perform pg_temp.expect_error(format($q$select cancel_ap_bill(%L, current_date, 'JE-T1')$q$, b), 'pembayaran aktif');
  perform cancel_goods_receipt(g, current_date);
  perform pg_temp.assert_eq('T1 sisa kembali', ap_bill_pool_remaining(b), 1000000);
  perform pg_temp.expect_error(format($q$select cancel_payment(%L, current_date, '  ', false)$q$, p), 'Alasan');
  perform pg_temp.expect_error(format($q$select cancel_payment(%L, current_date, 'x', null)$q$, p), 'benar-benar berpindah');
  perform pg_temp.expect_error(format($q$select cancel_payment(%L, current_date - 1, 'x', true)$q$, p), 'lebih awal');
  perform cancel_payment(p, current_date, 'Salah nominal', true);
  perform pg_temp.assert_eq('T1 sisa utang kembali', ap_bill_remaining(b), 1000000);
  perform pg_temp.assert_true('T1 status belum', (select status from transactions where id = b) = 'belum');
  perform pg_temp.expect_error(format($q$select cancel_payment(%L, current_date, 'x', true)$q$, p), 'sudah dibatalkan');
  perform cancel_ap_bill(b, current_date, 'JE-T1');
  perform pg_temp.assert_true('T1 dibatalkan', (select status from transactions where id = b) = 'dibatalkan');
  perform pg_temp.assert_eq('T1 persediaan nol', pg_temp.bal(inv) - ctx.inv0, 0);
  perform pg_temp.assert_eq('T1 bank nol', pg_temp.bal(pg_temp.role_acct('cash.bank')) - ctx.bank0, 0);
  perform pg_temp.assert_eq('T1 utang nol', pg_temp.bal(pg_temp.role_acct('ap.payable')) - ctx.ap0, 0);
  perform pg_temp.assert_eq('T1 stok nol', (select qty_on_hand from inventory_balances where item_id = i1), 0);
  raise notice 'T1 OK';

  -- T2 satu tombol + uang muka ikut dibalik; pratinjau akurat
  b := pg_temp.pbill(1000000, s);
  dep := create_deposit('INBOUND', s, current_date, 'APD-T2', 300000, pg_temp.role_acct('cash.bank'), pg_temp.role_acct('ap.deposit_asset'));
  perform apply_deposit(dep, b, 300000, current_date, 'ADA-T2', pg_temp.role_acct('ap.deposit_asset'), pg_temp.role_acct('ap.payable'));
  p := pg_temp.pay(b, s, 700000);
  g := pg_temp.grn(b, i2, 50, 10000);
  prev := ap_bill_cancellation_preview(b);
  perform pg_temp.assert_eq('T2 pratinjau tanpa penghalang', jsonb_array_length(prev->'blockers'), 0);
  perform pg_temp.assert_eq('T2 pratinjau GRN', jsonb_array_length(prev->'goods_receipts'), 1);
  perform pg_temp.assert_eq('T2 pratinjau bayar', jsonb_array_length(prev->'payments'), 1);
  perform pg_temp.assert_eq('T2 pratinjau DP', jsonb_array_length(prev->'deposit_applications'), 1);
  perform cancel_ap_bill_cascade(b, current_date, 'Nota salah', false);
  perform pg_temp.assert_true('T2 dibatalkan', (select status from transactions where id = b) = 'dibatalkan');
  perform pg_temp.assert_eq('T2 DP kembali', deposit_remaining(dep), 300000);
  perform pg_temp.assert_eq('T2 stok', (select qty_on_hand from inventory_balances where item_id = i2), 0);
  perform pg_temp.assert_true('T2 alasan tersimpan', (select reason from ap_bill_cancellations where transaction_id = b) = 'Nota salah');
  perform pg_temp.expect_error(format($q$select cancel_ap_bill_cascade(%L, current_date, 'lagi', false)$q$, b), 'pernah dibatalkan');
  -- tagihan polos tanpa pembayaran: alasan tetap tersimpan, dan gak bisa dibalik dua kali
  b2 := create_transaction('INBOUND', s, current_date, 'Jasa uji', 'APB-T2-' || substr(gen_random_uuid()::text, 1, 8),
    jsonb_build_array(jsonb_build_object('account_id', pg_temp.role_acct('rounding.expense'), 'amount', 50000)),
    pg_temp.role_acct('ap.payable'), false, null, 0);
  perform cancel_ap_bill_cascade(b2, current_date, 'Salah catat', null);
  perform pg_temp.assert_true('T2 alasan tanpa pembayaran', (select reason from ap_bill_cancellations where transaction_id = b2) = 'Salah catat');
  perform pg_temp.expect_error(format($q$select cancel_ap_bill(%L, current_date, 'JE-T2')$q$, b2), 'pernah dibatalkan');
  raise notice 'T2 OK';

  -- T3 cascade atomik: stok sudah terjual -> semuanya batal, pembayaran tetap aktif
  b := pg_temp.pbill(1000000, s);
  p := pg_temp.pay(b, s, 1000000);
  g := pg_temp.grn(b, i3, 100, 10000);
  perform pg_temp.sell(i3, c, 30);
  prev := ap_bill_cancellation_preview(b);
  perform pg_temp.assert_true('T3 pratinjau menyebut penghalang', jsonb_array_length(prev->'blockers') > 0);
  perform pg_temp.expect_error(format($q$select cancel_ap_bill_cascade(%L, current_date, 'x', false)$q$, b), 'Koreksi Barang Masuk');
  perform pg_temp.assert_true('T3 pembayaran tetap aktif', not exists (select 1 from payment_cancellations where payment_id = p));

  -- T4 Koreksi Barang Masuk: 100 tercatat, benar 80, 30 terjual, harga sama -> stok 50, HPP gak berubah
  g2 := revise_goods_receipt(g, current_date, null,
    jsonb_build_array(jsonb_build_object('item_id', i3, 'qty_received', 80, 'unit_cost', 10000)), 0, 'Salah hitung qty', current_date);
  perform pg_temp.assert_eq('T4 stok', (select qty_on_hand from inventory_balances where item_id = i3), 50);
  perform pg_temp.assert_eq('T4 avg', (select avg_cost from inventory_balances where item_id = i3), 10000);
  perform pg_temp.assert_eq('T4 sisa barang kembali 200rb', ap_bill_pool_remaining(b), 200000);
  select * into rev from goods_receipt_revisions where old_goods_note_id = g;
  perform pg_temp.assert_eq('T4 tanpa koreksi HPP', rev.cogs_adjustment, 0);
  perform pg_temp.assert_true('T4 tautan', rev.new_goods_note_id = g2);
  perform pg_temp.assert_true('T4 lama dibatalkan', not goods_note_is_active(g));
  perform pg_temp.assert_true('T4 baru aktif', goods_note_is_active(g2));
  perform pg_temp.assert_true('T4 kartu stok cocok',
    (select sum(qty) from inventory_movements where item_id = i3) = 50);
  raise notice 'T3/T4 OK';

  -- T5 Koreksi harga salah ketik: 10@1000 + 10@10000 (benar 1000), 5 terjual -> avg 1000, HPP turun 22.500
  b := pg_temp.pbill(10000, s);
  g := pg_temp.grn(b, i4, 10, 1000);
  perform pg_temp.age_note(g, 2);
  b2 := pg_temp.pbill(100000, s);
  g := pg_temp.grn(b2, i4, 10, 10000);
  perform pg_temp.age_note(g, 1);
  perform pg_temp.assert_eq('T5 avg tercampur', (select avg_cost from inventory_balances where item_id = i4), 5500);
  perform pg_temp.sell(i4, c, 5);
  perform pg_temp.expect_error(format('select cancel_goods_receipt(%L, current_date)', g), 'Koreksi Barang Masuk');
  g2 := revise_goods_receipt(g, current_date, null,
    jsonb_build_array(jsonb_build_object('item_id', i4, 'qty_received', 10, 'unit_cost', 1000)), 0, 'Salah ketik harga', current_date);
  perform pg_temp.assert_eq('T5 stok', (select qty_on_hand from inventory_balances where item_id = i4), 15);
  perform pg_temp.assert_eq('T5 avg benar', (select avg_cost from inventory_balances where item_id = i4), 1000);
  select * into rev from goods_receipt_revisions where old_goods_note_id = g;
  perform pg_temp.assert_eq('T5 HPP turun', rev.cogs_adjustment, -22500);
  perform pg_temp.assert_eq('T5 sisa barang', ap_bill_pool_remaining(b2), 90000);

  -- T6 Koreksi Tagihan: yang tersisa 90rb diturunkan (nota kredit), belum dibayar
  perform pg_temp.expect_error(format($q$select adjust_ap_bill(%L, -90001, current_date, 'x')$q$, b2), 'melebihi barang');
  perform pg_temp.expect_error(format($q$select adjust_ap_bill(%L, -1, current_date, ' ')$q$, b2), 'Alasan');
  perform adjust_ap_bill(b2, -90000, current_date, 'Nota kredit supplier', 'NK-01');
  perform pg_temp.assert_eq('T6 sisa barang nol', ap_bill_pool_remaining(b2), 0);
  perform pg_temp.assert_eq('T6 utang turun', ap_bill_remaining(b2), 10000);
  perform pg_temp.assert_true('T6 belum', (select status from transactions where id = b2) = 'belum');
  -- sudah dibayar penuh: penurunan ditolak karena melebihi sisa utang
  perform pg_temp.pay(b2, s, 10000);
  perform pg_temp.assert_true('T6 lunas', (select status from transactions where id = b2) = 'lunas');
  perform adjust_ap_bill(b2, 5000, current_date, 'Nota debit');
  perform pg_temp.assert_eq('T6 naik', ap_bill_remaining(b2), 5000);
  perform pg_temp.assert_eq('T6 sisa barang naik', ap_bill_pool_remaining(b2), 5000);
  perform pg_temp.expect_error(format($q$select adjust_ap_bill(%L, -5001, current_date, 'x')$q$, b2), 'melebihi');
  raise notice 'T5/T6 OK';

  -- T7 akun retur dijaga: Pembelian Belum Diterima ditolak; barang fisik wajib Persediaan; Persediaan lolos
  perform pg_temp.expect_error(format($q$select create_ap_return(%L, current_date, 'APC-T7a', 0, %L, %L, %L::jsonb, %L)$q$,
    b, pg_temp.role_acct('ap.payable'), pg_temp.role_acct('inventory.purchase_not_received'),
    jsonb_build_array(jsonb_build_object('item_id', i4, 'qty_returned', 1)), pg_temp.role_acct('ap.return_credit_asset')), 'Pembelian Belum Diterima');
  perform pg_temp.expect_error(format($q$select create_ap_return(%L, current_date, 'APC-T7b', 0, %L, %L, %L::jsonb, %L)$q$,
    b, pg_temp.role_acct('ap.payable'), pg_temp.role_acct('rounding.expense'),
    jsonb_build_array(jsonb_build_object('item_id', i4, 'qty_returned', 1)), pg_temp.role_acct('ap.return_credit_asset')), 'wajib mengkredit akun Persediaan');
  ret := create_ap_return(b, current_date, 'APC-T7c', 0, pg_temp.role_acct('ap.payable'), inv,
    jsonb_build_array(jsonb_build_object('item_id', i4, 'qty_returned', 1)), pg_temp.role_acct('ap.return_credit_asset'));
  perform pg_temp.assert_true('T7 retur tercatat', ret is not null);

  -- T8 penghalang: retur menghalangi cascade, saldo retur menghalangi pembatalan bayar
  perform pg_temp.assert_true('T8 pratinjau menyebut retur', jsonb_array_length(ap_bill_cancellation_preview(b)->'blockers') > 0);
  p2 := pg_temp.pay(b, s, 9000);
  ret := create_ap_return(b, current_date, 'APC-T8', 0, pg_temp.role_acct('ap.payable'), inv,
    jsonb_build_array(jsonb_build_object('item_id', i4, 'qty_returned', 1)), pg_temp.role_acct('ap.return_credit_asset'));
  perform pg_temp.assert_true('T8 ada saldo retur', exists (select 1 from return_credits where return_id = ret));
  perform pg_temp.expect_error(format($q$select cancel_payment(%L, current_date, 'x', true)$q$, p2), 'jadi saldo');
  raise notice 'T7/T8 OK';

  -- T9 koreksi item salah: X diganti Y; koreksi lebih besar dari sisa barang ditolak dan semuanya batal
  b := pg_temp.pbill(100000, s);
  g := pg_temp.grn(b, i1, 10, 10000);
  perform pg_temp.expect_error(format($q$select revise_goods_receipt(%L, current_date, null, %L::jsonb, 0, 'x', current_date)$q$,
    g, jsonb_build_array(jsonb_build_object('item_id', i2, 'qty_received', 11, 'unit_cost', 10000))), 'melebihi sisa kolam');
  perform pg_temp.assert_true('T9 penolakan gak ninggalin bekas', goods_note_is_active(g));
  g2 := revise_goods_receipt(g, current_date, null,
    jsonb_build_array(jsonb_build_object('item_id', i2, 'qty_received', 10, 'unit_cost', 10000)), 0, 'Salah pilih barang', current_date);
  perform pg_temp.assert_eq('T9 stok i1', (select qty_on_hand from inventory_balances where item_id = i1), 0);
  perform pg_temp.assert_eq('T9 stok i2', (select qty_on_hand from inventory_balances where item_id = i2), 10);
  -- dokumen hasil koreksi bisa dibatalkan seperti biasa, dan dokumen lama gak bisa dikoreksi lagi
  perform pg_temp.expect_error(format($q$select revise_goods_receipt(%L, current_date, null, %L::jsonb, 0, 'x', current_date)$q$,
    g, jsonb_build_array(jsonb_build_object('item_id', i2, 'qty_received', 1, 'unit_cost', 1))), 'sudah dibatalkan');
  perform cancel_goods_receipt(g2, current_date);
  perform pg_temp.assert_eq('T9 sisa barang penuh', ap_bill_pool_remaining(b), 100000);
  raise notice 'T9 OK';

end $$;

do $$
declare
  ctx t_ctx%rowtype;
  inv uuid := pg_temp.role_acct('inventory.raw_material');
  c uuid; i uuid; t uuid; p uuid; v_before numeric;
begin
  select * into ctx from t_ctx;
  select id into c from counterparties where name = 'Customer Uji';
  select id into i from items where name = 'Uji 4';

  select gn.transaction_id into t from goods_notes gn
    join goods_note_lines l on l.goods_note_id = gn.id
    where gn.type = 'OUTBOUND' and l.item_id = i limit 1;
  p := record_payment('OUTBOUND', c, current_date, ar_invoice_remaining(t), 'ARP-T10', 'BANK', pg_temp.role_acct('ar.receivable'), t);
  perform pg_temp.assert_true('T10 lunas', (select status from transactions where id = t) = 'lunas');
  perform pg_temp.assert_true('T10 tampil di POS', exists (select 1 from pos_sales_with_status where id = t));
  perform pg_temp.expect_error(format($q$select cancel_ar_invoice(%L, current_date, 'JE-T10')$q$, t), 'pembayaran aktif');
  perform cancel_payment(p, current_date, 'Salah invoice', false);
  perform pg_temp.assert_true('T10 belum', (select status from transactions where id = t) = 'belum');
  perform pg_temp.assert_true('T10 hilang dari POS', not exists (select 1 from pos_sales_with_status where id = t));
  perform pg_temp.expect_error(format($q$select void_pos_transaction(%L, current_date, 'JE-T10')$q$, t), 'sudah dibatalkan');
  perform cancel_ar_invoice(t, current_date, 'JE-T10b');
  perform pg_temp.assert_true('T10 dibatalkan', (select status from transactions where id = t) = 'dibatalkan');
  raise notice 'T10 OK';

  -- Invarian akhir
  perform pg_temp.assert_eq('INV saldo Pembelian Belum Diterima = total sisa barang', pg_temp.pbd_gap(), ctx.gap0);
  perform pg_temp.assert_true('INV semua jurnal seimbang', not exists (
    select 1 from journal_lines group by journal_entry_id having sum(debit) <> sum(credit)));
  raise notice 'INVARIAN OK';
end $$;

rollback;
