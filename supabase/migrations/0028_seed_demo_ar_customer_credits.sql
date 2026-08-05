-- Seed data AR Customer Credit (Kelebihan Bayar) untuk story CV Roti Barokah
-- (docs/story/accounts-receivable.md Skenario 10, 11), akhir Agustus - awal
-- September 2026. Lanjutan dari 0008 (seed AR) — Warung Bu Imas.
-- Tanggal sengaja setelah 2026-08-25 (periode B ditutup di 0017_seed_demo_period_closing.sql,
-- '2026-01-01' s/d '2026-08-25') — tanggal di dalam/sebelum rentang itu ditolak trigger
-- journal_entries_block_retroactive_into_closed_period.

-- Bugfix overload record_ar_payment: 0027 nambah parameter ke-8 (p_customer_credit_account_id
-- default null) lewat `create or replace function`. Postgres nge-ID fungsi dari
-- nama+tipe parameter, bukan nama doang — jadi `create or replace` gak nge-replace versi
-- 0007 (7 param, gak ada default), malah nambah overload baru. Instance yang udah kepasang
-- 0027 (sebelum drop eksplisit ditambahin ke situ) sekarang punya 2 overload nyangkut,
-- bikin `record_ar_payment(...)` 7 argumen ambigu (error 42725 "is not unique"). Drop di
-- sini juga (bukan cuma di 0027) biar instance yang UDAH terlanjur apply 0027 versi lama
-- ikut kebenerin pas migration ini jalan — `if exists` bikin ini aman di-apply berkali-kali
-- termasuk di instance baru yang 0027-nya udah punya drop ini dari awal (no-op).
drop function if exists record_ar_payment(uuid, date, numeric, text, uuid, uuid, jsonb);

-- Akun baru, diprediksi di chart-of-accounts.md sejak Fase 6, baru dipakai sekarang.
insert into accounts (code, name, category) values
  ('2400', 'Saldo Kredit Customer', 'liability');

-- ============================================================
-- Skenario 10: Bu Imas overpay Rp750.000 buat invoice Rp700.000, excess Rp50.000 jadi
-- saldo kredit.
-- ============================================================

select create_ar_invoice(
  (select id from customers where name = 'Warung Bu Imas'),
  '2026-08-28', 'Kirim roti ke Warung Bu Imas', 'Nota grosir #007', 700000,
  (select id from accounts where code = '1300'), (select id from accounts where code = '4200')
);

select record_ar_payment(
  (select id from customers where name = 'Warung Bu Imas'),
  '2026-09-02', 750000, 'Bukti transfer Bu Imas #2',
  (select id from accounts where code = '1200'), (select id from accounts where code = '1300'),
  jsonb_build_array(
    jsonb_build_object(
      'invoice_id', (select id from ar_invoices where source_ref = 'Nota grosir #007'),
      'amount', 700000
    )
  ),
  (select id from accounts where code = '2400')
);

-- ============================================================
-- Skenario 11: invoice baru Rp300.000, saldo kredit Rp50.000 dipakai motong duluan,
-- sisa Rp250.000 dibayar tunai.
-- ============================================================

select create_ar_invoice(
  (select id from customers where name = 'Warung Bu Imas'),
  '2026-09-05', 'Kirim roti ke Warung Bu Imas', 'Nota grosir #006', 300000,
  (select id from accounts where code = '1300'), (select id from accounts where code = '4200')
);

select apply_ar_customer_credit(
  (select id from ar_customer_credits where payment_id =
    (select id from ar_payments where source_ref = 'Bukti transfer Bu Imas #2')),
  (select id from ar_invoices where source_ref = 'Nota grosir #006'),
  50000, '2026-09-05', 'Nota grosir #006',
  (select id from accounts where code = '2400'), (select id from accounts where code = '1300')
);

select record_ar_payment(
  (select id from customers where name = 'Warung Bu Imas'),
  '2026-09-10', 250000, 'Bukti transfer Bu Imas #3',
  (select id from accounts where code = '1200'), (select id from accounts where code = '1300'),
  jsonb_build_array(
    jsonb_build_object(
      'invoice_id', (select id from ar_invoices where source_ref = 'Nota grosir #006'),
      'amount', 250000
    )
  )
);
