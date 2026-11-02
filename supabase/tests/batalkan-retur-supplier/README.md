# Tes SQL — Batalkan Retur ke Supplier (migration 0061)

Skrip psql biasa, dijalankan di **database lokal Docker saja** — jangan pernah diarahkan ke database live. Cara menjalankan sama dengan `../koreksi-salah-input/README.md`, dengan `test-0061.sql`. Satu transaksi yang di-`rollback` di akhir.

Cakupan: T1 retur sebagian lalu dibatalkan (sisa, stok, rata-rata, label Kartu Stok, lalu barang masuk dan tagihan bisa dibatalkan), T2 tagihan lunas dengan saldo retur (pembayaran diblokir, saldo nol setelah batal), T3 saldo sudah dicairkan tunai (retur ditolak dibatalkan), T4 urutan terbaru dulu plus pratinjau Batalkan Tagihan, T5 retur penuh dibatalkan lalu diretur ulang (cap nilai tagihan), plus invarian saldo Pembelian Belum Diterima dan jurnal seimbang.

**Status:** ditulis bersama migration, belum pernah dijalankan (tidak ada Docker saat penulisan).
