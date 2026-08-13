-- Follow-up to 0017: Stock Opname's "Akun Selisih Kurang"/"Akun Selisih Lebih" fields
-- were missed in the original sweep (found during rollout verification) — same raw
-- COA picker problem, same fix. Both always resolve to 1 fixed account each per the
-- seeded chart of accounts (supabase/migrations/0004_inventory_schema.sql).

insert into default_account_settings (role_key, label, account_id) values
  ('inventory.shortage_expense', 'Beban Selisih Persediaan (selisih kurang)', (select id from accounts where code = '6000')),
  ('inventory.surplus_revenue', 'Pendapatan Selisih Persediaan (selisih lebih)', (select id from accounts where code = '4400'));
