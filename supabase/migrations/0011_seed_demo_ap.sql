-- Seed data Accounts Payable untuk story CV Roti Barokah (docs/story/accounts-payable.md).
-- suppliers via insert langsung (master data, gak ada RPC khusus).
-- Bill/payment baru via RPC create_ap_bill/record_ap_payment biar lewat validasi
-- yang sama kayak yang bakal dipakai app. created_by NULL (auth.uid() kosong di konteks migration).

insert into suppliers (name, contact, payment_term_days) values
  ('Toko Tepung Makmur', '022-xxxx-1001', 14),
  ('Toko Gula Sejahtera', '022-xxxx-1002', 7);

-- Toko Tepung Makmur: utang timbul tanggal 10 Juli udah tercatat di journal entry
-- (migration 0005, source_ref 'Nota beli #SUP-014') sebelum ap_bills ada.
-- Insert langsung, link ke journal entry yang sudah ada — bukan lewat RPC
-- (RPC selalu bikin journal entry baru, di sini entry-nya udah terlanjur ada).
insert into ap_bills (supplier_id, bill_date, due_date, description, source_ref, amount, journal_entry_id)
select
  (select id from suppliers where name = 'Toko Tepung Makmur'),
  '2026-07-10', '2026-07-24',
  'Beli tepung & gula, belum bayar', 'Nota beli #SUP-014', 800000,
  (select id from journal_entries where source_ref = 'Nota beli #SUP-014');

-- Skenario 1: Toko Gula Sejahtera, bill 12 Juli, lunas 19 Juli (tepat waktu).
select create_ap_bill(
  (select id from suppliers where name = 'Toko Gula Sejahtera'),
  '2026-07-12', 'Ambil gula dari Toko Gula Sejahtera', 'Nota beli #SUP-020', 300000,
  (select id from accounts where code = '1400'), (select id from accounts where code = '2100')
);

select record_ap_payment(
  (select id from suppliers where name = 'Toko Gula Sejahtera'),
  '2026-07-19', 300000, 'Bukti transfer Toko Gula Sejahtera #1',
  (select id from accounts where code = '2100'), (select id from accounts where code = '1200'),
  jsonb_build_array(
    jsonb_build_object(
      'bill_id', (select id from ap_bills where source_ref = 'Nota beli #SUP-020'),
      'amount', 300000
    )
  )
);

-- Skenario 2: Toko Tepung Makmur, bill 15 Juli, dicicil 2x.
select create_ap_bill(
  (select id from suppliers where name = 'Toko Tepung Makmur'),
  '2026-07-15', 'Ambil tepung tambahan dari Toko Tepung Makmur', 'Nota beli #SUP-021', 1000000,
  (select id from accounts where code = '1400'), (select id from accounts where code = '2100')
);

select record_ap_payment(
  (select id from suppliers where name = 'Toko Tepung Makmur'),
  '2026-07-20', 600000, 'Bukti transfer Toko Tepung Makmur #1',
  (select id from accounts where code = '2100'), (select id from accounts where code = '1200'),
  jsonb_build_array(
    jsonb_build_object(
      'bill_id', (select id from ap_bills where source_ref = 'Nota beli #SUP-021'),
      'amount', 600000
    )
  )
);

select record_ap_payment(
  (select id from suppliers where name = 'Toko Tepung Makmur'),
  '2026-07-27', 400000, 'Bukti transfer Toko Tepung Makmur #2',
  (select id from accounts where code = '2100'), (select id from accounts where code = '1200'),
  jsonb_build_array(
    jsonb_build_object(
      'bill_id', (select id from ap_bills where source_ref = 'Nota beli #SUP-021'),
      'amount', 400000
    )
  )
);

-- Skenario 3: Toko Gula Sejahtera, 3 bill kecil dibayar gabungan sekali.
select create_ap_bill(
  (select id from suppliers where name = 'Toko Gula Sejahtera'),
  '2026-07-20', 'Ambil gula #1', 'Nota beli #SUP-022', 100000,
  (select id from accounts where code = '1400'), (select id from accounts where code = '2100')
);

select create_ap_bill(
  (select id from suppliers where name = 'Toko Gula Sejahtera'),
  '2026-07-22', 'Ambil gula #2', 'Nota beli #SUP-023', 80000,
  (select id from accounts where code = '1400'), (select id from accounts where code = '2100')
);

select create_ap_bill(
  (select id from suppliers where name = 'Toko Gula Sejahtera'),
  '2026-07-24', 'Ambil gula #3', 'Nota beli #SUP-024', 90000,
  (select id from accounts where code = '1400'), (select id from accounts where code = '2100')
);

select record_ap_payment(
  (select id from suppliers where name = 'Toko Gula Sejahtera'),
  '2026-07-27', 270000, 'Bukti transfer Toko Gula Sejahtera #2 (gabungan 3 nota)',
  (select id from accounts where code = '2100'), (select id from accounts where code = '1200'),
  jsonb_build_array(
    jsonb_build_object('bill_id', (select id from ap_bills where source_ref = 'Nota beli #SUP-022'), 'amount', 100000),
    jsonb_build_object('bill_id', (select id from ap_bills where source_ref = 'Nota beli #SUP-023'), 'amount', 80000),
    jsonb_build_object('bill_id', (select id from ap_bills where source_ref = 'Nota beli #SUP-024'), 'amount', 90000)
  )
);

-- Skenario 5: bill salah input (dobel catat SUP-024), langsung dibatalkan.
select create_ap_bill(
  (select id from suppliers where name = 'Toko Gula Sejahtera'),
  '2026-07-24', 'Salah input, dobel catat dari Nota beli #SUP-024', 'Nota beli #SUP-025', 50000,
  (select id from accounts where code = '1400'), (select id from accounts where code = '2100')
);

select cancel_ap_bill(
  (select id from ap_bills where source_ref = 'Nota beli #SUP-025'),
  '2026-07-24', 'Pembatalan Nota beli #SUP-025 (dobel catat)'
);

-- Skenario 4: Toko Tepung Makmur (bill 10 Juli di atas) sengaja belum ada payment
-- sampai hari ini (2026-07-30) — due_date 24 Juli udah lewat 6 hari, contoh aging/telat bayar.
