-- Seed data Period Closing untuk story CV Roti Barokah (docs/story/financial-reports.md).
-- Nutup 2 periode kontigu lewat RPC close_period yang udah ada (0016_period_closing.sql) —
-- bukan insert langsung, biar lewat validasi (kontiguitas, overlap, hitung ulang saldo)
-- yang sama kayak yang bakal dipakai app.

-- Periode A: 2025 penuh — tahun akuisisi Oven & Motor (fixed-assets.md), cuma ada
-- Beban Penyusutan, belum ada Pendapatan sama sekali (General Ledger baru mulai Juli 2026).
-- Laba Bersih Periode A: 0 - 12.600.000 = Rp(12.600.000) — rugi, wajar (tahun investasi).
select close_period(
  '2025-01-01', '2025-12-31',
  (select id from accounts where code = '3200'),
  'TUTUP-BUKU-2025'
);

-- Periode B: 1 Januari - 25 Agustus 2026 — seluruh transaksi General Ledger, AR, AP,
-- Inventory yang sudah di-seed (semuanya jatuh di rentang ini, gak ada yang lewat).
-- Laba Bersih Periode B: 3.160.000 - 2.187.500 = Rp972.500 — untung, operasional sehat.
select close_period(
  '2026-01-01', '2026-08-25',
  (select id from accounts where code = '3200'),
  'TUTUP-BUKU-2026-S1'
);

-- Setelah ini, periode yang masih terbuka mulai 2026-08-26 — transaksi baru apa pun
-- (dari modul mana pun) yang bertanggal <= 2026-08-25 bakal ditolak trigger
-- journal_entries_block_retroactive_into_closed_period.
