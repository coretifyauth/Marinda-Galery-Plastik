\set ON_ERROR_STOP on
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

-- DATA LAMA: barang masuk + tagihan bundel lewat RPC lama (sebelum 0056)
select create_goods_receipt(null,'2026-10-01','SJ-LAMA-1',
  '[{"order_line_id":"","item_id":"b0000000-0000-0000-0000-0000000000a1","qty_received":40,"unit_cost":10000}]'::jsonb,
  'Pembelian lama A','APB-LAMA-1',(select id from accounts where code='1400'),(select id from accounts where code='2100'),
  null,false,'a0000000-0000-0000-0000-000000000001',0);
select create_goods_receipt(null,'2026-10-02','SJ-LAMA-2',
  '[{"order_line_id":"","item_id":"b0000000-0000-0000-0000-0000000000b1","qty_received":10,"unit_cost":5000}]'::jsonb,
  'Pembelian lama B (diskon)','APB-LAMA-2',(select id from accounts where code='1400'),(select id from accounts where code='2100'),
  null,false,'a0000000-0000-0000-0000-000000000002',2000);

select 'legacy_notes' k, count(*) from goods_notes where type='INBOUND';
select item_id::text, qty_on_hand, avg_cost from inventory_balances order by item_id;
