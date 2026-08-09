-- Akun baru buat PPN (migration seed terpisah, pola sama semua akun baru lain --
-- 1350, 1360, 2300, 2500, 4300, 5700, 5800, 5900, 6000, 4400, dst).
-- Interim manual-only: belum ada RPC yang otomatis mecah PPN sebagai baris jurnal
-- terpisah (lihat memory/scope-debt/tax-handling.md) -- akun ini cuma nyiapin
-- "kantong" buat dicatat manual lewat create_journal_entry kalau/pas dibutuhkan.

insert into accounts (code, name, category) values
  ('1500', 'PPN Masukan', 'asset'),
  ('2400', 'PPN Keluaran', 'liability');
