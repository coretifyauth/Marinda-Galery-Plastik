\set ON_ERROR_STOP on
-- Tes migration 0069 (koreksi barang masuk lama). Database LOKAL saja. Satu transaksi, di-ROLLBACK di akhir. Lihat README.md.
begin;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","email":"tester@example.com"}', true);

-- Akun default tidak lagi di-seed migration (0033): siapkan seperti fixture lain (tagihan-dulu-barang-menyusul/fixtures-live-like.sql).
insert into app_user_signup_whitelist (email, role_name) values ('tester@example.com', 'admin') on conflict do nothing;
insert into auth.users (id, email, aud, role) values ('11111111-1111-1111-1111-111111111111', 'tester@example.com', 'authenticated', 'authenticated') on conflict do nothing;
insert into app_user_roles (user_id, role_name) values ('11111111-1111-1111-1111-111111111111', 'admin') on conflict do nothing;
do $$ begin
  if not exists (select 1 from app_settings) then
    perform bootstrap_default_accounts();
    perform complete_onboarding('Toko Uji');
  end if;
end $$;

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
-- barang masuk LAMA: tagihan biasa (Debit Persediaan / Kredit Utang) + goods_notes tanpa jurnal & tanpa nomor, seperti data live.
create or replace function pg_temp.legacy(p_supplier uuid, p_item uuid, p_qty numeric, p_cost numeric, out bill uuid, out note uuid, out line uuid)
language plpgsql as $$
begin
  bill := create_transaction('INBOUND', p_supplier, current_date, 'Tagihan lama uji', 'APB-L-' || substr(gen_random_uuid()::text, 1, 8),
    jsonb_build_array(jsonb_build_object('account_id', pg_temp.role_acct('inventory.raw_material'), 'amount', p_qty * p_cost)),
    pg_temp.role_acct('ap.payable'));
  -- data live lama dibuat SEBELUM penjaga 0057 ada, jadi fixture mematikan penjaga hanya di sekitar insert ini
  alter table goods_notes disable trigger goods_notes_inbound_from_bill_guard_trigger;
  insert into goods_notes (type, transaction_id, note_date, counterparty_id, created_by)
    values ('INBOUND', bill, current_date, p_supplier, auth.uid()) returning id into note;
  alter table goods_notes enable trigger goods_notes_inbound_from_bill_guard_trigger;
  insert into goods_note_lines (goods_note_id, item_id, qty, unit_cost) values (note, p_item, p_qty, p_cost) returning id into line;
  insert into inventory_movements (item_id, movement_date, qty, goods_note_line_id) values (p_item, current_date, p_qty, line);
  insert into inventory_balances (item_id, qty_on_hand, avg_cost) values (p_item, p_qty, p_cost)
    on conflict (item_id) do update set qty_on_hand = inventory_balances.qty_on_hand + p_qty, avg_cost = p_cost;
end $$;
create or replace function pg_temp.sell(p_item uuid, p_customer uuid, p_qty numeric) returns uuid language plpgsql as $$
begin
  return create_goods_issue(p_customer, current_date, 'Penjualan uji', 'ARI-T-' || substr(gen_random_uuid()::text, 1, 8),
    jsonb_build_array(jsonb_build_object('account_id', pg_temp.role_acct('ar.revenue'), 'amount', p_qty * 50000)),
    pg_temp.role_acct('ar.receivable'),
    jsonb_build_array(jsonb_build_object('item_id', p_item, 'qty_issued', p_qty, 'unit_price', 50000)),
    pg_temp.role_acct('inventory.hpp'), pg_temp.role_acct('inventory.raw_material'), false);
end $$;
-- Satu transaksi = satu now(): mundurkan barang masuk ini supaya urutan waktu mutasi eksplisit.
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

do $$
declare
  s uuid := gen_random_uuid(); c uuid := gen_random_uuid();
  i1 uuid := gen_random_uuid(); i2 uuid := gen_random_uuid(); i3 uuid := gen_random_uuid();
  inv uuid := pg_temp.role_acct('inventory.raw_material');
  hpp uuid := pg_temp.role_acct('inventory.hpp');
  inv0 numeric; hpp0 numeric;
  r record; l1 record; b uuid; n uuid; ln uuid; n2 uuid; rev goods_receipt_revisions%rowtype;
begin
  insert into counterparties (id, name, payment_term_days) values (s, 'Supplier Uji', 30), (c, 'Customer Uji', 30);
  insert into counterparty_type_mapping (counterparty_id, role) values (s, 'supplier'), (c, 'customer');
  insert into items (id, name, item_type, uom, inventory_account_id) values
    (i1, 'Uji 1', 'RAW_MATERIAL', 'pcs', inv), (i2, 'Uji 2', 'RAW_MATERIAL', 'pcs', inv), (i3, 'Uji 3', 'RAW_MATERIAL', 'pcs', inv);

  -- T1 salah satuan: tercatat 10 pcs @ 10.000 (Rp100.000), seharusnya 10 box = 1.440 pcs. Belum ada penjualan.
  select * into r from pg_temp.legacy(s, i1, 10, 10000);
  b := r.bill; n := r.note; ln := r.line;
  inv0 := pg_temp.bal(inv); hpp0 := pg_temp.bal(hpp);
  n2 := revise_legacy_goods_receipt(n, jsonb_build_array(jsonb_build_object('line_id', ln, 'qty', 1440)), 'Salah satuan: box dicatat pcs', current_date);
  perform pg_temp.assert_eq('T1 stok', (select qty_on_hand from inventory_balances where item_id = i1), 1440);
  perform pg_temp.assert_eq('T1 avg', (select avg_cost from inventory_balances where item_id = i1), 100000.0 / 1440, 0.01);
  perform pg_temp.assert_eq('T1 nilai stok = Rp100.000', (select qty_on_hand * avg_cost from inventory_balances where item_id = i1), 100000, 10); -- avg_cost tersimpan 2 desimal => selisih receh
  perform pg_temp.assert_eq('T1 persediaan GL tak berubah', pg_temp.bal(inv), inv0);
  perform pg_temp.assert_eq('T1 HPP GL tak berubah', pg_temp.bal(hpp), hpp0);
  perform pg_temp.assert_eq('T1 nilai baris baru persis Rp100.000',
    (select sum(round(qty * unit_cost, 2) - coalesce(discount_amount, 0)) from goods_note_lines where goods_note_id = n2), 100000, 0);
  perform pg_temp.assert_true('T1 lama dibatalkan', (select status from goods_receipts_overview where id = n) = 'dibatalkan');
  perform pg_temp.assert_true('T1 baru aktif & tetap lama', (select status from goods_receipts_overview where id = n2) = 'aktif'
    and (select is_legacy from goods_receipts_overview where id = n2));
  select * into rev from goods_receipt_revisions where old_goods_note_id = n;
  perform pg_temp.assert_eq('T1 tanpa koreksi HPP', rev.cogs_adjustment, 0, 0);
  perform pg_temp.assert_true('T1 tanpa jurnal', rev.cogs_journal_entry_id is null);
  perform pg_temp.assert_true('T1 tagihan utuh', (select status from transactions where id = b) <> 'dibatalkan');
  -- stok kartu: -10 lalu +1440 => jumlah mutasi = 1440
  perform pg_temp.assert_eq('T1 jumlah mutasi', (select sum(qty) from inventory_movements where item_id = i1), 1440);

  -- T3 batalkan tagihan sesudah koreksi: hanya dokumen pengganti yang dibalik (stok kembali 0, bukan -10 / error)
  perform cancel_ap_bill(b, current_date, 'JE-T3');
  perform pg_temp.assert_eq('T3 stok kembali 0', (select qty_on_hand from inventory_balances where item_id = i1), 0);
  perform pg_temp.assert_true('T3 tagihan batal', (select status from transactions where id = b) = 'dibatalkan');

  -- T2 salah satuan, sebagian sudah terjual: 10 pcs @ 10.000, terjual 3 (HPP 30.000), lalu koreksi ke 1.440 pcs
  select * into r from pg_temp.legacy(s, i2, 10, 10000);
  b := r.bill; n := r.note; ln := r.line;
  perform pg_temp.age_note(n, 2);
  perform pg_temp.sell(i2, c, 3);
  perform pg_temp.assert_eq('T2 stok sebelum', (select qty_on_hand from inventory_balances where item_id = i2), 7);
  inv0 := pg_temp.bal(inv); hpp0 := pg_temp.bal(hpp);
  n2 := revise_legacy_goods_receipt(n, jsonb_build_array(jsonb_build_object('line_id', ln, 'qty', 1440)), 'Salah satuan', current_date);
  perform pg_temp.assert_eq('T2 stok', (select qty_on_hand from inventory_balances where item_id = i2), 1437);
  -- HPP 3 pcs seharusnya 3 x 69,44 = 208,33 bukan 30.000 => HPP turun ~29.791,67, Persediaan naik sebesar itu
  perform pg_temp.assert_eq('T2 HPP turun', pg_temp.bal(hpp) - hpp0, -29791.67, 1);
  perform pg_temp.assert_eq('T2 persediaan naik', pg_temp.bal(inv) - inv0, 29791.67, 1);
  -- nilai stok di buku besar (item ini saja, i1 sudah 0) = qty x avg
  perform pg_temp.assert_eq('T2 stok sinkron GL', (select qty_on_hand * avg_cost from inventory_balances where item_id = i2),
    100000 - 3 * 100000.0 / 1440, 10);
  select * into rev from goods_receipt_revisions where old_goods_note_id = n;
  perform pg_temp.assert_eq('T2 cogs tercatat', rev.cogs_adjustment, -29791.67, 1);
  perform pg_temp.assert_true('T2 jurnal ada', rev.cogs_journal_entry_id is not null);

  -- T4 penolakan
  select * into r from pg_temp.legacy(s, i3, 10, 10000);
  b := r.bill; n := r.note; ln := r.line;
  perform pg_temp.expect_error(format($q$select revise_legacy_goods_receipt(%L, '[]'::jsonb, 'x', current_date)$q$, n), 'semua');
  perform pg_temp.expect_error(format($q$select revise_legacy_goods_receipt(%L, jsonb_build_array(jsonb_build_object('line_id', %L, 'qty', 0)), 'x', current_date)$q$, n, ln), 'lebih dari 0');
  perform pg_temp.expect_error(format($q$select revise_legacy_goods_receipt(%L, jsonb_build_array(jsonb_build_object('line_id', %L, 'qty', 10)), 'x', current_date)$q$, n, ln), 'Tidak ada perubahan');
  perform pg_temp.expect_error(format($q$select revise_legacy_goods_receipt(%L, jsonb_build_array(jsonb_build_object('line_id', %L, 'qty', 20)), '  ', current_date)$q$, n, ln), 'Alasan');
  perform pg_temp.expect_error(format($q$select revise_legacy_goods_receipt(%L, jsonb_build_array(jsonb_build_object('line_id', %L, 'qty', 20)), 'x', current_date - 5)$q$, n, ln), 'lebih awal');
  n2 := revise_legacy_goods_receipt(n, jsonb_build_array(jsonb_build_object('line_id', ln, 'qty', 20)), 'ok', current_date);
  perform pg_temp.expect_error(format($q$select revise_legacy_goods_receipt(%L, jsonb_build_array(jsonb_build_object('line_id', %L, 'qty', 30)), 'x', current_date)$q$, n, ln), 'sudah dikoreksi');
  -- T5 penjaga tetap menutup pembuatan barang masuk lama "dari nol" (tanpa dokumen lama yang digantikan)
  select * into r from pg_temp.legacy(s, i3, 1, 1000);
  perform pg_temp.expect_error(format($q$insert into goods_notes (type, transaction_id, note_date, counterparty_id)
    values ('INBOUND', %L, current_date, %L)$q$,
    (select transaction_id from goods_notes where id = r.note), s), 'wajib punya jurnal dan nomor');

  raise notice 'SEMUA TES 0069 LULUS';
end $$;

rollback;
