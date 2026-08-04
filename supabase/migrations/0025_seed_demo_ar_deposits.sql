-- Seed data AR Deposit (Uang Muka/DP) untuk story CV Roti Barokah
-- (docs/story/accounts-receivable.md Skenario 7, 8, 9), Desember 2026 - Januari 2027.
-- Lanjutan dari 0008 (seed AR).

-- Akun baru, diprediksi di chart-of-accounts.md sejak Fase 6, baru dipakai sekarang.
insert into accounts (code, name, category) values
  ('2300', 'Uang Muka Penjualan', 'liability'),
  ('4300', 'Pendapatan Lain-lain', 'revenue');

-- Customer baru — pemesan custom (bukan warung langganan), lihat docs/story/accounts-receivable.md.
insert into customers (name, contact, payment_term_days) values
  ('Ibu Dewi', '0812-xxxx-0004', 7),
  ('Pak Joko', '0812-xxxx-0005', 7);

-- ============================================================
-- Skenario 7: DP diterima & diterapkan penuh ke invoice (Ibu Dewi, kue ulang tahun)
-- ============================================================

select create_ar_deposit(
  (select id from customers where name = 'Ibu Dewi'),
  '2026-12-28', 'DP Kue Ultah Ibu Dewi', 500000,
  (select id from accounts where code = '1200'), (select id from accounts where code = '2300')
);

select create_ar_invoice(
  (select id from customers where name = 'Ibu Dewi'),
  '2027-01-10', 'Kue ulang tahun custom', 'Nota Kue #001', 2000000,
  (select id from accounts where code = '1300'), (select id from accounts where code = '4100')
);

select apply_ar_deposit(
  (select id from ar_deposits where source_ref = 'DP Kue Ultah Ibu Dewi'),
  (select id from ar_invoices where source_ref = 'Nota Kue #001'),
  500000, '2027-01-10', 'Nota Kue #001',
  (select id from accounts where code = '2300'), (select id from accounts where code = '1300')
);

select record_ar_payment(
  (select id from customers where name = 'Ibu Dewi'),
  '2027-01-15', 1500000, 'Pelunasan Nota Kue #001',
  (select id from accounts where code = '1200'), (select id from accounts where code = '1300'),
  jsonb_build_array(
    jsonb_build_object(
      'invoice_id', (select id from ar_invoices where source_ref = 'Nota Kue #001'),
      'amount', 1500000
    )
  )
);

-- ============================================================
-- Skenario 8: DP hangus, order dibatalin sebelum invoice ada (Pak Joko, kue pernikahan)
-- ============================================================

select create_ar_deposit(
  (select id from customers where name = 'Pak Joko'),
  '2027-01-02', 'DP Kue Pernikahan Pak Joko', 1000000,
  (select id from accounts where code = '1200'), (select id from accounts where code = '2300')
);

select forfeit_ar_deposit(
  (select id from ar_deposits where source_ref = 'DP Kue Pernikahan Pak Joko'),
  '2027-01-05', 'Pembatalan pesanan Pak Joko',
  (select id from accounts where code = '2300'), (select id from accounts where code = '4300')
);

-- ============================================================
-- Skenario 9: invoice dengan DP-application ternyata salah input, dibatalkan
-- (Ibu Dewi, pesanan kedua)
-- ============================================================

select create_ar_deposit(
  (select id from customers where name = 'Ibu Dewi'),
  '2027-01-20', 'DP Kue Custom #2 Ibu Dewi', 300000,
  (select id from accounts where code = '1200'), (select id from accounts where code = '2300')
);

-- Staff salah ketik nominal: harusnya 1.000.000, kepencet 1.800.000.
select create_ar_invoice(
  (select id from customers where name = 'Ibu Dewi'),
  '2027-01-25', 'Kue custom kedua (salah input nominal)', 'Nota Kue #002', 1800000,
  (select id from accounts where code = '1300'), (select id from accounts where code = '4100')
);

select apply_ar_deposit(
  (select id from ar_deposits where source_ref = 'DP Kue Custom #2 Ibu Dewi'),
  (select id from ar_invoices where source_ref = 'Nota Kue #002'),
  300000, '2027-01-25', 'Nota Kue #002',
  (select id from accounts where code = '2300'), (select id from accounts where code = '1300')
);

-- Ketauan salah, invoice dibatalkan — cancel_ar_invoice ikut reverse jurnal DP-application
-- di atas, DP-nya otomatis balik "belum dipakai".
select cancel_ar_invoice(
  (select id from ar_invoices where source_ref = 'Nota Kue #002'),
  '2027-01-26', 'Pembatalan Nota Kue #002 - salah input nominal'
);

-- Invoice yang benar diterbitkan ulang, DP yang sama diterapkan lagi.
select create_ar_invoice(
  (select id from customers where name = 'Ibu Dewi'),
  '2027-01-26', 'Kue custom kedua (koreksi nominal)', 'Nota Kue #002-R', 1000000,
  (select id from accounts where code = '1300'), (select id from accounts where code = '4100')
);

select apply_ar_deposit(
  (select id from ar_deposits where source_ref = 'DP Kue Custom #2 Ibu Dewi'),
  (select id from ar_invoices where source_ref = 'Nota Kue #002-R'),
  300000, '2027-01-26', 'Nota Kue #002-R',
  (select id from accounts where code = '2300'), (select id from accounts where code = '1300')
);
