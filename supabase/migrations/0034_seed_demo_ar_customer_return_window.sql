-- Seed data batas hari retur per customer untuk story CV Roti Barokah
-- (docs/story/accounts-receivable.md Skenario 14), Oktober 2026.

-- Warung Bu Imas dikasih toleransi retur 14 hari (kesepakatan dagang, gak ada hubungan
-- sama sifat fisik barangnya) — customer existing lain sengaja dibiarin NULL (gak
-- dibatasi), pola sama credit_limit/overdue_threshold_days yang gak diisi retroaktif ke
-- semua customer.
update customers set return_window_days = 14 where name = 'Warung Bu Imas';

-- Catatan: skenario retur yang DITOLAK (Bu Imas coba retur 1 Oktober 2026 buat invoice
-- 28 Agustus 2026 — 34 hari, ngelewatin batas 14 hari) sengaja gak dieksekusi di sini,
-- karena bakal bikin migration ini gagal (raise exception ngebatalin seluruh transaksi
-- migration). Pola sama kayak skenario credit hold (Skenario 4) yang juga cuma
-- didokumentasikan naratif di docs/story/accounts-receivable.md, gak dieksekusi sebagai
-- SQL yang sengaja gagal.
