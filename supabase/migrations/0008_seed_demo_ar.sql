-- Seed data Accounts Receivable untuk story CV Roti Barokah (docs/story/accounts-receivable.md).
-- customers via insert langsung (master data, gak ada RPC khusus).
-- Invoice/payment baru via RPC create_ar_invoice/record_ar_payment biar lewat validasi
-- yang sama kayak yang bakal dipakai app. created_by NULL (auth.uid() kosong di konteks migration).

insert into customers (name, contact, payment_term_days) values
  ('Warung Pak Budi', '0812-xxxx-0001', 14),
  ('Warung Bu Imas', '0812-xxxx-0002', 7),
  ('Warung Kang Ade', '0812-xxxx-0003', 7);

-- Warung Pak Budi: piutang timbul tanggal 7 Juli udah tercatat di journal entry
-- (migration 0005, source_ref 'Nota grosir #002') sebelum ar_invoices ada.
-- Insert langsung, link ke journal entry yang sudah ada — bukan lewat RPC
-- (RPC selalu bikin journal entry baru, di sini entry-nya udah terlanjur ada).
insert into ar_invoices (customer_id, invoice_date, due_date, description, source_ref, amount, journal_entry_id)
select
  (select id from customers where name = 'Warung Pak Budi'),
  '2026-07-07', '2026-07-21',
  'Kirim roti ke Warung Pak Budi, termin 2 minggu', 'Nota grosir #002', 1200000,
  (select id from journal_entries where source_ref = 'Nota grosir #002');

-- Warung Bu Imas: invoice 10 Juli, lunas 17 Juli (skenario 1 — tepat waktu).
select create_ar_invoice(
  (select id from customers where name = 'Warung Bu Imas'),
  '2026-07-10', 'Kirim roti ke Warung Bu Imas, termin 1 minggu', 'Nota grosir #003', 500000,
  (select id from accounts where code = '1300'), (select id from accounts where code = '4200')
);

select record_ar_payment(
  (select id from customers where name = 'Warung Bu Imas'),
  '2026-07-17', 500000, 'Bukti transfer Bu Imas #1',
  (select id from accounts where code = '1200'), (select id from accounts where code = '1300'),
  jsonb_build_array(
    jsonb_build_object(
      'invoice_id', (select id from ar_invoices where source_ref = 'Nota grosir #003'),
      'amount', 500000
    )
  )
);

-- Warung Kang Ade: invoice 12 Juli, dicicil 2x (skenario 2 — bayar sebagian).
select create_ar_invoice(
  (select id from customers where name = 'Warung Kang Ade'),
  '2026-07-12', 'Kirim roti ke Warung Kang Ade, termin 1 minggu', 'Nota grosir #004', 900000,
  (select id from accounts where code = '1300'), (select id from accounts where code = '4200')
);

select record_ar_payment(
  (select id from customers where name = 'Warung Kang Ade'),
  '2026-07-19', 500000, 'Bukti transfer Kang Ade #1',
  (select id from accounts where code = '1200'), (select id from accounts where code = '1300'),
  jsonb_build_array(
    jsonb_build_object(
      'invoice_id', (select id from ar_invoices where source_ref = 'Nota grosir #004'),
      'amount', 500000
    )
  )
);

select record_ar_payment(
  (select id from customers where name = 'Warung Kang Ade'),
  '2026-07-26', 400000, 'Bukti transfer Kang Ade #2',
  (select id from accounts where code = '1200'), (select id from accounts where code = '1300'),
  jsonb_build_array(
    jsonb_build_object(
      'invoice_id', (select id from ar_invoices where source_ref = 'Nota grosir #004'),
      'amount', 400000
    )
  )
);

-- Warung Pak Budi sengaja belum ada payment sampai hari ini (2026-07-30) —
-- due_date 21 Juli udah lewat 9 hari, jadi contoh aging/telat bayar (skenario 3).
