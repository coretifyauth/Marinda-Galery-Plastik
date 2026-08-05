-- Seed data AR Return Credit untuk story CV Roti Barokah
-- (docs/story/accounts-receivable.md Skenario 13), backfill + refund, September 2026.

-- Akun baru, diprediksi sejak Fase 6, baru dipakai sekarang.
insert into accounts (code, name, category) values
  ('2500', 'Saldo Kredit Retur Customer', 'liability');

-- ============================================================
-- Backfill: retur Warung Kang Ade (5 September 2026, migration 0023) bikin outstanding
-- invoice-nya jadi minus Rp50.000 — kejadian itu sudah tercatat SEBELUM fitur AR Return
-- Credit ini ada, jadi create_ar_credit_note versi lama (0022) gak sempat otomatis
-- mencairkan excess-nya. Backfill manual: insert reclass journal entry + baris
-- ar_return_credits yang SEHARUSNYA otomatis kebentuk kalau fitur ini udah ada waktu itu.
-- Nominal & tanggal dihitung persis dari kejadian aslinya (bukan angka baru): invoice
-- Rp900.000 udah lunas penuh SEBELUM retur (sisa outstanding = 0), retur Rp50.000 penuh
-- jadi excess.
-- ============================================================

select create_journal_entry(
  '2026-09-05', 'Saldo kredit dari retur (backfill)', 'Retur roti apek 5 warung Kang Ade',
  jsonb_build_array(
    jsonb_build_object(
      'account_id', (select id from accounts where code = '1300'), 'debit', 50000, 'credit', 0
    ),
    jsonb_build_object(
      'account_id', (select id from accounts where code = '2500'), 'debit', 0, 'credit', 50000
    )
  )
);

insert into ar_return_credits (customer_id, credit_note_id, amount, journal_entry_id, created_by)
values (
  (select id from customers where name = 'Warung Kang Ade'),
  (select id from ar_credit_notes where source_ref = 'Retur roti apek 5 warung Kang Ade'),
  50000,
  (select id from journal_entries
     where source_ref = 'Retur roti apek 5 warung Kang Ade'
       and description = 'Saldo kredit dari retur (backfill)'),
  null
);

-- ============================================================
-- Skenario 13: saldo kredit retur direfund tunai (Kang Ade gak ada rencana order lagi
-- dalam waktu dekat, minta uangnya balik langsung daripada nunggu dipakai)
-- ============================================================

select refund_ar_return_credit(
  (select id from ar_return_credits where credit_note_id =
    (select id from ar_credit_notes where source_ref = 'Retur roti apek 5 warung Kang Ade')),
  50000, '2026-09-10', 'Refund tunai retur Kang Ade',
  (select id from accounts where code = '2500'), (select id from accounts where code = '1200')
);
