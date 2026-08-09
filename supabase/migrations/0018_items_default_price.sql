-- Harga Jual Default per Item -- Opsi 1 (flat, 1 kolom per item) dari diskusi gap "item gak
-- melekat ke harga jual bisnis" (2026-08-09). Murni data master/referensi, BUKAN kejadian
-- transaksi -- gak ada jurnal, gak ada RPC baru, 0 perubahan ke signature create_ar_invoice/
-- create_goods_issue. Dipakai UI doang buat menyarankan p_amount pas invoice baru dibuat;
-- p_amount tetap wajib diisi eksplisit dari caller seperti sebelumnya (snapshot behavior --
-- perubahan default_price gak pernah retroaktif ngubah invoice yang udah terbit, pola sama
-- customer.payment_term_days vs ar_invoices.due_date).
--
-- Nullable -- gak semua item punya harga jual standar (bahan baku gak dijual langsung,
-- barang jadi custom order harganya nego tiap kali).

alter table items add column default_price numeric(14,2) check (default_price is null or default_price >= 0);
