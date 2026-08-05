-- Seed data AR Bad Debt Write-off untuk story CV Roti Barokah
-- (docs/story/accounts-receivable.md Skenario 12), Februari - Juni 2027.
-- Lanjutan dari 0025 (seed AR Deposit).

-- Akun baru, diprediksi sejak Fase 6, baru dipakai sekarang.
insert into accounts (code, name, category) values
  ('5700', 'Beban Piutang Tak Tertagih', 'expense');

-- Customer baru — pemesan custom (bukan warung langganan), referral dari Ibu Dewi.
insert into customers (name, contact, payment_term_days) values
  ('Bu Rina', '0812-xxxx-0006', 7);

-- ============================================================
-- Skenario 12: Piutang tak tertagih (write-off), pesanan custom yang kabur (Bu Rina)
-- ============================================================

-- Referral dari langganan yang udah dipercaya (Ibu Dewi) — Bu Nur kirim langsung tanpa
-- minta DP, beda dari pola Ibu Dewi/Pak Joko yang selalu bayar DP di muka.
select create_ar_invoice(
  (select id from customers where name = 'Bu Rina'),
  '2027-02-01', 'Kue ulang tahun custom', 'Nota Kue #003', 1500000,
  (select id from accounts where code = '1300'), (select id from accounts where code = '4100')
);

-- Due date 2027-02-08 lewat, follow-up WhatsApp berkali-kali gak dibales, nomor akhirnya
-- gak aktif. Ditunggu 4 bulan, gak ada respons sama sekali — dianggap gak akan tertagih.
-- Belum ada payment/retur/DP/kredit apa pun yang nyentuh invoice ini, jadi write-off penuh
-- Rp1.500.000 (persis sisa outstanding riilnya).
select write_off_ar_invoice(
  (select id from ar_invoices where source_ref = 'Nota Kue #003'),
  '2027-06-01', 1500000, 'Write-off piutang Bu Rina - customer tidak dapat dihubungi',
  (select id from accounts where code = '5700'), (select id from accounts where code = '1300')
);
