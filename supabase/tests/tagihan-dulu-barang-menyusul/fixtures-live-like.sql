\set ON_ERROR_STOP on
-- Meniru data live SEBELUM 0056: 16 barang masuk lama alur "dibuat bareng tagihan" (RPC lama),
-- sebagian stok sudah terjual. Dijalankan di database LOKAL saja, setelah `db reset --local --version 0055`.
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","email":"tester@example.com"}', false);
insert into app_user_signup_whitelist (email, role_name) values ('tester@example.com','admin') on conflict do nothing;
insert into auth.users (id, email, aud, role) values ('11111111-1111-1111-1111-111111111111','tester@example.com','authenticated','authenticated') on conflict do nothing;
insert into app_user_roles (user_id, role_name) values ('11111111-1111-1111-1111-111111111111','admin') on conflict do nothing;
select bootstrap_default_accounts();
select complete_onboarding('Toko Uji');

insert into counterparties (id, name, payment_term_days) values
  ('a0000000-0000-0000-0000-000000000001','CV Supplier Satu',30),
  ('a0000000-0000-0000-0000-000000000002','CV Supplier Dua',30),
  ('a0000000-0000-0000-0000-000000000003','Pelanggan Uji',30);
insert into counterparty_type_mapping (counterparty_id, role) values
  ('a0000000-0000-0000-0000-000000000001','supplier'),
  ('a0000000-0000-0000-0000-000000000002','supplier'),
  ('a0000000-0000-0000-0000-000000000003','customer');
insert into items (id, name, item_type, uom, inventory_account_id) values
  ('b0000000-0000-0000-0000-0000000000a1','Kantong A','RAW_MATERIAL','pcs',(select id from accounts where code='1400')),
  ('b0000000-0000-0000-0000-0000000000b1','Kantong B','RAW_MATERIAL','pcs',(select id from accounts where code='1400')),
  ('b0000000-0000-0000-0000-0000000000c1','Kantong C','RAW_MATERIAL','pcs',(select id from accounts where code='1400'));

-- 16 barang masuk lama (RPC lama sebelum 0056)
select create_goods_receipt(null,'2026-10-01','SJ-LAMA-1',
  '[{"order_line_id":"","item_id":"b0000000-0000-0000-0000-0000000000a1","qty_received":40,"unit_cost":10000}]'::jsonb,
  'Pembelian lama A','APB-LAMA-1',(select id from accounts where code='1400'),(select id from accounts where code='2100'),
  null,false,'a0000000-0000-0000-0000-000000000001',0);
select create_goods_receipt(null,'2026-10-02','SJ-LAMA-2',
  '[{"order_line_id":"","item_id":"b0000000-0000-0000-0000-0000000000b1","qty_received":10,"unit_cost":5000}]'::jsonb,
  'Pembelian lama B (diskon)','APB-LAMA-2',(select id from accounts where code='1400'),(select id from accounts where code='2100'),
  null,false,'a0000000-0000-0000-0000-000000000002',2000);
do $$
declare i int;
begin
  for i in 3..16 loop
    perform create_goods_receipt(null, ('2026-10-02'::date + i), 'SJ-LAMA-' || i,
      jsonb_build_array(jsonb_build_object('order_line_id','',
        'item_id', case i % 3 when 0 then 'b0000000-0000-0000-0000-0000000000a1' when 1 then 'b0000000-0000-0000-0000-0000000000b1' else 'b0000000-0000-0000-0000-0000000000c1' end,
        'qty_received', 10 + i, 'unit_cost', 1000 * (5 + i % 4))),
      'Pembelian lama ' || i, 'APB-LAMA-' || i, (select id from accounts where code='1400'), (select id from accounts where code='2100'),
      null, false, 'a0000000-0000-0000-0000-000000000001', 0);
  end loop;
end $$;

-- sebagian stok A terjual
select create_goods_issue('a0000000-0000-0000-0000-000000000003','2026-10-20','Penjualan lama','ARI-LAMA-1',
  jsonb_build_array(jsonb_build_object('account_id',(select id from accounts where code='4200'),'amount',5*15000)),
  (select id from accounts where code='1300'),
  jsonb_build_array(jsonb_build_object('item_id','b0000000-0000-0000-0000-0000000000a1','qty_issued',5,'unit_price',15000)),
  (select id from accounts where code='5100'),(select id from accounts where code='1400'),false);

select 'legacy_inbound' k, count(*) from goods_notes where type='INBOUND';
