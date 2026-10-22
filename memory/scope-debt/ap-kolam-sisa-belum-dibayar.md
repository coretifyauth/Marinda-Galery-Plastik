# Sisa kolam tagihan barang yang belum dibayar belum punya jalur penutupan

**Modul asal:** Accounts Payable — "Tagihan Dulu, Barang Menyusul" (kolam tagihan). **Status:** Ditunda.

## Kasus

Nota supplier Rp10 juta dicatat sebagai tagihan barang (kolam Rp10 juta). Barang yang datang baru Rp4 juta, supplier bilang sisanya batal dikirim — tapi tagihan belum dibayar sama sekali (atau baru dibayar sebagian kecil). Secara bisnis ini **koreksi utang**: nota kredit dari supplier yang menurunkan Utang Usaha dan kolam sekaligus (Debit Utang Usaha, Kredit Pembelian Belum Diterima).

`release_ap_bill_pool` cuma melepas dua hal: receh di bawah satuan pembulatan (ke Beban Selisih Pembulatan) dan bagian yang **sudah dibayar** (ke Uang Muka, maksimal dibayar − biaya tambahan − barang terpakai − uang muka yang sudah dilepas). Sisa kolam yang belum dibayar tidak bisa ditutup lewat jalur mana pun; tagihannya juga tidak bisa dibatalkan selama punya barang masuk aktif atau pelepasan kolam.

## Kenapa ditunda

Butuh jalur sendiri: dokumen nota kredit supplier (nomor, tanggal, jurnal pembalik parsial ke Utang Usaha dan akun kolam), aturan interaksinya dengan retur ke supplier (`create_ap_return` sudah mengurangi Utang Usaha untuk barang yang sudah diterima), dan dampaknya ke `recompute_transaction_status` / status lunas. Belum ada kasus nyata di cerita bisnis, dan solusi sementara (bayar dulu bagian barang yang datang, sisanya dilepas sebagai uang muka lalu refund/hangus) sudah mencakup kasus tagihan yang sudah dibayar. Pembanding: sisi AR tidak punya padanan (invoice dikirim setelah barang keluar).

## Referensi

- `docs/domain/accounts-payable.md` — submodule "Tagihan Dulu, Barang Menyusul (Kolam Tagihan)", bagian Cara Kerja (sisa kolam) dan Aturan Bisnis.
- `docs/architecture/goods-notes-schema.md` — section "Barang Masuk dari Tagihan", "Keterbatasan yang diketahui".
