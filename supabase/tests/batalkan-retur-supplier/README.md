# Tes SQL — Batalkan Retur ke Supplier (migration 0061)

Skrip psql biasa, dijalankan di **database lokal Docker saja** — jangan pernah diarahkan ke database live. Cara menjalankan sama dengan `../koreksi-salah-input/README.md`, dengan `test-0061.sql`. Satu transaksi yang di-`rollback` di akhir.

Cakupan: T1 retur sebagian lalu dibatalkan (sisa, stok, rata-rata, label Kartu Stok, lalu barang masuk dan tagihan bisa dibatalkan), T2 tagihan lunas dengan saldo retur (pembayaran diblokir, saldo nol setelah batal), T3 saldo sudah dicairkan tunai (retur ditolak dibatalkan), T4 urutan terbaru dulu plus pratinjau Batalkan Tagihan, T5 retur penuh dibatalkan lalu diretur ulang (cap nilai tagihan), plus invarian saldo Pembelian Belum Diterima dan jurnal seimbang.

**Status:** lulus di database lokal (diverifikasi sebelum dan sesudah migration `0070`, 2026-11-04).

## Migration 0062 (Batalkan Pencairan Saldo Retur)

`test-0062.sql` (cara jalan sama): V1 kasus tagihan dibayar penuh + diretur penuh + saldo dicairkan tunai, diurai berurutan (pencairan, retur, pembayaran, barang masuk, tagihan) sampai semua akun nol; V2 pencairan yang dibatalkan boleh dicairkan lagi. Lulus di database lokal (2026-11-04).

## Migration 0065

Dihapus bersama fiturnya di `0070` (tukar barang dicabut, tabelnya dibuang); `test-0065.sql` ikut dihapus.
