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


-- sebagai user terautentikasi (admin) -- RLS & grant ikut berlaku
set role authenticated;

do $$
declare i uuid := 'b0000000-0000-0000-0000-0000000000a9'; g uuid; bill uuid; s record;
begin
  -- item dibuat sebagai admin lewat RLS biasa
  insert into items (id, name, item_type, uom, inventory_account_id)
    values (i, 'Kantong RLS', 'RAW_MATERIAL', 'pcs', (select id from accounts where code = '1400'));
  g := pg_temp.grn(i, 50, 1000);
  perform pg_temp.revise(g, 1100);
  perform pg_temp.assert_eq('RLS nilai', (select total_value from goods_notes_with_billing_status where id = g), 55000);
  bill := pg_temp.bill(array[g]);
  perform pg_temp.sale(i, 10);
  s := pg_temp.st(i); perform pg_temp.assert_eq('RLS avg', s.avg, 1100); perform pg_temp.assert_eq('RLS Q', s.q, 40);
  g := pg_temp.grn(i, 5, 900);
  perform cancel_goods_receipt(g, '2026-10-16');
  raise notice 'RLS OK (admin terautentikasi)';
end $$;

-- user biasa (bukan admin) tidak boleh menulis
reset role;
insert into app_user_signup_whitelist (email, role_name) values ('kasir@example.com', 'cashier') on conflict do nothing;
insert into auth.users (id, email, aud, role) values ('22222222-2222-2222-2222-222222222222', 'kasir@example.com', 'authenticated', 'authenticated') on conflict do nothing;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated","email":"kasir@example.com"}', false);
set role authenticated;
do $$
begin
  perform pg_temp.expect_error($q$select pg_temp.grn('b0000000-0000-0000-0000-0000000000a9', 5, 100)$q$, 'row-level security');
  raise notice 'RLS OK (non-admin ditolak)';
end $$;
reset role;
select 'RLS TES LULUS' as hasil;
