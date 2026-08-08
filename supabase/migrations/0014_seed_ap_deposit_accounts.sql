-- Akun baru buat AP Deposit (migration 0013) -- di-insert di migration seed terpisah, bukan
-- di migration schema, pola sama semua akun baru lain (1350, 2300, 2500, 4300, dst).

insert into accounts (code, name, category) values
  ('1360', 'Uang Muka Pembelian', 'asset'),
  ('5800', 'Beban Kerugian Uang Muka', 'expense');
