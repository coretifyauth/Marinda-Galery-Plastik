-- Seed data journal entries untuk story CV Roti Barokah (docs/story/general-ledger.md).
-- Dijalankan via RPC create_journal_entry (bukan insert langsung) biar lewat validasi
-- yang sama kayak yang bakal dipakai app (leaf-only, balance-check, dst).
-- created_by NULL (auth.uid() kosong di konteks migration, kolomnya nullable).

select create_journal_entry(
  '2026-07-01', 'Setoran modal awal', 'Setoran modal awal',
  jsonb_build_array(
    jsonb_build_object('account_id', (select id from accounts where code = '1200'), 'debit', 10000000, 'credit', 0),
    jsonb_build_object('account_id', (select id from accounts where code = '3100'), 'debit', 0, 'credit', 10000000)
  )
);

select create_journal_entry(
  '2026-07-05', 'Jual roti tunai di kios', 'Nota kios #001',
  jsonb_build_array(
    jsonb_build_object('account_id', (select id from accounts where code = '1100'), 'debit', 500000, 'credit', 0),
    jsonb_build_object('account_id', (select id from accounts where code = '4100'), 'debit', 0, 'credit', 500000)
  )
);

select create_journal_entry(
  '2026-07-07', 'Kirim roti ke Warung Pak Budi, termin 2 minggu', 'Nota grosir #002',
  jsonb_build_array(
    jsonb_build_object('account_id', (select id from accounts where code = '1300'), 'debit', 1200000, 'credit', 0),
    jsonb_build_object('account_id', (select id from accounts where code = '4200'), 'debit', 0, 'credit', 1200000)
  )
);

select create_journal_entry(
  '2026-07-10', 'Beli tepung & gula, belum bayar', 'Nota beli #SUP-014',
  jsonb_build_array(
    jsonb_build_object('account_id', (select id from accounts where code = '1400'), 'debit', 800000, 'credit', 0),
    jsonb_build_object('account_id', (select id from accounts where code = '2100'), 'debit', 0, 'credit', 800000)
  )
);

select create_journal_entry(
  '2026-07-15', 'Bayar gaji karyawan Juli minggu 2', 'Slip gaji Juli minggu 2',
  jsonb_build_array(
    jsonb_build_object('account_id', (select id from accounts where code = '5200'), 'debit', 2000000, 'credit', 0),
    jsonb_build_object('account_id', (select id from accounts where code = '1200'), 'debit', 0, 'credit', 2000000)
  )
);

select create_journal_entry(
  '2026-07-20', 'Bayar cicilan KUR: pokok + bunga', 'Bukti transfer cicilan KUR Juli',
  jsonb_build_array(
    jsonb_build_object('account_id', (select id from accounts where code = '2200'), 'debit', 1000000, 'credit', 0),
    jsonb_build_object('account_id', (select id from accounts where code = '5500'), 'debit', 150000, 'credit', 0),
    jsonb_build_object('account_id', (select id from accounts where code = '1200'), 'debit', 0, 'credit', 1150000)
  )
);
